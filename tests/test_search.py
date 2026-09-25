"""The rung search: same answer as a plain bisection, in fewer renders.

A fake strategy stands in for Ghostscript and Pillow so every curve and every
target can be swept in milliseconds. Sizes only fall down the ladder (the
search, like the bisection before it, relies on that), but the curves vary:
steep, gentle, flat stretches, and rungs that fail to render.
"""

import math
from pathlib import Path

import pytest

from fitpdf.engine import compress_to_target
from fitpdf.strategies import Probe


class FakeStrategy:
    kind = "pdf"
    always_render = False

    def __init__(self, sizes: list[int | None], original: int):
        self.sizes = sizes
        self.rungs = [{"i": i} for i in range(len(sizes))]
        self.original = original
        self.renders: list[int] = []

    def probe(self, src: Path) -> Probe:
        return Probe(kind="pdf", pages=1)

    def ensure_available(self) -> None:
        pass

    def lossless(self, src: Path, dst: Path, *, strip_metadata: bool) -> int:
        dst.write_bytes(b"x" * self.original)
        return self.original

    def render(self, src: Path, dst: Path, rung: dict, *, timeout: int) -> int:
        i = rung["i"]
        self.renders.append(i)
        size = self.sizes[i]
        if size is None:
            raise RuntimeError("render failed")
        dst.write_bytes(b"x" * size)
        return size

    def validate(self, out: Path, probe: Probe) -> bool:
        # The real PDF strategy reads probe.pages here. Checking the type
        # catches the engine passing anything else (it once handed over a
        # rung index through a shadowed name, and every PDF render failed).
        assert isinstance(probe, Probe), f"validate got {probe!r}"
        return True

    def output_suffix(self, src: Path, lossy: bool) -> str:
        return ".pdf"


ORIGINAL = 5_000_000  # bigger than every rung, as a real input is


def _source(tmp_path: Path) -> Path:
    src = tmp_path / "in.pdf"
    src.write_bytes(b"x" * ORIGINAL)
    return src


def _bisect_renders(sizes: list[int | None], target: int) -> tuple[int | None, int]:
    """The old search: plain bisection. Returns (fitting rung, renders)."""
    lo, hi, fit, n = 0, len(sizes) - 1, None, 0
    while lo <= hi:
        mid = (lo + hi) // 2
        n += 1
        if sizes[mid] is not None and sizes[mid] <= target:
            fit, hi = mid, mid - 1
        else:
            lo = mid + 1
    return fit, n


def _curves() -> dict[str, list[int | None]]:
    return {
        "exponential": [int(900_000 * 0.8**i) for i in range(12)],
        "steep": [int(4_000_000 * 0.55**i) for i in range(12)],
        "gentle": [int(500_000 * 0.95**i) for i in range(12)],
        "linear": [1_000_000 - 70_000 * i for i in range(12)],
        "plateau": [800_000] * 4 + [int(400_000 * 0.8**i) for i in range(8)],
        "failures": [None, 900_000, 700_000, None, 450_000, 300_000,
                     200_000, 150_000, None, 80_000, 60_000, 50_000],
    }


def _targets(sizes):
    known = sorted({s for s in sizes if s})
    # Every boundary, plus just above and below each size, plus unreachable.
    out = {known[0] - 1, known[-1] + 1}
    for s in known:
        out |= {s, s - 1, s + 1}
    return sorted(t for t in out if t > 0)


@pytest.mark.parametrize("curve", sorted(_curves()))
def test_guided_search_picks_the_same_rung_as_bisection(tmp_path, curve):
    sizes = _curves()[curve]
    src = _source(tmp_path)
    total_guided = total_bisect = 0
    for target in _targets(sizes):
        strategy = FakeStrategy(sizes, original=ORIGINAL)
        result = compress_to_target(src, tmp_path / "out.pdf", target, strategy=strategy)
        expected, bisect_n = _bisect_renders(sizes, target)
        got = int(result.method.split(":")[1]) if result.method.startswith("rung:") else None
        assert got == expected, f"target {target}: rung {got}, bisection says {expected}"
        assert len(set(strategy.renders)) == len(strategy.renders)  # no rung twice
        # Never meaningfully worse than bisection on any single target.
        assert len(strategy.renders) <= bisect_n + 2
        total_guided += len(strategy.renders)
        total_bisect += bisect_n
    assert total_guided <= total_bisect


