import asyncio
import json
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..engine import analyze, estimate_floor
from ..strategies import (
    IMAGE_SUFFIXES,
    MAX_IMAGE_PIXELS,
    MAX_OTHER_IMAGE_PIXELS,
    MAX_RESIZE_EDGE,
    PDF_SUFFIXES,
    image_too_big,
)
from ..units import human_size, parse_limit
from . import limits, store
from .config import Settings
from .jobs import run_compress

SWEEP_INTERVAL = 60
UPLOAD_CHUNK = 1024 * 1024

# /health counts a missing worker only after this long: the worker process
# starts next to the API and takes a few seconds to register.
WORKER_GRACE_SECONDS = 60
# Longest /health takes to answer.
HEALTH_TIMEOUT = 3.0
# Free disk kept for uploads in flight; see receive_upload.
MIN_FREE_BYTES = 500 * 1024 * 1024
# /api/fit waits this long for the run before answering 202 with a status URL.
# Kept under the ~100s a proxy in front of the API (Cloudflare, on Render) lets
# a request sit without a response before cutting it off.
FIT_WAIT_SECONDS = 80.0
FIT_POLL_INTERVAL = 0.5

# Endpoints that take a file. Their rate limit is checked in middleware, before
# the multipart body is read.
UPLOAD_PATHS = ("/api/upload", "/api/fit")

API_DESCRIPTION = """
Compress a PDF or image so it fits under an upload limit, like "200 KB" on a
visa form or "1 MB" on a job site. Lossless first; if that is not enough, the
gentlest lossy setting that fits. Free, no key needed.

**Quickest route, one call:** `POST /api/fit` with the file and a `target`
such as `200KB` or `1.5MB`. It answers with a `download_url` when the file is
ready (usually seconds), or `202` with a `status_url` to poll for large files.

**Step by step (what the website does):** `POST /api/upload`, then
`POST /api/jobs/{job_id}/compress` with `{"target_bytes": n}`, then follow
`GET /api/jobs/{job_id}/events` (Server-Sent Events) or poll
`GET /api/jobs/{job_id}` until `status` is `done`, then
`GET /api/jobs/{job_id}/download`.

**Exact pixel size (images only):** add `width` and `height` to either
route to get a JPEG of exactly that many pixels, as exam and ID photo forms
ask for. `fit` decides what happens when the shape differs: `crop` (default)
fills the frame and trims the overflow, `pad` keeps the whole image and adds
a white border.

**Units:** KB and MB are 1000-based, so a `200KB` target aims under 200,000
bytes and passes whichever way the destination counts.

**Limits:** uploads up to 25 MB; per client, 30 uploads and 100 compressions
an hour (`GET /api/limits` shows what is left; a refusal is `429` with
`Retry-After`). Accepted types: PDF, JPEG, PNG, WebP, TIFF, BMP.

**Retention:** the original is deleted 5 minutes after a run finishes, the
result 10 minutes after; `DELETE /api/jobs/{job_id}` removes both at once.
Files are used for nothing else. Website: https://fitfilesize.com
"""

# SSE timing. The ping keeps proxies and load balancers from reaping a stream
# that has gone quiet mid-run; many drop idle connections at 30-60s.
EVENT_POLL_INTERVAL = 0.4
PING_INTERVAL = 15.0

ACCEPTED_SUFFIXES = PDF_SUFFIXES | IMAGE_SUFFIXES

MEDIA_TYPES = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".bmp": "image/bmp",
}


Fit = Literal["crop", "pad"]

PIXELS = Field(None, ge=1, le=MAX_RESIZE_EDGE)


class CompressRequest(BaseModel):
    target_bytes: int = Field(gt=0)
    width: int | None = PIXELS
    height: int | None = PIXELS
    fit: Fit = "crop"
    prepare: bool = Field(
        False,
        description="Start the run ahead of time, before the visitor has confirmed "
        "the size. A later request with the same settings adopts it; one with "
        "different settings replaces it.",
    )


def run_params(target_bytes: int, resize: tuple[int, int] | None, fit: str) -> str:
    """What a run was asked for, to tell whether a head-start matches."""
    return json.dumps([target_bytes, list(resize) if resize else None, fit if resize else None])


