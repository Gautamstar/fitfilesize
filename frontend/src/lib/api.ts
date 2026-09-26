/**
 * Typed client for the FitFileSize backend (the fitpdf package).
 *
 * One function per endpoint, each declaring what it returns, so callers get
 * autocomplete and typo protection instead of guessing at response shapes.
 */

import type { AnalyzeResponse, JobState, Resize, UploadResponse } from '../types/api'
import { setFileLimits } from './fileCheck'

/**
 * Base URL for the API.
 *
 * Empty in development: vite.config.ts proxies /api to localhost:8000, so
 * relative paths work and CORS never applies. In a production build this is
 * baked in from the VITE_API_URL env var at build time (see .env.example).
 */
export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')

/** Error carrying the HTTP status, so callers can special-case 404/410/409. */
export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * One fetch wrapper for every call. Throws ApiError on a non-2xx response,
 * pulling FastAPI's `detail` field out of the body when it is there.
 *
 * The <T> is a generic: callers say what they expect back, and the cast at the
 * bottom applies it. Nothing is validated at runtime, so the types in
 * types/api.ts have to be kept honest by hand.
 */
async function request<T>(
  path: string,
  init?: RequestInit,
  { conflictMeansDone = false }: { conflictMeansDone?: boolean } = {},
): Promise<T> {
  // Transient failures (a dropped connection, or the host answering 502-504
  // while it swaps instances or the server says it is busy) are retried
  // twice, a little later each time. Anything else is a real answer.
  for (let attempt = 0; ; attempt++) {
    const retryable = attempt < RETRY_DELAYS_MS.length && !init?.signal?.aborted
    let res: Response
    try {
      res = await fetch(API_BASE + path, init)
    } catch (err) {
      if (init?.signal?.aborted) throw err
      if (retryable) {
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      throw new Error("couldn't reach the server; check your connection and try again")
    }

    if (res.ok) return (await res.json()) as T
    if (retryable && TRANSIENT_STATUSES.has(res.status)) {
      await sleep(RETRY_DELAYS_MS[attempt])
      continue
    }
    // A retry of a request that had in fact arrived the first time: the
    // server already has what we asked for.
    if (res.status === 409 && conflictMeansDone && attempt > 0) return {} as T

    let message = `request failed (${res.status})`
    try {
      const body = await res.json()
      if (typeof body?.detail === 'string') message = body.detail
    } catch {
      // Body was not JSON. Keep the generic message.
    }
    throw new ApiError(message, res.status)
  }
}

/** Waits before each retry of a transient failure; its length is the retry count. */
export const RETRY_DELAYS_MS = [1000, 3000]
const TRANSIENT_STATUSES = new Set([502, 503, 504])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * GET /api/limits, fire and forget, as soon as the page loads.
 *
 * A free-tier backend sleeps when idle and takes up to a minute to wake. Poking
 * it here starts that clock while the visitor is still choosing a file,
 * instead of when they drop it. The answer also carries the largest file the
 * server takes, which the page then checks before uploading (lib/fileCheck).
 * Errors are swallowed: the page keeps its built-in limits, and a failed
 * upload reports itself later with a real message.
 */
export function warmUp(): void {
  fetch(API_BASE + '/api/limits')
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      const files = body?.files
      if (
        typeof files?.max_bytes === 'number' &&
        typeof files?.max_pixels?.jpeg === 'number' &&
        typeof files?.max_pixels?.other === 'number'
      ) {
        setFileLimits({ maxBytes: files.max_bytes, maxPixels: files.max_pixels })
      }
    })
    .catch(() => {})
}

/** POST /api/upload. Sends the PDF or image, gets back a job id and basic info. */
export async function uploadFile(
  file: File,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<UploadResponse> {
  // One retry for a dropped connection or a busy server; the bar starts over.
  try {
    return await sendUpload(file, signal, onProgress)
  } catch (err) {
    const transient =
      !(err instanceof ApiError) || TRANSIENT_STATUSES.has(err.status)
    if (!transient || signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      throw err
    }
    await sleep(RETRY_DELAYS_MS[0])
    onProgress?.(0)
    return sendUpload(file, signal, onProgress)
  }
}

function sendUpload(
  file: File,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<UploadResponse> {
  const form = new FormData()
  form.append('file', file)
  // XMLHttpRequest rather than fetch: only it reports upload progress, and a
  // 5 MB photo on mobile data takes long enough to need a bar. No
  // Content-Type header: the browser sets it, including the multipart
  // boundary, and setting it by hand breaks the upload.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', API_BASE + '/api/upload')
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total)
      }
    }
    xhr.onload = () => {
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        // Not JSON; handled below.
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        resolve(body as UploadResponse)
        return
      }
      const detail = (body as { detail?: unknown } | null)?.detail
      reject(
        new ApiError(
          typeof detail === 'string' ? detail : `request failed (${xhr.status})`,
          xhr.status,
        ),
      )
    }
    xhr.onerror = () =>
      reject(new Error('the upload did not reach the server; check your connection and try again'))
    xhr.onabort = () => reject(new DOMException('The upload was cancelled.', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(form)
  })
}

/** POST /api/jobs/{id}/analyze. Estimates the floor that bounds the slider. */
export function analyzeJob(jobId: string, signal?: AbortSignal): Promise<AnalyzeResponse> {
  return request<AnalyzeResponse>(`/api/jobs/${jobId}/analyze`, { method: 'POST', signal })
}

/**
 * POST /api/jobs/{id}/compress. Queues the run; progress arrives over SSE.
 * With `resize`, an image comes back at exactly that many pixels.
 */
export function startCompress(
  jobId: string,
  targetBytes: number,
  resize?: Resize | null,
  signal?: AbortSignal,
  prepare = false,
  minBytes: number | null = null,
): Promise<{ job_id: string; status: string }> {
  return request(
    `/api/jobs/${jobId}/compress`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_bytes: targetBytes,
        ...resize,
        ...(minBytes ? { min_bytes: minBytes } : {}),
        ...(prepare ? { prepare } : {}),
      }),
      signal,
    },
    // A retried Compress that finds a run already going: the first try got
    // through. (Not for a head-start, whose 409 means "not needed".)
    { conflictMeansDone: !prepare },
  )
}

/** GET /api/jobs/{id}. Current job state, including seconds until deletion. */
export function getJob(jobId: string, signal?: AbortSignal): Promise<JobState> {
  return request<JobState>(`/api/jobs/${jobId}`, { signal })
}

/** DELETE /api/jobs/{id}. Removes stored files immediately. */
export function deleteJob(jobId: string, signal?: AbortSignal): Promise<{ deleted: boolean }> {
  return request(`/api/jobs/${jobId}`, { method: 'DELETE', signal })
}

/** Direct link for the browser to download from. Not fetched through JS. */
export function downloadUrl(jobId: string): string {
  return `${API_BASE}/api/jobs/${jobId}/download`
}

/** SSE endpoint. Consumed by EventSource in hooks/useProgressStream.ts. */
export function eventsUrl(jobId: string): string {
  return `${API_BASE}/api/jobs/${jobId}/events`
}
