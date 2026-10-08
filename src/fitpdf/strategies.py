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
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".heic", ".heif"}

# iPhone photos (HEIC). Pillow opens them once pillow-heif registers its
# plugin; its format name is "HEIF". Almost no upload form accepts HEIC, so
# unlike every other format a HEIC always comes back as a JPEG, and says so.
try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # pragma: no cover - a build without HEIC support
    pass
CONVERT_TO_JPEG = {"HEIF"}


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

# Largest image taken at all, in pixels, sized for the VPS (API 1 GB, each
# worker 1 GB). Peaks measured there on the real code path:
# * JPEG decodes at reduced size, so 64 MP (every phone camera up to 64 MP
#   sensors) peaks around 250 MB.
# * PNG, TIFF and BMP decode in full, so they stop at 50 MP: a transparent
#   PNG peaks at 420 MB analysing and 490 MB compressing, an opaque one 300.
# * WebP decodes worst of all, about 15 bytes a pixel (Pillow's decoder holds
#   several full copies), so it stops at 16 MP, a 4000 x 4000 web image:
#   about 330 MB. At 34 MP it took 580 MB just to open.
MAX_IMAGE_PIXELS = {"JPEG": 64_000_000, "WEBP": 16_000_000}
MAX_OTHER_IMAGE_PIXELS = 50_000_000
# Past this a WebP skips the lossless pass: re-encoding losslessly at
# method 6 took 1.4 GB on a 34 MP image, and a photo's lossless copy comes
# out larger than the lossy original anyway.
MAX_WEBP_LOSSLESS_PIXELS = 12_000_000


def image_too_big(src: Path) -> str | None:
    """Why an image has too many pixels to process safely, or None.

    Reads the header only.
    """
    from PIL import Image

    try:
        with Image.open(src) as im:
            fmt = (im.format or "").upper()
            pixels = im.width * im.height
    except Image.DecompressionBombError:
        # Pillow will not even open an image this big (over twice its own
        # 89 MP safety limit), so it is certainly over ours.
        cap = MAX_IMAGE_PIXELS["JPEG"] // 1_000_000
        return f"this image has far too many pixels; the most we can take is {cap} megapixels"
    except Exception:
        return None  # not an image this can read; analyze says so
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


# A PNG stays a PNG while it can: 256 colours (pngquant) at full size, then
# at smaller sizes. For screenshots, diagrams and cheat sheets that is 3 to 5
# times smaller with text still sharp, where a JPEG blurs it. A photo saved
# as PNG cannot drop to 256 colours without visible banding, and pngquant
# refuses it (see PNG_QUALITY); then the run offers JPEG instead.
FULL_SIZE = 100_000  # a max_edge larger than any image: keep every pixel
PNG_RUNGS: list[dict] = [
    {"max_edge": edge, "colors": 256}
    # Down to 480 px, below the JPEG ladder's 800: a PNG cannot drop quality
    # instead, and a 640 px screenshot is still readable.
    for edge in (FULL_SIZE, 6000, 5000, 4000, 3500, 3000, 2600, 2200, 1800, 1400, 1000, 800, 640, 480)
]
# pngquant's --quality, used only when a JPEG may take over (an API caller's
# allow_jpeg): it gives up (exit 99) rather than go below the minimum, so a
# photo goes to JPEG instead of being posterised. When the result must stay
# a PNG, giving up would only leave the file at its original size, so then
# pngquant always returns its best 256 colours.
PNG_QUALITY = "60-100"
# pngquant's own default; 3 was a third slower for no visible difference.
PNGQUANT_SPEED = "4"
# Its fastest, for drafts: the search only needs each rung's size, and at
# 10 a 47 MP render takes 1.3 s instead of 6.9 s, for a file about 5% larger
# (up to 18% on a flat graphic). The chosen rung is rendered again at
# PNGQUANT_SPEED before it is handed back (see the engine's drafts).
PNGQUANT_DRAFT_SPEED = "10"
# Only a rung this big, of a file this big, is drafted. Below either a
# proper render is quick anyway. And a big file is a photo or a dense
# graphic, whose drafts run a steady 5 to 15 percent over; a flat graphic
# (a small file, however many pixels) can have drafts twice the real size.
DRAFT_MIN_PIXELS = 8_000_000
DRAFT_MIN_BYTES = 8_000_000
PNGQUANT_QUALITY_TOO_LOW = 99


# Every image comes back in the format it came in: this is not a converter.
# PNG, TIFF and BMP take the 256-colour ladder above (BMP has no compression,
# so 8-bit colour and fewer pixels are its only levers); WebP, which has
# lossy compression and transparency, takes the JPEG ladder's steps saved as
# WebP. JPEG is JPEG throughout.
PALETTE_FORMATS = {"PNG", "TIFF", "BMP"}
# Saving each format as small as it goes without losing anything more.
NATIVE_SAVE = {
    "PNG": {"format": "PNG", "optimize": True},
    "TIFF": {"format": "TIFF", "compression": "tiff_adobe_deflate"},
    "BMP": {"format": "BMP"},
}


class PngRefused(Exception):
    """256 colours would visibly damage this image; it should not stay a PNG."""


# A HEIC converted to JPEG may keep every pixel: someone converting a 48 MP
# iPhone photo with room to spare expects all of it, not the 4000 px the
# JPEG ladder starts at.
CONVERT_RUNGS: list[dict] = [{"max_edge": FULL_SIZE, "quality": 92}, *IMAGE_RUNGS]


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


