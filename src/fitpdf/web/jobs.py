"""The RQ job that runs on the worker. Publishes progress as it climbs the ladder."""

import json
from pathlib import Path

from rq import get_current_job

from ..engine import compress_to_target
from . import store


def run_compress(
    job_id: str,
    src: str,
    dst: str,
    target_bytes: int,
    ttl: int,
    gs_timeout: int,
) -> None:
    rq_job = get_current_job()
    if rq_job is None:
        raise RuntimeError("run_compress must be executed through an RQ queue")
    r = rq_job.connection

    store.update_job(r, job_id, status="compressing")
    store.push_event(r, job_id, {"stage": "start", "target_bytes": target_bytes}, ttl)

    def on_progress(event: dict) -> None:
        try:
            store.push_event(r, job_id, event, ttl)
        except Exception:
            pass  # progress is best-effort; never kill the compression over it

    try:
        result = compress_to_target(
            Path(src), Path(dst), target_bytes, timeout=gs_timeout, on_progress=on_progress
        )
    except Exception as e:
        store.update_job(r, job_id, status="error", error=str(e))
        store.push_event(r, job_id, {"stage": "error", "message": str(e)}, ttl)
        raise

    store.update_job(
        r,
        job_id,
        status="done",
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
        ttl,
    )
