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


def human_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    for unit in ("KB", "MB", "GB"):
        n /= 1024
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}"
    return f"{n:.1f} GB"
