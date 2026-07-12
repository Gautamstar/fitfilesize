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


def delete_job(r, job_id: str) -> None:
    r.delete(job_key(job_id), events_key(job_id))
