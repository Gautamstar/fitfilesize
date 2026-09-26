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
from typing import ClassVar, Protocol

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
    # Typical drop in log(output size) per rung down PDF_RUNGS, measured on
    # production scans. Only seeds the search's first guess; see engine.
    typical_log_step = 0.21

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
# Largest picture decoded in full. Pillow holds RGB at four bytes a pixel, so
# a 48 MP photo is about 190 MB, and the free server has 512 MB for
# everything. A JPEG bigger than this decodes at reduced size (see
# ImageStrategy._decoded) and skips the lossless pass; other formats cannot
# decode small, so uploads above MAX_IMAGE_PIXELS are refused instead.
MAX_DECODE_PIXELS = 24_000_000

# Largest image taken at all, in pixels. A JPEG decodes at reduced size, so
# 64 MP (every phone camera up to 64 MP sensors) peaks around 250 MB. Other
# formats decode in full first, four bytes a pixel, so they stop at 34 MP
# (an 8K screenshot), about 220 MB. Measured on the web worker's code path.
MAX_IMAGE_PIXELS = {"JPEG": 64_000_000}
MAX_OTHER_IMAGE_PIXELS = 34_000_000


def image_too_big(src: Path) -> str | None:
    """Why an image has too many pixels to process safely, or None.

    Reads the header only.
    """
    from PIL import Image

    with Image.open(src) as im:
        fmt = (im.format or "").upper()
        pixels = im.width * im.height
    limit = MAX_IMAGE_PIXELS.get(fmt, MAX_OTHER_IMAGE_PIXELS)
    if pixels <= limit:
        return None
    mp, cap = pixels / 1e6, limit // 1_000_000
    if fmt == "JPEG":
        return f"this photo is {mp:.0f} megapixels; the most we can take is {cap}. Make it smaller first"
    return (
        f"this image is {mp:.0f} megapixels; the most we can take for a {fmt or 'non-JPEG'} "
        f"is {cap} ({MAX_IMAGE_PIXELS['JPEG'] // 1_000_000} for a JPEG). "
        "Save it as a JPEG or make it smaller first"
    )

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

# Largest side an exact-size result may have. Forms that ask for pixels want a
# few hundred, visa photos up to about 1200; this matches the top of the
# ordinary ladder. Capped because an enlargement costs the worker memory and
# CPU for every pixel however small the upload was: 4000 x 4000 is 48 MB.
MAX_RESIZE_EDGE = 4000


def fit_exact(im, size: tuple[int, int], fit: str):
    """Return `im` at exactly `size` pixels, cropped or padded to get there."""
    from PIL import Image, ImageOps

    if fit == "crop":
        return ImageOps.fit(im, size, Image.LANCZOS, centering=CROP_CENTERING)
    return ImageOps.pad(im, size, Image.LANCZOS, color=(255, 255, 255))


