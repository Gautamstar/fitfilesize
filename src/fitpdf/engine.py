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
    pad_gif,
    pad_jpeg,
)
from .units import human_size

# `RUNGS` is the PDF ladder. Named without a prefix because the CLI and the
# public package API treat PDFs as the default media type.
RUNGS = PDF_RUNGS

# A fitting result at least this share of the target ends the search without
# rendering the gentler neighbour to confirm it is too big. Simulated over
# every target on 15 real and realistic files: renders per run 2.20 -> 2.00;
# 0.6% of runs keep a setting one step harsher than needed, and those files
# come out about 5% smaller than they had to be.
CLOSE_ENOUGH = 0.9
# The most a big file's draft runs over its proper render (see
# strategies.DRAFT_MIN_BYTES): measured at 5 to 15 percent on photos and
# dense graphics.
DRAFT_OVERSHOOT = 1.15
# A target at least this share of the file is usually met at full size, so
# the gentlest-first render is made properly rather than drafted and redone.
LIKELY_FULL_SIZE = 0.5

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
    # An image that could not get under the limit in its own format (PNG,
    # WebP, TIFF, BMP), in a run not allowed to turn it into a JPEG: a JPEG
    # could have gone smaller.
    needs_jpeg: bool = False

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
    # An image that keeps its format has its own floor: a BMP screenshot
    # bottoms out near 145 KB where a JPEG of it would reach a few.
    native_first = getattr(strategy, "native_first", None)
    must_convert = getattr(strategy, "must_convert", None)
    if native_first is not None and native_first(src):
        strategy.use_native(True)
    elif must_convert is not None and must_convert(src):
        strategy.use_conversion()

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
    cache: dict[int, tuple[int | None, Path]],
    target: int,
    prior_slope: float | None = None,
    original: int | None = None,
) -> int | None:
    """The rung predicted to be the gentlest that fits, from sizes measured so far.

    Output size falls roughly exponentially down the ladder, so log(size) is
    close to linear in the rung index. Interpolate between the nearest
    measured rungs on either side of the target, or extrapolate from the two
    nearest on one side. With a single measurement, `prior_slope` (the
    strategy's typical drop in log size per rung) stands in for the second
    point. None when there is not enough to go on.

    When that single measurement fits (the analyze step's floor, say) and the
    `original` size is known, the original is a second, real point above the
    target: treated as one step gentler than the gentlest rung, it gives a
    slope measured on this file. Neither guess is reliable alone (a big photo
    drops a lot at the first rung, a 300 dpi scan barely moves), so the two
    are averaged. Over every target on a set of real files this cut renders
    per run from 2.7 to 2.4, and a 6-page scan from 3.6 to 2.1.
    """
    import math

    points = sorted((i, s) for i, (s, _) in cache.items() if s)
    if len(points) == 1 and prior_slope:
        (i1, s1), = points
        prior = max(0, math.ceil(i1 + (math.log(s1) - math.log(target)) / prior_slope - 1e-9))
        if original and s1 <= target < original:
            anchored = _interpolate([(-1, original), (i1, s1)], target)
            if anchored is not None:
                return math.ceil((prior + anchored) / 2)
        return prior
    if len(points) < 2:
        return None
    return _interpolate(points, target)


