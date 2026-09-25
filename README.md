# FitFileSize

**Live at [fitfilesize.com](https://fitfilesize.com).**

Compress a PDF or image to fit under a target file size. Built for the "this
portal only accepts files under 4 MB" problem: pick a target, get a file that
actually fits, or an honest report of the smallest achievable size.

Accepts PDF, JPEG, PNG, WebP, TIFF and BMP.

The site is FitFileSize; the Python package, CLI and `FITPDF_*` settings keep
the original name, `fitpdf`.

## How it works

The same three steps regardless of what you feed it:

1. **Lossless pass first.** For PDFs that is object streams, stream
   recompression and unused-resource removal (pikepdf). For JPEGs it is an
   optimised re-encode that reuses the existing DCT coefficients, so the pixels
   are untouched and only metadata is dropped. Sometimes this alone is enough.
2. **If still over target, binary-search a ladder** of increasingly aggressive
   settings for the gentlest one that fits. PDFs step down Ghostscript image
   DPI and JPEG quality; images step down pixel dimensions and JPEG quality.
   Twelve rungs are searched in at most four attempts.
3. **If even the harshest rung cannot fit**, you get the smallest achievable
   file plus a clear "floor" warning instead of a silent failure.

Only step 1, the ladder's contents, and "render one rung" differ per media
type. Those live behind one protocol in `src/fitpdf/strategies.py`, so the
search itself is written once. Adding a third media type means implementing
four methods, not touching the search.

## Install

Requires Python 3.10+. Ghostscript is needed for the PDF path only; images work
without it.

```
# Windows
winget install ArtifexSoftware.GhostScript

# Debian/Ubuntu (and WSL2)
sudo apt install ghostscript
```

Then:

```
pip install -e ".[dev]"
```

If Ghostscript is not on PATH, point to it with the `FITPDF_GS` env var.

## Use

```
fitpdf scan.pdf -t 4mb            # fit under 4 MB
fitpdf photo.jpg -t 500kb         # images work the same way
fitpdf scan.pdf -t 500kb -o out.pdf
fitpdf scan.pdf                   # lossless-only pass
```

A lossy image result is always JPEG, so the output name is re-suffixed to match
what was actually produced (`logo.png` in, `logo.fit.jpg` out).

Exit codes: 0 target hit, 2 floor reached (target not possible), 1 error.

## Web service

A React UI with drag-and-drop upload, a target-size slider bounded by an
estimated floor (the smallest the file can likely go), live progress while the
ladder runs, and download links that self-destruct minutes after the run
finishes (see Retention below).

### Architecture

```
browser ──▶ nginx (SPA + /api proxy) ──▶ FastAPI ──▶ Redis ──▶ RQ worker
                                            │          │          │
                                            └──── shared job volume ────┘
```

Four pieces, each with one job:

- **`src/fitpdf/`** is the engine: pure Python, no web framework, driven either
  by the CLI or the API. `engine.py` holds the media-agnostic search;
  `strategies.py` holds everything that knows about a specific file format.
  Neither knows anything about HTTP.
- **`src/fitpdf/web/`** is a thin API over it. Uploads land on a shared volume,
  work is enqueued, and nothing blocks the request thread.
- **The worker** runs Ghostscript out-of-process. A compression can take
  minutes and can be killed by a timeout, so it must not live inside a request.
- **`frontend/`** is a Vite + React + TypeScript SPA. Its types are a
  hand-maintained mirror of the API in `frontend/src/types/api.ts`.

Progress reaches the browser over Server-Sent Events rather than polling.
Events are appended to a Redis list and replayed from an offset, so a client
that connects late, reconnects, or reloads still sees the whole run.

### Running it

The whole stack, including the frontend, in one command:

```
docker compose up --build
```

Then open http://localhost:5173. The API is also exposed directly on port 8000.

For frontend work you want the Vite dev server instead, with hot reload. Start
the backend however you like, then:

```
cd frontend
npm install
npm run dev
```

That serves on port 5174 and proxies `/api` to `localhost:8000`, so the browser
sees one origin and CORS never applies.

For a backend-only look with no Docker and no Redis, inline mode runs jobs
in-process against a fake Redis:

```
pip install -e ".[dev]"
set FITPDF_INLINE=1
uvicorn fitpdf.web.app:create_app --factory --port 8000
```

To run the real queue outside Docker you need a Redis somewhere, then:

```
uvicorn fitpdf.web.app:create_app --factory --port 8000
python -m fitpdf.web.worker
```

Configuration (env vars): `REDIS_URL`, `FITPDF_DATA_DIR` (default `data`),
`FITPDF_TTL_SECONDS` (default 600), `FITPDF_PENDING_TTL_SECONDS` (default 1800),
`FITPDF_INPUT_GRACE_SECONDS` (default 300), `FITPDF_MAX_UPLOAD` (bytes, default
50 MB), `FITPDF_GS_TIMEOUT` (seconds per Ghostscript attempt, default 180),
`ALLOWED_ORIGINS` (comma-separated CORS origins, only needed when the frontend
is hosted separately), and the rate limits below.

### Rate limits

Each visitor gets `FITPDF_UPLOADS_PER_HOUR` uploads (default 30) and
`FITPDF_RUNS_PER_HOUR` floor estimates plus compressions (default 100) per
hour, counted in Redis in fixed one-hour windows. `0` turns a limit off. An
over-budget upload is refused with a 429 before its body is read, and every
limited response carries `X-RateLimit-Remaining` and, when refused,
`Retry-After`. `GET /api/limits` reports the caller's budget without spending
any of it.

The visitor is identified by the first valid IP in `FITPDF_CLIENT_IP_HEADERS`
(default `CF-Connecting-IP,True-Client-IP,X-Forwarded-For`), falling back to
the socket peer; IPv6 is grouped by /64. Only list headers the proxy in front
overwrites. A header it passes through untouched can be forged to get a fresh
budget. The Docker Compose stack sets it to `X-Real-IP`, which its nginx
always overwrites. Set it to an empty string when nothing sits in front.

### Retention

Three clocks, because a job's risk profile changes once it finishes.

| What | When it is deleted |
| --- | --- |
| the stored original | `FITPDF_INPUT_GRACE_SECONDS` after the job finishes |
| the compressed output and job metadata | `FITPDF_TTL_SECONDS` after the job finishes |
| a job that never finishes | `FITPDF_PENDING_TTL_SECONDS` after upload |

Retention is measured from **completion**, not upload, so a slow 40 MB scan and
a fast 2 MB form get the same download window. The original upload is the
sensitive half, so it goes first and is kept only long enough for the "try
another size" button to re-run against it.

`FITPDF_PENDING_TTL_SECONDS` must stay above the queue's per-job timeout
(`FITPDF_GS_TIMEOUT * 8 + 120`, so 26 minutes at the default). Set it lower and
the sweeper will delete a job's input while it is still compressing.

The sweeper runs once a minute, so actual deletion lands within 60s of the
times above.

## Deploy

Backend on Render, frontend on Vercel, both on free plans.

Render (API, worker and Redis):

1. Dashboard, New, Blueprint, pick this repo. `render.yaml` sets up a Docker
   web service (Ghostscript ships in the image, and the worker runs inside the
   same container since free plans do not include separate workers) plus a free
   Key Value instance for the queue.
2. Set `ALLOWED_ORIGINS` to your Vercel URL once you have it, e.g.
   `https://fitpdf.vercel.app`.

Vercel (React frontend):

1. Import the repo, set the root directory to `frontend`. Vercel detects Vite;
   the build command is `npm run build` and the output directory is `dist`.
2. Add an env var `VITE_API_URL` with the Render URL, e.g.
   `https://fitpdf.onrender.com`. It is read at build time (see
   `frontend/.env.example`), so changing it needs a redeploy.

Free tier notes: the Render service spins down after 15 minutes idle, so the
first request after a quiet spell takes about a minute. Storage is ephemeral,
which is fine here because nothing is kept long anyway. Keep `FITPDF_MAX_UPLOAD`
well under the 512 MB instance memory: Ghostscript needs several times the file
size while distilling, and a large upload will get the process OOM-killed.

The API serves no HTML. In production the SPA is a separate origin (Vercel), so
`ALLOWED_ORIGINS` is required there; in Docker Compose nginx proxies `/api` and
they share an origin, so it is not.

### API

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/api/fit` | one call for agents and scripts: multipart `file` + `target` (`200KB`, `1.5MB`, bytes; 1000-based), waits up to 80s and returns `download_url`, or `202` with `status_url` |
| POST | `/api/upload` | multipart upload, returns job id, media kind and basic info |
| POST | `/api/jobs/{id}/analyze` | estimates the floor, returns slider bounds |
| POST | `/api/jobs/{id}/compress` | queues a run with `{"target_bytes": n}` |
| GET | `/api/jobs/{id}` | job state, including seconds until auto-delete |
| GET | `/api/jobs/{id}/events` | SSE stream of rung attempts and the final result |
| GET | `/api/jobs/{id}/download` | the compressed file |
| DELETE | `/api/jobs/{id}` | delete stored files right now |
| GET | `/api/limits` | the caller's remaining hourly budget, without spending it |

Interactive docs are served at `/docs` (OpenAPI at `/openapi.json`), and the
site publishes `/llms.txt`, a plain-text guide for AI agents built from
`frontend/public/llms.txt` plus the landing-page list.

All stored files are deleted on the schedule in Retention above, no exceptions.

## Develop

Backend:

```
pytest -q          # tests skip Ghostscript-dependent cases if gs is missing
ruff check src tests
```

Frontend (from `frontend/`):

```
npx tsc -b         # typecheck; vite does not check types on its own
npm run lint
npm run build
```

CI runs both halves on every push.

Web tests run against a fake Redis with the queue in synchronous mode, so they
need neither a Redis server nor a worker process.

## Roadmap

- Hosting: laptop plus a tunnel, free tier only
- Form-preserving lossy path (per-image recompression via pikepdf, no re-distill)
- Sandboxed workers, rate limiting, metrics
