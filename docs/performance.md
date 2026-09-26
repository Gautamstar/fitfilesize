# Performance

Where a visitor's time goes on fitfilesize.com, measured on production, and
what has been done about it. Numbers are from 2026-09-25.

## How it was measured

- **Network:** `curl` timing (DNS, TCP, TLS, time to first byte), 10 fresh
  connections per endpoint, from Toronto.
- **Full flow:** real Chrome (Playwright, `channel="chrome"`) on the live site:
  upload, size picker, compress, result, download, delete, with each API
  call's timing from the browser.
- **Server side:** the progress stream (`/api/jobs/{id}/events`) read directly,
  timestamping each event as it arrives, which splits a run into its
  lossless pass and individual rung renders.
- **Page load:** Lighthouse 12, mobile preset.
- **Test files:** a 5.0 MB 12 MP phone photo, a 4.9 MB three-page 300 dpi
  scan, and a 0.23 MB one-page PDF, generated to compress like the real thing.

## Baseline (before this change)

### Network and page load: fine

| | Time to first byte | Notes |
|---|---|---|
| Website (Vercel, Montreal edge, cache hit) | ~82 ms | Lighthouse mobile 98, LCP 2.3 s, 171 KB transferred |
| API `/health` (Cloudflare Toronto → Render us-west) | ~180 ms | ~145 ms of it is the round trip to the origin; every API call pays it |
| Raw upload to the API | ~4.9 MB/s | a 5 MB file takes ~1 s here; on mobile data (5–10 Mbit/s up) 5–8 s |

### The flow: processing dominates

| File → target | Upload → size picker | Compress → result |
|---|---|---|
| 5.0 MB photo → 200 KB | 2.3–2.8 s | **9.6–10.5 s** |
| 4.9 MB scan → 500 KB | 3.3 s | **12.2–12.3 s** |
| 0.23 MB PDF → 100 KB | 1.3–1.8 s | **4.6–5.7 s** |

Per call (typical): upload 0.2–1.1 s, analyze (floor estimate) 0.8–2.1 s,
compress request 0.2 s, **the run itself 3.5–11.4 s**, status/delete ~0.1–0.4 s.

### Inside a run

| | What the time went on |
|---|---|
| Photo → 200 KB (9.2 s) | lossless pass **4.2 s** (5.0 → 4.57 MB, useless against 200 KB), then 3 renders at 1.2–2.6 s |
| Scan → 500 KB (11.3 s) | 4 renders at 2.5–3.0 s; the first (rung 5) already fit, the next three all checked gentler rungs that did not |
| Small PDF → 100 KB (3.7 s) | 4 renders at ~0.8 s, mostly Ghostscript start-up |

Two more facts:

- The analyze step already renders the harshest rung to estimate the floor,
  and that measurement was thrown away before the run.
- The same work runs **15–20× faster on a laptop** (photo run 0.48 s,
  estimate 0.06 s): the free Render instance has a small fraction of one CPU,
  shared by the API and the worker.

## What changed (this PR)

1. **Skip a lossless pass that cannot reach the target.** For a JPEG, a
   lossless re-encode saves a few percent; below half the original size it is
   skipped. PNG, TIFF and BMP keep it (they can shrink a lot losslessly), and
   PDFs keep it (it is fast and occasionally large).
2. **Guided search.** Output size falls roughly exponentially down the
   ladder, so the sizes already measured predict which rung will just fit;
   that rung and its gentler neighbour usually settle it in two renders. With
   only one measurement, the strategy's typical per-rung drop (0.21 for PDFs,
   0.44 for images, measured on production) seeds the guess. Two
   contradicted predictions fall back to bisection. The answer is unchanged:
   the gentlest rung that fits.
3. **Reuse the analyze step's floor render.** It is kept as `floor.<ext>` in
   the job directory and seeds the run, so the harshest rung is never
   rendered twice, and a target below the floor needs no render at all.

### Results

Same outputs, byte for byte, in every case below.

| | Before | After |
|---|---|---|
| Photo, local, analyze + compress (500/200/100/30 KB) | 4–5 steps, 0.53–0.73 s | **2 steps, 0.19–0.28 s** |
| Sweep of 6 size curves × every target (tests/test_search.py) | 3.8 renders per run | **2.6–3.1** with the floor known; ≥40% fewer with the typical slope |
| Scan → 500 KB on production (renders) | 4 | **2** (predicted from measured rung sizes) |
| Small PDF → 100 KB on production (renders) | 4 | **2** (predicted) |
| Target below the floor | ~4 renders | **0** |

Production measurements after deploy: see "After deploy" below.

## Further options, ranked by effect for the cost

1. **More CPU (Render Starter or above).** Every render is 15–20× slower
   than on a laptop. Moving off the free instance speeds up every step with
   no code change. It is the single biggest lever and a cost decision.
2. **Show the size picker before the floor estimate finishes.** Analyze is
   0.8–2.1 s of the wait before the picker. The picker could open at once
   with provisional bounds and tighten when the estimate lands, or the
   estimate could start in the upload request and save a round trip.
3. **Shrink big photos in the browser before upload.** For small targets a
   12 MP photo never needs more than ~2600 px. Downscaling client-side before
   upload would cut the upload from 5 MB to under 1 MB (seconds on mobile
   data) and the server's decode work with it.
4. **Region.** The API is in the western US; each of the ~7 calls in a run
   pays ~145 ms from eastern North America. A region nearer most visitors
   (or fewer calls) saves roughly half a second per compression. Needs the
   Redis instance moved too.
