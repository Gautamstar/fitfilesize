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
    always_render: bool
    """True when every result must come from `render`: the output has to
    change in a way the original and the lossless pass cannot, such as exact
    pixel dimensions. The engine then skips both shortcuts."""

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
    always_render = False

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


# Exact pixel size, as exam and ID forms ask for ("200 x 230 pixels, under
# 50 KB"). The dimensions are fixed, so JPEG quality is the only lever left.
RESIZE_QUALITIES = (95, 90, 85, 80, 75, 70, 65, 60, 50, 40, 30, 20)

FIT_MODES = ("crop", "pad")
"""How an image meets a different aspect ratio: "crop" fills the frame and
trims the overflow, "pad" keeps the whole image and fills the gap with white."""

# Where "crop" cuts from. Horizontally centred; vertically a little above
# centre, because in a portrait photo the head is in the upper part, and
# trimming evenly from top and bottom is what cuts it off.
CROP_CENTERING = (0.5, 0.35)

MAX_RESIZE_EDGE = 10_000


def fit_exact(im, size: tuple[int, int], fit: str):
    """Return `im` at exactly `size` pixels, cropped or padded to get there."""
    from PIL import Image, ImageOps

    if fit == "crop":
        return ImageOps.fit(im, size, Image.LANCZOS, centering=CROP_CENTERING)
    return ImageOps.pad(im, size, Image.LANCZOS, color=(255, 255, 255))


class ImageStrategy:
    kind = "image"

    def __init__(self, resize: tuple[int, int] | None = None, fit: str = "crop") -> None:
        """`resize`, if given, is the exact (width, height) of the result."""
        if fit not in FIT_MODES:
            raise ValueError(f"fit must be one of {', '.join(FIT_MODES)}, not {fit!r}")
        if resize is not None and not all(1 <= n <= MAX_RESIZE_EDGE for n in resize):
            raise ValueError(f"width and height must be between 1 and {MAX_RESIZE_EDGE} pixels")
        self.resize = resize
        self.fit = fit
        self.always_render = resize is not None
        # Decoded pictures, reused by every rung of a run. A strategy lives
        # for one run (one file), so this never outlives the file it holds.
        self._pixels: dict[tuple, object] = {}
        if resize is None:
            self.rungs = IMAGE_RUNGS
        else:
            width, height = resize
            self.rungs = [{"width": width, "height": height, "quality": q} for q in RESIZE_QUALITIES]

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
        if self.resize is not None:
            warnings.extend(self._resize_notes(*self._upright_size(src)))
        return Probe(kind="image", pages=1, width=width, height=height, warnings=warnings)

    def _resize_notes(self, src_w: int, src_h: int) -> list[str]:
        """What an exact resize will do to the picture, beyond losing pixels."""
        assert self.resize is not None
        w, h = self.resize
        notes: list[str] = []
        src_ratio, dst_ratio = src_w / src_h, w / h
        # The share of the longer side that does not fit the new shape.
        mismatch = 1 - min(src_ratio, dst_ratio) / max(src_ratio, dst_ratio)
        if mismatch > 0.02:
            if self.fit == "crop":
                side = "width" if src_ratio > dst_ratio else "height"
                notes.append(
                    f"trimmed about {round(mismatch * 100)}% of the {side} to fill "
                    f"{w} x {h} pixels; choose the white border option to keep the "
                    "whole image"
                )
            else:
                notes.append(f"added a white border to keep the whole image at {w} x {h} pixels")
        scale = (max if self.fit == "crop" else min)(w / src_w, h / src_h)
        if scale > 1.05:
            notes.append(f"enlarged from {src_w} x {src_h} pixels, so it may look soft")
        return notes

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
        from PIL import Image

        if "width" in rung:
            # Every rung of an exact-size run shares one picture and differs
            # only in quality, so the resize happens once per run.
            size = (rung["width"], rung["height"])
            key = ("fit", src, size)
            if key not in self._pixels:
                self._pixels[key] = fit_exact(self._decoded(src, rung), size, self.fit)
            im = self._pixels[key]
        else:
            im = self._decoded(src, rung)
            # Sized from the full source, not from `im`, so the result is the
            # same size whether or not the decoder already shrank it.
            full_w, full_h = self._upright_size(src)
            if max(full_w, full_h) > rung["max_edge"]:
                # Only ever shrink to the cap; smaller images keep their size.
                scale = rung["max_edge"] / max(full_w, full_h)
                new_size = (max(1, round(full_w * scale)), max(1, round(full_h * scale)))
                im = im.resize(new_size, Image.LANCZOS)

        im.save(dst, "JPEG", quality=rung["quality"], optimize=True, progressive=True)
        return dst.stat().st_size

    def _upright_size(self, src: Path) -> tuple[int, int]:
        """(width, height) of the source once turned the way it is viewed."""
        from PIL import Image

        key = ("size", src)
        if key not in self._pixels:
            with Image.open(src) as im:
                width, height = im.size
                # Orientations 5-8 turn the photo a quarter, swapping its sides.
                turned = im.getexif().get(0x0112, 1) in (5, 6, 7, 8)
            self._pixels[key] = (height, width) if turned else (width, height)
        return self._pixels[key]

    def _decoded(self, src: Path, rung: dict):
        """The source upright and in RGB on white, decoded once per run.

        Decoding a phone photo is a large share of each render, and every rung
        of a run starts from the same pixels, so they are kept. When the rung's
        output is much smaller than the source, a JPEG can also be shrunk by
        2, 4 or 8 while it is decoded (Pillow's draft mode), which is far
        cheaper than decoding every pixel and resizing them afterwards. At
        least twice the output size is kept, as Pillow's own thumbnail() does,
        so the final LANCZOS resize still decides the quality.
        """
        from PIL import Image, ImageOps

        width, height = self._upright_size(src)
        if "width" in rung:
            sx, sy = rung["width"] / width, rung["height"] / height
            scale = max(sx, sy) if self.fit == "crop" else min(sx, sy)
        else:
            scale = rung["max_edge"] / max(width, height)
        reduce = 1
        while reduce < 8 and reduce * 2 * 2 * scale <= 1:
            reduce *= 2

        key = ("decoded", src, reduce)
        if key not in self._pixels:
            with Image.open(src) as opened:
                if reduce > 1:
                    # A no-op for anything but JPEG, which then decodes in full.
                    # Pillow picks the factor as width // requested, so ask for
                    # width // reduce: rounding that up would turn a factor of
                    # 2 into 1 for every odd-sized photo.
                    opened.draft(
                        None,
                        (max(1, opened.width // reduce), max(1, opened.height // reduce)),
                    )
                im = ImageOps.exif_transpose(opened)

                if im.mode in ("RGBA", "LA", "P"):
                    # JPEG has no alpha. Composite onto white rather than
                    # letting Pillow drop the channel and produce black
                    # fringing.
                    background = Image.new("RGB", im.size, (255, 255, 255))
                    converted = im.convert("RGBA")
                    background.paste(converted, mask=converted.split()[-1])
                    im = background
                elif im.mode != "RGB":
                    im = im.convert("RGB")
            self._pixels[key] = im
        return self._pixels[key]

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
