"""GIFs: compressed and resized as animated GIFs, timing and looping kept."""

import math
import shutil
from itertools import pairwise
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from fitpdf.engine import compress_to_target
from fitpdf.strategies import (
    GIF_RUNGS,
    GifStrategy,
    detect_strategy,
    gif_too_big,
    pad_gif,
    read_gif,
)

pytestmark = pytest.mark.skipif(shutil.which("gifsicle") is None, reason="gifsicle not installed")


def _clip(path: Path, frames: int = 30, size=(240, 135), delays=None, loop: int | None = 0) -> Path:
    """A video-like clip: a noisy gradient with a subject moving across it."""
    w, h = size
    background = Image.blend(
        Image.effect_noise(size, 60).convert("RGB"),
        Image.linear_gradient("L").resize(size).convert("RGB"),
        0.6,
    )
    pictures = []
    for i in range(frames):
        im = background.copy()
        x = int(w * 0.3 + w * 0.25 * math.sin(i / 4))
        draw = ImageDraw.Draw(im)
        draw.ellipse((x, h // 4, x + w // 4, h // 4 + h // 2), fill=(220, 170, 130))
        # A bar that grows each frame, in the middle so a crop keeps it: no
        # two frames alike, which Pillow would merge into one.
        draw.rectangle((w // 2 - 30, h - 8, w // 2 - 30 + 2 * i + 2, h - 2), fill=(0, 0, 0))
        pictures.append(im)
    extra = {} if loop is None else {"loop": loop}
    pictures[0].save(
        path, save_all=True, append_images=pictures[1:],
        duration=delays or [40 + 10 * (i % 3) for i in range(frames)], **extra,
    )
    return path


def _emoji(path: Path, frames: int = 12) -> Path:
    """A see-through animated emoji, 128 x 128."""
    pictures = []
    for i in range(frames):
        im = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
        r = 40 + i
        ImageDraw.Draw(im).ellipse((64 - r, 64 - r, 64 + r, 64 + r), fill=(255, 205, 40, 255))
        pictures.append(im)
    pictures[0].save(
        path, save_all=True, append_images=pictures[1:], duration=50, loop=0,
        disposal=2, transparency=0,
    )
    return path


def _frames(path: Path) -> list[Image.Image]:
    with Image.open(path) as im:
        out = []
        for i in range(im.n_frames):
            im.seek(i)
            out.append(im.convert("RGBA").copy())
        return out


def test_reads_size_delays_and_loop_without_decoding(tmp_path):
    gif = _clip(tmp_path / "a.gif", frames=5, delays=[40, 50, 60, 70, 80], loop=3)
    info = read_gif(gif)
    assert (info.width, info.height, info.frames) == (240, 135, 5)
    assert info.delays == [4, 5, 6, 7, 8]  # hundredths of a second
    assert info.loop == 3
    assert read_gif(_clip(tmp_path / "once.gif", frames=2, loop=None)).loop is None


def test_refuses_what_is_not_a_whole_gif(tmp_path):
    gif = _clip(tmp_path / "a.gif", frames=3)
    cut = tmp_path / "cut.gif"
    cut.write_bytes(gif.read_bytes()[:400])
    for bad in (cut, tmp_path / "x.gif"):
        if not bad.exists():
            bad.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 20)
        with pytest.raises(ValueError):
            read_gif(bad)


def test_a_gif_is_recognised_by_name_or_by_its_bytes(tmp_path):
    gif = _clip(tmp_path / "a.gif", frames=2)
    nameless = tmp_path / "upload"
    nameless.write_bytes(gif.read_bytes())
    assert isinstance(detect_strategy(gif), GifStrategy)
    assert isinstance(detect_strategy(nameless), GifStrategy)
    assert isinstance(detect_strategy(gif, resize=(128, 128)), GifStrategy)


def test_a_compressed_gif_stays_an_animated_gif_with_its_timing(tmp_path):
    gif = _clip(tmp_path / "a.gif", frames=30, loop=0)
    before = read_gif(gif)
    target = gif.stat().st_size // 4
    result = compress_to_target(gif, tmp_path / "out.gif", target)
    assert result.hit_target and result.output.suffix == ".gif"
    assert result.final_bytes <= target
    after = read_gif(result.output)
    assert after.frames == before.frames
    assert after.delays == before.delays
    assert after.loop == before.loop


def test_dropped_frames_keep_the_length_and_match_their_originals(tmp_path):
    # A big block jumping across a noisy picture: each frame differs a lot
    # from the next, so a frame showing the wrong picture stands out.
    background = Image.effect_noise((240, 135), 40).convert("RGB")
    pictures = []
    for i in range(9):
        im = background.copy()
        ImageDraw.Draw(im).rectangle((i * 22, 20, i * 22 + 60, 115), fill=(200, 40, 40))
        pictures.append(im)
    gif = tmp_path / "a.gif"
    pictures[0].save(gif, save_all=True, append_images=pictures[1:], duration=[30, 40, 50] * 3, loop=0)
    strategy = GifStrategy()
    rung = next(r for r in GIF_RUNGS if r.get("frame_step") == 2)
    out = tmp_path / "half.gif"
    strategy.render(gif, out, {**rung, "lossy": 0, "colors": 256, "scale": 1.0}, timeout=60)
    before, after = read_gif(gif), read_gif(out)
    assert after.frames == 5  # frames 0, 2, 4, 6, 8
    assert sum(after.delays) == sum(before.delays)
    assert after.delays[0] == before.delays[0] + before.delays[1]
    assert strategy.validate(out, strategy.probe(gif))
    assert strategy.notes_for(out) == ["kept every other frame to fit; it plays at the same speed"]
    # Each kept frame shows its own original, not a broken partial update
    # left over from the frames dropped around it. (Not exactly equal: some
    # gifsicle builds merge the frames' palettes, shifting colours slightly.)
    source, kept = _frames(gif), _frames(out)

    def diff(a, b):
        return sum(abs(x - y) for x, y in zip(a.tobytes(), b.tobytes(), strict=True)) / len(a.tobytes())

    for j, frame in enumerate(kept[:-1]):
        own, neighbour = diff(source[2 * j], frame), diff(source[2 * j + 1], frame)
        assert own < 4 and own < neighbour / 2


def test_a_dropped_frame_run_says_so(tmp_path):
    gif = _clip(tmp_path / "a.gif", frames=40)
    # Small enough that only the frame-dropping rungs can reach it.
    floor = GifStrategy().render(gif, tmp_path / "floor.gif", GIF_RUNGS[-1], timeout=60)
    result = compress_to_target(gif, tmp_path / "out.gif", int(floor * 1.05))
    assert result.hit_target
    assert "kept every other frame to fit; it plays at the same speed" in result.warnings


def test_transparency_survives_compression(tmp_path):
    gif = _emoji(tmp_path / "e.gif")
    result = compress_to_target(gif, tmp_path / "out.gif", int(gif.stat().st_size * 0.6))
    assert result.hit_target
    first = _frames(result.output)[0]
    assert first.getpixel((0, 0))[3] == 0  # the corner is still see-through
    assert first.getpixel((first.width // 2, first.height // 2))[3] == 255


@pytest.mark.parametrize("fit", ["crop", "pad"])
def test_an_exact_size_fits_every_frame(tmp_path, fit):
    gif = _clip(tmp_path / "a.gif", frames=12)
    strategy = detect_strategy(gif, resize=(128, 128), fit=fit)
    result = compress_to_target(gif, tmp_path / "out.gif", 256_000, strategy=strategy)
    info = read_gif(result.output)
    assert (info.width, info.height, info.frames) == (128, 128, 12)
    assert info.delays == read_gif(gif).delays
    frames = _frames(result.output)
    if fit == "pad":
        # The 16:9 clip in a square: see-through above and below it.
        assert frames[0].getpixel((64, 2))[3] == 0
        assert "added a see-through border to keep the whole image at 128 x 128 pixels" in result.warnings
    else:
        assert frames[0].getpixel((64, 2))[3] == 255
        assert any(w.startswith("trimmed about 44% of the width") for w in result.warnings)


def test_an_exact_size_is_rendered_even_when_the_file_already_fits(tmp_path):
    gif = _emoji(tmp_path / "e.gif")
    strategy = detect_strategy(gif, resize=(64, 64))
    result = compress_to_target(gif, tmp_path / "out.gif", 1_000_000, strategy=strategy)
    assert read_gif(result.output).width == 64


def test_a_minimum_size_is_met_with_a_comment_and_the_frames_unchanged(tmp_path):
    gif = _emoji(tmp_path / "e.gif")
    padded = tmp_path / "padded.gif"
    padded.write_bytes(gif.read_bytes())
    size = pad_gif(padded, gif.stat().st_size + 5000)
    assert gif.stat().st_size + 5000 <= size <= gif.stat().st_size + 5002
    assert read_gif(padded).delays == read_gif(gif).delays
    assert [f.tobytes() for f in _frames(padded)] == [f.tobytes() for f in _frames(gif)]

    strategy = detect_strategy(gif, resize=(32, 32))
    result = compress_to_target(gif, tmp_path / "out.gif", 50_000, strategy=strategy, min_bytes=20_000)
    assert result.final_bytes >= 20_000
    assert any(w.startswith("padded to") for w in result.warnings)


def test_a_gif_too_long_to_process_is_refused_up_front(tmp_path, monkeypatch):
    gif = _clip(tmp_path / "a.gif", frames=10)
    assert gif_too_big(gif) is None
    monkeypatch.setattr("fitpdf.strategies.MAX_GIF_PIXEL_FRAMES", 9 * 240 * 135)
    assert gif_too_big(gif) == (
        "this GIF is 10 frames of 240 x 135 pixels, more than we can process; "
        "shorten it or make it smaller first"
    )


def test_the_ladder_only_gets_smaller(tmp_path):
    gif = _clip(tmp_path / "a.gif", frames=20)
    strategy = GifStrategy()
    sizes = [
        strategy.render(gif, tmp_path / f"r{i}.gif", rung, timeout=60)
        for i, rung in enumerate(GIF_RUNGS)
    ]
    # Lossy steps can land a hair apart either way on a small clip; overall
    # each step must not grow the file by more than a little.
    assert all(b <= a * 1.03 for a, b in pairwise(sizes))
    assert sizes[-1] < sizes[0] / 5
