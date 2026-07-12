# fitpdf

Compress a PDF to fit under a target file size. Built for the "this portal only
accepts files under 4 MB" problem: pick a target, get a file that actually fits,
or an honest report of the smallest achievable size.

## How it works

1. Lossless pass first (pikepdf): object streams, stream recompression, unused
   resource removal, optional metadata strip. Sometimes this alone is enough.
2. If still over target, a binary search over a ladder of Ghostscript
   downsampling rungs (image DPI + JPEG quality) finds the gentlest setting that
   fits under the target.
3. If even the most aggressive rung cannot fit, you get the smallest achievable
   file plus a clear "floor" warning instead of a silent failure.

## Install

Requires Python 3.10+ and Ghostscript.

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
fitpdf scan.pdf -t 500kb -o out.pdf
fitpdf scan.pdf                   # lossless-only pass
```

Exit codes: 0 target hit, 2 floor reached (target not possible), 1 error.

## Web service

A local web UI with drag-and-drop upload, a target-size slider bounded by an
estimated floor (the smallest the file can likely go), live progress while the
ladder runs, and download links that self-destruct after 30 minutes.

The easiest way to run it is Docker Compose (API, worker, and Redis):

```
docker compose up --build
```

Then open http://localhost:8000.

For a quick look without Docker or Redis, inline mode runs jobs in-process:

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
`FITPDF_TTL_SECONDS` (default 1800), `FITPDF_MAX_UPLOAD` (bytes, default 200 MB),
`FITPDF_GS_TIMEOUT` (seconds per Ghostscript attempt, default 180).

### API

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/api/upload` | multipart upload, returns job id and basic PDF info |
| POST | `/api/jobs/{id}/analyze` | estimates the floor, returns slider bounds |
| POST | `/api/jobs/{id}/compress` | queues a run with `{"target_bytes": n}` |
| GET | `/api/jobs/{id}` | job state, including seconds until auto-delete |
| GET | `/api/jobs/{id}/events` | SSE stream of rung attempts and the final result |
| GET | `/api/jobs/{id}/download` | the compressed file |
| DELETE | `/api/jobs/{id}` | delete stored files right now |

All stored files are deleted 30 minutes after upload, no exceptions.

## Develop

```
pytest -q          # tests skip Ghostscript-dependent cases if gs is missing
ruff check src tests
```

Web tests run against a fake Redis with the queue in synchronous mode, so they
need neither a Redis server nor a worker process.

## Roadmap

- Hosting: laptop plus a tunnel, free tier only
- Form-preserving lossy path (per-image recompression via pikepdf, no re-distill)
- Sandboxed workers, rate limiting, metrics
