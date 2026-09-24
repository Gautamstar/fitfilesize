import asyncio
import json
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..engine import analyze, estimate_floor
from ..strategies import IMAGE_SUFFIXES, PDF_SUFFIXES
from ..units import human_size
from . import store
from .config import Settings
from .jobs import run_compress

SWEEP_INTERVAL = 60
UPLOAD_CHUNK = 1024 * 1024

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


class CompressRequest(BaseModel):
    target_bytes: int = Field(gt=0)


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
            stamp = d.stat().st_mtime
            for f in d.iterdir():
                stamp = min(stamp, f.stat().st_mtime)
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


def create_app(settings: Settings | None = None, redis_conn=None, queue=None) -> FastAPI:
    settings = settings or Settings.from_env()

    if redis_conn is None:
        if settings.inline:
            import fakeredis

            redis_conn = fakeredis.FakeRedis()
        else:
            import redis

            redis_conn = redis.Redis.from_url(settings.redis_url)
    r = redis_conn

    if queue is None:
        from rq import Queue

        queue = Queue(settings.queue_name, connection=r, is_async=not settings.inline)
    q = queue

    settings.data_dir.mkdir(parents=True, exist_ok=True)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async def sweep_loop():
            while True:
                try:
                    await run_in_threadpool(sweep_expired, settings.data_dir, settings, r)
                except Exception:
                    pass
                await asyncio.sleep(SWEEP_INTERVAL)

        task = asyncio.create_task(sweep_loop())
        yield
        task.cancel()

    app = FastAPI(title="FitPDF", lifespan=lifespan)

    if settings.allowed_origins:
        from fastapi.middleware.cors import CORSMiddleware

        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.allowed_origins),
            allow_methods=["GET", "POST", "DELETE"],
            allow_headers=["*"],
        )

    @app.get("/health")
    async def health():
        return {"ok": True}

    def job_dir(job_id: str) -> Path:
        return settings.data_dir / job_id

    def input_path(job_id: str) -> Path | None:
        """The stored upload, whatever extension it came in with."""
        return next(iter(sorted(job_dir(job_id).glob("input.*"))), None)

    def require_input(job_id: str) -> Path:
        src = input_path(job_id)
        if src is None:
            raise HTTPException(410, "stored file is gone (deleted after the run finished)")
        return src

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

    @app.post("/api/upload")
    async def upload(file: UploadFile):
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
    async def analyze_job(job_id: str):
        job = require_job(job_id)
        src = require_input(job_id)
        floor = await run_in_threadpool(estimate_floor, src, timeout=settings.gs_timeout)
        store.update_job(r, job_id, floor_estimate=floor, status="analyzed")
        return {
            "job_id": job_id,
            "original_bytes": int(job["size_bytes"]),
            "floor_estimate": floor,
        }

    @app.post("/api/jobs/{job_id}/compress", status_code=202)
    async def compress(job_id: str, req: CompressRequest):
        job = require_job(job_id)
        if job.get("status") in ("queued", "compressing"):
            raise HTTPException(409, "a compression run is already in progress for this file")
        src = require_input(job_id)
        # No suffix: compress_to_target picks the right one for what it produced
        # (a lossy image result is always JPEG) and reports it back.
        dst = job_dir(job_id) / "output"
        # A previous run may have left an output with a different suffix; clear
        # it so a stale file can never be served as this run's result.
        for stale in job_dir(job_id).glob("output.*"):
            stale.unlink(missing_ok=True)
        store.clear_events(r, job_id)
        # A re-run ("try another size") is no longer a finished job, so drop the
        # completion stamp and put the key back on the pending clock.
        store.clear_completion(r, job_id, settings.pending_ttl_seconds)
        store.update_job(r, job_id, status="queued", target_bytes=req.target_bytes)
        q.enqueue(
            run_compress,
            job_id,
            str(src),
            str(dst),
            req.target_bytes,
            settings.ttl_seconds,
            settings.pending_ttl_seconds,
            settings.gs_timeout,
            job_timeout=settings.gs_timeout * 8 + 120,
            result_ttl=settings.ttl_seconds,
            failure_ttl=settings.ttl_seconds,
        )
        return {"job_id": job_id, "status": "queued"}

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
        # The suffix depends on what the run produced: a lossy image result is
        # JPEG even when a PNG went in.
        out = next(iter(sorted(job_dir(job_id).glob("output.*"))), None)
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
