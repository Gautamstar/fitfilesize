import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    redis_url: str = "redis://localhost:6379/0"
    data_dir: Path = Path("data")

    ttl_seconds: int = 600
    """How long a finished job's files survive, measured from COMPLETION.

    Measuring from completion rather than upload means every user gets the same
    window to download, instead of a big slow file silently getting less time
    than a small fast one.
    """

    pending_ttl_seconds: int = 1800
    """Ceiling on a job that never reaches a terminal state.

    Must stay above the longest possible run. The queue allows
    gs_timeout * 8 + 120 seconds per job (see app.py), so with the default
    180s gs_timeout a run can take 26 minutes. Set this below that and the
    sweeper will delete a job's input file while it is still compressing.
    """

    input_grace_seconds: int = 300
    """How long input.pdf survives after completion.

    The original upload is the sensitive half (passports, bank statements), so
    it is deleted well before the compressed output. The only thing it is kept
    for is the "try another size" path, which re-runs against the original.
    """

    max_upload_bytes: int = 50 * 1024 * 1024
    gs_timeout: int = 180
    queue_name: str = "fitpdf"
    allowed_origins: tuple[str, ...] = ()
    """CORS origins for a separately hosted frontend, e.g. the Vercel deploy."""
    inline: bool = False
    """Run jobs in-process against a fake Redis. Dev convenience for machines
    without Redis or Docker; needs the fakeredis package (dev extra)."""

    @classmethod
    def from_env(cls) -> "Settings":
        origins = tuple(
            o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()
        )
        return cls(
            redis_url=os.environ.get("REDIS_URL", cls.redis_url),
            data_dir=Path(os.environ.get("FITPDF_DATA_DIR", "data")),
            ttl_seconds=int(os.environ.get("FITPDF_TTL_SECONDS", str(cls.ttl_seconds))),
            pending_ttl_seconds=int(
                os.environ.get("FITPDF_PENDING_TTL_SECONDS", str(cls.pending_ttl_seconds))
            ),
            input_grace_seconds=int(
                os.environ.get("FITPDF_INPUT_GRACE_SECONDS", str(cls.input_grace_seconds))
            ),
            max_upload_bytes=int(os.environ.get("FITPDF_MAX_UPLOAD", str(cls.max_upload_bytes))),
            gs_timeout=int(os.environ.get("FITPDF_GS_TIMEOUT", "180")),
            allowed_origins=origins,
            inline=os.environ.get("FITPDF_INLINE", "") == "1",
        )
