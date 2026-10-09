"""Image compression: the same search harness, a Pillow strategy underneath."""

import pytest
from pathlib import Path
from PIL import Image

from fitpdf.engine import analyze, compress_to_target, estimate_floor
from fitpdf.strategies import IMAGE_RUNGS, ImageStrategy, PdfStrategy, detect_strategy

# Under every 256-colour PNG of the photo_png fixture, over its JPEGs.
PHOTO_PNG_LIMIT = 40_000


def test_detect_strategy_by_extension(photo_jpg, transparent_png, image_pdf):
    assert isinstance(detect_strategy(photo_jpg), ImageStrategy)
    assert isinstance(detect_strategy(transparent_png), ImageStrategy)
    assert isinstance(detect_strategy(image_pdf), PdfStrategy)


def test_detect_strategy_sniffs_when_extension_is_useless(photo_jpg, image_pdf, tmp_path):
    """The web layer stores uploads under a fixed name, so sniffing has to work."""
    blob_pdf = tmp_path / "upload"
    blob_pdf.write_bytes(image_pdf.read_bytes())
    assert isinstance(detect_strategy(blob_pdf), PdfStrategy)

    blob_img = tmp_path / "upload2"
    blob_img.write_bytes(photo_jpg.read_bytes())
    assert isinstance(detect_strategy(blob_img), ImageStrategy)


def test_analyze_image(photo_jpg):
    a = analyze(photo_jpg)
    assert a.kind == "image"
    assert a.pages == 1
    assert (a.width, a.height) == (3000, 2000)
    assert a.image_share == 1.0


def test_lossless_keeps_pixels_and_drops_metadata(photo_jpg, tmp_path):
    out = tmp_path / "out.jpg"
    size = ImageStrategy().lossless(photo_jpg, out, strip_metadata=True)
    assert size > 0
    with Image.open(out) as im:
        # quality="keep" reuses the DCT coefficients, so dimensions are intact
        assert im.size == (3000, 2000)
        assert not im.getexif()


def test_hits_target(photo_jpg, tmp_path):
    original = photo_jpg.stat().st_size
    target = int(original * 0.25)
    result = compress_to_target(photo_jpg, tmp_path / "out.jpg", target)
    assert result.hit_target, f"floor was {result.final_bytes} vs target {target}"
    assert result.final_bytes <= target
    assert result.kind == "image"
    with Image.open(result.output) as im:
        assert im.format == "JPEG"


def test_impossible_target_reports_floor(photo_jpg, tmp_path):
    result = compress_to_target(photo_jpg, tmp_path / "out.jpg", 500)
    assert not result.hit_target
    assert result.method == "floor"
    assert result.output.exists()
    assert result.final_bytes < result.original_bytes
    assert any("floor" in w for w in result.warnings)


def test_progress_events_carry_image_rung_settings(photo_jpg, tmp_path):
    events = []
    target = int(photo_jpg.stat().st_size * 0.25)
    compress_to_target(photo_jpg, tmp_path / "out.jpg", target, on_progress=events.append)
    starts = [e for e in events if e["stage"] == "rung_start"]
    results = [e for e in events if e["stage"] == "rung_result"]
    assert starts and len(starts) == len(results)
    # image rungs, not PDF ones
    assert all("max_edge" in e and "quality" in e for e in starts)
    assert any(e["fits"] for e in results)


def test_binary_search_beats_linear(photo_jpg, tmp_path):
    """12 rungs must be searched in at most 4 renders, not 12."""
    events = []
    target = int(photo_jpg.stat().st_size * 0.25)
    compress_to_target(photo_jpg, tmp_path / "out.jpg", target, on_progress=events.append)
    renders = [e for e in events if e["stage"] == "rung_start"]
    assert len(renders) <= 4


def test_transparency_warning_is_raised(transparent_photo_png, tmp_path):
    result = compress_to_target(
        transparent_photo_png, tmp_path / "out.png", PHOTO_PNG_LIMIT, allow_jpeg=True
    )
    assert result.output.suffix == ".jpg"
    assert any("see-through parts are now white" in w for w in result.warnings)


def test_an_opaque_png_with_an_alpha_channel_gets_no_transparency_warning(
    photo_png, tmp_path
):
    # Most screenshots are RGBA with every pixel solid: nothing turns white.
    png = tmp_path / "screenshot.png"
    Image.open(photo_png).convert("RGBA").save(png, "PNG")
    assert ImageStrategy().probe(png).warnings == []
    result = compress_to_target(png, tmp_path / "out.png", PHOTO_PNG_LIMIT, allow_jpeg=True)
    assert not any("see-through" in w for w in result.warnings)
    assert any(w.startswith("saved as a JPG: as a PNG") for w in result.warnings)


def test_transparency_is_known_without_a_render(transparent_png, tmp_path):
    # A target below the floor is answered by the analyze step's render
    # alone, so this run never decodes the source itself. (Its PNG ladder
    # would decode it, so this run goes straight to JPEG.)
    strategy = ImageStrategy()
    strategy.native_first = lambda src: False
    floor = tmp_path / "floor.jpg"
    ImageStrategy().render(transparent_png, floor, IMAGE_RUNGS[-1], timeout=60)
    result = compress_to_target(
        transparent_png, tmp_path / "out.png", 100, strategy=strategy,
        prerendered={len(IMAGE_RUNGS) - 1: floor},
    )
    assert result.method == "floor"
    assert any("see-through parts are now white" in w for w in result.warnings)


