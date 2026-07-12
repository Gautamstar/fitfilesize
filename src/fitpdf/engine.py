import shutil
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import pikepdf

from .gs import GhostscriptError, gs_available, run_gs

RUNGS: list[dict] = [
    {"color_dpi": 300, "mono_dpi": 600, "jpeg_q": 90},
    {"color_dpi": 250, "mono_dpi": 600, "jpeg_q": 85},
    {"color_dpi": 200, "mono_dpi": 400, "jpeg_q": 80},
    {"color_dpi": 175, "mono_dpi": 400, "jpeg_q": 75},
    {"color_dpi": 150, "mono_dpi": 300, "jpeg_q": 70},
    {"color_dpi": 125, "mono_dpi": 300, "jpeg_q": 65},
    {"color_dpi": 110, "mono_dpi": 300, "jpeg_q": 60},
    {"color_dpi": 96, "mono_dpi": 200, "jpeg_q": 55},
    {"color_dpi": 85, "mono_dpi": 200, "jpeg_q": 50},
    {"color_dpi": 72, "mono_dpi": 150, "jpeg_q": 45},
    {"color_dpi": 60, "mono_dpi": 150, "jpeg_q": 40},
    {"color_dpi": 50, "mono_dpi": 100, "jpeg_q": 30},
]


@dataclass
class Analysis:
    pages: int = 0
    size_bytes: int = 0
    image_bytes: int = 0
    image_share: float = 0.0
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

    @property
    def saved_pct(self) -> float:
        if self.original_bytes == 0:
            return 0.0
        return 100.0 * (1 - self.final_bytes / self.original_bytes)


def analyze(path: Path | str) -> Analysis:
    path = Path(path)
    size = path.stat().st_size
    try:
        pdf = pikepdf.open(path)
    except pikepdf.PasswordError:
        return Analysis(size_bytes=size, encrypted=True)
    with pdf:
        image_bytes = 0
        seen: set[tuple[int, int]] = set()
        for page in pdf.pages:
            for _, img in page.get_images().items():
                key = img.objgen
                if key in seen:
                    continue
                seen.add(key)
                try:
                    image_bytes += int(img.stream_dict.get("/Length", 0))
                except (TypeError, ValueError, AttributeError):
                    continue
        return Analysis(
            pages=len(pdf.pages),
            size_bytes=size,
            image_bytes=image_bytes,
            image_share=image_bytes / size if size else 0.0,
            has_forms="/AcroForm" in pdf.Root,
        )


def lossless_pass(src: Path | str, dst: Path | str, strip_metadata: bool = True) -> int:
    """Structure-only shrink: object streams, stream recompression, unreferenced-resource removal."""
    src, dst = Path(src), Path(dst)
    with pikepdf.open(src) as pdf:
        if strip_metadata:
            try:
                with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
                    meta.clear()
                for key in list(pdf.docinfo.keys()):
                    del pdf.docinfo[key]
            except Exception:
                pass
        pdf.remove_unreferenced_resources()
        pdf.save(
            dst,
            object_stream_mode=pikepdf.ObjectStreamMode.generate,
            compress_streams=True,
            recompress_flate=True,
        )
    return dst.stat().st_size


ProgressFn = Callable[[dict], None]


def estimate_floor(src: Path | str, *, timeout: int = 120) -> int:
    """Cheap floor estimate: one Ghostscript run at the harshest rung.

    Used by the web analyze step to bound the target slider before the user
    commits to a full compression run. The real floor found by
    compress_to_target can differ slightly (it also considers the lossless
    pass), so treat this as an estimate.
    """
    src = Path(src)
    original = src.stat().st_size
    if gs_available():
        with tempfile.TemporaryDirectory(prefix="fitpdf-") as tmp:
            out = Path(tmp) / "floor.pdf"
            try:
                size = run_gs(src, out, **RUNGS[-1], timeout=timeout)
                return min(size, original)
            except GhostscriptError:
                pass
    # No Ghostscript (or it failed): assume images compress away almost
    # entirely and everything else stays.
    a = analyze(src)
    return min(original, max(original - int(a.image_bytes * 0.9), 1024))


def _valid_pdf(path: Path, expected_pages: int) -> bool:
    try:
        with pikepdf.open(path) as pdf:
            return len(pdf.pages) == expected_pages
    except Exception:
        return False


def compress_to_target(
    src: Path | str,
    dst: Path | str,
    target_bytes: int,
    *,
    timeout: int = 120,
    strip_metadata: bool = True,
    on_progress: ProgressFn | None = None,
) -> CompressResult:
    """Compress src to fit under target_bytes, degrading as little as possible.

    Strategy: lossless pass first; if still over target, binary-search the rung
    ladder (gentlest downsampling that fits). If no rung fits, return the best
    achievable (the floor) with hit_target=False.

    on_progress, if given, is called with a dict per step:
      {"stage": "lossless", "size": int}
      {"stage": "rung_start", "rung": int, "color_dpi": int, "mono_dpi": int, "jpeg_q": int}
      {"stage": "rung_result", "rung": int, "size": int | None, "fits": bool}
    """

    def emit(event: dict) -> None:
        if on_progress is not None:
            on_progress(event)
    src, dst = Path(src), Path(dst)
    original = src.stat().st_size
    warnings: list[str] = []

    with pikepdf.open(src) as pdf:
        pages = len(pdf.pages)
        if "/AcroForm" in pdf.Root:
            warnings.append(
                "PDF contains form fields; lossy compression may flatten them "
                "(form-preserving path is on the roadmap)"
            )

    if original <= target_bytes:
        shutil.copyfile(src, dst)
        return CompressResult(dst, original, original, target_bytes, True, "none", 0, warnings)

    with tempfile.TemporaryDirectory(prefix="fitpdf-") as tmp:
        tmpdir = Path(tmp)
        loss_path = tmpdir / "lossless.pdf"
        loss_size = lossless_pass(src, loss_path, strip_metadata)
        emit({"stage": "lossless", "size": loss_size})

        if loss_size <= target_bytes:
            shutil.copyfile(loss_path, dst)
            return CompressResult(
                dst, original, loss_size, target_bytes, True, "lossless", 0, warnings
            )

        if not gs_available():
            raise GhostscriptError(
                "Lossless pass alone cannot reach the target and Ghostscript is not "
                "installed. Install it (Windows: winget install ArtifexSoftware.GhostScript, "
                "Linux: apt install ghostscript) or set FITPDF_GS."
            )

        cache: dict[int, tuple[int | None, Path]] = {}

        def try_rung(i: int) -> tuple[int | None, Path]:
            if i in cache:
                return cache[i]
            emit({"stage": "rung_start", "rung": i, **RUNGS[i]})
            out = tmpdir / f"rung{i}.pdf"
            try:
                size: int | None = run_gs(src, out, **RUNGS[i], timeout=timeout)
            except GhostscriptError:
                size = None
            if size is not None and not _valid_pdf(out, pages):
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

        lo, hi = 0, len(RUNGS) - 1
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
            shutil.copyfile(out, dst)
            return CompressResult(
                dst, original, size, target_bytes, True, f"rung:{fit}", len(cache), warnings
            )

        candidates = [(s, p) for s, p in cache.values() if s is not None]
        candidates.append((loss_size, loss_path))
        floor_size, floor_path = min(candidates, key=lambda c: c[0])
        shutil.copyfile(floor_path, dst)
        warnings.append(
            "target not reachable; returning the smallest achievable file (the floor)"
        )
        return CompressResult(
            dst, original, floor_size, target_bytes, False, "floor", len(cache), warnings
        )
