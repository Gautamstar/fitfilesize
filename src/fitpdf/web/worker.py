"""Worker entry point: python -m fitpdf.web.worker

Uses the standard forking Worker on Linux (Docker). On Windows, where fork is
unavailable, falls back to SimpleWorker with timer-based job timeouts.
"""

import sys

from rq import Queue, SimpleWorker, Worker
from rq.timeouts import TimerDeathPenalty

from . import store
from .config import Settings

# How long the worker's registration lives without a heartbeat. RQ refreshes
# it at least every WORKER_TTL - 15 seconds while idle, and while a job runs,
# and it expires WORKER_TTL + 60 seconds after the last one. /health reads
# it: a worker that hangs drops out within about two minutes, and Render
# restarts the container. RQ's default (420 s) would take nine.
WORKER_TTL = 60


class WindowsWorker(SimpleWorker):
    death_penalty_class = TimerDeathPenalty


def queues(settings: Settings, conn) -> list[Queue]:
    """The queues to work, highest priority first.

    RQ checks them in this order for every job it takes, so a run a visitor
    asked for always starts before a waiting head-start run. A head-start
    already running is not interrupted; it stops at its next step only if
    its own visitor picks another size.
    """
    return [
        Queue(settings.queue_name, connection=conn),
        Queue(settings.prepare_queue_name, connection=conn),
    ]


def killed_handler(settings: Settings, conn):
    """Report a run whose process was killed, at once.

    A run killed by a signal (the operating system ending it for using too
    much memory, in practice) never gets to write its own error, and the page
    would wait until the sweeper noticed the silence, five minutes or more.
    RQ calls this in the worker as soon as the run's process dies. The write
    goes through store.run_write, so it only lands if that run is still the
    job's current one.
    """

    def handle(job, retpid, ret_val, rusage) -> None:
        if not job.func_name.endswith("run_compress") or not job.args:
            return
        job_id, run_id = job.args[0], job.kwargs.get("run_id", "")
        message = store.KILLED_MESSAGE
        try:
            store.run_write(
                conn, job_id, run_id,
                {"status": "error", "error": message},
                {"stage": "error", "message": message},
                pending_ttl=settings.pending_ttl_seconds,
                complete_ttl=settings.ttl_seconds,
            )
        except store.Superseded:
            pass
        except Exception as e:  # never take the worker down over a report
            print(f"could not report killed run for job {job_id}: {e}")

    return handle


def main() -> int:
    settings = Settings.from_env()
    conn = store.connect(settings.redis_url)
    worker_cls = WindowsWorker if sys.platform == "win32" else Worker
    work = queues(settings, conn)
    names = ", ".join(q.name for q in work)
    print(f"fitpdf worker listening on queues {names} ({settings.redis_url})")
    worker_cls(
        work,
        connection=conn,
        worker_ttl=WORKER_TTL,
        work_horse_killed_handler=killed_handler(settings, conn),
    ).work()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
