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


# Shown when the run itself was killed: by the operating system, in practice,
# when a file needs more memory than the small server has.
KILLED_MESSAGE = (
    "This file was too much for the server to process. "
    "Try a smaller file or a larger size limit."
)


def connect(url: str):
    """A Redis client that rides out short blips instead of failing requests.

    Timeouts so a dead connection is noticed in seconds, not minutes;
    retries with backoff on connection and timeout errors, so a Redis restart
    or a dropped socket costs a retry rather than an error page; and a
    liveness check on connections idle for 30 s, which catches sockets the
    host dropped silently. RQ raises the socket timeout on the worker's own
    connection where it blocks waiting for jobs.
    """
    import redis
    from redis.backoff import ExponentialBackoff
    from redis.retry import Retry

    return redis.Redis.from_url(
        url,
        socket_timeout=5,
        socket_connect_timeout=5,
        health_check_interval=30,
        retry=Retry(ExponentialBackoff(cap=2, base=0.2), 3),
        retry_on_error=[redis.ConnectionError, redis.TimeoutError],
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


# --------------------------------------------------------------------------- #
# Runs. Each queued run gets an id, stored on the job. A newer run (a
# different size picked after a head-start began) replaces it, and the old
# run's writes must then land nowhere: not its events in the new run's
# stream, not its "done" over the new run's status. Every write a run makes
# goes through run_write, which checks the id and writes in one transaction.
# --------------------------------------------------------------------------- #


class Superseded(Exception):
    """This run has been replaced by a newer one, or its job deleted."""


def new_run_id() -> str:
    return uuid.uuid4().hex


def run_write(
    r,
    job_id: str,
    run_id: str,
    fields: dict | None = None,
    event: dict | None = None,
    *,
    pending_ttl: int,
    complete_ttl: int | None = None,
) -> None:
    """Write a run's fields and event, only while it is the job's current run.

    With `complete_ttl`, the run is finishing: the completion stamp and the
    key TTLs are set as mark_completed does, unless the run is a head-start
    nobody has asked for yet (`prepared`). That one keeps the pending clock,
    so a visitor still looking at the size picker does not find their upload
    deleted five minutes after a run they never saw; adopt() starts the
    clocks when they press Compress.

    Raises Superseded when the job has another run or is gone. WATCH makes
    the check and the write one step: a replacement landing in between
    aborts the write and the check runs again.
    """
    jk, ek = job_key(job_id), events_key(job_id)

    def attempt(p) -> None:
        current = p.hget(jk, "run_id")
        if current is None or current.decode() != run_id:
            raise Superseded(job_id)
        prepared = p.hget(jk, "prepared") == b"1"
        completing = complete_ttl is not None and not prepared
        p.multi()
        mapping = {k: str(v) for k, v in (fields or {}).items()}
        if completing:
            mapping["completed_at"] = now_stamp()
        if mapping:
            p.hset(jk, mapping=mapping)
        if event is not None:
            p.rpush(ek, json.dumps(event))
            p.expire(ek, pending_ttl)
        if completing:
            p.expire(jk, complete_ttl)
            p.expire(ek, complete_ttl)

    # redis-py's transaction(): WATCH, run attempt(), EXEC, and start over if
    # the watched key changed in between.
    r.transaction(attempt, jk)


def adopt(r, job_id: str, ttl: int) -> bool:
    """Turn a head-start into the visitor's run. False if there is none.

    A run still going just loses its `prepared` mark, and finishes as any
    run does. One already finished gets the completion stamp it held back,
    so the download window starts now. Watched, like run_write, so a run
    finishing at the same moment cannot slip between the two.
    """
    jk, ek = job_key(job_id), events_key(job_id)

    def attempt(p) -> bool:
        if p.hget(jk, "prepared") != b"1":
            return False
        status = (p.hget(jk, "status") or b"").decode()
        p.multi()
        p.hset(jk, "prepared", "0")
        if status in TERMINAL_STATUSES:
            p.hset(jk, "completed_at", now_stamp())
            p.expire(jk, ttl)
            p.expire(ek, ttl)
        return True

    return r.transaction(attempt, jk, value_from_callable=True)
