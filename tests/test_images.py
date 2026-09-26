"""Image compression: the same search harness, a Pillow strategy underneath."""

import pytest
from PIL import Image

from fitpdf.engine import analyze, compress_to_target, estimate_floor
from fitpdf.strategies import IMAGE_RUNGS, ImageStrategy, PdfStrategy, detect_strategy


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


def test_transparency_warning_is_raised(transparent_png, tmp_path):
    result = compress_to_target(
        transparent_png, tmp_path / "out.png", transparent_png.stat().st_size // 10
    )
    assert any("see-through parts are now white" in w for w in result.warnings)


def test_an_opaque_png_with_an_alpha_channel_gets_no_transparency_warning(
    photo_jpg, tmp_path
):
    # Most screenshots are RGBA with every pixel solid: nothing turns white.
    png = tmp_path / "screenshot.png"
    Image.open(photo_jpg).convert("RGBA").save(png, "PNG")
    assert ImageStrategy().probe(png).warnings == []
    result = compress_to_target(png, tmp_path / "out.png", png.stat().st_size // 20)
    assert not any("see-through" in w for w in result.warnings)
    assert any(w.startswith("saved as a JPG: as a PNG") for w in result.warnings)


def test_transparency_is_known_without_a_render(transparent_png, tmp_path):
    # A target below the floor is answered by the analyze step's render
    # alone, so this run never decodes the source itself.
    strategy = ImageStrategy()
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


def test_lossy_output_is_rejigged_to_jpg(transparent_png, tmp_path):
    """A PNG in gives a JPEG out, so the caller's .png name must not be trusted."""
    # small enough that the lossless PNG pass cannot possibly win
    result = compress_to_target(transparent_png, tmp_path / "out.png", 4_000)
    assert result.output.suffix == ".jpg"
    assert result.output.exists()


def test_a_png_that_becomes_a_jpg_says_so(photo_jpg, tmp_path):
    # An opaque PNG has no transparency warning to mention the change, and a
    # site that only takes PNG would refuse the result without one.
    png = tmp_path / "screenshot.png"
    Image.open(photo_jpg).save(png, "PNG")
    result = compress_to_target(png, tmp_path / "out.png", png.stat().st_size // 20)
    assert result.output.suffix == ".jpg"
    assert any(w.startswith("saved as a JPG: as a PNG") for w in result.warnings)


def test_a_jpg_or_a_transparent_png_gets_no_extra_format_warning(
    photo_jpg, transparent_png, tmp_path
):
    jpg = compress_to_target(photo_jpg, tmp_path / "a.jpg", photo_jpg.stat().st_size // 10)
    assert not any("saved as a JPG" in w for w in jpg.warnings)
    png = compress_to_target(
        transparent_png, tmp_path / "b.png", transparent_png.stat().st_size // 10
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
