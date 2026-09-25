"""The RQ job that runs on the worker. Publishes progress as it climbs the ladder."""

import json
from pathlib import Path

from rq import get_current_job

from ..engine import compress_to_target
from ..strategies import ImageStrategy, detect_strategy
from . import store


def _floor_render(src: Path) -> dict[int, Path] | None:
    """The analyze step's harshest-rung render, keyed by its rung index.

    Only for the default ladder: an exact-size run renders a different picture
    at every rung, so the floor render says nothing about it.
    """
    floors = sorted(src.parent.glob("floor.*"))
    if not floors:
        return None
    return {len(detect_strategy(src).rungs) - 1: floors[0]}


def run_compress(
    job_id: str,
    src: str,
    dst: str,
    target_bytes: int,
    ttl: int,
    pending_ttl: int,
    gs_timeout: int,
    resize: tuple[int, int] | None = None,
    fit: str = "crop",
) -> None:
    rq_job = get_current_job()
    if rq_job is None:
        raise RuntimeError("run_compress must be executed through an RQ queue")
    r = rq_job.connection

    # In-flight events carry the pending TTL, not the (much shorter) completion
    # TTL: a long run would otherwise expire its own event list mid-job and
    # break SSE replay for anyone who reconnects. mark_completed resets both
    # keys to the short TTL once the job lands.
    # Queued on a server that has since restarted: the job survived in Redis
    # but its upload did not survive on disk. Say so plainly, rather than
    # letting the engine fail with a raw "No such file or directory".
    if not Path(src).exists():
        store.fail_job(r, job_id, store.RESTARTED_MESSAGE, ttl, pending_ttl)
        return

    store.update_job(r, job_id, status="compressing")
    store.touch_progress(r, job_id)
    store.push_event(r, job_id, {"stage": "start", "target_bytes": target_bytes}, pending_ttl)

    def on_progress(event: dict) -> None:
        try:
            store.push_event(r, job_id, event, pending_ttl)
            store.touch_progress(r, job_id)
        except Exception:
            pass  # progress is best-effort; never kill the compression over it

    try:
        # The API only accepts a resize for images, so no PDF gets here with one.
        strategy = ImageStrategy(resize=tuple(resize), fit=fit) if resize else None
        result = compress_to_target(
            Path(src),
            Path(dst),
            target_bytes,
            timeout=gs_timeout,
            on_progress=on_progress,
            strategy=strategy,
            prerendered=_floor_render(Path(src)) if strategy is None else None,
        )
    except Exception as e:
        store.update_job(r, job_id, status="error", error=str(e), completed_at=store.now_stamp())
        store.push_event(r, job_id, {"stage": "error", "message": str(e)}, pending_ttl)
        store.mark_completed(r, job_id, ttl)
        raise

    store.update_job(
        r,
        job_id,
        status="done",
        # In the same write as the status, so nobody reads "done" without a
        # completion time (see store.fail_job). mark_completed below restamps
        # it and resets the key TTLs.
        completed_at=store.now_stamp(),
        hit_target=int(result.hit_target),
        final_bytes=result.final_bytes,
        target_bytes=target_bytes,
        method=result.method,
        rungs_tried=result.rungs_tried,
        warnings=json.dumps(result.warnings),
    )
    store.push_event(
        r,
        job_id,
        {
            "stage": "done",
            "hit_target": result.hit_target,
            "final_bytes": result.final_bytes,
            "original_bytes": result.original_bytes,
            "target_bytes": target_bytes,
            "method": result.method,
            "warnings": result.warnings,
        },
        pending_ttl,
    )
    store.mark_completed(r, job_id, ttl)