class ImageStrategy:
    kind = "image"
    # As PdfStrategy.typical_log_step, measured on a 12 MP phone photo.
    typical_log_step = 0.44

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
        # Whether see-through pixels were turned white; None until known.
        self.flattened: bool | None = None
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
            # Transparency is not warned about here: a mode that can hold it
            # (most screenshots are RGBA) usually has none, and finding out
            # means decoding every pixel. _decoded() checks the pixels it
            # decodes anyway and sets `flattened`.
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

    # How far the lossless pass can shrink each format, as a share of the
    # original. A JPEG pass only re-optimises entropy coding and drops
    # metadata: a few percent, so below half the original it cannot help.
    # A PNG that is already compressed gains 3 to 10 percent from
    # re-optimising, and even one saved at a weak compression level about
    # half; below a quarter it cannot help either. (Measured on photo-like
    # and UI-screenshot PNGs. On the free server the pass took 7 s on a
    # 3.6 MB PNG to save 9 percent.)
    LOSSLESS_REACH: ClassVar[dict[str, float]] = {"JPEG": 0.5, "PNG": 0.25}
    # A PNG stored close to raw (compression level 0) can shrink many times
    # over and stay a PNG, so it always gets the pass.
    STORED_PNG = 0.9

    def lossless_hopeless(self, src: Path, original: int, target: int) -> bool:
        """True when the lossless pass cannot get the file down to the target.

        JPEG and PNG only. TIFF and BMP are often stored uncompressed and can
        shrink a great deal on the way to PNG, so they always get the pass.
        Reads the header only; no pixels are decoded.
        """
        from PIL import Image

        try:
            with Image.open(src) as im:
                fmt = (im.format or "").upper()
                reach = self.LOSSLESS_REACH.get(fmt)
                if fmt == "JPEG" and im.width * im.height > MAX_DECODE_PIXELS:
                    # Not about reach: the pass decodes and re-encodes every
                    # pixel, too much memory for a photo this big on a small
                    # server. The ladder, which decodes it small, takes over.
                    return True
                if reach is None or target >= original * reach:
                    return False
                if fmt == "PNG":
                    raw = im.width * im.height * len(im.getbands())
                    return original < raw * self.STORED_PNG
                return True
        except Exception:
            return False

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

        Only one decode is kept, and any rung that needs no more pixels than
        it holds reuses it; a rung that needs more replaces it. So a run holds
        at most one copy of the picture, however many rungs it tries.
        """
        from PIL import Image, ImageOps

        width, height = self._upright_size(src)
        if "width" in rung:
            sx, sy = rung["width"] / width, rung["height"] / height
            scale = max(sx, sy) if self.fit == "crop" else min(sx, sy)
        else:
            scale = rung["max_edge"] / max(width, height)
        # Keep twice the output, as thumbnail() does. A source too big to hold
        # in full on a small server (see MAX_DECODE_PIXELS) settles for the
        # output size itself: a JPEG's scaled decode already averages the
        # pixels it drops, so the quality cost is small, and a 48 MP photo is
        # held at 12 MP instead of 48.
        need = scale if width * height > MAX_DECODE_PIXELS else 2 * scale
        reduce = 1
        while reduce < 8 and reduce * 2 * need <= 1:
            reduce *= 2

        key = ("decoded", src)
        cached = self._pixels.get(key)
        if cached is None or cached[0] > reduce:
            # Let the previous decode go before making the next one.
            self._pixels.pop(key, None)
            with Image.open(src) as opened:
                full_width = opened.width
                if reduce > 1:
                    # A no-op for anything but JPEG, which then decodes in full.
                    # Pillow picks the factor as width // requested, so ask for
                    # width // reduce: rounding that up would turn a factor of
                    # 2 into 1 for every odd-sized photo.
                    opened.draft(
                        None,
                        (max(1, opened.width // reduce), max(1, opened.height // reduce)),
                    )
                opened.load()
                # What the decoder actually did: nothing for a PNG, and for a
                # JPEG possibly less than asked.
                actual = round(full_width / opened.width)
                im = opened
                if actual < reduce and reduce % actual == 0:
                    # Formats with no scaled decode (PNG, WebP, TIFF, BMP)
                    # shrink right after it instead, with a box filter as the
                    # JPEG decoder does, so the run holds the small copy and
                    # not the full one.
                    im = im.reduce(reduce // actual)
                    actual = reduce
                # In place, so an upright picture (every PNG, most photos
                # taken the right way up) is never copied. Pixels stay usable
                # once loaded, after the `with` closes the file.
                ImageOps.exif_transpose(im, in_place=True)

                if im.mode in ("RGBA", "LA", "P"):
                    # JPEG has no alpha. Composite onto white rather than
                    # letting Pillow drop the channel and produce black
                    # fringing.
                    converted = im if im.mode == "RGBA" else im.convert("RGBA")
                    alpha = converted.getchannel("A")
                    # One pass over pixels already in memory: only a pixel
                    # that is actually see-through turns white.
                    self.flattened = alpha.getextrema()[0] < 255
                    if self.flattened:
                        background = Image.new("RGB", im.size, (255, 255, 255))
                        background.paste(converted, mask=alpha)
                        im = background
                    else:
                        im = converted.convert("RGB")
                else:
                    self.flattened = False
                    if im.mode != "RGB":
                        im = im.convert("RGB")
            self._pixels[key] = (actual, im)
        return self._pixels[key][1]

    def lost_transparency(self, src: Path) -> bool:
        """Whether a JPEG made from src turned see-through pixels white.

        Known for free once a render has decoded the source. A run answered
        entirely by the analyze step's floor render never decodes it, so
        then it is checked here, and only for a mode that can hold alpha.
        """
        from PIL import Image

        if self.flattened is None:
            with Image.open(src) as im:
                self.flattened = im.mode in ("RGBA", "LA", "P") and (
                    im.convert("RGBA").getchannel("A").getextrema()[0] < 255
                )
        return self.flattened

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
