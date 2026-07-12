import os
import shutil
import subprocess
from pathlib import Path

_GS_CANDIDATES = ("gs", "gswin64c", "gswin32c")


class GhostscriptError(RuntimeError):
    pass


def find_gs() -> str | None:
    """Locate the Ghostscript binary. The FITPDF_GS env var overrides PATH lookup."""
    override = os.environ.get("FITPDF_GS")
    if override and Path(override).exists():
        return override
    for name in _GS_CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    return None


def gs_available() -> bool:
    return find_gs() is not None


def run_gs(
    src: Path,
    dst: Path,
    *,
    color_dpi: int,
    mono_dpi: int,
    jpeg_q: int,
    timeout: int = 120,
) -> int:
    """Re-distill src through Ghostscript with the given downsampling rung. Returns output size."""
    gs = find_gs()
    if gs is None:
        raise GhostscriptError(
            "Ghostscript not found. Install it (Windows: winget install ArtifexSoftware.GhostScript, "
            "Linux: apt install ghostscript) or set FITPDF_GS to the binary path."
        )
    args = [
        gs,
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        "-dNOPAUSE",
        "-dBATCH",
        "-dQUIET",
        "-dSAFER",
        f"-sOutputFile={dst}",
        "-dDownsampleColorImages=true",
        f"-dColorImageResolution={color_dpi}",
        "-dColorImageDownsampleType=/Bicubic",
        "-dColorImageDownsampleThreshold=1.0",
        "-dDownsampleGrayImages=true",
        f"-dGrayImageResolution={color_dpi}",
        "-dGrayImageDownsampleType=/Bicubic",
        "-dGrayImageDownsampleThreshold=1.0",
        "-dDownsampleMonoImages=true",
        f"-dMonoImageResolution={mono_dpi}",
        "-dMonoImageDownsampleType=/Subsample",
        "-dMonoImageDownsampleThreshold=1.0",
        "-dAutoFilterColorImages=false",
        "-dAutoFilterGrayImages=false",
        "-dColorImageFilter=/DCTEncode",
        "-dGrayImageFilter=/DCTEncode",
        f"-dJPEGQ={jpeg_q}",
        "-dDetectDuplicateImages=true",
        "-dCompressFonts=true",
        "-dSubsetFonts=true",
        str(src),
    ]
    try:
        proc = subprocess.run(args, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise GhostscriptError(f"Ghostscript timed out after {timeout}s") from e
    if proc.returncode != 0 or not dst.exists():
        tail = proc.stderr.decode(errors="replace")[-500:]
        raise GhostscriptError(f"Ghostscript failed (exit {proc.returncode}): {tail}")
    return dst.stat().st_size
