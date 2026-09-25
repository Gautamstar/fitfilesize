"""The media-agnostic half: inspection, the target search, and the floor.

Everything that knows about a specific file format lives in strategies.py. What
is left here is the part worth reading: lossless first, then a binary search
over a ladder of increasingly aggressive settings, then an honest report of the
smallest achievable size when the target simply is not reachable.
"""

import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import pikepdf

from .strategies import (
    IMAGE_RUNGS,
    PDF_RUNGS,
    Strategy,
    copy_through,
    detect_strategy,
    lossless_pass,
)

# `RUNGS` is the PDF ladder. Named without a prefix because the CLI and the
# public package API treat PDFs as the default media type.
RUNGS = PDF_RUNGS

__all__ = [
    "IMAGE_RUNGS",
    "PDF_RUNGS",
    "RUNGS",
    "Analysis",
    "CompressResult",
    "analyze",
    "compress_to_target",
    "estimate_floor",
    "lossless_pass",
]


@dataclass
class Analysis:
    kind: str = "pdf"
    """"pdf" or "image"."""
    pages: int = 0
    size_bytes: int = 0
    image_bytes: int = 0
    image_share: float = 0.0
    width: int = 0
    height: int = 0
    has_forms: bool = False
    encrypted: bool = False


@dataclass
class CompressResult:
    output: Path
    original_bytes: int
    final_bytes: int
    target_bytes: int
    hit_target: bool
    method: str
    rungs_tried: int = 0
    warnings: list[str] = field(default_factory=list)
    kind: str = "pdf"

    @property
    def saved_pct(self) -> float:
        if self.original_bytes == 0:
            return 0.0
        return 100.0 * (1 - self.final_bytes / self.original_bytes)


def analyze(path: Path | str) -> Analysis:
    path = Path(path)
    size = path.stat().st_size
    strategy = detect_strategy(path)

    if strategy.kind == "image":
        try:
            probe = strategy.probe(path)
        except Exception:
            return Analysis(kind="image", size_bytes=size)
        return Analysis(
            kind="image",
            pages=1,
            size_bytes=size,
            # An image file is essentially all image data.
            image_bytes=size,
            image_share=1.0,
            width=probe.width,
            height=probe.height,
        )

    try:
        pdf = pikepdf.open(path)
    except pikepdf.PasswordError:
        return Analysis(size_bytes=size, encrypted=True)
    with pdf:
        image_bytes = 0
        seen: set[tuple[int, int]] = set()
        for page in pdf.pages:
            for img in page.get_images().values():
                key = img.objgen
                if key in seen:
                    continue
                seen.add(key)
                try:
                    image_bytes += int(img.stream_dict.get("/Length", 0))
                except (TypeError, ValueError, AttributeError):
                    continue
        return Analysis(
            kind="pdf",
            pages=len(pdf.pages),
            size_bytes=size,
            image_bytes=image_bytes,
            image_share=image_bytes / size if size else 0.0,
            has_forms="/AcroForm" in pdf.Root,
        )


ProgressFn = Callable[[dict], None]


def estimate_floor(src: Path | str, *, timeout: int = 120, keep: Path | str | None = None) -> int:
    """Cheap floor estimate: one render at the harshest rung.

    Used by the web analyze step to bound the target slider before the user
    commits to a full run. The real floor found by compress_to_target can differ
    slightly (it also considers the lossless pass), so treat this as an estimate.

    `keep`, if given, receives a copy of the harshest-rung render when one was
    actually made (not when the estimate fell back to a heuristic). The web
    service passes it on to compress_to_target as `prerendered`, so the run
    starts with that rung measured and never renders it twice.
    """
    src = Path(src)
    original = src.stat().st_size
    strategy = detect_strategy(src)

    try:
        strategy.ensure_available()
    except Exception:
        # No tooling: assume image data compresses away almost entirely and
        # everything else stays.
        a = analyze(src)
        return min(original, max(original - int(a.image_bytes * 0.9), 1024))

    with tempfile.TemporaryDirectory(prefix="fitpdf-") as tmp:
        out = Path(tmp) / f"floor{strategy.output_suffix(src, lossy=True)}"
        try:
            size = strategy.render(src, out, strategy.rungs[-1], timeout=timeout)
            if keep is not None:
                copy_through(out, Path(keep).with_suffix(out.suffix))
            return min(size, original)
        except Exception:
            a = analyze(src)
            return min(original, max(original - int(a.image_bytes * 0.9), 1024))


