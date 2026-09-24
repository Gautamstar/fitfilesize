/**
 * Typed client for the FitFileSize backend (the fitpdf package).
 *
 * One function per endpoint, each declaring what it returns, so callers get
 * autocomplete and typo protection instead of guessing at response shapes.
 */

import type { AnalyzeResponse, JobState, UploadResponse } from '../types/api'

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
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, init)

  if (!res.ok) {
    let message = `request failed (${res.status})`
    try {
      const body = await res.json()
      if (typeof body?.detail === 'string') message = body.detail
    } catch {
      // Body was not JSON. Keep the generic message.
    }
    throw new ApiError(message, res.status)
  }

  return (await res.json()) as T
}

/**
 * GET /health, fire and forget, as soon as the page loads.
 *
 * A free-tier backend sleeps when idle and takes up to a minute to wake. Poking
 * it here starts that clock while the visitor is still choosing a file,
 * instead of when they drop it. The answer does not matter, so errors are
 * swallowed: a failed upload reports itself later with a real message.
 */
export function warmUp(): void {
  fetch(API_BASE + '/health').catch(() => {})
}

/** POST /api/upload. Sends the PDF or image, gets back a job id and basic info. */
export function uploadFile(file: File, signal?: AbortSignal): Promise<UploadResponse> {
  const form = new FormData()
  form.append('file', file)
  // Note: no Content-Type header. The browser sets it, including the
  // multipart boundary, and setting it by hand breaks the upload.
  return request<UploadResponse>('/api/upload', { method: 'POST', body: form, signal })
}

/** POST /api/jobs/{id}/analyze. Estimates the floor that bounds the slider. */
export function analyzeJob(jobId: string, signal?: AbortSignal): Promise<AnalyzeResponse> {
  return request<AnalyzeResponse>(`/api/jobs/${jobId}/analyze`, { method: 'POST', signal })
}

/** POST /api/jobs/{id}/compress. Queues the run; progress arrives over SSE. */
export function startCompress(
  jobId: string,
  targetBytes: number,
  signal?: AbortSignal,
): Promise<{ job_id: string; status: string }> {
  return request(`/api/jobs/${jobId}/compress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_bytes: targetBytes }),
    signal,
  })
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