def resize_for(job: dict, width: int | None, height: int | None) -> tuple[int, int] | None:
    """The exact size a run asks for, or None. Refuses what cannot be done."""
    if width is None and height is None:
        return None
    if width is None or height is None:
        raise HTTPException(422, "give both width and height, or neither")
    if job.get("kind") != "image":
        raise HTTPException(422, "width and height apply to images only, not PDFs")
    return (width, height)


def _limit_headers(quota: limits.Quota) -> dict[str, str]:
    headers = {
        "X-RateLimit-Limit": str(quota.limit),
        "X-RateLimit-Remaining": str(quota.remaining),
        "X-RateLimit-Reset": str(quota.reset_in),
    }
    if quota.exceeded:
        headers["Retry-After"] = str(quota.reset_in)
    return headers


def _limit_message(limit: int, noun: str, quota: limits.Quota) -> str:
    minutes = max(1, -(-quota.reset_in // 60))
    return (
        f"You have reached the limit of {limit} {noun} an hour. "
        f"Try again in {minutes} minute{'s' if minutes != 1 else ''}."
    )


def remove_tree(path: Path, attempts: int = 3) -> bool:
    """Delete a job directory, reporting whether it actually went.

    shutil.rmtree(ignore_errors=True) on its own is not good enough here. On
    Windows a virus scanner or the search indexer can hold a handle open for a
    moment and the delete fails silently, which for this service means a user's
    upload outliving the retention promise with nothing logged. Retry briefly,
    and tell the caller the truth either way so the next sweep can try again.
    """
    for attempt in range(attempts):
        shutil.rmtree(path, ignore_errors=True)
        if not path.exists():
            return True
        time.sleep(0.05 * (attempt + 1))
    return not path.exists()


def sweep_expired(data_dir: Path, settings: "Settings", r) -> int:
    """Delete expired job dirs plus their Redis keys. Returns dirs removed.

    Two clocks, because a job's risk profile changes once it finishes:

    * Finished jobs expire at completion + ttl_seconds, so the download window
      is the same length for everyone. Their input.pdf is unlinked earlier, at
      completion + input_grace_seconds, since the original upload is the
      sensitive half and is only needed for "try another size".
    * Unfinished jobs expire at upload + pending_ttl_seconds, which has to stay
      above the queue's per-job timeout or this would delete files out from
      under a running compression.
    """
    if not data_dir.exists():
        return 0
    removed = 0
    now = time.time()
    for d in data_dir.iterdir():
        if not d.is_dir():
            continue

        job = store.get_job(r, d.name)
        if job is None:
            # No Redis record: an orphan from a crash or a flushed store. Fall
            # back to filesystem age so these cannot accumulate forever.
            stamp = _oldest_mtime(d)
            if stamp is None:
                continue  # removed while we looked (a Delete now, or another sweep)
            if now - stamp > settings.pending_ttl_seconds and remove_tree(d):
                removed += 1
            continue

        completed_at = int(job["completed_at"]) if "completed_at" in job else None
        if completed_at is None:
            expire_at = int(job.get("created_at", "0")) + settings.pending_ttl_seconds
        else:
            expire_at = completed_at + settings.ttl_seconds
            if now - completed_at > settings.input_grace_seconds:
                for src in d.glob("input.*"):
                    src.unlink(missing_ok=True)

        if now > expire_at and remove_tree(d):
            # Only forget the job once its files are actually gone, so a failed
            # delete stays visible to the next sweep instead of becoming an
            # orphan we have less information about.
            store.delete_job(r, d.name)
            removed += 1
    return removed


def _oldest_mtime(d: Path) -> float | None:
    """Oldest modification time in a job directory, or None if it vanished.

    Directories disappear under the sweep whenever a visitor clicks Delete now
    or a second sweep runs, and an uncaught FileNotFoundError here would
    abandon the whole pass, leaving every later directory unswept that minute.
    """
    try:
        stamp = d.stat().st_mtime
        for f in d.iterdir():
            stamp = min(stamp, f.stat().st_mtime)
    except FileNotFoundError:
        return None
    return stamp


def stale_after(settings: "Settings") -> int:
    """Seconds of silence after which a compressing job is taken to be dead.

    A live run reports progress at least once per Ghostscript attempt, and
    each attempt is killed at gs_timeout, so twice that plus a minute of slack
    is comfortably longer than any real gap.
    """
    return settings.gs_timeout * 2 + 60


def recover_interrupted(data_dir: Path, settings: "Settings", r) -> int:
    """Fail unfinished jobs that a restart has orphaned. Returns jobs failed.

    Two ways a restart strands a job. Its upload can be gone, because the new
    server started from an empty disk (Render's free tier has no persistent
    disk). Or its run can be dead, because the worker was killed mid-job and
    nothing will ever report on it again. Either way the job would otherwise
    sit on "Working on it" until its pending TTL, 30 minutes by default, ran
    out. Failing it sends an error event, so the visitor is told within a
    minute and can upload again.
    """
    now = time.time()
    failed = 0
    for job_id in store.active_job_ids(r):
        job = store.get_job(r, job_id)
        if job is None:
            continue  # expired or deleted between the scan and the read
        has_input = any((data_dir / job_id).glob("input.*"))
        dead_run = (
            job.get("status") == "compressing"
            and now - int(job.get("progress_at", job.get("created_at", "0"))) > stale_after(settings)
        )
        if not has_input or dead_run:
            store.fail_job(
                r, job_id, store.RESTARTED_MESSAGE, settings.ttl_seconds, settings.pending_ttl_seconds
            )
            failed += 1
    return failed


def create_app(
    settings: Settings | None = None,
    redis_conn=None,
    queue=None,
    *,
    prepare_queue=None,
    background_sweep: bool = True,
    worker_grace: float = WORKER_GRACE_SECONDS,
) -> FastAPI:
    """Build the API. background_sweep=False skips the once-a-minute sweep and
    recovery loop; tests turn it off and call those functions directly, since
    a loop racing the test's own calls makes results depend on timing.
    worker_grace is how long after start /health waits for a worker to
    register before counting its absence (see health())."""
    settings = settings or Settings.from_env()
    started = time.monotonic()

    if redis_conn is None:
        if settings.inline:
            import fakeredis

            redis_conn = fakeredis.FakeRedis()
        else:
            redis_conn = store.connect(settings.redis_url)
    r = redis_conn

    if queue is None:
        from rq import Queue

        queue = Queue(settings.queue_name, connection=r, is_async=not settings.inline)
    q = queue
    # Head-start runs wait on their own queue, which the worker only reads
    # when the main one is empty: one visitor's guess never holds up another
    # visitor's Compress. Same connection and mode as the main queue.
    if prepare_queue is None:
        from rq import Queue

        prepare_queue = Queue(
            settings.prepare_queue_name, connection=q.connection, is_async=q._is_async
        )
    pq = prepare_queue

    settings.data_dir.mkdir(parents=True, exist_ok=True)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async def sweep_loop():
            while True:
                # Recovery first: it runs on the first pass after startup, which
                # is exactly when a deploy has just orphaned jobs.
                try:
                    await run_in_threadpool(recover_interrupted, settings.data_dir, settings, r)
                except Exception:
                    pass
                try:
                    await run_in_threadpool(sweep_expired, settings.data_dir, settings, r)
                except Exception:
                    pass
                await asyncio.sleep(SWEEP_INTERVAL)

        task = asyncio.create_task(sweep_loop()) if background_sweep else None
        yield
        if task is not None:
            task.cancel()

    app = FastAPI(
        title="FitFileSize API",
        version="1.0.0",
        description=API_DESCRIPTION,
        lifespan=lifespan,
    )

    # Registered before CORS so CORS wraps it: a refusal from here still gets
    # the Access-Control headers, and the browser can show its message.
    import redis as _redis

    @app.exception_handler(_redis.ConnectionError)
    @app.exception_handler(_redis.TimeoutError)
    async def redis_unavailable(request: Request, exc: Exception):
        # The client already retried with backoff (store.connect); Redis is
        # really away. A 503 tells the page to retry, where a bare 500 reads
        # as broken for good.
        return JSONResponse(
            {"detail": "the server is busy for a moment; try again"}, status_code=503
        )

    @app.middleware("http")
    async def limit_uploads(request: Request, call_next):
        """Refuse over-budget uploads before their body is read.

        FastAPI parses a multipart form before the endpoint runs, so a check
        inside upload() would still accept the whole file, up to the size
        limit, on every refused attempt. Here the body is never touched.
        """
        limit = settings.uploads_per_hour
        if request.method != "POST" or request.url.path not in UPLOAD_PATHS or limit <= 0:
            return await call_next(request)
        quota = limits.hit(
            r, "uploads", limits.client_key(request, settings.client_ip_headers), limit
        )
        if quota.exceeded:
            return JSONResponse(
                {"detail": _limit_message(limit, "files", quota)},
                status_code=429,
                headers=_limit_headers(quota),
            )
        response = await call_next(request)
        response.headers.update(_limit_headers(quota))
        return response

    if settings.allowed_origins:
        from fastapi.middleware.cors import CORSMiddleware

        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.allowed_origins),
            allow_methods=["GET", "POST", "DELETE"],
            allow_headers=["*"],
        )

    def worker_alive() -> bool:
        """Whether a worker is registered on the main queue.

        RQ keeps a worker's registration alive with heartbeats and lets it
        expire when they stop (worker.WORKER_TTL), so a hung or dead worker
        drops out of Worker.all() within about two minutes.
        """
        if settings.inline:
            return True  # runs happen in the API process; there is no worker
        from rq import Worker

        return any(settings.queue_name in w.queue_names() for w in Worker.all(connection=r))

    @app.get(
        "/health",
        summary="Health check",
        responses={503: {"description": "Redis or the worker is not working."}},
    )
    async def health(response: Response):
        """Whether the service can take and finish work.

        Render restarts the container when this keeps failing, and holds a
        new deploy back from traffic until it passes, so a stuck worker or a
        lost Redis connection mends itself; UptimeRobot, which polls it,
        emails when it does not. A worker gets `worker_grace` seconds after
        start to register before its absence counts, so a deploy is not
        refused for booting.
        """

        def check() -> dict:
            try:
                if not r.ping():
                    raise ConnectionError("no PONG")
            except Exception:
                return {"ok": False, "redis": False, "worker": False}
            try:
                worker_ok = worker_alive()
            except Exception:
                worker_ok = False
            booting = not worker_ok and time.monotonic() - started < worker_grace
            return {"ok": worker_ok or booting, "redis": True, "worker": worker_ok}

        try:
            # Quick either way: the Redis client retries with backoff, which
            # suits requests but would leave a health check hanging while
            # Redis is away, and a slow answer says less than a 503.
            state = await asyncio.wait_for(run_in_threadpool(check), HEALTH_TIMEOUT)
        except TimeoutError:
            state = {"ok": False, "redis": False, "worker": False}
        if not state["ok"]:
            response.status_code = 503
        return state

    # HEAD as well: uptime monitors (UptimeRobot by default) probe with HEAD,
    # and a 405 there reads as the service being down. Kept out of the OpenAPI
    # schema, where a second operation on the same function would repeat its
    # operation id and break strict client generators.
    app.add_api_route("/health", health, methods=["HEAD"], include_in_schema=False)

    def enforce(request: Request, response: Response, bucket: str, limit: int, noun: str):
        """Count this request against the visitor's hourly budget, or refuse it."""
        if limit <= 0:
            return
        quota = limits.hit(r, bucket, limits.client_key(request, settings.client_ip_headers), limit)
        if quota.exceeded:
            raise HTTPException(429, _limit_message(limit, noun, quota), headers=_limit_headers(quota))
        response.headers.update(_limit_headers(quota))

    @app.get("/api/limits")
    async def get_limits(request: Request):
        """The caller's remaining budget, without spending any of it, and the
        largest file the server takes.

        `files` lets a page refuse a file before uploading it: the upload
        size cap, and the pixel caps for images (JPEG, and every other
        format). The server checks both again on upload.
        """
        client = limits.client_key(request, settings.client_ip_headers)
        out: dict = {
            "files": {
                "max_bytes": settings.max_upload_bytes,
                "max_pixels": {
                    "jpeg": MAX_IMAGE_PIXELS["JPEG"],
                    "other": MAX_OTHER_IMAGE_PIXELS,
                },
            }
        }
        for bucket, limit in (("uploads", settings.uploads_per_hour), ("runs", settings.runs_per_hour)):
            if limit > 0:
                q = limits.peek(r, bucket, client, limit)
                out[bucket] = {"limit": q.limit, "remaining": q.remaining, "reset_in": q.reset_in}
        return out

    def job_dir(job_id: str) -> Path:
        return settings.data_dir / job_id

    def input_path(job_id: str) -> Path | None:
        """The stored upload, whatever extension it came in with."""
        return next(iter(sorted(job_dir(job_id).glob("input.*"))), None)

    def require_input(job_id: str, job: dict) -> Path:
        src = input_path(job_id)
        if src is None:
            # A finished job's original is removed on schedule; an unfinished
            # one only loses it to a restart.
            if "completed_at" in job and job.get("error") != store.RESTARTED_MESSAGE:
                raise HTTPException(410, "stored file is gone (deleted after the run finished)")
            raise HTTPException(410, store.RESTARTED_MESSAGE)
        return src

    def output_path(job_id: str, job: dict) -> Path | None:
        """The current run's result file, if it has one.

        The suffix depends on what the run produced: a lossy image result is
        JPEG even when a PNG went in.
        """
        run_id = job.get("run_id", "")
        return next(iter(sorted(job_dir(job_id).glob(f"output-{run_id}.*"))), None)

    def require_job(job_id: str) -> dict:
        job = store.get_job(r, job_id)
        if job is None:
            raise HTTPException(404, "job not found (it may have expired)")
        return job

    def job_state(job_id: str, job: dict) -> dict:
        # Mirrors sweep_expired: finished jobs count down from completion,
        # unfinished ones from upload.
        if "completed_at" in job:
            expires_at = int(job["completed_at"]) + settings.ttl_seconds
        else:
            expires_at = int(job.get("created_at", "0")) + settings.pending_ttl_seconds
        state = {
            "job_id": job_id,
            "status": job.get("status", "unknown"),
            "kind": job.get("kind", "pdf"),
            "filename": job.get("filename", "input.pdf"),
            "size_bytes": int(job.get("size_bytes", "0")),
            "pages": int(job.get("pages", "0")),
            "expires_in": max(0, expires_at - int(time.time())),
        }
        for key in ("width", "height"):
            if key in job:
                state[key] = int(job[key])
        for key in ("floor_estimate", "target_bytes", "final_bytes", "rungs_tried"):
            if key in job:
                state[key] = int(job[key])
        if "hit_target" in job:
            state["hit_target"] = job["hit_target"] == "1"
        if "method" in job:
            state["method"] = job["method"]
        if "error" in job:
            state["error"] = job["error"]
        if "warnings" in job:
            state["warnings"] = json.loads(job["warnings"])
        return state

    async def receive_upload(file: UploadFile) -> tuple[str, str, int, object]:
        """Store an upload and create its job. Returns (job_id, filename, size, info).

        Shared by /api/upload and /api/fit. Rate limiting happens earlier, in
        the limit_uploads middleware, before the body is read.
        """
        filename = file.filename or "input"
        # Keep the uploader's extension so detect_strategy can use it, but never
        # trust it as a path: only a known suffix is allowed through.
        suffix = Path(filename).suffix.lower()
        if suffix not in ACCEPTED_SUFFIXES:
            raise HTTPException(
                415,
                "unsupported file type; upload a PDF or an image "
                "(JPEG, PNG, WebP, TIFF, BMP)",
            )

        # Out of disk, an upload fails halfway with a raw error. Clear expired
        # jobs now rather than at the next sweep, and if that is not enough,
        # say so before reading the file.
        needed = max(MIN_FREE_BYTES, 4 * settings.max_upload_bytes)
        if shutil.disk_usage(settings.data_dir).free < needed:
            await run_in_threadpool(sweep_expired, settings.data_dir, settings, r)
            if shutil.disk_usage(settings.data_dir).free < needed:
                raise HTTPException(
                    503, "the server is short on space right now; try again in a minute"
                )

        job_id = store.new_job_id()
        d = job_dir(job_id)
        d.mkdir(parents=True)
        dest = d / f"input{suffix}"
        size = 0
        try:
            with dest.open("wb") as f:
                while chunk := await file.read(UPLOAD_CHUNK):
                    size += len(chunk)
                    if size > settings.max_upload_bytes:
                        raise HTTPException(
                            413,
                            f"file is over the {human_size(settings.max_upload_bytes)} "
                            "upload limit",
                        )
                    f.write(chunk)
            if size == 0:
                raise HTTPException(400, "empty upload")
            # Past these, a run would need more memory than the server has
            # and be killed partway; refuse it up front with the reason.
            # Before analyze, which cannot open the very largest images.
            if suffix in IMAGE_SUFFIXES and (reason := image_too_big(dest)):
                raise HTTPException(422, reason)
            try:
                info = await run_in_threadpool(analyze, dest)
            except Exception:
                raise HTTPException(
                    422, "that file is not a readable PDF or image"
                ) from None
            if info.encrypted:
                raise HTTPException(
                    422, "this PDF is password protected; remove the password first"
                )
        except HTTPException:
            remove_tree(d)
            raise

        store.create_job(
            r,
            job_id,
            {
                "status": "uploaded",
                "kind": info.kind,
                "filename": filename,
                "size_bytes": size,
                "pages": info.pages,
                "width": info.width,
                "height": info.height,
            },
            settings.pending_ttl_seconds,
        )
        return job_id, filename, size, info

    @app.post("/api/upload", summary="Upload a file (step 1 of the step-by-step flow)")
    async def upload(file: UploadFile):
        """Store a PDF or image and return its job id plus basic facts about it."""
        job_id, filename, size, info = await receive_upload(file)
        return {
            "job_id": job_id,
            "kind": info.kind,
            "filename": filename,
            "size_bytes": size,
            "pages": info.pages,
            "width": info.width,
            "height": info.height,
            "image_share": round(info.image_share, 3),
            "has_forms": info.has_forms,
            # Nothing has finished yet, so the live window is the pending one.
            "expires_in": settings.pending_ttl_seconds,
        }

    @app.post("/api/jobs/{job_id}/analyze")
    async def analyze_job(job_id: str, request: Request, response: Response):
        job = require_job(job_id)
        src = require_input(job_id, job)
        enforce(request, response, "runs", settings.runs_per_hour, "compressions")
        # The floor render is kept next to the upload: the compression run
        # reuses it as its harshest rung instead of rendering it again.
        floor = await run_in_threadpool(
            estimate_floor, src, timeout=settings.gs_timeout, keep=job_dir(job_id) / "floor"
        )
        store.update_job(r, job_id, floor_estimate=floor, status="analyzed")
        return {
            "job_id": job_id,
            "original_bytes": int(job["size_bytes"]),
            "floor_estimate": floor,
        }

    @app.post("/api/jobs/{job_id}/compress", status_code=202)
    async def compress(job_id: str, req: CompressRequest, request: Request, response: Response):
        """Queue a run, or with `prepare`, start one ahead of time.

        The page sends a `prepare` run as soon as the file is read, for the
        size picked before upload (a landing page's size or a chip), so the
        work happens while the visitor looks at the size picker. Their
        Compress then adopts that run if the settings match, and replaces it
        if not: the old run stops at its next step (see jobs.run_compress).
        """
        job = require_job(job_id)
        resize = resize_for(job, req.width, req.height)
        params = run_params(req.target_bytes, resize, req.fit)
        head_start = job.get("prepared") == "1"
        running = job.get("status") in ("queued", "compressing")

        if req.prepare:
            # Only ahead of a first run: never over one the visitor asked for.
            if job.get("status") not in ("uploaded", "analyzed"):
                raise HTTPException(409, "this file already has a compression run")
        elif head_start:
            same = job.get("run_params") == params
            if same and job.get("status") == "queued":
                # Still waiting on the low-priority queue: requeue it as a
                # real run so it is not stuck behind other visitors' runs.
                # Nothing had started, so nothing is lost, and the budget was
                # already spent on the head-start.
                queue_run(job_id, require_input(job_id, job), req.target_bytes, resize, req.fit)
                return {"job_id": job_id, "status": "queued"}
            done_ok = job.get("status") == "done" and output_path(job_id, job) is not None
            if same and (running or done_ok):
                if store.adopt(r, job_id, settings.ttl_seconds):
                    return {"job_id": job_id, "status": "queued"}
            # Different settings (or a head-start that failed): replace it.
        elif running:
            raise HTTPException(409, "a compression run is already in progress for this file")

        src = require_input(job_id, job)
        enforce(request, response, "runs", settings.runs_per_hour, "compressions")
        queue_run(job_id, src, req.target_bytes, resize, req.fit, prepared=req.prepare)
        return {"job_id": job_id, "status": "queued"}

    def queue_run(
        job_id: str,
        src: Path,
        target_bytes: int,
        resize: tuple[int, int] | None = None,
        fit: str = "crop",
        prepared: bool = False,
    ) -> None:
        """Reset a job for a fresh run and put it on the worker queue."""
        # The new run id goes in first: from this write on, any earlier run of
        # this job is superseded and its writes land nowhere.
        run_id = store.new_run_id()
        store.update_job(
            r,
            job_id,
            run_id=run_id,
            status="queued",
            target_bytes=target_bytes,
            prepared="1" if prepared else "0",
            run_params=run_params(target_bytes, resize, fit),
        )
        # No suffix: compress_to_target picks the right one for what it produced
        # (a lossy image result is always JPEG) and reports it back. Named for
        # the run, so a superseded run finishing late can never have its file
        # served as this one's.
        dst = job_dir(job_id) / f"output-{run_id}"
        for stale in job_dir(job_id).glob("output*"):
            stale.unlink(missing_ok=True)
        store.clear_events(r, job_id)
        # A re-run ("try another size") is no longer a finished job, so drop the
        # completion stamp and put the key back on the pending clock.
        store.clear_completion(r, job_id, settings.pending_ttl_seconds)
        (pq if prepared else q).enqueue(
            run_compress,
            job_id,
            str(src),
            str(dst),
            target_bytes,
            settings.ttl_seconds,
            settings.pending_ttl_seconds,
            settings.gs_timeout,
            resize,
            fit,
            run_id=run_id,  # by name: the worker's killed-run handler reads it
            job_timeout=settings.gs_timeout * 8 + 120,
            result_ttl=settings.ttl_seconds,
            failure_ttl=settings.ttl_seconds,
        )

    def public_url(request: Request, path: str) -> str:
        """Absolute URL for a path on this API, as the client reached it.

        Behind a proxy the socket sees plain HTTP, so the scheme comes from
        X-Forwarded-Proto when the proxy sets it.
        """
        scheme = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0]
        host = request.headers.get("host", request.url.netloc)
        return f"{scheme}://{host}{path}"

    @app.post(
        "/api/fit",
        summary="Compress a file to fit a size limit, in one call",
        responses={
            202: {"description": "Still compressing; poll status_url."},
            422: {"description": "Unreadable file, bad target, or the run failed."},
            429: {"description": "Hourly limit reached; see Retry-After."},
        },
    )
    async def fit(
        request: Request,
        response: Response,
        file: UploadFile,
        target: str = Form(
            ...,
            description="The limit to fit under, like 200KB, 1.5MB or 200000 (bytes). "
            "KB and MB are 1000-based.",
        ),
        width: int | None = Form(
            None, ge=1, le=MAX_RESIZE_EDGE, description="Exact width in pixels (images only)."
        ),
        height: int | None = Form(
            None, ge=1, le=MAX_RESIZE_EDGE, description="Exact height in pixels (images only)."
        ),
        fit: Literal["crop", "pad"] = Form(
            "crop",
            description="When the shape differs: crop to fill, or pad with a white border.",
        ),
    ):
        """Upload a file and compress it to fit under `target`.

        Waits for the result (usually a few seconds) and returns a
        `download_url`. If the run takes longer than about 80 seconds, answers
        `202` with a `status_url` to poll instead; the job keeps going. When
        `fits` is false, the file could not get that small and the result is
        the smallest version that could be made.
        """
        try:
            target_bytes = parse_limit(target)
        except ValueError as e:
            raise HTTPException(422, str(e)) from None
        job_id, _, _, _ = await receive_upload(file)
        job = require_job(job_id)
        try:
            resize = resize_for(job, width, height)
        except HTTPException:
            # The upload is useless without a run; do not leave it waiting.
            store.delete_job(r, job_id)
            remove_tree(job_dir(job_id))
            raise
        enforce(request, response, "runs", settings.runs_per_hour, "compressions")
        queue_run(job_id, require_input(job_id, job), target_bytes, resize, fit)

        waited = 0.0
        job = store.get_job(r, job_id) or {}
        while job.get("status") not in store.TERMINAL_STATUSES and waited < FIT_WAIT_SECONDS:
            await asyncio.sleep(FIT_POLL_INTERVAL)
            waited += FIT_POLL_INTERVAL
            job = store.get_job(r, job_id) or {}

        status_path = f"/api/jobs/{job_id}"
        if job.get("status") == "error":
            raise HTTPException(422, job.get("error", "compression failed"))
        if job.get("status") != "done":
            response.status_code = 202
            return {
                "job_id": job_id,
                "status": job.get("status", "queued"),
                "status_url": public_url(request, status_path),
                "download_url": public_url(request, f"{status_path}/download"),
                "message": "Still compressing. Poll status_url until status is done "
                "(or error), then fetch download_url.",
            }
        state = job_state(job_id, job)
        return {
            "job_id": job_id,
            "status": "done",
            "fits": state.get("hit_target", False),
            "original_bytes": state["size_bytes"],
            "final_bytes": state.get("final_bytes"),
            "target_bytes": target_bytes,
            "download_url": public_url(request, f"{status_path}/download"),
            "expires_in": state["expires_in"],
            "warnings": state.get("warnings", []),
        }

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: str):
        return job_state(job_id, require_job(job_id))

    @app.get("/api/jobs/{job_id}/events")
    async def events(job_id: str):
        require_job(job_id)

        async def stream():
            job = store.get_job(r, job_id)
            yield f"event: state\ndata: {json.dumps(job_state(job_id, job))}\n\n"
            idx = 0
            # Measured against the clock rather than summed from sleep
            # intervals: 0.4s steps never land exactly on a multiple of the
            # ping interval, and float drift made the first ping arrive at 90s.
            last_event = last_write = time.monotonic()
            while time.monotonic() - last_event < settings.ttl_seconds:
                new = await run_in_threadpool(store.get_events, r, job_id, idx)
                for ev in new:
                    idx += 1
                    yield f"data: {json.dumps(ev)}\n\n"
                    if ev.get("stage") in ("done", "error"):
                        return
                job = store.get_job(r, job_id)
                if job is None:
                    return
                if job.get("status") in store.TERMINAL_STATUSES:
                    # terminal but no done event left to replay (list expired)
                    yield f"event: state\ndata: {json.dumps(job_state(job_id, job))}\n\n"
                    return
                now = time.monotonic()
                if new:
                    last_event = last_write = now
                elif now - last_write >= PING_INTERVAL:
                    yield ": ping\n\n"
                    last_write = now
                await asyncio.sleep(EVENT_POLL_INTERVAL)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/api/jobs/{job_id}/download")
    async def download(job_id: str):
        job = require_job(job_id)
        out = output_path(job_id, job)
        if out is None:
            raise HTTPException(404, "no compressed file yet for this job")
        stem = Path(job.get("filename", "input")).stem or "output"
        return FileResponse(
            out,
            media_type=MEDIA_TYPES.get(out.suffix.lower(), "application/octet-stream"),
            filename=f"{stem}.fit{out.suffix}",
        )

    @app.delete("/api/jobs/{job_id}")
    async def delete(job_id: str):
        require_job(job_id)
        remove_tree(job_dir(job_id))
        store.delete_job(r, job_id)
        return {"job_id": job_id, "deleted": True}

    return app
