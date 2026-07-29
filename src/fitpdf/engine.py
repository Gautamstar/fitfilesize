"""The media-agnostic half: inspection, the target search, and the floor.

Everything that knows about a specific file format lives in strategies.py. What
is left here is the part worth reading: lossless first, then a binary search
over a ladder of increasingly aggressive settings, then an honest report of the
smallest achievable size when the target simply is not reachable.
"""

import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import pikepdf

from .strategies import (
    IMAGE_RUNGS,
    PDF_RUNGS,
    Strategy,
    copy_through,
    detect_strategy,
    lossless_pass,
)

# `RUNGS` is the PDF ladder. Named without a prefix because the CLI and the
# public package API treat PDFs as the default media type.
RUNGS = PDF_RUNGS

__all__ = [
    "IMAGE_RUNGS",
    "PDF_RUNGS",
    "RUNGS",
    "Analysis",
    "CompressResult",
    "analyze",
    "compress_to_target",
    "estimate_floor",
    "lossless_pass",
]


@dataclass
class Analysis:
    kind: str = "pdf"
    """"pdf" or "image"."""
    pages: int = 0
    size_bytes: int = 0
    image_bytes: int = 0
    image_share: float = 0.0
    width: int = 0
    height: int = 0
    has_forms: bool = False
    encrypted: bool = False


@dataclass
class CompressResult:
    output: Path
    original_bytes: int
    final_bytes: int
    target_bytes: int
    hit_target: bool
    method: str
    rungs_tried: int = 0
    warnings: list[str] = field(default_factory=list)
    kind: str = "pdf"

    @property
    def saved_pct(self) -> float:
        if self.original_bytes == 0:
            return 0.0
        return 100.0 * (1 - self.final_bytes / self.original_bytes)


def analyze(path: Path | str) -> Analysis:
    path = Path(path)
    size = path.stat().st_size
    strategy = detect_strategy(path)

    if strategy.kind == "image":
        try:
            probe = strategy.probe(path)
        except Exception:
            return Analysis(kind="image", size_bytes=size)
        return Analysis(
            kind="image",
            pages=1,
            size_bytes=size,
            # An image file is essentially all image data.
            image_bytes=size,
            image_share=1.0,
            width=probe.width,
            height=probe.height,
        )

    try:
        pdf = pikepdf.open(path)
    except pikepdf.PasswordError:
        return Analysis(size_bytes=size, encrypted=True)
    with pdf:
        image_bytes = 0
        seen: set[tuple[int, int]] = set()
        for page in pdf.pages:
            for img in page.get_images().values():
                key = img.objgen
                if key in seen:
                    continue
                seen.add(key)
                try:
                    image_bytes += int(img.stream_dict.get("/Length", 0))
                except (TypeError, ValueError, AttributeError):
                    continue
        return Analysis(
            kind="pdf",
            pages=len(pdf.pages),
            size_bytes=size,
            image_bytes=image_bytes,
            image_share=image_bytes / size if size else 0.0,
            has_forms="/AcroForm" in pdf.Root,
        )


ProgressFn = Callable[[dict], None]


def estimate_floor(src: Path | str, *, timeout: int = 120) -> int:
    """Cheap floor estimate: one render at the harshest rung.

    Used by the web analyze step to bound the target slider before the user
    commits to a full run. The real floor found by compress_to_target can differ
    slightly (it also considers the lossless pass), so treat this as an estimate.
    """
    src = Path(src)
    original = src.stat().st_size
    strategy = detect_strategy(src)

    try:
        strategy.ensure_available()
    except Exception:
        # No tooling: assume image data compresses away almost entirely and
        # everything else stays.
        a = analyze(src)
        return min(original, max(original - int(a.image_bytes * 0.9), 1024))

    with tempfile.TemporaryDirectory(prefix="fitpdf-") as tmp:
        out = Path(tmp) / f"floor{strategy.output_suffix(src, lossy=True)}"
        try:
            size = strategy.render(src, out, strategy.rungs[-1], timeout=timeout)
            return min(size, original)
        except Exception:
            a = analyze(src)
            return min(original, max(original - int(a.image_bytes * 0.9), 1024))