def _predict_boundary(
    cache: dict[int, tuple[int | None, Path]], target: int, prior_slope: float | None = None
) -> int | None:
    """The rung predicted to be the gentlest that fits, from sizes measured so far.

    Output size falls roughly exponentially down the ladder, so log(size) is
    close to linear in the rung index. Interpolate between the nearest
    measured rungs on either side of the target, or extrapolate from the two
    nearest on one side. With a single measurement, `prior_slope` (the
    strategy's typical drop in log size per rung) stands in for the second
    point. None when there is not enough to go on.
    """
    import math

    points = sorted((i, s) for i, (s, _) in cache.items() if s)
    if len(points) == 1 and prior_slope:
        (i1, s1), = points
        return max(0, math.ceil(i1 + (math.log(s1) - math.log(target)) / prior_slope - 1e-9))
    if len(points) < 2:
        return None
    above = [p for p in points if p[1] > target]
    below = [p for p in points if p[1] <= target]
    if above and below:
        (i1, s1), (i2, s2) = above[-1], below[0]
    elif above:
        (i1, s1), (i2, s2) = above[-2], above[-1]
    else:
        (i1, s1), (i2, s2) = below[0], below[1]
    if i1 == i2 or s1 <= s2:
        return None  # flat or rising: no usable slope
    slope = (math.log(s1) - math.log(s2)) / (i2 - i1)
    crossing = i1 + (math.log(s1) - math.log(target)) / slope
    return max(0, math.ceil(crossing - 1e-9))


