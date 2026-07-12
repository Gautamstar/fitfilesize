import pikepdf
import pytest

from fitpdf.engine import analyze, compress_to_target, estimate_floor, lossless_pass
from fitpdf.gs import gs_available

requires_gs = pytest.mark.skipif(not gs_available(), reason="ghostscript not installed")


def test_analyze_image_pdf(image_pdf):
    a = analyze(image_pdf)
    assert a.pages == 3
    assert not a.encrypted
    assert not a.has_forms
    assert a.image_share > 0.3


def test_analyze_blank_pdf(blank_pdf):
    a = analyze(blank_pdf)
    assert a.pages == 1
    assert a.image_bytes == 0


def test_lossless_output_is_valid(image_pdf, tmp_path):
    out = tmp_path / "out.pdf"
    size = lossless_pass(image_pdf, out)
    assert size > 0
    with pikepdf.open(out) as pdf:
        assert len(pdf.pages) == 3


def test_already_under_target_copies(image_pdf, tmp_path):
    out = tmp_path / "out.pdf"
    original = image_pdf.stat().st_size
    result = compress_to_target(image_pdf, out, original * 10)
    assert result.hit_target
    assert result.method == "none"
    assert out.stat().st_size == original


@requires_gs
def test_hits_target(image_pdf, tmp_path):
    out = tmp_path / "out.pdf"
    original = image_pdf.stat().st_size
    target = int(original * 0.4)
    result = compress_to_target(image_pdf, out, target)
    assert result.hit_target, f"floor was {result.final_bytes} vs target {target}"
    assert result.final_bytes <= target
    assert result.method.startswith("rung:") or result.method == "lossless"
    with pikepdf.open(out) as pdf:
        assert len(pdf.pages) == 3


@requires_gs
def test_progress_callback_reports_rungs(image_pdf, tmp_path):
    out = tmp_path / "out.pdf"
    events = []
    target = int(image_pdf.stat().st_size * 0.4)
    compress_to_target(image_pdf, out, target, on_progress=events.append)
    stages = [e["stage"] for e in events]
    assert "lossless" in stages
    assert "rung_start" in stages
    starts = [e for e in events if e["stage"] == "rung_start"]
    results = [e for e in events if e["stage"] == "rung_result"]
    assert len(starts) == len(results)
    assert all("color_dpi" in e and "jpeg_q" in e for e in starts)
    assert any(e["fits"] for e in results)


@requires_gs
def test_estimate_floor(image_pdf):
    original = image_pdf.stat().st_size
    floor = estimate_floor(image_pdf)
    assert 0 < floor < original


def test_estimate_floor_without_gs(image_pdf, monkeypatch):
    monkeypatch.setattr("fitpdf.engine.gs_available", lambda: False)
    original = image_pdf.stat().st_size
    floor = estimate_floor(image_pdf)
    assert 0 < floor <= original


@requires_gs
def test_impossible_target_reports_floor(image_pdf, tmp_path):
    out = tmp_path / "out.pdf"
    result = compress_to_target(image_pdf, out, 2_000)
    assert not result.hit_target
    assert result.method == "floor"
    assert out.exists()
    assert result.final_bytes < result.original_bytes
    assert any("floor" in w for w in result.warnings)
