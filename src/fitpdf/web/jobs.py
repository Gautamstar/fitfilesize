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
    run_id: str = "",
    min_bytes: int | None = None,
    focus: tuple[float, float] | None = None,
) -> None:
    rq_job = get_current_job()
    if rq_job is None:
        raise RuntimeError("run_compress must be executed through an RQ queue")
    r = rq_job.connection

    # Every write checks this is still the job's current run (store.run_write).
    # A replaced run, a head-start whose size the visitor changed, or a job
    # deleted meanwhile, stops at its next step and writes nothing more.
    # In-flight events carry the pending TTL, not the (much shorter)
    # completion TTL: a long run would otherwise expire its own event list
    # mid-job and break SSE replay for anyone who reconnects. The finishing
    # write resets both keys to the short TTL.
    def write(fields: dict | None = None, event: dict | None = None, *, done: bool = False) -> None:
        store.run_write(
            r, job_id, run_id, fields, event,
            pending_ttl=pending_ttl, complete_ttl=ttl if done else None,
        )

    try:
        # Queued on a server that has since restarted: the job survived in
        # Redis but its upload did not survive on disk. Say so plainly, rather
        # than letting the engine fail with a raw "No such file or directory".
        if not Path(src).exists():
            message = store.RESTARTED_MESSAGE
            write({"status": "error", "error": message}, {"stage": "error", "message": message}, done=True)
            return

        write({"status": "compressing", "progress_at": store.now_stamp()},
              {"stage": "start", "target_bytes": target_bytes})

        def on_progress(event: dict) -> None:
            try:
                write({"progress_at": store.now_stamp()}, event)
            except store.Superseded:
                raise  # ends the run between steps
            except Exception:
                pass  # progress is best-effort; never kill the compression over it

        try:
            # The API only accepts a resize for images, so no PDF gets here with one.
            strategy = (
                ImageStrategy(resize=tuple(resize), fit=fit, focus=tuple(focus) if focus else None)
                if resize
                else None
            )
            result = compress_to_target(
                Path(src),
                Path(dst),
                target_bytes,
                timeout=gs_timeout,
                on_progress=on_progress,
                strategy=strategy,
                prerendered=_floor_render(Path(src)) if strategy is None else None,
                min_bytes=min_bytes,
            )
        except store.Superseded:
            raise
        except Exception as e:
            write({"status": "error", "error": str(e)}, {"stage": "error", "message": str(e)}, done=True)
            raise

        write(
            # One write with the status, so nobody reads "done" without its
            # results or (once asked for) its completion time.
            {
                "status": "done",
                "hit_target": int(result.hit_target),
                "final_bytes": result.final_bytes,
                "target_bytes": target_bytes,
                "method": result.method,
                "rungs_tried": result.rungs_tried,
                "warnings": json.dumps(result.warnings),
            },
            {
                "stage": "done",
                "hit_target": result.hit_target,
                "final_bytes": result.final_bytes,
                "original_bytes": result.original_bytes,
                "target_bytes": target_bytes,
                "method": result.method,
                "warnings": result.warnings,
                # The deletion clock restarts at completion (or, for a
                # head-start, when the visitor adopts it). The page opened its
                # stream while the job was pending and read the 30-minute
                # pending window then, so it needs the real one here.
                "expires_in": ttl,
            },
            done=True,
        )
    except store.Superseded:
        # Not an error: someone asked for a different run, or deleted the job.
        return
