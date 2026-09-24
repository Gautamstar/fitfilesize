"""Per-visitor rate limits, counted in Redis.

Fixed one-hour windows: fitpdf:rl:{bucket}:{client}:{window} is INCR'd per
request and expires with its window. Coarse, but cheap, shared by every API
process, and hard to get wrong. The point is to stop one script from queueing
unlimited Ghostscript runs on a small instance, not to meter anyone precisely.

Behind a proxy the socket peer is the proxy, so every visitor would share one
bucket. The client address comes from the first of `ip_headers` that holds a
valid IP instead. Which header to trust depends on the host, because a client
can send any header it likes and only some proxies overwrite what it sent;
see Settings.client_ip_headers.
"""

import ipaddress
import time
from dataclasses import dataclass

from starlette.requests import Request

KEY_PREFIX = "fitpdf:rl:"
WINDOW_SECONDS = 3600


@dataclass(frozen=True)
class Quota:
    limit: int
    used: int
    reset_in: int

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used)

    @property
    def exceeded(self) -> bool:
        return self.used > self.limit


def client_key(request: Request, ip_headers: tuple[str, ...]) -> str:
    """A stable key for the visitor behind this request.

    IPv6 addresses are keyed by their /64: a home connection is usually handed
    a whole /64, so keying by full address would let one visitor rotate
    through billions of keys.
    """
    for name in ip_headers:
        value = request.headers.get(name)
        if not value:
            continue
        # X-Forwarded-For style lists put the original client first.
        candidate = value.split(",")[0].strip()
        try:
            ip = ipaddress.ip_address(candidate)
        except ValueError:
            continue
        return _bucket(ip)
    peer = request.client.host if request.client else "unknown"
    try:
        return _bucket(ipaddress.ip_address(peer))
    except ValueError:
        return peer


def _bucket(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str:
    if ip.version == 6:
        return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    return str(ip)


def _key(bucket: str, client: str, window: int) -> str:
    return f"{KEY_PREFIX}{bucket}:{client}:{window}"


def hit(r, bucket: str, client: str, limit: int) -> Quota:
    """Count one request and report the quota after it."""
    now = int(time.time())
    window = now // WINDOW_SECONDS
    key = _key(bucket, client, window)
    pipe = r.pipeline()
    pipe.incr(key)
    pipe.expire(key, WINDOW_SECONDS)
    used, _ = pipe.execute()
    return Quota(limit=limit, used=int(used), reset_in=(window + 1) * WINDOW_SECONDS - now)


def peek(r, bucket: str, client: str, limit: int) -> Quota:
    """The quota as it stands, without counting anything."""
    now = int(time.time())
    window = now // WINDOW_SECONDS
    used = r.get(_key(bucket, client, window))
    return Quota(
        limit=limit, used=int(used or 0), reset_in=(window + 1) * WINDOW_SECONDS - now
    )
