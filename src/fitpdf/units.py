import re

_UNITS = {"b": 1, "kb": 1024, "mb": 1024**2, "gb": 1024**3}

_SIZE_RE = re.compile(r"\s*(\d+(?:\.\d+)?)\s*([kmg]?b)?\s*", re.IGNORECASE)


def parse_size(text: str | int) -> int:
    """Parse a human size like '4mb', '500 KB', or '2000000' into bytes (binary units)."""
    if isinstance(text, int):
        value = text
    else:
        m = _SIZE_RE.fullmatch(str(text))
        if not m:
            raise ValueError(f"cannot parse size: {text!r}")
        unit = (m.group(2) or "b").lower()
        value = int(float(m.group(1)) * _UNITS[unit])
    if value <= 0:
        raise ValueError(f"size must be positive: {text!r}")
    return value


_DECIMAL = {"b": 1, "kb": 1000, "mb": 1000**2, "gb": 1000**3}


def parse_limit(text: str) -> int:
    """Parse an upload limit like '200KB', '1.5 MB' or '200000' into bytes.

    Decimal units, unlike parse_size: a portal's "200 KB" limit may mean
    200,000 or 204,800 bytes, and aiming under the smaller passes either way.
    This is what the web API uses, matching the site's own presets.
    """
    m = _SIZE_RE.fullmatch(str(text))
    if not m:
        raise ValueError(f"cannot parse size: {text!r}; use something like 200KB or 1.5MB")
    value = int(float(m.group(1)) * _DECIMAL[(m.group(2) or "b").lower()])
    if value <= 0:
        raise ValueError(f"size must be positive: {text!r}")
    return value


def human_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    for unit in ("KB", "MB", "GB"):
        n /= 1024
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}"
    return f"{n:.1f} GB"