def compress_to_target(
    src: Path | str,
    dst: Path | str,
    target_bytes: int,
    *,
    timeout: int = 120,
    strip_metadata: bool = True,
    on_progress: ProgressFn | None = None,
    strategy: Strategy | None = None,
) -> CompressResult:
    """Compress src to fit under target_bytes, degrading as little as possible.

    Lossless pass first; if still over target, binary-search the strategy's rung
    ladder for the gentlest setting that fits. If no rung fits, return the best
    achievable (the floor) with hit_target=False.

    `dst` is used as given when the produced format matches its extension, and
    re-suffixed otherwise (a lossy image result is always JPEG). The path
    actually written is on the returned result's `output`.

    on_progress, if given, is called with a dict per step:
      {"stage": "lossless", "size": int}
      {"stage": "rung_start", "rung": int, ...rung settings}
      {"stage": "rung_result", "rung": int, "size": int | None, "fits": bool}
    """

    def emit(event: dict) -> None:
        if on_progress is not None:
            on_progress(event)

    src, dst = Path(src), Path(dst)
    strategy = strategy or detect_strategy(src)
    original = src.stat().st_size
    probe = strategy.probe(src)
    warnings = list(probe.warnings)

    def finish(
        produced: Path, size: int, hit: bool, method: str, tried: int, lossy: bool
    ) -> CompressResult:
        target_path = dst.with_suffix(strategy.output_suffix(src, lossy=lossy))
        copy_through(produced, target_path)
        return CompressResult(
            target_path, original, size, target_bytes, hit, method, tried, warnings, strategy.kind
        )

    if original <= target_bytes:
        return finish(src, original, True, "none", 0, lossy=False)

    with tempfile.TemporaryDirectory(prefix="fitpdf-") as tmp:
        tmpdir = Path(tmp)

        loss_path = tmpdir / f"lossless{strategy.output_suffix(src, lossy=False)}"
        loss_size = strategy.lossless(src, loss_path, strip_metadata=strip_metadata)
        emit({"stage": "lossless", "size": loss_size})

        if loss_size <= target_bytes:
            return finish(loss_path, loss_size, True, "lossless", 0, lossy=False)

        strategy.ensure_available()

        lossy_suffix = strategy.output_suffix(src, lossy=True)
        cache: dict[int, tuple[int | None, Path]] = {}

        def try_rung(i: int) -> tuple[int | None, Path]:
            if i in cache:
                return cache[i]
            emit({"stage": "rung_start", "rung": i, **strategy.rungs[i]})
            out = tmpdir / f"rung{i}{lossy_suffix}"
            try:
                size: int | None = strategy.render(src, out, strategy.rungs[i], timeout=timeout)
            except Exception:
                size = None
            if size is not None and not strategy.validate(out, probe):
                size = None
            emit(
                {
                    "stage": "rung_result",
                    "rung": i,
                    "size": size,
                    "fits": size is not None and size <= target_bytes,
                }
            )
            cache[i] = (size, out)
            return cache[i]

        lo, hi = 0, len(strategy.rungs) - 1
        fit: int | None = None
        while lo <= hi:
            mid = (lo + hi) // 2
            size, _ = try_rung(mid)
            if size is not None and size <= target_bytes:
                fit = mid
                hi = mid - 1
            else:
                lo = mid + 1

        if fit is not None:
            size, out = cache[fit]
            assert size is not None
            return finish(out, size, True, f"rung:{fit}", len(cache), lossy=True)

        candidates = [(s, p, True) for s, p in cache.values() if s is not None]
        candidates.append((loss_size, loss_path, False))
        floor_size, floor_path, floor_lossy = min(candidates, key=lambda c: c[0])
        warnings.append(
            "target not reachable; returning the smallest achievable file (the floor)"
        )
        return finish(floor_path, floor_size, False, "floor", len(cache), lossy=floor_lossy)
