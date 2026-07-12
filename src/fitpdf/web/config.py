import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    redis_url: str = "redis://localhost:6379/0"
    data_dir: Path = Path("data")
    ttl_seconds: int = 1800
    max_upload_bytes: int = 200 * 1024 * 1024
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
            ttl_seconds=int(os.environ.get("FITPDF_TTL_SECONDS", "1800")),
            max_upload_bytes=int(os.environ.get("FITPDF_MAX_UPLOAD", str(cls.max_upload_bytes))),
            gs_timeout=int(os.environ.get("FITPDF_GS_TIMEOUT", "180")),
            allowed_origins=origins,
            inline=os.environ.get("FITPDF_INLINE", "") == "1",
        )
