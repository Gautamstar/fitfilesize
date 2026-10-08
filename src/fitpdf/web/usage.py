"""Daily usage counts: how many files are uploaded and downloaded, and from where.

Page views (Cairn) say who visited; these say who used the tool. Each row is
a count for one day and one combination of:

* event: ``upload`` (a file arrived) or ``download`` (a result was taken,
  counted once per job however often it is fetched)
* source: ``web`` (the site), ``mcp`` (the fitfilesize-mcp package) or
  ``api`` (any other caller)
* kind: ``pdf``, ``gif`` or ``image`` (any other image)
* page: the landing page the site was on (``home`` for /), or ``-``
* outcome: for downloads, ``fit`` or ``over`` (could not get under the
  limit); ``-`` for uploads

Nothing about the file or the visitor is kept: no name, size, address or
content. Redis keeps nothing across a restart and job folders are swept, so
the counts live in their own SQLite file (FITPDF_USAGE_DB) on its own
volume. Without that setting, counting is off.

Read them on the server with ``python -m fitpdf.web.usage [days]``.
"""

import logging
import re
import sqlite3
import sys
import time
from datetime import date, timedelta
from pathlib import Path

log = logging.getLogger("uvicorn.error")

SCHEMA = """
CREATE TABLE IF NOT EXISTS counts (
    day TEXT NOT NULL,
    event TEXT NOT NULL,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    page TEXT NOT NULL,
    outcome TEXT NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (day, event, source, kind, page, outcome)
)
"""

# A landing page slug as the site sends it; anything else is not recorded.
PAGE_RE = re.compile(r"^[a-z0-9-]{1,80}$")


def clean_page(page: str | None) -> str:
    """The page as stored: ``home`` for /, the slug, or ``-`` if missing or odd."""
    if page is None:
        return "-"
    page = page.strip("/")
    if page == "":
        return "home"
    return page if PAGE_RE.match(page) else "-"


def source_for(user_agent: str | None, origin: str | None, allowed: tuple[str, ...]) -> str:
    """Who is calling: the MCP package, the site itself, or another API client."""
    if (user_agent or "").startswith("fitfilesize-mcp/"):
        return "mcp"
    if origin and origin in allowed:
        return "web"
    return "api"


def _connect(db: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db, timeout=2)
    conn.execute(SCHEMA)
    return conn


def record(
    db: Path | None,
    event: str,
    source: str,
    kind: str,
    page: str = "-",
    outcome: str = "-",
    today: date | None = None,
) -> None:
    """Add one to a count. Never raises: a counting problem must not fail a request."""
    if db is None:
        return
    day = (today or date.fromtimestamp(time.time())).isoformat()
    try:
        db.parent.mkdir(parents=True, exist_ok=True)
        with _connect(db) as conn:
            conn.execute(
                "INSERT INTO counts VALUES (?, ?, ?, ?, ?, ?, 1) "
                "ON CONFLICT DO UPDATE SET n = n + 1",
                (day, event, source, kind, page, outcome),
            )
        conn.close()
    except (sqlite3.Error, OSError) as e:
        log.warning("usage count not recorded: %s", e)


def rows(db: Path, days: int, today: date | None = None) -> list[tuple]:
    """(day, event, source, kind, page, outcome, n) for the last `days` days."""
    since = ((today or date.today()) - timedelta(days=days - 1)).isoformat()
    with _connect(db) as conn:
        out = conn.execute(
            "SELECT day, event, source, kind, page, outcome, n FROM counts "
            "WHERE day >= ? ORDER BY day, event, source, kind, page, outcome",
            (since,),
        ).fetchall()
    conn.close()
    return out


def report(data: list[tuple]) -> str:
    """A plain-text summary: per day by source, then the pages files came from."""
    if not data:
        return "No uploads or downloads recorded in this period."
    lines = ["day         uploads (web/mcp/api)   downloads (web/mcp/api)   fit / over"]
    by_day: dict[str, dict[tuple[str, str], int]] = {}
    for day, event, source, _kind, _page, outcome, n in data:
        d = by_day.setdefault(day, {})
        d[(event, source)] = d.get((event, source), 0) + n
        if event == "download":
            d[("outcome", outcome)] = d.get(("outcome", outcome), 0) + n
    for day, d in by_day.items():
        up = [d.get(("upload", s), 0) for s in ("web", "mcp", "api")]
        down = [d.get(("download", s), 0) for s in ("web", "mcp", "api")]
        lines.append(
            f"{day}  {sum(up):4} ({up[0]}/{up[1]}/{up[2]})"
            f"{'':12}{sum(down):4} ({down[0]}/{down[1]}/{down[2]})"
            f"{'':14}{d.get(('outcome', 'fit'), 0)} / {d.get(('outcome', 'over'), 0)}"
        )
    pages: dict[str, list[int]] = {}
    for _day, event, _source, _kind, page, _outcome, n in data:
        p = pages.setdefault(page, [0, 0])
        p[0 if event == "upload" else 1] += n
    lines += ["", "page                                   uploads  downloads"]
    for page, (up, down) in sorted(pages.items(), key=lambda kv: -kv[1][0]):
        lines.append(f"{page:38} {up:7}  {down:9}")
    return "\n".join(lines)


if __name__ == "__main__":
    import os

    path = os.environ.get("FITPDF_USAGE_DB")
    if not path:
        sys.exit("FITPDF_USAGE_DB is not set, so nothing is being counted")
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    print(report(rows(Path(path), days)))