5. **Progress latency.** The events endpoint polls Redis every 0.4 s, adding
   ~0.2 s on average to each update and to "done". Blocking reads (BLPOP) or
   a shorter poll would cut it.
6. **Worker start-up.** RQ's default worker forks per job; a non-forking
   worker would save the fork on every run. Small, and it trades away
   per-job isolation.
7. **Page weight.** Fine today (98). The JS bundle is 121 KB compressed;
   dropping the animation library would trim it if LCP ever creeps up.

## After deploy

Measured on production on 2026-09-25, same files and method as the baseline.
Each run produced the same file as before, to the byte or within a few bytes
of Ghostscript's embedded metadata.

| File → target | Run before | Run after | Renders before → after |
|---|---|---|---|
| 5.0 MB photo → 200 KB | 9.2 s | **4.2–4.6 s** | lossless pass + 3 → **2** |
| 4.9 MB scan → 500 KB | 11.3 s | **4.9 s** | 4 → **2** |
| 0.23 MB PDF → 100 KB | 3.7 s | **1.6 s** | 4 → **2** |

On the photo, the guided search's first render, seeded by the floor and the
typical image slope, landed on the answer (setting 7 of 12) and the second
confirmed the gentler neighbour was too big.

Locally with Ghostscript installed (PDF numbers the first pass could not
measure): on the scan, 5 steps to 3 for the 500 and 200 KB targets and 5 to
1 below the floor; on the one-page PDF, 5 to 3, and 5 to 1 below the floor.

One regression was caught before release: the first version of the search
shadowed the engine's `probe` variable, so every PDF render failed
validation. The Ghostscript tests that catch it are skipped on a machine
without Ghostscript, which is how it passed locally; CI caught it. The fake
strategy in `tests/test_search.py` now asserts it receives a real Probe, so
the same mistake fails without Ghostscript too.

## Live test, varied sizes (2026-09-25)

Thirteen runs in Chrome on production, 0.1 to 12 MB, targets 20 KB to 2 MB.
Every result fit its limit. Compress times ran from 1.9 s (small targets,
where the floor render already answers most of it) to 15.2 s (a 7.9 MB,
6-page scan to 2 MB).

That slowest run spent 2.1 s rendering the gentlest rung, which for a
300 dpi scan is the original again. With only the floor measured, the
typical PDF slope (0.21) pointed there; the scan actually drops about 0.45
per rung. The first guess now also interpolates from the original's size
and averages the two. Simulated over every target on the measured ladders
of eight real files (264 runs), renders per run fell from 2.73 to 2.36; the
6-page scan from 3.62 to 2.09 (to 2 MB: 4 renders to 2), while the 3-page
scan rose from 2.00 to 2.72. Answers are unchanged in every case.

## Head-start runs and stopping close to the target (2026-09-25)

Two changes to the search logic, after the first-guess experiments above
showed the guess itself had little left to give (15 files, 623 simulated
runs: no rule beat the live one by more than 0.02 renders per run).

- **Head-start.** The size picked before upload (a landing page's, or a chip)
  is known once the file is read, so the page starts that run straight away
  (`prepare`), while the visitor looks at the size picker. Compress with the
  same settings adopts the run; different settings replace it, and the old
  run stops at its next step. Locally at production-like render speed:

  | Visitor | Wait after Compress, before | After |
  |---|---|---|
  | Looks at the picker 6 s, keeps the size (photo to 200 KB) | ~3.9 s | **0.3 s** |
  | Presses Compress at once | ~3.9 s | 3.5 s |
  | Picks another size after 2 s | ~4 s | 4.8 s (the head-start stops at its next step first) |
  | Looks 8 s, keeps the size (6-page scan to 500 KB) | ~7.1 s | **0.3 s** |

- **Close enough.** A fit within 10% of the target ends the search without
  rendering the gentler neighbour to confirm it is too big: renders per run
  2.20 to 2.00 in simulation; 0.6% of runs keep a setting one step harsher
  than needed (those files about 5% smaller than they had to be).

## Smaller uploads for big photos (2026-09-26)

For a JPEG over 1.5 MB and a limit chosen before upload that is well under
it, the browser uploads a copy at 3000 px and quality 95 instead
(`frontend/src/lib/shrink.ts`), used only when the copy is still at least 3x
the limit. The server's answer is then a rung at or below 3000 px, which the
copy holds in full. A larger limit or pixel size picked afterwards uploads the
original before the run.

| Photo | Sent | At 1.5 Mbit/s upload, drop to size picker |
|---|---|---|
| 5 MB phone photo, IBPS 50 KB | 2.7 MB instead of 4.9 MB | 15.4 s instead of 27.5 s |
| 10.7 MB 48 MP photo, 500 KB | 1.5 MB instead of 10.4 MB | 8.9 s instead of 57.7 s |
| 12 MB photo, 1 MB | 3.3 MB instead of 11.8 MB | |

Answers, 4 photos (one stored sideways with EXIF orientation 6) x 6 limits
from 20 KB to 1 MB: 23 of 24 the same rung as from the original, within
0.5 dB of it against a direct Lanczos resize; the other one step up (2200 px
instead of 2000, still under 500 KB). Copies sized down toward the limit
were tried and dropped: the browser's resampling differs from Pillow's enough
that a copy near the answer's size changed 6 of 24 answers, some a step down.
