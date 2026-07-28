"""Per-media compression strategies.

The interesting part of this project is the search: a lossless pass first, then
a binary search over a ladder of increasingly aggressive settings, then an
honest floor when nothing fits. None of that is specific to PDFs.

This module isolates the parts that *are* media-specific behind one protocol,
so `engine.compress_to_target` runs the same search for any media type:

    probe    what is this file, how many pages/pixels, anything to warn about
    lossless a structure-only shrink that changes no visible content
    render   apply one rung of the ladder, return the resulting size
    validate did that produce a file we would actually hand back

`PdfStrategy` uses pikepdf and Ghostscript; `ImageStrategy` uses Pillow. Adding
a third media type means implementing four methods, not touching the search.
"""

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import pikepdf

from .gs import GhostscriptError, gs_available, run_gs

PDF_SUFFIXES = {".pdf"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"}


@dataclass
class Probe:
    """What a strategy learned about the input before compressing it."""

    kind: str
    """"pdf" or "image"."""
    pages: int = 0
    """Page count for PDFs, 1 for images."""
    width: int = 0
    height: int = 0
    """Pixel dimensions for images, 0 for PDFs."""
    warnings: list[str] = field(default_factory=list)


class Strategy(Protocol):
    kind: str
    rungs: list[dict]

    def probe(self, src: Path) -> Probe: ...

    def ensure_available(self) -> None:
        """Raise if the tooling this strategy needs is missing."""

    def lossless(self, src: Path, dst: Path, *, strip_metadata: bool) -> int: ...

    def render(self, src: Path, dst: Path, rung: dict, *, timeout: int) -> int: ...

    def validate(self, out: Path, probe: Probe) -> bool: ...

    def output_suffix(self, src: Path, lossy: bool) -> str:
        """Extension for the result. Lossy image output becomes .jpg."""


# --------------------------------------------------------------------------- #
# PDF
# --------------------------------------------------------------------------- #

PDF_RUNGS: list[dict] = [
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


class PdfStrategy:
    kind = "pdf"
    rungs = PDF_RUNGS

    def probe(self, src: Path) -> Probe:
        warnings: list[str] = []
        with pikepdf.open(src) as pdf:
            pages = len(pdf.pages)
            if "/AcroForm" in pdf.Root:
                warnings.append(
                    "PDF contains form fields; lossy compression may flatten them "
                    "(form-preserving path is on the roadmap)"
                )
        return Probe(kind="pdf", pages=pages, warnings=warnings)

    def ensure_available(self) -> None:
        if not gs_available():
            raise GhostscriptError(
                "Lossless pass alone cannot reach the target and Ghostscript is not "
                "installed. Install it (Windows: winget install ArtifexSoftware.GhostScript, "
                "Linux: apt install ghostscript) or set FITPDF_GS."
            )

    def lossless(self, src: Path, dst: Path, *, strip_metadata: bool) -> int:
        return lossless_pass(src, dst, strip_metadata)

    def render(self, src: Path, dst: Path, rung: dict, *, timeout: int) -> int:
        return run_gs(src, dst, **rung, timeout=timeout)

    def validate(self, out: Path, probe: Probe) -> bool:
        """Ghostscript can exit 0 having dropped pages. Check the count survived."""
        try:
            with pikepdf.open(out) as pdf:
                return len(pdf.pages) == probe.pages
        except Exception:
            return False

    def output_suffix(self, src: Path, lossy: bool) -> str:
        return ".pdf"


# --------------------------------------------------------------------------- #
# Images
# --------------------------------------------------------------------------- #

# Two levers, pixel dimensions and JPEG quality, tightened together so the
# ladder stays monotonic and the binary search stays valid. max_edge caps the
# longest side; images smaller than the cap are never upscaled.
IMAGE_RUNGS: list[dict] = [
    {"max_edge": 4000, "quality": 92},
    {"max_edge": 3500, "quality": 88},
    {"max_edge": 3000, "quality": 85},
    {"max_edge": 2600, "quality": 82},
    {"max_edge": 2200, "quality": 78},
    {"max_edge": 2000, "quality": 75},
    {"max_edge": 1800, "quality": 70},
    {"max_edge": 1600, "quality": 65},
    {"max_edge": 1400, "quality": 60},
    {"max_edge": 1200, "quality": 55},
    {"max_edge": 1000, "quality": 45},
    {"max_edge": 800, "quality": 35},
]


class ImageStrategy:
    kind = "image"
    rungs = IMAGE_RUNGS

    def probe(self, src: Path) -> Probe:
        from PIL import Image

        warnings: list[str] = []
        with Image.open(src) as im:
            width, height = im.size
            fmt = im.format or ""
            if im.mode in ("RGBA", "LA", "P"):
                warnings.append(
                    "image has transparency; the compressed result is JPEG and will "
                    "have a white background where it used to be transparent"
                )
            if getattr(im, "n_frames", 1) > 1:
                warnings.append(
                    f"{fmt} has multiple frames; only the first one is kept"
                )
        return Probe(kind="image", pages=1, width=width, height=height, warnings=warnings)

    def ensure_available(self) -> None:
        from PIL import Image  # noqa: F401

    def lossless(self, src: Path, dst: Path, *, strip_metadata: bool) -> int:
        """Re-encode with no visible change: strip EXIF, optimise the entropy coding.

        For an upright JPEG this is genuinely lossless, and the only thing lost is
        metadata (which on a phone photo includes GPS coordinates, worth dropping
        on its own merits). A JPEG carrying a rotation flag has to be re-encoded,
        because baking the rotation in means new pixels.
        """
        from PIL import Image, ImageOps

        # `opened` stays bound to what the context manager will close; every
        # transform below produces a new in-memory image held separately.
        with Image.open(src) as opened:
            fmt = (opened.format or "JPEG").upper()
            # EXIF carries the orientation flag. Dropping EXIF without baking the
            # rotation into the pixels first would leave photos sideways.
            needs_rotation = opened.getexif().get(0x0112, 1) not in (0, 1)

            if fmt == "JPEG" and not needs_rotation:
                # quality="keep" reuses the existing DCT coefficients, so this is
                # genuinely lossless. It only works on an unmodified JPEG, which
                # is why the rotation case below has to re-encode instead.
                opened.save(dst, "JPEG", quality="keep", optimize=True, progressive=True)
            elif fmt == "JPEG":
                ImageOps.exif_transpose(opened).save(
                    dst, "JPEG", quality=95, optimize=True, progressive=True
                )
            elif fmt == "PNG":
                ImageOps.exif_transpose(opened).save(dst, "PNG", optimize=True)
            elif fmt == "WEBP":
                opened.save(dst, "WEBP", lossless=True, method=6)
            else:
                # TIFF/BMP have no meaningful lossless shrink; PNG is the
                # honest floor for "same pixels, smaller file".
                opened.save(dst, "PNG", optimize=True)
        return dst.stat().st_size

    def render(self, src: Path, dst: Path, rung: dict, *, timeout: int) -> int:
        from PIL import Image, ImageOps

        with Image.open(src) as opened:
            im = ImageOps.exif_transpose(opened)

            if im.mode in ("RGBA", "LA", "P"):
                # JPEG has no alpha. Composite onto white rather than letting
                # Pillow drop the channel and produce black fringing.
                background = Image.new("RGB", im.size, (255, 255, 255))
                converted = im.convert("RGBA")
                background.paste(converted, mask=converted.split()[-1])
                im = background
            elif im.mode != "RGB":
                im = im.convert("RGB")

            max_edge = rung["max_edge"]
            longest = max(im.size)
            if longest > max_edge:
                scale = max_edge / longest
                new_size = (max(1, round(im.width * scale)), max(1, round(im.height * scale)))
                im = im.resize(new_size, Image.LANCZOS)

            im.save(dst, "JPEG", quality=rung["quality"], optimize=True, progressive=True)
        return dst.stat().st_size

    def validate(self, out: Path, probe: Probe) -> bool:
        from PIL import Image

        try:
            with Image.open(out) as im:
                im.verify()
            return out.stat().st_size > 0
        except Exception:
            return False

    def output_suffix(self, src: Path, lossy: bool) -> str:
        if lossy:
            return ".jpg"
        suffix = src.suffix.lower()
        # The lossless path re-encodes unsupported formats as PNG.
        return suffix if suffix in {".jpg", ".jpeg", ".png", ".webp"} else ".png"


# --------------------------------------------------------------------------- #

def detect_strategy(src: Path | str) -> Strategy:
    """Pick a strategy from the file extension, falling back to sniffing."""
    src = Path(src)
    suffix = src.suffix.lower()
    if suffix in PDF_SUFFIXES:
        return PdfStrategy()
    if suffix in IMAGE_SUFFIXES:
        return ImageStrategy()

    # No usable extension (the web layer stores uploads under a fixed name):
    # sniff the magic bytes instead.
    with src.open("rb") as f:
        head = f.read(8)
    if head.startswith(b"%PDF"):
        return PdfStrategy()
    return ImageStrategy()


def copy_through(src: Path, dst: Path) -> int:
    shutil.copyfile(src, dst)
    return dst.stat().st_size