def test_transparency_is_flattened_onto_white(transparent_png, tmp_path):
    """JPEG has no alpha. Dropping the channel naively gives black fringing."""
    out = tmp_path / "flat.jpg"
    ImageStrategy().render(transparent_png, out, {"max_edge": 4000, "quality": 85}, timeout=60)
    with Image.open(out) as im:
        assert im.mode == "RGB"
        # the fully transparent corner should have become white, not black
        assert im.getpixel((0, 0)) == (255, 255, 255)


def test_lossy_output_is_rejigged_to_jpg(photo_png, tmp_path):
    """A PNG that has to become a JPEG must not keep the caller's .png name."""
    result = compress_to_target(photo_png, tmp_path / "out.png", PHOTO_PNG_LIMIT, allow_jpeg=True)
    assert result.output.suffix == ".jpg"
    assert result.output.exists()


def test_a_png_that_becomes_a_jpg_says_so(photo_png, tmp_path):
    # An opaque PNG has no transparency warning to mention the change, and a
    # site that only takes PNG would refuse the result without one.
    result = compress_to_target(photo_png, tmp_path / "out.png", PHOTO_PNG_LIMIT, allow_jpeg=True)
    assert result.hit_target
    assert result.output.suffix == ".jpg"
    assert any(w.startswith("saved as a JPG: as a PNG") for w in result.warnings)