def fit_exact(
    im,
    size: tuple[int, int],
    fit: str,
    focus: tuple[float, float] | None = None,
    border: tuple[int, ...] = (255, 255, 255),
):
    """Return `im` at exactly `size` pixels, cropped or padded to get there.

    `focus` is where a crop cuts from, as ImageOps.fit's centering: (0, 0)
    keeps the top-left, (1, 1) the bottom-right. The visitor sets it by
    dragging the crop box; without it, CROP_CENTERING. `border` fills the
    gap a pad leaves: white for a JPEG, see-through for a GIF.
    """
    from PIL import Image, ImageOps

    if fit == "crop":
        return ImageOps.fit(im, size, Image.LANCZOS, centering=focus or CROP_CENTERING)
    return ImageOps.pad(im, size, Image.LANCZOS, color=border)


def resize_notes(
    src_w: int, src_h: int, size: tuple[int, int], fit: str, border: str = "white"
) -> list[str]:
    """What an exact resize will do to the picture, beyond losing pixels."""
    w, h = size
    notes: list[str] = []
    src_ratio, dst_ratio = src_w / src_h, w / h
    # The share of the longer side that does not fit the new shape.
    mismatch = 1 - min(src_ratio, dst_ratio) / max(src_ratio, dst_ratio)
    if mismatch > 0.02:
        if fit == "crop":
            side = "width" if src_ratio > dst_ratio else "height"
            notes.append(
                f"trimmed about {round(mismatch * 100)}% of the {side} to fill "
                f"{w} x {h} pixels; choose the {border} border option to keep the "
                "whole image"
            )
        else:
            notes.append(f"added a {border} border to keep the whole image at {w} x {h} pixels")
    scale = (max if fit == "crop" else min)(w / src_w, h / src_h)
    if scale > 1.05:
        notes.append(f"enlarged from {src_w} x {src_h} pixels, so it may look soft")
    return notes