def test_guided_search_saves_renders_with_a_known_floor(tmp_path):
    # The web flow: the analyze step already rendered the harshest rung.
    sizes = _curves()["exponential"]
    src = _source(tmp_path)
    floor = tmp_path / "floor.pdf"
    floor.write_bytes(b"x" * sizes[-1])
    guided = bisect = 0
    for target in _targets(sizes):
        strategy = FakeStrategy(sizes, original=ORIGINAL)
        compress_to_target(
            src, tmp_path / "out.pdf", target, strategy=strategy,
            prerendered={len(sizes) - 1: floor},
        )
        assert len(sizes) - 1 not in strategy.renders  # the floor is never re-rendered
        guided += len(strategy.renders)
        bisect += _bisect_renders(sizes, target)[1]
    # At least a fifth fewer renders across the sweep, from the floor alone
    # (this fake strategy gives no typical slope; see the next test).
    assert guided <= math.floor(bisect * 0.8), (guided, bisect)


def test_a_typical_slope_makes_the_first_guess_count(tmp_path):
    # With only the floor measured, the strategy's typical per-rung drop aims
    # the first render at the likely boundary instead of the middle.
    sizes = _curves()["exponential"]  # drops by ln(1/0.8) ~ 0.22 per rung
    src = _source(tmp_path)
    floor = tmp_path / "floor.pdf"
    floor.write_bytes(b"x" * sizes[-1])
    guided = bisect = 0
    for target in _targets(sizes):
        strategy = FakeStrategy(sizes, original=ORIGINAL)
        strategy.typical_log_step = 0.21  # what PdfStrategy uses: close, not exact
        result = compress_to_target(
            src, tmp_path / "out.pdf", target, strategy=strategy,
            prerendered={len(sizes) - 1: floor},
        )
        expected, n = _bisect_renders(sizes, target)
        got = int(result.method.split(":")[1]) if result.method.startswith("rung:") else None
        assert got == expected
        guided += len(strategy.renders)
        bisect += n
    assert guided <= math.floor(bisect * 0.6), (guided, bisect)


def test_unreachable_target_costs_no_renders_when_the_floor_is_known(tmp_path):
    sizes = _curves()["exponential"]
    src = _source(tmp_path)
    floor = tmp_path / "floor.pdf"
    floor.write_bytes(b"x" * sizes[-1])
    strategy = FakeStrategy(sizes, original=ORIGINAL)
    result = compress_to_target(
        src, tmp_path / "out.pdf", sizes[-1] - 1, strategy=strategy,
        prerendered={len(sizes) - 1: floor},
    )
    assert strategy.renders == []
    assert result.hit_target is False
    assert result.final_bytes == sizes[-1]
    assert result.method == "floor"


def test_hopeless_lossless_pass_is_skipped_for_a_jpeg(photo_jpg, tmp_path):
    events = []
    compress_to_target(
        photo_jpg, tmp_path / "out.jpg", photo_jpg.stat().st_size // 10,
        on_progress=events.append,
    )
    assert "lossless" not in [e["stage"] for e in events]


def test_lossless_pass_still_runs_when_it_could_reach_the_target(photo_jpg, tmp_path):
    events = []
    compress_to_target(
        photo_jpg, tmp_path / "out.jpg", int(photo_jpg.stat().st_size * 0.8),
        on_progress=events.append,
    )
    assert events[0]["stage"] == "lossless"


def test_lossless_pass_still_runs_for_png_whatever_the_target(transparent_png, tmp_path):
    # PNG, TIFF and BMP can shrink a great deal losslessly; only JPEG is capped.
    events = []
    compress_to_target(
        transparent_png, tmp_path / "out.jpg", transparent_png.stat().st_size // 20,
        on_progress=events.append,
    )
    assert events[0]["stage"] == "lossless"


def test_search_is_announced_with_the_ladder_and_what_is_known(tmp_path):
    sizes = _curves()["exponential"]
    src = _source(tmp_path)
    floor = tmp_path / "floor.pdf"
    floor.write_bytes(b"x" * sizes[-1])
    events = []
    compress_to_target(
        src, tmp_path / "out.pdf", sizes[5], strategy=FakeStrategy(sizes, original=ORIGINAL),
        prerendered={len(sizes) - 1: floor}, on_progress=events.append,
    )
    stages = [e["stage"] for e in events]
    # After the lossless pass, before the first render.
    assert stages.index("search") == stages.index("lossless") + 1
    assert stages.index("search") < stages.index("rung_start")
    search = events[stages.index("search")]
    assert search["rungs"] == len(sizes)
    assert search["known"] == [{"rung": len(sizes) - 1, "size": sizes[-1]}]