def test_a_graphic_png_stays_a_png_at_full_size(photo_jpg, tmp_path):
    # Flat colours (a screenshot, a cheat sheet): 256 colours hold them, so
    # the result is still a PNG, every pixel kept.
    png = tmp_path / "sheet.png"
    Image.open(photo_jpg).save(png, "PNG")
    result = compress_to_target(png, tmp_path / "out.png", png.stat().st_size // 2)
    assert result.hit_target
    assert result.output.suffix == ".png"
    with Image.open(result.output) as out, Image.open(png) as src:
        assert out.size == src.size
    assert not any("JPG" in w for w in result.warnings)


@pytest.mark.parametrize(
    ("fmt", "suffix", "kwargs"),
    [("WEBP", ".webp", {"quality": 95}), ("TIFF", ".tif", {}), ("BMP", ".bmp", {})],
)
def test_every_format_comes_back_as_itself(photo_jpg, tmp_path, fmt, suffix, kwargs):
    # Not a converter: a WebP, TIFF or BMP that has to shrink stays one.
    src = tmp_path / f"in{suffix}"
    Image.open(photo_jpg).save(src, fmt, **kwargs)
    result = compress_to_target(src, tmp_path / f"out{suffix}", src.stat().st_size // 4)
    assert result.hit_target
    assert result.output.suffix == suffix
    with Image.open(result.output) as out:
        assert out.format == fmt
    assert not any("JPG" in w for w in result.warnings)


def test_a_transparent_webp_keeps_its_transparency(transparent_png, tmp_path):
    webp = tmp_path / "logo.webp"
    Image.open(transparent_png).save(webp, "WEBP", quality=100)
    result = compress_to_target(webp, tmp_path / "out.webp", webp.stat().st_size // 3)
    assert result.output.suffix == ".webp"
    with Image.open(result.output) as out:
        assert out.convert("RGBA").getchannel("A").getextrema()[0] < 255


def test_the_floor_estimate_is_for_the_format_that_comes_back(photo_jpg, tmp_path):
    # A BMP stays a BMP, whose floor is 8-bit pixels: far above what a JPEG
    # of it would reach, and the picker must not offer sizes below it.
    bmp = tmp_path / "shot.bmp"
    Image.open(photo_jpg).save(bmp, "BMP")
    jpg = tmp_path / "shot.jpg"
    Image.open(photo_jpg).save(jpg, "JPEG", quality=95)
    keep = tmp_path / "floor"
    bmp_floor = estimate_floor(bmp, keep=keep)
    assert (tmp_path / "floor.bmp").exists()
    with Image.open(tmp_path / "floor.bmp") as im:
        assert im.format == "BMP" and max(im.size) == 480
    assert bmp_floor > 3 * estimate_floor(jpg)


def _native_ladder(src: Path) -> list[dict]:
    strategy = ImageStrategy()
    assert strategy.native_first(src)
    strategy.use_native(True)
    return strategy.rungs


def test_a_run_reuses_the_native_floor_render(photo_jpg, tmp_path):
    png = tmp_path / "sheet.png"
    Image.open(photo_jpg).save(png, "PNG")
    floor = estimate_floor(png, keep=tmp_path / "floor")
    last = len(_native_ladder(png)) - 1
    events = []
    result = compress_to_target(
        png, tmp_path / "out.png", floor // 2,
        prerendered={last: tmp_path / "floor.png"}, on_progress=events.append,
    )
    # Under the floor: answered by the analyze step's render, nothing rendered again.
    assert result.method == "floor" and result.output.suffix == ".png"
    assert result.final_bytes == floor
    assert not any(e["stage"] == "rung_start" for e in events)


def test_an_iphone_heic_always_comes_back_as_an_upright_jpeg(iphone_heic, tmp_path):
    # Even far under the limit: handing back the original would hand back
    # a HEIC, which almost no upload form accepts.
    result = compress_to_target(iphone_heic, tmp_path / "out.heic", iphone_heic.stat().st_size * 10)
    assert result.hit_target and result.output.suffix == ".jpg"
    with Image.open(result.output) as out:
        assert out.format == "JPEG"
        assert out.size == (1200, 1600)  # portrait, turned once, full size kept
    assert any(w == "converted from HEIC to JPEG" for w in result.warnings)


def test_an_unreadable_heic_says_what_to_do(iphone_heic, tmp_path, monkeypatch):
    def fail(*args, **kwargs):
        raise ValueError("Decoder plugin generated an error")

    monkeypatch.setattr(ImageStrategy, "_decoded", fail)
    with pytest.raises(RuntimeError, match=r"HEIC.*could not be read"):
        compress_to_target(iphone_heic, tmp_path / "out.heic", 60_000)


def test_a_heic_under_a_tight_limit_fits_as_a_jpeg(iphone_heic, tmp_path):
    result = compress_to_target(iphone_heic, tmp_path / "out.heic", 60_000)
    assert result.hit_target and result.output.suffix == ".jpg"
    assert result.final_bytes <= 60_000


def test_display_p3_colours_are_converted_to_srgb(tmp_path):
    # iPhone photos carry a Display P3 profile; the result has none, so its
    # numbers must be sRGB or it looks dull everywhere.
    p3 = Path("/System/Library/ColorSync/Profiles/Display P3.icc")
    if not p3.exists():
        pytest.skip("needs the Display P3 profile macOS ships")
    src = tmp_path / "p3.jpg"
    Image.new("RGB", (1200, 900), (60, 170, 90)).save(src, "JPEG", quality=95, icc_profile=p3.read_bytes())
    result = compress_to_target(src, tmp_path / "out.jpg", 5_000)
    assert result.method.startswith("rung:") or result.method == "floor"
    with Image.open(result.output) as out:
        r, g, b = out.convert("RGB").getpixel((600, 450))
    # That P3 green in sRGB numbers is (0, 173, 80): red all but gone.
    assert r < 20 and 165 <= g <= 180, (r, g, b)


def test_the_lossless_pass_keeps_a_colour_profile(tmp_path):
    # Same pixels, same profile: dropping an iPhone photo's P3 tag dulls it.
    p3 = Path("/System/Library/ColorSync/Profiles/Display P3.icc")
    if not p3.exists():
        pytest.skip("needs the Display P3 profile macOS ships")
    for fmt, name in (("JPEG", "a.jpg"), ("PNG", "a.png")):
        src = tmp_path / name
        Image.effect_noise((600, 400), 40).convert("RGB").save(src, fmt, icc_profile=p3.read_bytes())
        out = tmp_path / ("l" + name)
        ImageStrategy().lossless(src, out, strip_metadata=True)
        with Image.open(out) as im:
            assert im.info.get("icc_profile") == p3.read_bytes(), fmt


def test_a_p3_png_kept_a_png_is_converted_to_srgb(tmp_path):
    p3 = Path("/System/Library/ColorSync/Profiles/Display P3.icc")
    if not p3.exists():
        pytest.skip("needs the Display P3 profile macOS ships")
    src = tmp_path / "shot.png"
    im = Image.new("RGB", (1200, 900), (60, 170, 90))
    im.paste(Image.effect_noise((600, 900), 60).convert("RGB"), (0, 0))  # too busy for lossless
    im.save(src, "PNG", compress_level=0, icc_profile=p3.read_bytes())
    result = compress_to_target(src, tmp_path / "out.png", src.stat().st_size // 50)
    assert result.output.suffix == ".png" and result.method != "lossless"
    with Image.open(result.output) as out:
        w, h = out.size
        r, g, b = out.convert("RGB").getpixel((w * 3 // 4, h // 2))  # the flat green half
    assert r < 20 and 165 <= g <= 180, (r, g, b)


def test_a_transparent_png_keeps_its_transparency(transparent_png, tmp_path):
    result = compress_to_target(
        transparent_png, tmp_path / "out.png", transparent_png.stat().st_size // 2
    )
    assert result.output.suffix == ".png"
    with Image.open(result.output) as out:
        assert out.convert("RGBA").getchannel("A").getextrema()[0] < 255
    assert not any("see-through" in w for w in result.warnings)


def test_a_png_that_cannot_fit_stays_a_png_at_its_floor(photo_png, tmp_path):
    # Not a converter: a PNG comes back a PNG, as small as it goes.
    result = compress_to_target(photo_png, tmp_path / "out.png", PHOTO_PNG_LIMIT)
    assert result.needs_jpeg
    assert not result.hit_target and result.method == "floor"
    assert result.output.suffix == ".png"
    assert not any("JPG" in w for w in result.warnings)


def test_keep_png_false_goes_straight_to_jpeg(photo_jpg, tmp_path):
    # An API caller who asks for JPEG: no PNG is searched even though one would fit.
    png = tmp_path / "sheet.png"
    Image.open(photo_jpg).save(png, "PNG")
    events = []
    result = compress_to_target(
        png, tmp_path / "out.png", png.stat().st_size // 2, allow_jpeg=True, keep_png=False,
        on_progress=events.append,
    )
    assert result.output.suffix == ".jpg"
    assert not any("colors" in e for e in events if e["stage"] == "rung_start")


def test_a_png_that_must_stay_a_png_never_lets_pngquant_give_up(photo_png, tmp_path, monkeypatch):
    # Giving up would leave the file at its original size, since no JPEG
    # follows; so pngquant gets no quality floor.
    import shutil
    import subprocess

    fake = tmp_path / "pngquant"
    fake.write_text("#!/bin/sh\nexit 1\n")
    fake.chmod(0o755)
    monkeypatch.setattr(shutil, "which", lambda name: str(fake) if name == "pngquant" else None)
    calls = []
    monkeypatch.setattr(
        subprocess, "run", lambda args, **k: calls.append(args) or subprocess.CompletedProcess(args, 1, b"", b"")
    )
    compress_to_target(photo_png, tmp_path / "out.png", PHOTO_PNG_LIMIT)
    assert calls and not any("--quality" in c for c in calls)


def test_pngquant_refusing_a_photo_skips_the_rest_of_the_png_ladder(
    photo_png, tmp_path, monkeypatch
):
    # pngquant exits 99 when 256 colours would look bad; that is about the
    # picture, not its size, so no smaller PNG is tried.
    import shutil
    import subprocess

    fake = tmp_path / "pngquant"
    fake.write_text("#!/bin/sh\nexit 99\n")
    fake.chmod(0o755)
    monkeypatch.setattr(shutil, "which", lambda name: str(fake) if name == "pngquant" else None)
    calls = []
    real_run = subprocess.run
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: calls.append(a) or real_run(*a, **k))
    events = []
    result = compress_to_target(
        photo_png, tmp_path / "out.png", PHOTO_PNG_LIMIT, allow_jpeg=True, on_progress=events.append
    )
    assert len(calls) == 1
    assert result.output.suffix == ".jpg" and result.hit_target


def test_a_jpg_or_a_transparent_png_gets_no_extra_format_warning(
    photo_jpg, transparent_photo_png, tmp_path
):
    jpg = compress_to_target(photo_jpg, tmp_path / "a.jpg", photo_jpg.stat().st_size // 10)
    assert not any("saved as a JPG" in w for w in jpg.warnings)
    png = compress_to_target(
        transparent_photo_png, tmp_path / "b.png", PHOTO_PNG_LIMIT, allow_jpeg=True
    )
    assert sum("JPG" in w for w in png.warnings) == 1


def test_already_under_target_copies(photo_jpg, tmp_path):
    original = photo_jpg.stat().st_size
    result = compress_to_target(photo_jpg, tmp_path / "out.jpg", original * 10)
    assert result.hit_target
    assert result.method == "none"
    assert result.output.stat().st_size == original


def test_estimate_floor(photo_jpg):
    floor = estimate_floor(photo_jpg)
    assert 0 < floor < photo_jpg.stat().st_size


def test_image_path_needs_no_ghostscript(photo_jpg, tmp_path, monkeypatch):
    """Images must not depend on Ghostscript being installed."""
    monkeypatch.setattr("fitpdf.strategies.gs_available", lambda: False)
    result = compress_to_target(photo_jpg, tmp_path / "out.jpg", 60_000)
    assert result.final_bytes <= 60_000


# --------------------------------------------------------------------------- #
# Exact pixel size

def test_resize_hits_exact_dimensions_and_target(photo_jpg, tmp_path):
    strategy = ImageStrategy(resize=(200, 230))
    result = compress_to_target(photo_jpg, tmp_path / "out.jpg", 20_000, strategy=strategy)
    assert result.hit_target
    assert result.final_bytes <= 20_000
    with Image.open(result.output) as im:
        assert im.format == "JPEG"
        assert im.size == (200, 230)


def test_resize_applies_even_when_the_file_already_fits(photo_jpg, tmp_path):
    """A form that wants 200 x 230 wants it whatever the file size."""
    events = []
    strategy = ImageStrategy(resize=(200, 230))
    result = compress_to_target(
        photo_jpg, tmp_path / "out.jpg", photo_jpg.stat().st_size * 10,
        strategy=strategy, on_progress=events.append,
    )
    assert result.method.startswith("rung:")
    assert not any(e["stage"] == "lossless" for e in events)
    with Image.open(result.output) as im:
        assert im.size == (200, 230)


def test_resize_keeps_the_gentlest_quality_that_fits(photo_jpg, tmp_path):
    events = []
    strategy = ImageStrategy(resize=(400, 300))
    compress_to_target(
        photo_jpg, tmp_path / "out.jpg", 10**9, strategy=strategy, on_progress=events.append
    )
    starts = [e for e in events if e["stage"] == "rung_start"]
    assert all(e["width"] == 400 and e["height"] == 300 for e in starts)
    # Everything fits, so the search ends on the first, highest-quality rung.
    assert min(e["rung"] for e in starts) == 0


def test_resize_pad_keeps_the_whole_image_on_white(photo_jpg, tmp_path):
    # photo_jpg is 3:2 landscape; a square frame leaves bands top and bottom.
    out = tmp_path / "pad.jpg"
    strategy = ImageStrategy(resize=(300, 300), fit="pad")
    strategy.render(photo_jpg, out, strategy.rungs[0], timeout=60)
    with Image.open(out) as im:
        assert im.size == (300, 300)
        r, g, b = im.getpixel((150, 5))
        assert min(r, g, b) > 245


def test_keep_format_makes_a_see_through_png_at_an_exact_size(transparent_png, tmp_path):
    """A Discord emoji: 128 x 128, still a PNG, still see-through."""
    strategy = ImageStrategy(resize=(128, 128), keep_format=True)
    result = compress_to_target(transparent_png, tmp_path / "out", 256_000, strategy=strategy)
    assert result.hit_target
    with Image.open(result.output) as im:
        assert im.format == "PNG"
        assert im.size == (128, 128)
        assert im.convert("RGBA").getchannel("A").getextrema()[0] < 255
    assert not any("white" in w for w in result.warnings)


def test_keep_format_pads_a_png_with_a_see_through_border(photo_png, tmp_path):
    strategy = ImageStrategy(resize=(300, 300), fit="pad", keep_format=True)
    result = compress_to_target(photo_png, tmp_path / "out", 10**9, strategy=strategy)
    with Image.open(result.output) as im:
        assert im.format == "PNG"
        assert im.size == (300, 300)
        assert im.convert("RGBA").getpixel((150, 2))[3] == 0
    assert any("see-through border" in w for w in result.warnings)


def test_keep_format_keeps_a_webp_a_webp(photo_jpg, tmp_path):
    webp = tmp_path / "photo.webp"
    with Image.open(photo_jpg) as im:
        im.save(webp, "WEBP", quality=90)
    strategy = ImageStrategy(resize=(200, 230), keep_format=True)
    result = compress_to_target(webp, tmp_path / "out", 20_000, strategy=strategy)
    assert result.hit_target and result.final_bytes <= 20_000
    with Image.open(result.output) as im:
        assert im.format == "WEBP"
        assert im.size == (200, 230)


def test_an_exact_size_without_keep_format_is_still_a_jpeg(transparent_png, tmp_path):
    """Exam and ID forms that ask for pixels ask for JPEG, and so does the API by default."""
    strategy = ImageStrategy(resize=(128, 128))
    result = compress_to_target(transparent_png, tmp_path / "out", 256_000, strategy=strategy)
    with Image.open(result.output) as im:
        assert im.format == "JPEG"


def test_resize_crop_cuts_where_the_focus_says(tmp_path):
    # Left half red, right half blue: a square crop of this 2:1 picture keeps
    # one half or the other, depending on where it cuts from.
    src = tmp_path / "halves.png"
    im = Image.new("RGB", (400, 200), (220, 0, 0))
    im.paste((0, 0, 220), (200, 0, 400, 200))
    im.save(src)

    def middle(focus):
        out = tmp_path / "out.jpg"
        strategy = ImageStrategy(resize=(100, 100), focus=focus)
        strategy.render(src, out, strategy.rungs[0], timeout=60)
        with Image.open(out) as res:
            return res.getpixel((50, 50))

    assert middle((0, 0.5))[0] > 200  # red: the left edge kept
    assert middle((1, 0.5))[2] > 200  # blue: the right edge kept


def test_resize_notes_say_what_happened_to_the_picture(photo_jpg):
    crop = ImageStrategy(resize=(200, 200)).probe(photo_jpg).warnings
    assert any("trimmed about 33% of the width" in w for w in crop)
    pad = ImageStrategy(resize=(200, 200), fit="pad").probe(photo_jpg).warnings
    assert any("white border" in w for w in pad)
    bigger = ImageStrategy(resize=(3900, 2600)).probe(photo_jpg).warnings
    assert any("enlarged from 3000 x 2000" in w for w in bigger)
    same_shape = ImageStrategy(resize=(600, 400)).probe(photo_jpg).warnings
    assert same_shape == []


def test_resize_rejects_bad_settings():
    with pytest.raises(ValueError):
        ImageStrategy(resize=(0, 100))
    with pytest.raises(ValueError):
        # Past the cap: a tiny upload must not become a huge enlargement.
        ImageStrategy(resize=(4001, 100))
    with pytest.raises(ValueError):
        ImageStrategy(resize=(100, 100), fit="stretch")
    with pytest.raises(ValueError):
        ImageStrategy(resize=(100, 100), focus=(0.5, 1.5))


# --------------------------------------------------------------------------- #
# Speed: work shared across the rungs of a run

def test_a_run_decodes_the_source_once(photo_jpg, tmp_path, monkeypatch):
    from PIL import ImageOps

    calls = []
    real = ImageOps.exif_transpose
    monkeypatch.setattr(
        ImageOps, "exif_transpose", lambda im, **kw: calls.append(1) or real(im, **kw)
    )
    # Every rung of this search needs more than half the source's pixels,
    # so all of them share one full-size decode.
    target = int(photo_jpg.stat().st_size * 0.4)
    result = compress_to_target(photo_jpg, tmp_path / "out.jpg", target)
    assert result.rungs_tried > 1
    assert len(calls) == 1


def test_an_exact_size_run_resizes_once(photo_jpg, tmp_path, monkeypatch):
    import fitpdf.strategies as strategies

    calls = []
    real = strategies.fit_exact
    monkeypatch.setattr(strategies, "fit_exact", lambda *a: calls.append(1) or real(*a))
    strategy = ImageStrategy(resize=(200, 230))
    result = compress_to_target(photo_jpg, tmp_path / "out.jpg", 3_000, strategy=strategy)
    assert result.rungs_tried > 1
    assert len(calls) == 1


def test_shrinking_while_decoding_keeps_sizes_exact(tmp_path):
    """Draft decoding must not change the result's dimensions, even for odd
    sizes and a photo stored sideways."""
    src = tmp_path / "sideways.jpg"
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees to view
    Image.linear_gradient("L").resize((4001, 2999)).convert("RGB").save(src, exif=exif)
    # Viewed upright it is 2999 x 4001, so an 800 pixel result can be decoded
    # at half size and a 150 x 200 one at an eighth.
    for rung, expected, reduce in (({"max_edge": 800, "quality": 35}, (600, 800), 2),
                                   ({"max_edge": 2200, "quality": 78}, (1649, 2200), 1)):
        strategy = ImageStrategy()
        out = tmp_path / "o.jpg"
        strategy.render(src, out, rung, timeout=60)
        assert strategy._pixels[("decoded", src)][0] == reduce
        with Image.open(out) as im:
            assert im.size == expected
    out = tmp_path / "fit.jpg"
    strategy = ImageStrategy(resize=(150, 200))
    strategy.render(src, out, strategy.rungs[0], timeout=60)
    assert strategy._pixels[("decoded", src)][0] == 8
    with Image.open(out) as im:
        assert im.size == (150, 200)


def test_a_run_holds_one_decode_even_when_the_decoder_cannot_shrink(tmp_path):
    """A PNG ignores draft mode, so it must not be decoded, and kept, once per
    requested shrink factor."""
    src = tmp_path / "big.png"
    Image.linear_gradient("L").resize((4000, 3000)).convert("RGB").save(src)
    strategy = ImageStrategy()
    for rung in (IMAGE_RUNGS[5], IMAGE_RUNGS[-1], IMAGE_RUNGS[0]):
        strategy.render(src, tmp_path / "o.jpg", rung, timeout=60)
    decodes = [k for k in strategy._pixels if k[0] == "decoded"]
    assert len(decodes) == 1
    assert strategy._pixels[decodes[0]][0] == 1


def test_a_photo_too_big_to_decode_in_full_skips_the_lossless_pass(tmp_path):
    # The pass decodes every pixel; above MAX_DECODE_PIXELS that is too much
    # memory, however close the target, and the ladder decodes it small.
    from fitpdf.strategies import MAX_DECODE_PIXELS

    big = tmp_path / "big.jpg"
    Image.new("RGB", (6000, 4500)).save(big, quality=90)  # 27 MP
    assert 6000 * 4500 > MAX_DECODE_PIXELS
    size = big.stat().st_size
    assert ImageStrategy().lossless_hopeless(big, size, int(size * 0.9))


def test_a_large_webp_skips_the_lossless_pass_and_a_small_one_keeps_it(tmp_path):
    # Lossless WebP at method 6 took 1.4 GB on a 34 MP image.
    big, small = tmp_path / "big.webp", tmp_path / "small.webp"
    Image.new("RGB", (4000, 3500)).save(big, "WEBP")  # 14 MP
    Image.new("RGB", (2000, 1500)).save(small, "WEBP")  # 3 MP
    for path, hopeless in ((big, True), (small, False)):
        size = path.stat().st_size
        assert ImageStrategy().lossless_hopeless(path, size, int(size * 0.97)) is hopeless


def test_a_png_is_shrunk_after_decoding_to_what_the_rung_needs(tmp_path):
    png = tmp_path / "wide.png"
    Image.new("RGB", (4000, 3000), (40, 90, 160)).save(png)
    strategy = ImageStrategy()
    im = strategy._decoded(png, {"max_edge": 800, "quality": 60})
    # Twice the output kept (1600 px), from a box reduce by 2: 2000 px.
    assert im.size == (2000, 1500)


def test_a_minimum_size_pads_a_small_jpeg_without_touching_the_picture(photo_jpg, tmp_path):
    # A signature at a form's 140 x 60 pixels is a few KB; the form wants
    # 10-20 KB. Padding makes it pass and leaves every pixel as it was.
    from fitpdf.strategies import pad_jpeg

    plain = tmp_path / "plain.jpg"
    compress_to_target(photo_jpg, plain, 20_000, strategy=ImageStrategy(resize=(140, 60)))
    padded = compress_to_target(
        photo_jpg, tmp_path / "padded.jpg", 20_000,
        strategy=ImageStrategy(resize=(140, 60)), min_bytes=10_240,
    )
    assert plain.stat().st_size < 10_240
    assert padded.final_bytes == padded.output.stat().st_size
    assert 10_240 <= padded.output.stat().st_size <= 20_000
    with Image.open(plain) as a, Image.open(padded.output) as b:
        assert a.size == b.size == (140, 60)
        assert a.tobytes() == b.tobytes()
    assert any("padded to" in w for w in padded.warnings)
    # Already big enough: left alone.
    before = padded.output.read_bytes()
    assert pad_jpeg(padded.output, 5_000) == len(before)
    assert padded.output.read_bytes() == before


def test_padding_reaches_the_minimum_across_segment_boundaries(photo_jpg, tmp_path):
    from fitpdf.strategies import pad_jpeg

    small = tmp_path / "s.jpg"
    Image.new("RGB", (20, 20)).save(small, quality=50)
    for want in (small.stat().st_size + 1, 70_000, 200_001):
        f = tmp_path / f"p{want}.jpg"
        f.write_bytes(small.read_bytes())
        size = pad_jpeg(f, want)
        assert want <= size <= want + 3
        with Image.open(f) as im:
            im.load()  # still a valid JPEG


def test_the_png_ladder_has_no_rung_the_image_is_too_small_for(photo_jpg):
    # A rung at or above the longest side renders the full-size picture again.
    from fitpdf.strategies import FULL_SIZE

    png = photo_jpg.parent / "ladder.png"
    Image.open(photo_jpg).save(png, "PNG")  # 3000 x 2000
    edges = [r["max_edge"] for r in _native_ladder(png)]
    assert edges[0] == FULL_SIZE
    assert all(e < 3000 for e in edges[1:])
    assert edges[1:] == sorted(edges[1:], reverse=True) and len(set(edges)) == len(edges)


def _pngquant_speeds(monkeypatch) -> list[str]:
    import subprocess

    speeds: list[str] = []
    real_run = subprocess.run

    def run(args, *a, **k):
        if "pngquant" in str(args[0]):
            speeds.append(args[args.index("--speed") + 1])
        return real_run(args, *a, **k)

    monkeypatch.setattr(subprocess, "run", run)
    return speeds


def _proper_sizes(src: Path, tmp_path: Path) -> list[int]:
    """Every rung of src's PNG ladder, rendered properly."""
    strategy = ImageStrategy()
    strategy.native_first(src)
    strategy.use_native(True)
    return [
        strategy.render(src, tmp_path / f"proper{i}.png", rung, timeout=60)
        for i, rung in enumerate(strategy.rungs)
    ]


def _draft_everything(monkeypatch) -> None:
    from fitpdf import strategies

    monkeypatch.setattr(strategies, "DRAFT_MIN_PIXELS", 1)
    monkeypatch.setattr(strategies, "DRAFT_MIN_BYTES", 1)


@pytest.fixture
def sheet_png(photo_jpg, tmp_path) -> Path:
    png = tmp_path / "sheet.png"
    Image.open(photo_jpg).save(png, "PNG")
    return png


def test_big_rungs_are_searched_with_drafts_and_the_answer_rendered_properly(
    sheet_png, tmp_path, monkeypatch
):
    import shutil

    from fitpdf import strategies

    if shutil.which("pngquant") is None:
        pytest.skip("drafts are a pngquant setting")
    proper = _proper_sizes(sheet_png, tmp_path)
    # Between two rungs, so one fits and the gentler one does not.
    target = (proper[3] + proper[2]) // 2
    _draft_everything(monkeypatch)
    speeds = _pngquant_speeds(monkeypatch)
    events = []
    result = compress_to_target(sheet_png, tmp_path / "out.png", target, on_progress=events.append)
    assert result.hit_target and result.method == "rung:3"
    # What comes back is the proper render, byte for byte the size of one.
    assert result.final_bytes == proper[3] == result.output.stat().st_size
    assert strategies.PNGQUANT_DRAFT_SPEED in speeds
    assert speeds[-1] == strategies.PNGQUANT_SPEED
    finals = [e for e in events if e["stage"] == "rung_start" and e.get("final")]
    assert [e["rung"] for e in finals][-1] == 3


def test_a_small_file_is_never_drafted(sheet_png, tmp_path, monkeypatch):
    # Under DRAFT_MIN_PIXELS and DRAFT_MIN_BYTES: every render is a proper one.
    speeds = _pngquant_speeds(monkeypatch)
    events = []
    compress_to_target(sheet_png, tmp_path / "out.png", sheet_png.stat().st_size // 8, on_progress=events.append)
    from fitpdf.strategies import PNGQUANT_SPEED

    assert speeds and set(speeds) == {PNGQUANT_SPEED}
    assert not any(e.get("final") for e in events)


def test_a_proper_render_that_fails_leaves_the_draft_that_fit(sheet_png, tmp_path, monkeypatch):
    import shutil


    if shutil.which("pngquant") is None:
        pytest.skip("drafts are a pngquant setting")
    _draft_everything(monkeypatch)
    real = ImageStrategy._render_png

    def render(self, src, dst, rung, *, timeout):
        if dst.name.startswith("final"):
            raise RuntimeError("pngquant failed")
        return real(self, src, dst, rung, timeout=timeout)

    monkeypatch.setattr(ImageStrategy, "_render_png", render)
    target = sheet_png.stat().st_size // 8
    result = compress_to_target(sheet_png, tmp_path / "out.png", target)
    assert result.hit_target and result.final_bytes <= target
    assert result.output.suffix == ".png"


def test_a_drafted_floor_is_rendered_properly(sheet_png, tmp_path, monkeypatch):
    import shutil


    if shutil.which("pngquant") is None:
        pytest.skip("drafts are a pngquant setting")
    proper = _proper_sizes(sheet_png, tmp_path)
    _draft_everything(monkeypatch)
    result = compress_to_target(sheet_png, tmp_path / "out.png", 1_000)
    assert result.method == "floor" and result.output.suffix == ".png"
    assert result.final_bytes <= proper[-1]


def test_full_size_is_tried_first_even_with_the_analyze_steps_floor(sheet_png, tmp_path):
    # A screenshot or graphic can be smaller at full size than shrunk, since
    # shrinking adds in-between colours; the seeded floor must not skip that.
    floor = estimate_floor(sheet_png, keep=tmp_path / "floor")
    last = len(_native_ladder(sheet_png)) - 1
    events = []
    compress_to_target(
        sheet_png, tmp_path / "out.png", sheet_png.stat().st_size // 2,
        prerendered={last: tmp_path / "floor.png"}, on_progress=events.append,
    )
    assert floor < sheet_png.stat().st_size // 2
    starts = [e["rung"] for e in events if e["stage"] == "rung_start"]
    assert starts[0] == 0


def test_the_lossless_estimate_is_close_to_the_real_pass_on_a_photo(photo_png, tmp_path):
    # Only a big file is estimated, and a big PNG is a photo: a flat graphic
    # compresses to a fraction of that (see ESTIMATE_PNG_BYTES).
    from fitpdf.strategies import estimate_png_lossless

    stored = tmp_path / "stored.png"
    Image.open(photo_png).save(stored, "PNG", compress_level=0)
    for src in (photo_png, stored):
        real = ImageStrategy().lossless(src, tmp_path / "l.png", strip_metadata=True)
        with Image.open(src) as im:
            assert abs(estimate_png_lossless(im) / real - 1) < 0.02, src.name


def test_a_big_png_skips_a_lossless_pass_its_sample_says_cannot_fit(photo_jpg, tmp_path, monkeypatch):
    # The pass costs by the byte (22 s on a 48 MB photo); a sample says first
    # whether it can reach the target at all.
    monkeypatch.setattr(ImageStrategy, "ESTIMATE_PNG_BYTES", 0)
    tight = tmp_path / "tight.png"
    Image.open(photo_jpg).save(tight, "PNG", optimize=True)
    stored = tmp_path / "stored.png"
    Image.open(photo_jpg).save(stored, "PNG", compress_level=0)
    s = ImageStrategy()
    size = tight.stat().st_size
    # Already as small as the pass makes it: 90 percent is out of reach.
    assert s.lossless_hopeless(tight, size, int(size * 0.9))
    # A stored PNG deflates many times over: 70 percent is easily in reach.
    size = stored.stat().st_size
    assert not s.lossless_hopeless(stored, size, int(size * 0.7))


def test_a_drafted_rung_that_just_missed_is_checked_above_a_proper_fit(
    photo_png, tmp_path, monkeypatch
):
    # Only rungs 0 and 1 are big enough to draft (2000 and 1800 px); rung 2
    # renders properly. Drafts here are proper renders padded 5 percent, so
    # with the target at rung 1's proper size its draft misses and rung 2
    # fits; but rung 1 is the answer, and is checked.
    from fitpdf import strategies

    proper = _proper_sizes(photo_png, tmp_path)
    monkeypatch.setattr(strategies, "DRAFT_MIN_BYTES", 1)
    monkeypatch.setattr(strategies, "DRAFT_MIN_PIXELS", 2_000_000)
    monkeypatch.setattr(strategies, "PNGQUANT_DRAFT_SPEED", strategies.PNGQUANT_SPEED)
    real = ImageStrategy._render_png

    def render(self, src, dst, rung, *, timeout):
        size = real(self, src, dst, rung, timeout=timeout)
        if self.is_draft(rung):
            with open(dst, "ab") as f:
                f.write(b"\0" * (size // 20))
            size = dst.stat().st_size
        return size

    monkeypatch.setattr(ImageStrategy, "_render_png", render)
    events = []
    result = compress_to_target(photo_png, tmp_path / "out.png", proper[1], on_progress=events.append)
    assert result.method == "rung:1" and result.final_bytes == proper[1]
    finals = [e["rung"] for e in events if e["stage"] == "rung_start" and e.get("final")]
    assert finals == [1]
