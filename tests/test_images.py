"""Image compression: the same search harness, a Pillow strategy underneath."""

import pytest
from PIL import Image

from fitpdf.engine import analyze, compress_to_target, estimate_floor
from fitpdf.strategies import ImageStrategy, PdfStrategy, detect_strategy


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


def test_transparency_warning_is_raised(transparent_png):
    probe = ImageStrategy().probe(transparent_png)
    assert any("transparency" in w for w in probe.warnings)


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
    bigger = ImageStrategy(resize=(6000, 4000)).probe(photo_jpg).warnings
    assert any("enlarged from 3000 x 2000" in w for w in bigger)
    same_shape = ImageStrategy(resize=(600, 400)).probe(photo_jpg).warnings
    assert same_shape == []


def test_resize_rejects_bad_settings():
    with pytest.raises(ValueError):
        ImageStrategy(resize=(0, 100))
    with pytest.raises(ValueError):
        ImageStrategy(resize=(100, 100), fit="stretch")
