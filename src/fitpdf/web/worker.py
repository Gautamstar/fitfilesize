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


def main() -> int:
    settings = Settings.from_env()
    conn = redis.Redis.from_url(settings.redis_url)
    queue = Queue(settings.queue_name, connection=conn)
    worker_cls = WindowsWorker if sys.platform == "win32" else Worker
    print(f"fitpdf worker listening on queue '{settings.queue_name}' ({settings.redis_url})")
    worker_cls([queue], connection=conn).work()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