def _interpolate(points: list[tuple[int, int]], target: int) -> int | None:
    """The rung where log size, linear between measured points, crosses target."""
    import math

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
    min_bytes: int | None = None,
    allow_jpeg: bool = False,
    keep_png: bool = True,
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

    `min_bytes`, for forms that also set a minimum size: a JPEG result under
    it is padded up to it with comment blocks (see strategies.pad_jpeg), the
    picture unchanged. Other formats are left as they are, with a warning.

    An image keeps its format (with no exact size asked for): this is not a
    converter. A PNG, WebP, TIFF or BMP searches the strategy's ladder for
    its own format, and if no rung fits the smallest one comes back as the
    floor, with needs_jpeg=True to say a JPEG could have gone smaller. `allow_jpeg` lets it go on to the JPEG ladder
    instead, for API callers who ask; `keep_png=False` goes straight there.

    `prerendered` maps rung indexes to files already rendered at that rung for
    this same source and strategy (the analyze step's floor render). They are
    used exactly as if this run had rendered them: as search data and as
    candidate results.

    The search is guided rather than a plain bisection. File size falls
    steadily down the ladder, roughly exponentially, so the sizes already
    measured predict which rung will just fit; that rung and its gentler
    neighbour usually settle it in two renders where bisection needs three or
    four. Predictions that stop helping fall back to bisection, and the answer
    is the same either way: the gentlest rung that fits, except that a fit
    within CLOSE_ENOUGH of the target ends the search without confirming
    that the next gentler rung is too big.

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
        produced: Path,
        size: int,
        hit: bool,
        method: str,
        tried: int,
        lossy: bool,
        needs_jpeg: bool = False,
    ) -> CompressResult:
        # Named after what was produced: a run can end on a PNG rung, a JPEG
        # rung or the lossless copy, whatever mode the strategy is left in.
        target_path = dst.with_suffix(produced.suffix.lower())
        copy_through(produced, target_path)
        notes_for = getattr(strategy, "notes_for", None)
        if notes_for is not None:
            warnings.extend(notes_for(produced))
        if min_bytes and size < min_bytes:
            pad = {".jpg": pad_jpeg, ".jpeg": pad_jpeg, ".gif": pad_gif}.get(
                target_path.suffix.lower()
            )
            if pad is not None:
                size = pad(target_path, min_bytes)
                warnings.append(
                    f"padded to {human_size(size)} to meet the minimum size; "
                    "the picture itself is unchanged"
                )
            else:
                warnings.append(
                    f"this is under the {human_size(min_bytes)} minimum, and only a JPEG "
                    "or GIF can be padded up to it"
                )
        # A PNG that comes back as a JPG can be refused by a site that only
        # takes PNG, and loses any see-through parts, so say which.
        before = src.suffix.lower().lstrip(".")
        after = target_path.suffix.lower().lstrip(".")
        lost_transparency = getattr(strategy, "lost_transparency", None)
        if converting:
            warnings.append("converted from HEIC to JPEG")
        elif after in ("jpg", "jpeg") and lossy and lost_transparency is not None and lost_transparency(src):
            warnings.append(
                "saved as a JPG, which has no transparency: the see-through parts are now white"
            )
        elif strategy.kind == "image" and before not in (after, "jpeg"):
            name = {"tif": "TIFF", "webp": "WebP"}.get(before, before.upper())
            warnings.append(f"saved as a JPG: as a {name} it could not get under your limit")
        return CompressResult(
            target_path, original, size, target_bytes, hit, method, tried, warnings, strategy.kind,
            needs_jpeg=needs_jpeg,
        )

    # A strategy that must transform the file (exact pixel dimensions, say)
    # cannot hand back the original or a lossless copy, however small.
    always_render = getattr(strategy, "always_render", False)
    # A HEIC always becomes a JPEG: handing back the original, or a lossless
    # copy of it, would hand back a HEIC.
    must_convert = getattr(strategy, "must_convert", None)
    converting = bool(must_convert and must_convert(src))
    if converting:
        strategy.use_conversion()

    if original <= target_bytes and not always_render and not converting:
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
        if not always_render and not skip_lossless and not converting:
            loss_size = strategy.lossless(src, loss_path, strip_metadata=strip_metadata)
            emit({"stage": "lossless", "size": loss_size})

            if loss_size <= target_bytes:
                return finish(loss_path, loss_size, True, "lossless", 0, lossy=False)

        strategy.ensure_available()

        def search_ladder(
            outdir: Path, seeds: dict[int, Path], gentlest_first: bool = False
        ) -> tuple[int | None, dict[int, tuple[int | None, Path]], int]:
            """Search strategy.rungs as they stand: (fitting rung or None, cache, seeded).

            `gentlest_first` renders rung 0 before searching: for a format's own
            ladder, the gentlest setting, usually the answer worth having.
            """
            outdir.mkdir(exist_ok=True)
            lossy_suffix = strategy.output_suffix(src, lossy=True)
            cache: dict[int, tuple[int | None, Path]] = {}
            for i, given in seeds.items():
                path = Path(given)
                # Only a render in this ladder's format seeds it: the analyze
                # step's floor is a PNG for a PNG, and says nothing about JPEG.
                if (
                    0 <= i < len(strategy.rungs)
                    and path.suffix.lower() == lossy_suffix
                    and path.exists()
                    and strategy.validate(path, probe)
                ):
                    cache[i] = (path.stat().st_size, path)
            seeded = len(cache)

            def try_rung(i: int) -> tuple[int | None, Path]:
                if i in cache:
                    return cache[i]
                emit({"stage": "rung_start", "rung": i, **strategy.rungs[i]})
                out = outdir / f"rung{i}{lossy_suffix}"
                is_draft = getattr(strategy, "is_draft", None)
                if is_draft is not None and is_draft(strategy.rungs[i]):
                    drafts[out] = i
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
            # Not held back by a seeded fit: the analyze step's floor always
            # fits a target above it, and says nothing about rung 0.
            # The rungs the search predicts from. Full size tried first and
            # missed is left out: on a graphic it can be smaller than the next
            # rung down (shrinking adds in-between colours), which throws the
            # prediction for the rest of the ladder.
            skip: set[int] = set()
            if gentlest_first and 0 not in cache and lo == 0 and hi >= 0:
                drafting = getattr(strategy, "draft", False)
                if target_bytes >= LIKELY_FULL_SIZE * original:
                    strategy.draft = False
                size, _ = try_rung(0)
                strategy.draft = drafting
                if size is not None and size <= target_bytes:
                    fit, hi = 0, -1
                else:
                    lo = 1
                    skip.add(0)
            misses = 0
            while lo <= hi:
                # Not on a draft, which runs larger than the real thing: the
                # gentler rung is cheap to draft, and polish needs its size.
                if (
                    fit is not None
                    and cache[fit][0] >= CLOSE_ENOUGH * target_bytes
                    and cache[fit][1] not in drafts
                ):
                    break
                guess = (
                    None
                    if misses >= 2
                    else _predict_boundary(
                        {i: c for i, c in cache.items() if i not in skip},
                        target_bytes, getattr(strategy, "typical_log_step", None), original,
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
            return fit, cache, seeded

        # Draft renders (a strategy's quick setting, see ImageStrategy.drafts)
        # made by this run, by rung: good enough to search with, but whatever
        # is handed back is rendered again properly first (see polish).
        drafts: dict[Path, int] = {}

        def polish(fit: int, cache: dict[int, tuple[int | None, Path]]) -> tuple[int, Path, int]:
            """(size, path, rung) of the result, rendered properly.

            A draft that fit is rendered again at full effort. How much that
            shrank it says how far this file's drafts run over, so the gentler
            rungs whose drafts missed can be judged too: one that should now
            fit is rendered properly and taken if it does. (When the answer
            was rendered properly to begin with, a small rung under the draft
            size, DRAFT_OVERSHOOT stands in for that measure.) A proper render
            that comes out over the target (rare: a flat graphic can come out
            a hair larger) leaves the draft, which fits.
            """
            strategy.draft = False
            size, out = cache[fit]
            assert size is not None
            best = (size, out, fit)
            # How much a proper render shrinks this file's drafts; until one
            # is measured, the most they typically run over.
            shrink = 1 / DRAFT_OVERSHOOT

            def proper(i: int) -> int | None:
                drafted = cache[i][1]
                emit({"stage": "rung_start", "rung": i, "final": True, **strategy.rungs[i]})
                final = drafted.with_name(f"final{i}{drafted.suffix}")
                try:
                    got: int | None = strategy.render(src, final, strategy.rungs[i], timeout=timeout)
                except Exception:
                    got = None
                if got is not None and not strategy.validate(final, probe):
                    got = None
                return got

            if out in drafts:
                got = proper(fit)
                if got is None or got > target_bytes:
                    emit({"stage": "rung_result", "rung": fit, "size": size, "fits": True})
                    return best
                emit({"stage": "rung_result", "rung": fit, "size": got, "fits": True})
                best = (got, out.with_name(f"final{fit}{out.suffix}"), fit)
                shrink = got / size
            # The gentler rungs whose drafts missed, judged by that shrink.
            # (Rendered properly already, a rung above that missed missed.)
            i = fit - 1
            while i >= 0:
                above, drafted = cache.get(i, (None, out))
                if above is None or drafted not in drafts or above * shrink > target_bytes:
                    break
                got = proper(i)
                fits = got is not None and got <= target_bytes
                emit({"stage": "rung_result", "rung": i, "size": got, "fits": fits})
                if not fits:
                    break
                assert got is not None
                best = (got, drafted.with_name(f"final{i}{drafted.suffix}"), i)
                i -= 1
            return best

        png_tried = 0
        png_results: list[tuple[int, Path]] = []
        native_first = getattr(strategy, "native_first", None)
        if keep_png and not always_render and native_first is not None and native_first(src):
            strategy.use_native(True)
            # Only worth refusing a poor 256-colour copy if a JPEG can follow.
            strategy.png_strict = allow_jpeg
            # Search with drafts, unless a JPEG may follow: then every PNG
            # size is compared with a JPEG one, and a draft's would be off.
            strategy.draft = bool(getattr(strategy, "drafts", False)) and not allow_jpeg
            # Full size first when it has a chance: a 256-colour copy of a
            # compressed PNG is rarely under a fifth of it, and below that the
            # full-size render (10 s at 40 MP) is wasted.
            fit, cache, _ = search_ladder(
                tmpdir / "native", prerendered or {}, gentlest_first=target_bytes >= 0.2 * original
            )
            png_tried = len(cache)
            png_results = [(s, p) for s, p in cache.values() if s is not None]
            if fit is not None:
                size, out, fit = polish(fit, cache)
                return finish(out, size, True, f"rung:{fit}", png_tried, lossy=True)
            if not allow_jpeg:
                pngs = [(s, p, True) for s, p in cache.values() if s is not None]
                if loss_size is not None:
                    pngs.append((loss_size, loss_path, False))
                floor_size, floor_path, floor_lossy = min(
                    pngs or [(original, src, False)], key=lambda c: c[0]
                )
                if floor_path in drafts:
                    # Rendered properly the floor is usually smaller still;
                    # the smaller of the two is kept.
                    strategy.draft = False
                    i = drafts[floor_path]
                    final = floor_path.with_name(f"final{i}{floor_path.suffix}")
                    try:
                        got = strategy.render(src, final, strategy.rungs[i], timeout=timeout)
                        if got < floor_size and strategy.validate(final, probe):
                            floor_size, floor_path = got, final
                    except Exception:
                        pass
            strategy.use_native(False)
            strategy.draft = False
            if not allow_jpeg:
                warnings.append(
                    "target not reachable; returning the smallest achievable file (the floor)"
                )
                return finish(
                    floor_path, floor_size, False, "floor", png_tried,
                    lossy=floor_lossy, needs_jpeg=True,
                )

        # A strategy whose own ladder searches with quick drafts (a GIF;
        # see GifStrategy.drafts). The JPEG ladder has none.
        strategy.draft = bool(getattr(strategy, "drafts", False))
        fit, cache, seeded = search_ladder(tmpdir, prerendered or {})
        tried = len(cache) - seeded + png_tried

        if fit is not None:
            size, out, fit = polish(fit, cache)
            return finish(out, size, True, f"rung:{fit}", tried, lossy=True)

        # The smallest of everything tried, PNG rungs included: a small
        # graphic can come out smaller as a 256-colour PNG than as any JPEG.
        candidates = [(s, p, True) for s, p in cache.values() if s is not None]
        candidates += [(s, p, True) for s, p in png_results]
        if loss_size is not None:
            candidates.append((loss_size, loss_path, False))
        if not candidates:
            if converting:
                # Nothing decoded: a damaged HEIC, or one this decoder cannot read.
                raise RuntimeError(
                    "this iPhone photo (HEIC) could not be read. Export it from Photos as a "
                    "JPEG, or share it as Most Compatible, and try that"
                )
            # Otherwise only reachable with always_render, where there is no
            # lossless copy to fall back on.
            raise RuntimeError("could not produce a readable file at those settings")
        floor_size, floor_path, floor_lossy = min(candidates, key=lambda c: c[0])
        if floor_path in drafts:
            # As for a PNG floor: rendered properly it is usually smaller.
            strategy.draft = False
            i = drafts[floor_path]
            final = floor_path.with_name(f"final{i}{floor_path.suffix}")
            try:
                got = strategy.render(src, final, strategy.rungs[i], timeout=timeout)
                if got < floor_size and strategy.validate(final, probe):
                    floor_size, floor_path = got, final
            except Exception:
                pass
        warnings.append(
            "target not reachable; returning the smallest achievable file (the floor)"
        )
        return finish(floor_path, floor_size, False, "floor", tried, lossy=floor_lossy)