def compress_to_target(
    src: Path | str,
    dst: Path | str,
    target_bytes: int,
    *,
    timeout: int = 120,
    strip_metadata: bool = True,
    on_progress: ProgressFn | None = None,
    strategy: Strategy | None = None,
    prerendered: dict[int, Path] | None = None,
) -> CompressResult:
    """Compress src to fit under target_bytes, degrading as little as possible.

    Lossless pass first; if still over target, binary-search the strategy's rung
    ladder for the gentlest setting that fits. If no rung fits, return the best
    achievable (the floor) with hit_target=False. A strategy with
    `always_render` set (an exact-size image) skips the lossless pass, so its
    result always comes from the ladder.

    `dst` is used as given when the produced format matches its extension, and
    re-suffixed otherwise (a lossy image result is always JPEG). The path
    actually written is on the returned result's `output`.

    `prerendered` maps rung indexes to files already rendered at that rung for
    this same source and strategy (the analyze step's floor render). They are
    used exactly as if this run had rendered them: as search data and as
    candidate results.

    The search is guided rather than a plain bisection. File size falls
    steadily down the ladder, roughly exponentially, so the sizes already
    measured predict which rung will just fit; that rung and its gentler
    neighbour usually settle it in two renders where bisection needs three or
    four. Predictions that stop helping fall back to bisection, and the answer
    is the same either way: the gentlest rung that fits.

    on_progress, if given, is called with a dict per step:
      {"stage": "lossless", "size": int}
      {"stage": "search", "rungs": int, "known": [{"rung": int, "size": int}]}
      {"stage": "rung_start", "rung": int, ...rung settings}
      {"stage": "rung_result", "rung": int, "size": int | None, "fits": bool}
    """

    def emit(event: dict) -> None:
        if on_progress is not None:
            on_progress(event)

    src, dst = Path(src), Path(dst)
    strategy = strategy or detect_strategy(src)
    original = src.stat().st_size
    probe = strategy.probe(src)
    warnings = list(probe.warnings)

    def finish(
        produced: Path, size: int, hit: bool, method: str, tried: int, lossy: bool
    ) -> CompressResult:
        target_path = dst.with_suffix(strategy.output_suffix(src, lossy=lossy))
        copy_through(produced, target_path)
        return CompressResult(
            target_path, original, size, target_bytes, hit, method, tried, warnings, strategy.kind
        )

    # A strategy that must transform the file (exact pixel dimensions, say)
    # cannot hand back the original or a lossless copy, however small.
    always_render = getattr(strategy, "always_render", False)

    if original <= target_bytes and not always_render:
        return finish(src, original, True, "none", 0, lossy=False)

    with tempfile.TemporaryDirectory(prefix="fitpdf-") as tmp:
        tmpdir = Path(tmp)

        loss_size: int | None = None
        loss_path = tmpdir / f"lossless{strategy.output_suffix(src, lossy=False)}"
        # A lossless pass that cannot possibly reach the target is pure waste:
        # on a slow server, re-encoding a 12 MP JPEG costs seconds to save a
        # few percent when the target is a twentieth of the file.
        lossless_hopeless = getattr(strategy, "lossless_hopeless", None)
        skip_lossless = bool(lossless_hopeless and lossless_hopeless(src, original, target_bytes))
        if not always_render and not skip_lossless:
            loss_size = strategy.lossless(src, loss_path, strip_metadata=strip_metadata)
            emit({"stage": "lossless", "size": loss_size})

            if loss_size <= target_bytes:
                return finish(loss_path, loss_size, True, "lossless", 0, lossy=False)

        strategy.ensure_available()

        lossy_suffix = strategy.output_suffix(src, lossy=True)
        cache: dict[int, tuple[int | None, Path]] = {}
        for i, given in (prerendered or {}).items():
            path = Path(given)
            if 0 <= i < len(strategy.rungs) and path.exists() and strategy.validate(path, probe):
                cache[i] = (path.stat().st_size, path)
        seeded = len(cache)

        def try_rung(i: int) -> tuple[int | None, Path]:
            if i in cache:
                return cache[i]
            emit({"stage": "rung_start", "rung": i, **strategy.rungs[i]})
            out = tmpdir / f"rung{i}{lossy_suffix}"
            try:
                size: int | None = strategy.render(src, out, strategy.rungs[i], timeout=timeout)
            except Exception:
                size = None
            if size is not None and not strategy.validate(out, probe):
                size = None
            emit(
                {
                    "stage": "rung_result",
                    "rung": i,
                    "size": size,
                    "fits": size is not None and size <= target_bytes,
                }
            )
            cache[i] = (size, out)
            return cache[i]

        lo, hi = 0, len(strategy.rungs) - 1
        fit: int | None = None
        # Seeded rungs narrow the range before anything is rendered: sizes
        # only shrink down the ladder, so a fitting rung rules out everything
        # harsher and a non-fitting one everything gentler.
        for i, (size, _) in sorted(cache.items()):
            if size is not None and size <= target_bytes:
                fit = i if fit is None else min(fit, i)
                hi = min(hi, i - 1)
            elif size is not None:
                lo = max(lo, i + 1)
        # Announce the ladder before searching it, with anything already known,
        # so a client can draw every rung (and the analyze step's floor) from
        # the start rather than only the ones this run happens to render.
        emit(
            {
                "stage": "search",
                "rungs": len(strategy.rungs),
                "known": [
                    {"rung": i, "size": size}
                    for i, (size, _) in sorted(cache.items())
                    if size is not None
                ],
            }
        )
        misses = 0
        while lo <= hi:
            guess = (
                None
                if misses >= 2
                else _predict_boundary(
                    cache, target_bytes, getattr(strategy, "typical_log_step", None)
                )
            )
            # Named `rung`, not `probe`: try_rung's validate() reads the
            # enclosing `probe` (the source's page count and size), and
            # shadowing it made every PDF render fail validation.
            if guess is None:
                rung = (lo + hi) // 2
            else:
                # Outside the open range the prediction still says which end
                # to check: a boundary at hi + 1 means "hi should not fit".
                rung = min(max(guess, lo), hi)
            size, _ = try_rung(rung)
            fits = size is not None and size <= target_bytes
            if fits:
                fit = rung
                hi = rung - 1
            else:
                lo = rung + 1
            # The prediction says rung r fits exactly when r >= guess. Two
            # results that contradict it and the model is not describing this
            # file; bisection bounds the rest of the search.
            if guess is not None and fits != (rung >= guess):
                misses += 1

        if fit is not None:
            size, out = cache[fit]
            assert size is not None
            return finish(out, size, True, f"rung:{fit}", len(cache) - seeded, lossy=True)

        candidates = [(s, p, True) for s, p in cache.values() if s is not None]
        if loss_size is not None:
            candidates.append((loss_size, loss_path, False))
        if not candidates:
            # Only reachable with always_render, where there is no lossless
            # copy to fall back on.
            raise RuntimeError("could not produce a readable file at those settings")
        floor_size, floor_path, floor_lossy = min(candidates, key=lambda c: c[0])
        warnings.append(
            "target not reachable; returning the smallest achievable file (the floor)"
        )
        return finish(
            floor_path, floor_size, False, "floor", len(cache) - seeded, lossy=floor_lossy
        )
