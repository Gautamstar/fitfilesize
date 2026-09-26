"""Worker entry point: python -m fitpdf.web.worker

Uses the standard forking Worker on Linux (Docker). On Windows, where fork is
unavailable, falls back to SimpleWorker with timer-based job timeouts.
"""

import sys

import redis
from rq import Queue, SimpleWorker, Worker
from rq.timeouts import TimerDeathPenalty

from .config import Settings


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


def main() -> int:
    settings = Settings.from_env()
    conn = redis.Redis.from_url(settings.redis_url)
    worker_cls = WindowsWorker if sys.platform == "win32" else Worker
    work = queues(settings, conn)
    names = ", ".join(q.name for q in work)
    print(f"fitpdf worker listening on queues {names} ({settings.redis_url})")
    worker_cls(work, connection=conn).work()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
