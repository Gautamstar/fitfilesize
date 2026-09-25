"""Job state and progress events in Redis.

Job metadata lives in a hash (fitpdf:job:{id}), progress events in a list
(fitpdf:events:{id}) that SSE readers replay from an offset, so no event is
lost to a subscribe race. Both keys carry the storage TTL, so Redis forgets
jobs on the same clock the file sweeper uses.
"""

import json
import time
import uuid

JOB_PREFIX = "fitpdf:job:"
EVENTS_PREFIX = "fitpdf:events:"

TERMINAL_STATUSES = ("done", "error")

# Everything before a terminal status. A job in one of these is waiting on the
# visitor (uploaded, analyzed) or on the worker (queued, compressing).
ACTIVE_STATUSES = ("uploaded", "analyzed", "queued", "compressing")

# Shown when a job's files or its run did not survive a server restart. On a
# host without a persistent disk (Render's free tier) a deploy starts from an
# empty data directory, so the visitor's only way forward is a fresh upload.
RESTARTED_MESSAGE = (
    "The server restarted while your file was being processed, so it was lost. "
    "Please upload it again."
)


def new_job_id() -> str:
    return uuid.uuid4().hex


def job_key(job_id: str) -> str:
    return JOB_PREFIX + job_id


def events_key(job_id: str) -> str:
    return EVENTS_PREFIX + job_id


def create_job(r, job_id: str, fields: dict, ttl: int) -> None:
    mapping = {"created_at": str(int(time.time()))}
    mapping.update({k: str(v) for k, v in fields.items()})
    r.hset(job_key(job_id), mapping=mapping)
    r.expire(job_key(job_id), ttl)


def update_job(r, job_id: str, **fields) -> None:
    r.hset(job_key(job_id), mapping={k: str(v) for k, v in fields.items()})


def get_job(r, job_id: str) -> dict | None:
    data = r.hgetall(job_key(job_id))
    if not data:
        return None
    return {k.decode(): v.decode() for k, v in data.items()}


def push_event(r, job_id: str, event: dict, ttl: int) -> None:
    key = events_key(job_id)
    r.rpush(key, json.dumps(event))
    r.expire(key, ttl)


def get_events(r, job_id: str, start: int = 0) -> list[dict]:
    raw = r.lrange(events_key(job_id), start, -1)
    return [json.loads(x) for x in raw]


def clear_events(r, job_id: str) -> None:
    r.delete(events_key(job_id))


def now_stamp() -> str:
    """Current time as stored in job hashes."""
    return str(int(time.time()))


def touch_progress(r, job_id: str) -> None:
    """Record that the run is alive. Read by the sweeper to spot dead runs."""
    r.hset(job_key(job_id), "progress_at", str(int(time.time())))


def fail_job(r, job_id: str, message: str, ttl: int, pending_ttl: int) -> None:
    """Move a job to error, tell anyone watching, and start its retention clock.

    The error event is what the progress stream and the polling fallback both
    act on, so a visitor waiting on the job sees the message within seconds.
    """
    # completed_at goes in the same write as the status: a reader must never
    # see a terminal status without it, or expires_in falls back to the
    # 30-minute pending clock instead of the real deletion time.
    update_job(r, job_id, status="error", error=message, completed_at=now_stamp())
    push_event(r, job_id, {"stage": "error", "message": message}, pending_ttl)
    mark_completed(r, job_id, ttl)


def active_job_ids(r) -> list[str]:
    """Ids of every job not yet done or failed. SCAN, so Redis is never blocked."""
    ids = []
    for raw in r.scan_iter(match=JOB_PREFIX + "*", count=200):
        key = raw.decode() if isinstance(raw, bytes) else raw
        status = r.hget(key, "status")
        if isinstance(status, bytes):
            status = status.decode()
        if status in ACTIVE_STATUSES:
            ids.append(key[len(JOB_PREFIX):])
    return ids


def mark_completed(r, job_id: str, ttl: int) -> None:
    """Stamp the completion time and restart both key TTLs from now.

    The completion stamp is what the file sweeper and `expires_in` measure
    against, so every user gets the same download window regardless of how
    long their compression took.
    """
    r.hset(job_key(job_id), "completed_at", str(int(time.time())))
    r.expire(job_key(job_id), ttl)
    r.expire(events_key(job_id), ttl)


def clear_completion(r, job_id: str, pending_ttl: int) -> None:
    """Undo mark_completed when a finished job is re-queued ("try another size").

    A previous failure's message goes too: the new run supersedes it, and a
    job reading status "done" with a leftover error is a contradiction.
    """
    r.hdel(job_key(job_id), "completed_at", "error")
    r.expire(job_key(job_id), pending_ttl)


def delete_job(r, job_id: str) -> None:
    r.delete(job_key(job_id), events_key(job_id))