def estimate_png_lossless(im) -> float:
    """The lossless pass's likely size for an open PNG, in bytes, from strips.

    PNG compresses row by row, so strips across the whole height, compressed
    as the pass would, stand in for the picture: 16 of them, 6 percent of the
    rows. Each strip's first row is compressed against an unrelated one above
    it, so strips are at least 32 rows: thinner ones overestimated a noisy
    photo by 8 percent. Within 1 percent of the real pass on photos, in a
    tenth of its time; a flat graphic can be 11 percent over, but is never
    big enough to be estimated (see ImageStrategy.ESTIMATE_PNG_BYTES).
    """
    import io

    from PIL import Image

    im.load()
    width, height = im.size
    tall = min(height, max(32, height * 6 // 100 // 16))
    strips = min(16, height // tall)
    tops = [i * (height - tall) // max(strips - 1, 1) for i in range(strips)]
    sample = Image.new(im.mode, (width, tall * strips))
    for n, top in enumerate(tops):
        sample.paste(im.crop((0, top, width, top + tall)), (0, n * tall))
    if im.mode == "P":
        sample.putpalette(im.getpalette())
    if "transparency" in im.info:
        sample.info["transparency"] = im.info["transparency"]
    buf = io.BytesIO()
    sample.save(buf, "PNG", optimize=True)
    return buf.tell() * height / sample.height


class ImageStrategy:
    kind = "image"
    # As PdfStrategy.typical_log_step, measured on a 12 MP phone photo.
    typical_log_step = 0.44

    def __init__(
        self,
        resize: tuple[int, int] | None = None,
        fit: str = "crop",
        focus: tuple[float, float] | None = None,
    ) -> None:
        """`resize`, if given, is the exact (width, height) of the result;
        `focus` is where a crop cuts from (see fit_exact)."""
        if fit not in FIT_MODES:
            raise ValueError(f"fit must be one of {', '.join(FIT_MODES)}, not {fit!r}")
        if focus is not None and not all(0 <= n <= 1 for n in focus):
            raise ValueError("focus must be two fractions between 0 and 1")
        self.focus = focus
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
        # "native" while searching the source format's own ladder (see
        # use_native), else "jpeg".
        self.mode = "jpeg"
        self.native_format = ""
        self.native_suffix = ""
        self._png_refused = False
        # Set by the engine when a JPEG may take over from the PNG ladder.
        self.png_strict = False
        # Set by the engine while it searches with quick renders (see drafts).
        self.draft = False
        # The source's (width, height) and file size, known once native_first
        # has looked.
        self._size = (0, 0)
        self._bytes = 0
        if resize is None:
            self.rungs = IMAGE_RUNGS
        else:
            width, height = resize
            self.rungs = [{"width": width, "height": height, "quality": q} for q in RESIZE_QUALITIES]

    def must_convert(self, src: Path) -> bool:
        """Whether src can only come back as a JPEG (see CONVERT_TO_JPEG)."""
        from PIL import Image

        try:
            with Image.open(src) as im:
                return (im.format or "").upper() in CONVERT_TO_JPEG
        except Exception:
            return False

    def use_conversion(self) -> None:
        """The JPEG ladder with a full-size first rung, for a must_convert source."""
        if self.resize is None:
            self.rungs = CONVERT_RUNGS

    def native_first(self, src: Path) -> bool:
        """Whether src has a ladder that keeps its own format (see
        PALETTE_FORMATS). Not with an exact size: that is a form's
        requirement, and those forms ask for JPEG."""
        from PIL import Image

        if self.resize is not None:
            return False
        try:
            with Image.open(src) as im:
                fmt = (im.format or "").upper()
                size = im.size
        except Exception:
            return False
        if fmt not in PALETTE_FORMATS and fmt != "WEBP":
            return False
        self.native_format = fmt
        self._size = size
        self._bytes = src.stat().st_size
        # The visitor's own extension (.tif or .tiff), so the name matches.
        self.native_suffix = src.suffix.lower() or {"PNG": ".png", "TIFF": ".tif", "BMP": ".bmp", "WEBP": ".webp"}[fmt]
        return True

    def use_native(self, on: bool) -> None:
        """Switch between the source format's own ladder and the JPEG one."""
        self.mode = "native" if on else "jpeg"
        if not on:
            self.rungs = IMAGE_RUNGS
            # Let the full-size decode go before the JPEG ladder decodes.
            self._pixels.pop(("native", "decoded"), None)
        elif self.native_format == "WEBP":
            self.rungs = [{**r, "format": "WEBP"} for r in IMAGE_RUNGS]
        else:
            # Only the sizes this image can take: a rung at or above its
            # longest side renders the same full-size picture as FULL_SIZE,
            # and a 4032 px photo would otherwise have three of them.
            longest = max(self._size) or FULL_SIZE
            rungs = [r for r in PNG_RUNGS if r["max_edge"] == FULL_SIZE or r["max_edge"] < longest]
            if self.native_format == "PNG":
                self.rungs = rungs
            else:
                self.rungs = [{**r, "format": self.native_format} for r in rungs]

    @property
    def drafts(self) -> bool:
        """Whether this ladder can be searched with quick draft renders: the
        256-colour one, where pngquant has a fast setting (see
        PNGQUANT_DRAFT_SPEED)."""
        return self.mode == "native" and self.native_format in PALETTE_FORMATS

    def is_draft(self, rung: dict) -> bool:
        """Whether rendering this rung now makes a draft: drafts are on and
        the rung is big enough to be worth one (see DRAFT_MIN_PIXELS)."""
        if not (self.draft and "colors" in rung and self._bytes >= DRAFT_MIN_BYTES):
            return False
        width, height = self._size
        scale = min(1.0, rung["max_edge"] / max(width, height, 1))
        return width * height * scale * scale >= DRAFT_MIN_PIXELS

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
        return resize_notes(src_w, src_h, self.resize, self.fit)

    def ensure_available(self) -> None:
        from PIL import Image  # noqa: F401

    # How far the lossless pass can shrink each format, as a share of the
    # original. A JPEG pass only re-optimises entropy coding and drops
    # metadata: a few percent, so below half the original it cannot help.
    # A PNG that is already compressed gains 3 to 10 percent from
    # re-optimising, and even one saved at a weak compression level about
    # half. Below 60 percent a PNG goes to the 256-colour PNG rungs instead,
    # which keep it a PNG: on a 40 MP cheat sheet the pass took 14 s to save
    # 17 percent, where full size at 256 colours took 10 s to save 64.
    # A lossy WebP re-encoded losslessly only grows; a lossless one gains a
    # few percent at most.
    LOSSLESS_REACH: ClassVar[dict[str, float]] = {"JPEG": 0.5, "PNG": 0.6, "WEBP": 0.95}
    # A PNG stored close to raw (compression level 0) can shrink many times
    # over and stay a PNG, so it always gets the pass.
    STORED_PNG = 0.9
    # Above this, a PNG within reach has its pass estimated before it is run
    # (see estimate_png_lossless): the pass costs by the byte, and on a 48 MB
    # photo took 22 s to save nothing. Below it the pass is a few seconds.
    ESTIMATE_PNG_BYTES = 8_000_000
    # How far over the target an estimate may be and the pass still run: on
    # photos it came within 1 percent of the real pass, and dense graphics
    # came out under it, which only means the pass runs.
    ESTIMATE_SLACK = 1.05

    def lossless_hopeless(self, src: Path, original: int, target: int) -> bool:
        """True when the lossless pass cannot get the file down to the target.

        JPEG, PNG and WebP by reach, and a large WebP by memory. A TIFF is
        often stored uncompressed and can shrink a great deal deflated, so it
        always gets the pass; a BMP has no compression to gain, so it never
        does. Reads the header only, except for a large PNG within reach,
        which is sampled (see ESTIMATE_PNG_BYTES).
        """
        from PIL import Image

        try:
            with Image.open(src) as im:
                fmt = (im.format or "").upper()
                reach = self.LOSSLESS_REACH.get(fmt)
                if fmt == "BMP":
                    return True
                if fmt == "JPEG" and im.width * im.height > MAX_DECODE_PIXELS:
                    # Not about reach: the pass decodes and re-encodes every
                    # pixel, too much memory for a photo this big on a small
                    # server. The ladder, which decodes it small, takes over.
                    return True
                if fmt == "WEBP" and im.width * im.height > MAX_WEBP_LOSSLESS_PIXELS:
                    return True
                if fmt == "PNG":
                    raw = im.width * im.height * len(im.getbands())
                    if original >= raw * self.STORED_PNG:
                        return False  # stored: the pass is sure to help
                    if target >= original * reach and original >= self.ESTIMATE_PNG_BYTES:
                        return estimate_png_lossless(im) > target * self.ESTIMATE_SLACK
                if reach is None or target >= original * reach:
                    return False
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
            # Same pixels, so the same colour profile: dropping an iPhone
            # photo's Display P3 tag would make it look dull everywhere.
            icc = {"icc_profile": opened.info["icc_profile"]} if opened.info.get("icc_profile") else {}
            # EXIF carries the orientation flag. Dropping EXIF without baking the
            # rotation into the pixels first would leave photos sideways.
            needs_rotation = opened.getexif().get(0x0112, 1) not in (0, 1)

            if fmt == "JPEG" and not needs_rotation:
                # quality="keep" reuses the existing DCT coefficients, so this is
                # genuinely lossless. It only works on an unmodified JPEG, which
                # is why the rotation case below has to re-encode instead.
                opened.save(dst, "JPEG", quality="keep", optimize=True, progressive=True, **icc)
            elif fmt == "JPEG":
                ImageOps.exif_transpose(opened).save(
                    dst, "JPEG", quality=95, optimize=True, progressive=True, **icc
                )
            elif fmt == "PNG":
                ImageOps.exif_transpose(opened).save(dst, "PNG", optimize=True, **icc)
            elif fmt == "WEBP":
                opened.save(dst, "WEBP", lossless=True, method=6, **icc)
            elif fmt == "TIFF":
                # Often stored uncompressed: deflate keeps every pixel.
                ImageOps.exif_transpose(opened).save(dst, **NATIVE_SAVE["TIFF"], **icc)
            else:
                opened.save(dst, fmt)
        return dst.stat().st_size

    def render(self, src: Path, dst: Path, rung: dict, *, timeout: int) -> int:
        from PIL import Image

        if "colors" in rung:
            return self._render_palette(src, dst, rung, timeout=timeout)
        if rung.get("format") == "WEBP":
            return self._render_webp(src, dst, rung)
        if "width" in rung:
            # Every rung of an exact-size run shares one picture and differs
            # only in quality, so the resize happens once per run.
            size = (rung["width"], rung["height"])
            key = ("fit", src, size)
            if key not in self._pixels:
                self._pixels[key] = fit_exact(self._decoded(src, rung), size, self.fit, self.focus)
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

    def _native_pixels(self, src: Path, max_edge: int):
        """The source upright, transparency kept, shrunk to max_edge. The
        full-size decode is held for the run's other rungs."""
        from PIL import Image, ImageOps

        key = ("native", "decoded")
        if key not in self._pixels:
            with Image.open(src) as opened:
                opened.load()
                im = ImageOps.exif_transpose(opened)
                keep_alpha = im.mode in ("RGBA", "LA", "PA") or (
                    im.mode == "P" and "transparency" in im.info
                )
                # pngquant and the re-encodes drop the profile, so the pixels
                # go to sRGB first (see _to_srgb): a Mac screenshot is P3.
                self._pixels[key] = _to_srgb(
                    im.convert("RGBA" if keep_alpha else "RGB"), opened.info.get("icc_profile")
                )
        im = self._pixels[key]
        if max(im.size) > max_edge:
            scale = max_edge / max(im.size)
            im = im.resize(
                (max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS
            )
        return im

    def _render_webp(self, src: Path, dst: Path, rung: dict) -> int:
        """A lossy WebP, transparency kept, at the rung's size and quality."""
        im = self._native_pixels(src, rung["max_edge"])
        im.save(dst, "WEBP", quality=rung["quality"], method=4)
        return dst.stat().st_size

    def _render_palette(self, src: Path, dst: Path, rung: dict, *, timeout: int) -> int:
        """256 colours at the rung's size, saved as the source's format."""
        from PIL import Image

        fmt = rung.get("format", "PNG")
        if fmt == "PNG":
            return self._render_png(src, dst, rung, timeout=timeout)
        png = dst.with_name(dst.stem + "-256.png")
        try:
            self._render_png(src, png, rung, timeout=timeout)
            with Image.open(png) as quantized:
                quantized.load()
                # A palette TIFF or BMP cannot hold transparency; RGBA can.
                out = quantized.convert("RGBA") if "transparency" in quantized.info else quantized
                out.save(dst, **NATIVE_SAVE[fmt])
        finally:
            png.unlink(missing_ok=True)
        return dst.stat().st_size

    def _render_png(self, src: Path, dst: Path, rung: dict, *, timeout: int) -> int:
        """A 256-colour PNG, transparency kept, shrunk to the rung's max_edge."""
        import shutil
        import subprocess
        import tempfile

        from PIL import Image

        if self._png_refused:
            raise PngRefused  # pngquant judges the colours, not the size
        im = self._native_pixels(src, rung["max_edge"])

        pngquant = shutil.which("pngquant")
        if pngquant is None:
            # Where pngquant is not installed (a laptop, say), Pillow's own
            # quantizer: close on flat graphics, blotchier on gradients.
            method = Image.Quantize.FASTOCTREE if im.mode == "RGBA" else Image.Quantize.MEDIANCUT
            im.quantize(rung["colors"], method=method, dither=Image.Dither.FLOYDSTEINBERG).save(
                dst, "PNG", optimize=True
            )
            return dst.stat().st_size
        with tempfile.TemporaryDirectory(prefix="fitpdf-png-") as tmp:
            raw = Path(tmp) / "in.png"
            im.save(raw, "PNG", compress_level=1)  # read once by pngquant; speed over size
            done = subprocess.run(
                [pngquant, str(rung["colors"]),
                 *(["--quality", PNG_QUALITY] if self.png_strict else []),
                 "--speed", PNGQUANT_DRAFT_SPEED if self.is_draft(rung) else PNGQUANT_SPEED, "--strip", "--force", "--output", str(dst), str(raw)],
                capture_output=True, timeout=timeout, check=False,
            )
        if done.returncode == PNGQUANT_QUALITY_TOO_LOW:
            self._png_refused = True
            raise PngRefused
        if done.returncode != 0:
            raise RuntimeError(f"pngquant failed: {done.stderr.decode(errors='replace')[:200]}")
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

                im = _to_srgb(im, opened.info.get("icc_profile"))
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
            return self.native_suffix if self.mode == "native" else ".jpg"
        suffix = src.suffix.lower()
        return suffix if suffix in IMAGE_SUFFIXES else ".png"


# --------------------------------------------------------------------------- #
# GIF
# --------------------------------------------------------------------------- #

# A GIF comes back a GIF, still moving: frame timing, looping and
# transparency kept. gifsicle does the work, as pngquant does for PNG: its
# -O3 rewrites each frame as only what changed, and --lossy lets the
# compressor drift a little from the exact pixels in return for far smaller
# frames, which is invisible at moderate levels.
GIF_SUFFIXES = {".gif"}


@dataclass
class GifInfo:
    """What a GIF's blocks say, read without decoding a pixel."""

    width: int
    height: int
    delays: list[int]
    """Each frame's delay, in hundredths of a second (0 when it sets none)."""
    loop: int | None
    """The loop count (0 is forever), or None when the GIF plays once."""

    @property
    def frames(self) -> int:
        return len(self.delays)


GIF_CUT_OFF = (
    "this GIF is incomplete: the file ends partway through. Download or save it "
    "again, then try once more"
)


def read_gif(path: Path | str) -> GifInfo:
    """Walk a GIF's blocks for its size, frame delays and loop count.

    Cheap at any length: image data is skipped sub-block by sub-block, never
    decoded. Raises ValueError on anything that is not a well-formed GIF.
    """
    data = Path(path).read_bytes()
    if data[:6] not in (b"GIF87a", b"GIF89a") or len(data) < 13:
        raise ValueError("this file is not a GIF")
    width = int.from_bytes(data[6:8], "little")
    height = int.from_bytes(data[8:10], "little")
    at = 13
    if data[10] & 0x80:
        at += 3 << ((data[10] & 7) + 1)

    def skip_sub_blocks(i: int) -> int:
        while True:
            if i >= len(data):
                raise ValueError(GIF_CUT_OFF)
            n = data[i]
            i += 1
            if n == 0:
                return i
            i += n

    delays: list[int] = []
    loop: int | None = None
    delay = 0
    while at < len(data):
        block = data[at]
        if block == 0x3B:  # trailer
            break
        if block == 0x21:  # extension
            label = data[at + 1] if at + 1 < len(data) else 0
            body = at + 2
            if label == 0xF9 and body + 5 <= len(data) and data[body] >= 4:
                delay = int.from_bytes(data[body + 2 : body + 4], "little")
            elif (
                label == 0xFF
                and data[body : body + 12] == b"\x0bNETSCAPE2.0"
                and body + 16 <= len(data)
                and data[body + 12] == 3
                and data[body + 13] == 1
            ):
                loop = int.from_bytes(data[body + 14 : body + 16], "little")
            at = skip_sub_blocks(body)
        elif block == 0x2C:  # image descriptor
            if at + 10 > len(data):
                raise ValueError(GIF_CUT_OFF)
            packed = data[at + 9]
            at += 10
            if packed & 0x80:
                at += 3 << ((packed & 7) + 1)
            at = skip_sub_blocks(at + 1)  # past the LZW code size
            delays.append(delay)
            delay = 0
        else:
            raise ValueError("this GIF is damaged and cannot be read")
    if not delays or width == 0 or height == 0:
        raise ValueError("this GIF has no pictures in it")
    return GifInfo(width, height, delays, loop)


# Frames times pixels a GIF may have in all: about 200 frames of 1000 x 1000,
# 650 of 640 x 360, 2000 of 320 x 320 (a 100-frame reaction GIF is 13
# million). Dropping frames needs every frame whole in gifsicle's memory, a
# byte a pixel: 409 MB at a 390-million GIF, so this keeps a run near 200 MB
# of a worker's 1 GB, and its time near 10 s.
MAX_GIF_PIXEL_FRAMES = 200_000_000
# For an exact size, every frame is fitted first (see GifStrategy._fitted)
# and Pillow holds them all, a byte a pixel, until it writes the file:
# 160 MB at most, a 1500-frame sticker.
MAX_GIF_EXACT_PIXEL_FRAMES = 160_000_000
# Searching, a GIF this big (1 MB) is rendered with gifsicle's quick -O1, and
# only the answer with -O3: on a 24 MB clip -O3 took 13 s a render to -O1's
# 2.4, for files 0 to 30 percent smaller (most on flat graphics and long
# GIFs). Above GIF_O3_MAX_PIXEL_FRAMES (a 120-frame 1000 x 1000 clip) -O3
# would take minutes, so the answer stays at -O1.
GIF_DRAFT_MIN_BYTES = 1_000_000
GIF_O3_MAX_PIXEL_FRAMES = 120_000_000
# -O3 only pays on some GIFs: 23 to 32 percent on screen recordings, flat
# graphics and long loops, nothing on video-like clips, where it took 31 s on
# a 1080p one. So a big GIF's first frames, shrunk to this many pixels in
# all, are tried both ways first; under GIF_O3_MIN_GAIN, everything stays at
# -O1. The sample's gain came within 4 points of the whole file's on nine
# kinds of GIF, and takes a second or two.
GIF_O3_SAMPLE_PIXELS = 1_500_000
GIF_O3_MIN_GAIN = 0.08


def gif_too_big(src: Path) -> str | None:
    """Why a GIF is too long or too large to process safely, or None."""
    try:
        info = read_gif(src)
    except ValueError:
        return None  # analyze says what is wrong with it
    if info.frames * info.width * info.height <= MAX_GIF_PIXEL_FRAMES:
        return None
    return (
        f"this GIF is {info.frames} frames of {info.width} x {info.height} pixels, "
        "more than we can process; shorten it or make it smaller first"
    )


# Gentlest first, each step a little smaller than the last: lossy
# compression at full size and every colour, then all three levers (lossy,
# colours, pixels) tightened a little at a time, and only at the end every
# other frame (each kept frame shown for the two it replaces, so it plays at
# the same speed). Tightening one lever at a time made big jumps: on a
# video-like GIF, 128 to 64 colours alone halved the file. Measured on a
# 5 MB video-like clip, most steps take 15 to 40 percent off; flat graphics
# move less, and lossy compression does little for them.
GIF_RUNGS: list[dict] = [
    {"lossy": lossy, "colors": colors, "scale": scale, **({"frame_step": step} if step else {})}
    for lossy, colors, scale, step in (
        (30, 256, 1.0, 0),
        (60, 256, 1.0, 0),
        (100, 256, 1.0, 0),
        (100, 192, 0.92, 0),
        (110, 160, 0.84, 0),
        (120, 128, 0.76, 0),
        (130, 128, 0.68, 0),
        (140, 96, 0.6, 0),
        (150, 96, 0.53, 0),
        (160, 80, 0.46, 0),
        (170, 64, 0.4, 0),
        (180, 64, 0.34, 0),
        (190, 56, 0.29, 0),
        (200, 48, 0.25, 0),
        # Every other frame, at the size of the step before: starting any
        # larger to soften the jump made the file bigger on short GIFs.
        (200, 48, 0.25, 2),
        (200, 40, 0.22, 2),
        (200, 32, 0.2, 2),
        # Long GIFs that still do not fit: every third, then fourth frame.
        (200, 32, 0.2, 3),
        (200, 24, 0.18, 4),
    )
]
# At an exact size the pixels are fixed, so the same order without them.
GIF_EXACT_STEPS: list[tuple[int, int, int]] = [
    (0, 256, 1), (30, 256, 1), (60, 256, 1), (90, 256, 1), (90, 128, 1), (120, 128, 1),
    (120, 64, 1), (150, 64, 1), (150, 32, 1), (200, 32, 1), (200, 32, 2), (200, 16, 2),
    (200, 16, 3), (200, 16, 4),
]
# Lossless -O3 rarely saves more than this share of a GIF; below it the
# pass is skipped (see GifStrategy.lossless_hopeless).
GIF_LOSSLESS_REACH = 0.5
# gifsicle options that drop comments, frame names and unknown extensions:
# none of them is seen, and the loop count is kept apart from them.
GIF_STRIP = ("--no-comments", "--no-names", "--no-extensions")
SEE_THROUGH = (0, 0, 0, 0)


class GifStrategy:
    kind = "image"
    # As PdfStrategy.typical_log_step: 0.33 a rung on a video-like GIF, 0.14
    # on a flat screen recording.
    typical_log_step = 0.25

    def __init__(
        self,
        resize: tuple[int, int] | None = None,
        fit: str = "crop",
        focus: tuple[float, float] | None = None,
    ) -> None:
        """As ImageStrategy: `resize` is an exact (width, height), every frame
        cropped or padded to it; a pad is see-through rather than white."""
        if fit not in FIT_MODES:
            raise ValueError(f"fit must be one of {', '.join(FIT_MODES)}, not {fit!r}")
        if focus is not None and not all(0 <= n <= 1 for n in focus):
            raise ValueError("focus must be two fractions between 0 and 1")
        if resize is not None and not all(1 <= n <= MAX_RESIZE_EDGE for n in resize):
            raise ValueError(f"width and height must be between 1 and {MAX_RESIZE_EDGE} pixels")
        self.resize, self.fit, self.focus = resize, fit, focus
        self.always_render = resize is not None
        if resize is None:
            self.rungs = GIF_RUNGS
        else:
            width, height = resize
            self.rungs = [
                {"width": width, "height": height, "lossy": lossy, "colors": colors,
                 **({"frame_step": step} if step > 1 else {})}
                for lossy, colors, step in GIF_EXACT_STEPS
            ]
        self._info: GifInfo | None = None
        self._src: Path | None = None
        self._bytes = 0
        self._o3_helps: bool | None = None
        # Each render's frame count, checked by validate, and what it gave up.
        self._frames: dict[Path, int] = {}
        self._notes: dict[Path, list[str]] = {}
        # Set by the engine while it searches with quick renders (see drafts).
        self.draft = False

    def info(self, src: Path) -> GifInfo:
        if self._info is None:
            self._info = read_gif(src)
            self._src = src
            self._bytes = src.stat().st_size
        return self._info

    @property
    def drafts(self) -> bool:
        """The ladder is searched with quick -O1 renders, and the answer made
        again with -O3 (see GIF_DRAFT_MIN_BYTES and the engine's polish)."""
        return True

    def is_draft(self, rung: dict) -> bool:
        """Whether rendering this rung now makes a draft: drafts are on and
        the answer will be made at -O3 (see _level). An exact size is small
        and never drafted."""
        return self.draft and "width" not in rung and self._level(rung, final=True) == "-O3"

    def _level(self, rung: dict, *, final: bool = False) -> str:
        """gifsicle's optimisation level for this render. `final` asks what
        the answer gets, drafting aside."""
        info = self._info
        if info is None or "width" in rung or self._bytes < GIF_DRAFT_MIN_BYTES:
            return "-O3"  # small: -O3 is quick
        if info.frames * info.width * info.height > GIF_O3_MAX_PIXEL_FRAMES:
            return "-O1"
        if not self.o3_helps():
            return "-O1"
        return "-O3" if final or not self.draft else "-O1"

    def o3_helps(self) -> bool:
        """Whether -O3 shrinks this GIF enough to be worth its time, from a
        small sample (see GIF_O3_SAMPLE_PIXELS). Asked once a run."""
        import math
        import tempfile

        if self._o3_helps is None:
            info, src = self._info, self._src
            assert info is not None and src is not None
            n = min(info.frames, 12)
            scale = min(1.0, math.sqrt(GIF_O3_SAMPLE_PIXELS / (n * info.width * info.height)))
            # A run of frames from the first: a GIF that stores only what
            # changed shows them correctly without the rest.
            args = ["--lossy=60", f"--scale={scale:.4f}"]
            with tempfile.TemporaryDirectory(prefix="fitpdf-gif-") as tmp:
                quick, full = Path(tmp) / "o1.gif", Path(tmp) / "o3.gif"
                try:
                    self._gifsicle(src, quick, ["-O1", *args], timeout=60, selection=[f"#0-{n - 1}"])
                    self._gifsicle(src, full, ["-O3", *args], timeout=60, selection=[f"#0-{n - 1}"])
                    gain = 1 - full.stat().st_size / quick.stat().st_size
                except Exception:
                    gain = 1.0  # unsure: let -O3 decide
            self._o3_helps = gain >= GIF_O3_MIN_GAIN
        return self._o3_helps

    def probe(self, src: Path) -> Probe:
        info = self.info(src)
        warnings: list[str] = []
        if self.resize is not None:
            w, h = self.resize
            if info.frames * w * h > MAX_GIF_EXACT_PIXEL_FRAMES:
                raise ValueError(
                    f"this GIF has {info.frames} frames, too many to resize to {w} x {h}; "
                    "shorten it or choose a smaller size"
                )
            warnings = resize_notes(info.width, info.height, self.resize, self.fit, "see-through")
        return Probe(kind="image", pages=1, width=info.width, height=info.height, warnings=warnings)

    def ensure_available(self) -> None:
        if shutil.which("gifsicle") is None:
            raise RuntimeError(
                "gifsicle is not installed (macOS: brew install gifsicle, "
                "Linux: apt install gifsicle)"
            )

    def lossless_hopeless(self, src: Path, original: int, target: int) -> bool:
        return target < original * GIF_LOSSLESS_REACH

    def lossless(self, src: Path, dst: Path, *, strip_metadata: bool) -> int:
        self.ensure_available()
        self.info(src)
        level = self._level({}, final=True)
        self._gifsicle(src, dst, [level, *(GIF_STRIP if strip_metadata else ())], timeout=120)
        self._frames[dst] = self.info(src).frames
        return dst.stat().st_size

    def render(self, src: Path, dst: Path, rung: dict, *, timeout: int) -> int:
        info = self.info(src)
        size = (rung["width"], rung["height"]) if "width" in rung else None
        step = rung.get("frame_step", 1) if info.frames > 1 else 1
        scale = 1.0
        if size is None and rung.get("scale", 1.0) < 1.0:
            # Never below 16 px on the short side.
            scale = min(1.0, max(rung["scale"], 16 / max(1, min(info.width, info.height))))
        args = [self._level(rung), *GIF_STRIP]
        if rung["lossy"]:
            args.append(f"--lossy={rung['lossy']}")
        if rung["colors"] < 256:
            args += ["--colors", str(rung["colors"])]
        notes: list[str] = []
        if size is None:
            source, frames = src, info
            if scale < 1.0:
                # gifsicle scales an animation correctly frame by frame.
                args += ["--scale", f"{scale:.4f}"]
            if step > 1:
                source = self._whole_frames(src, dst.parent)
        else:
            source = self._fitted(src, dst.parent, size)
            # Pillow merges frames that came out identical, adding up their
            # delays, so the fitted copy can have fewer frames.
            frames = read_gif(source)
        selection: list[str] = []
        if step > 1 and frames.frames > 1:
            # Each kept frame shows for the frames it stands in for, so the
            # animation keeps its length and speed.
            for i in range(0, frames.frames, step):
                selection += ["-d", str(sum(frames.delays[i : i + step])), f"#{i}"]
            which = {2: "every other frame"}.get(step, f"one frame in {step}")
            notes.append(f"kept {which} to fit; it plays at the same speed")
        self._gifsicle(source, dst, args, timeout=timeout, selection=selection)
        self._frames[dst] = len(range(0, frames.frames, step)) if selection else frames.frames
        self._notes[dst] = notes
        return dst.stat().st_size

    def _gifsicle(
        self, src: Path, dst: Path, args: list[str], *, timeout: int, selection: list[str] = ()
    ) -> None:
        import subprocess

        done = subprocess.run(
            ["gifsicle", "--no-warnings", *args, str(src), *selection, "-o", str(dst)],
            capture_output=True, timeout=timeout, check=False,
        )
        if done.returncode != 0:
            raise RuntimeError(f"gifsicle failed: {done.stderr.decode(errors='replace')[:200]}")

    def _whole_frames(self, src: Path, workdir: Path) -> Path:
        """src with every frame stored whole, so frames can be dropped.

        A GIF usually stores each frame as only what changed since the last,
        and dropping frames from that loses their changes: the kept frames
        show the wrong picture. gifsicle's -U stores each one whole, once the
        frames share one palette (it refuses some GIFs with a palette per
        frame). Made once a run.
        """
        out = workdir / "whole-frames.gif"
        if not out.exists():
            shared = workdir / "shared-palette.gif"
            self._gifsicle(src, shared, ["--colors", "256"], timeout=120)
            self._gifsicle(shared, out, ["-U"], timeout=120)
            shared.unlink(missing_ok=True)
        return out

    def _fitted(self, src: Path, workdir: Path, size: tuple[int, int]) -> Path:
        """src with every frame cropped or padded to `size`, made once a run.

        In Pillow, whose decoder hands back every frame whole, with
        fit_exact, so a crop lands where the visitor put the crop box,
        exactly as for a photo. Each frame is saved whole (disposal 2), so
        frames can be dropped from it too.
        """
        from PIL import Image

        out = workdir / f"fitted-{size[0]}x{size[1]}.gif"
        if out.exists():
            return out
        info = self.info(src)

        def frames():
            with Image.open(src) as im:
                for i in range(info.frames):
                    im.seek(i)
                    yield fit_exact(im.convert("RGBA"), size, self.fit, self.focus, SEE_THROUGH)

        # Streamed: Pillow keeps each frame as it encodes it, a byte a pixel,
        # rather than the four of every decoded frame held at once.
        stream = frames()
        first = next(stream)
        first.save(
            out, "GIF", save_all=True, append_images=stream,
            duration=[d * 10 for d in info.delays], disposal=2,
            **({"loop": info.loop} if info.loop is not None else {}),
        )
        return out

    def notes_for(self, out: Path) -> list[str]:
        """What a render gave up beyond quality, for the result's warnings."""
        return self._notes.get(out, [])

    def validate(self, out: Path, probe: Probe) -> bool:
        try:
            got = read_gif(out)
        except (OSError, ValueError):
            return False
        expected = self._frames.get(out)
        return expected is None or got.frames == expected

    def output_suffix(self, src: Path, lossy: bool) -> str:
        return ".gif"


def pad_gif(path: Path, min_bytes: int) -> int:
    """Grow a GIF to at least min_bytes with a comment, as pad_jpeg does a JPEG.

    A comment extension, which every decoder skips, goes just before the
    trailer. Returns the new size.
    """
    data = path.read_bytes()
    need = min_bytes - len(data)
    if need <= 0 or data[-1:] != b";":
        return len(data)
    comment = bytearray(b"\x21\xfe")
    need -= 3  # the extension's two bytes and its terminator
    while need > 0:
        n = min(255, max(1, need - 1))
        comment += bytes([n]) + b" " * n
        need -= n + 1
    comment += b"\x00"
    path.write_bytes(data[:-1] + bytes(comment) + b";")
    return path.stat().st_size


# --------------------------------------------------------------------------- #


def _to_srgb(im, icc: bytes | None):
    """im in sRGB, for a JPEG that carries no profile.

    iPhone photos, HEIC and JPEG alike, are Display P3. The rungs write JPEGs
    without a profile, which every viewer and upload validator reads as sRGB,
    so P3 numbers left as they are come out dull. Anything already sRGB, or
    without a profile, or in a mode the colour engine does not take, is left
    alone.
    """
    if not icc or im.mode not in ("RGB", "RGBA"):
        return im
    from io import BytesIO

    from PIL import ImageCms

    try:
        profile = ImageCms.ImageCmsProfile(BytesIO(icc))
        if "srgb" in ImageCms.getProfileDescription(profile).lower():
            return im
        return ImageCms.profileToProfile(
            im, profile, ImageCms.createProfile("sRGB"), outputMode=im.mode
        )
    except Exception:
        return im  # a broken profile is not worth failing the run over

def detect_strategy(
    src: Path | str,
    resize: tuple[int, int] | None = None,
    fit: str = "crop",
    focus: tuple[float, float] | None = None,
) -> Strategy:
    """Pick a strategy from the file extension, falling back to sniffing.

    `resize`, `fit` and `focus` go to an image strategy (see ImageStrategy).
    """
    src = Path(src)
    suffix = src.suffix.lower()
    if suffix in PDF_SUFFIXES:
        return PdfStrategy()
    if suffix in GIF_SUFFIXES:
        return GifStrategy(resize, fit, focus)
    if suffix in IMAGE_SUFFIXES:
        return ImageStrategy(resize, fit, focus)

    # No usable extension (the web layer stores uploads under a fixed name):
    # sniff the magic bytes instead.
    with src.open("rb") as f:
        head = f.read(12)
    if head.startswith(b"%PDF"):
        return PdfStrategy()
    if head.startswith((b"GIF87a", b"GIF89a")):
        return GifStrategy(resize, fit, focus)
    return ImageStrategy(resize, fit, focus)


def pad_jpeg(path: Path, min_bytes: int) -> int:
    """Grow a JPEG to at least min_bytes with comment blocks. Returns the new size.

    Some upload forms set a minimum size as well as a maximum (a signature
    "between 10 and 20 KB"), and a small image at its required pixel size can
    come out under it. JPEG comment segments (COM) are skipped by every
    decoder, so the picture is exactly as it was; only the byte count rises.
    They go after the APPn headers (JFIF, EXIF), where a strict reader expects
    them, and may overshoot the minimum by at most three bytes.
    """
    data = path.read_bytes()
    need = min_bytes - len(data)
    if need <= 0 or data[:2] != b"\xff\xd8":
        return len(data)
    at = 2
    while at + 4 <= len(data) and data[at] == 0xFF and 0xE0 <= data[at + 1] <= 0xEF:
        at += 2 + int.from_bytes(data[at + 2 : at + 4], "big")
    blocks = bytearray()
    while need > 0:
        payload = min(65533, max(0, need - 4))  # a segment is 4 bytes plus its payload
        blocks += b"\xff\xfe" + (payload + 2).to_bytes(2, "big") + b" " * payload
        need -= 4 + payload
    path.write_bytes(data[:at] + bytes(blocks) + data[at:])
    return path.stat().st_size


def copy_through(src: Path, dst: Path) -> int:
    shutil.copyfile(src, dst)
    return dst.stat().st_size
