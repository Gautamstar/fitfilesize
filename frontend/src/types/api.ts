/**
 * Hand-written mirror of the FitFileSize backend API.
 *
 * These types are ASSERTIONS, not guarantees. `await res.json()` returns `any`,
 * so nothing here is verified at compile time or at runtime. If the Python
 * changes shape and this file does not, TypeScript will happily lie to you.
 * Keep it in sync by hand.
 *
 * Backend source of truth: src/fitpdf/web/app.py
 */

/* ---- POST /api/upload. Every field is always present. ---- */

/** Which strategy the backend picked for this file. */
export type MediaKind = 'pdf' | 'image'

export interface UploadResponse {
  job_id: string
  kind: MediaKind
  filename: string
  size_bytes: number
  /** Page count for PDFs, 1 for images. */
  pages: number
  /** Pixel dimensions for images, 0 for PDFs. */
  width: number
  height: number
  image_share: number
  has_forms: boolean
  expires_in: number
}

/* ---- POST /api/jobs/{id}/analyze. Bounds for the target slider. ---- */

export interface AnalyzeResponse {
  job_id: string
  original_bytes: number
  floor_estimate: number
}

/* ---- POST /api/jobs/{id}/compress. Optional, images only. ---- */

/**
 * An exact pixel size for an image result, as exam and ID photo forms ask for.
 * `fit` decides what happens when the shape differs: 'crop' fills the frame
 * and trims the overflow, 'pad' keeps the whole image on a white border.
 */
export interface Resize {
  width: number
  height: number
  fit: 'crop' | 'pad'
}

/* ---- GET /api/jobs/{id}, and the SSE `state` event. ---- */

/**
 * Every value `status` can hold. Six come from the API and the worker; the
 * seventh, "unknown", is the fallback the API sends when a job has no status
 * recorded, and it reaches the client like any other value.
 */
export type JobStatus =
  | 'uploaded'
  | 'analyzed'
  | 'queued'
  | 'compressing'
  | 'done'
  | 'error'
  | 'unknown'

/**
 * How the engine reached the final file. Three are fixed strings; the rung
 * case is generated as `rung:{index}`, so it is an open family. A template
 * literal type covers that without falling back to plain `string`.
 */
export type CompressMethod =
  | 'none'
  | 'lossless'
  | 'floor'
  | `rung:${number}`

export interface JobState {
  // Always present.
  job_id: string
  status: JobStatus
  kind: MediaKind
  filename: string
  size_bytes: number
  pages: number
  expires_in: number

  // Images only.
  width?: number
  height?: number

  // Present once analysis has run.
  floor_estimate?: number

  // Present once a run has been queued or has finished.
  target_bytes?: number
  final_bytes?: number
  rungs_tried?: number
  hit_target?: boolean
  method?: CompressMethod
  warnings?: string[]

  // Present only on a failed run.
  error?: string
}

/* ------------------------------------------------------------------ *
 * 4. ProgressEvent                                                     *
 *    The SSE payloads from GET /api/jobs/{id}/events                    *
 *                                                                      *
 *    Six stages. "start", "error" and "done" come from the worker;      *
 *    "lossless", "rung_start" and "rung_result" come from the engine    *
 *    through its on_progress callback.                                  *
 *                                                                      *
 *    Each variant pins `stage` to one literal value, which makes it the *
 *    discriminant: a `switch (ev.stage)` narrows the union to a single  *
 *    variant per branch and blocks access to fields that stage does not *
 *    carry. Typing `stage` as `string` would break that.                *
 * ------------------------------------------------------------------ */

/** Emitted once when the worker picks up the job. */
export interface StartEvent {
  stage: 'start'
  target_bytes: number
}

/**
 * The lossless pass finished.
 *
 * `size` is a plain `number` here, since the lossless pass either succeeds or
 * raises. Contrast rung_result's `size`, which is nullable because a render
 * can fail without stopping the search.
 */
export interface LosslessEvent {
  stage: 'lossless'
  size: number
}

/**
 * A rung of the ladder is about to run. The settings come from whichever
 * strategy is driving, so a PDF run and an image run carry different fields.
 *
 * All share `stage: 'rung_start'`, so `stage` alone cannot tell them apart.
 * Narrow with the `in` operator on a field only one of them has:
 *
 *     if ('width' in ev) { ev.quality } else if ('max_edge' in ev) { ev.quality } else { ev.jpeg_q }
 */
export interface PdfRungStartEvent {
  stage: 'rung_start'
  rung: number
  color_dpi: number
  mono_dpi: number
  jpeg_q: number
}

export interface ImageRungStartEvent {
  stage: 'rung_start'
  rung: number
  /** Cap on the longest side, in pixels. */
  max_edge: number
  /** JPEG quality, 1-95. */
  quality: number
}

/** An image run at an exact pixel size, where only quality changes. */
export interface ResizeRungStartEvent {
  stage: 'rung_start'
  rung: number
  width: number
  height: number
  quality: number
}

export type RungStartEvent = PdfRungStartEvent | ImageRungStartEvent | ResizeRungStartEvent

/**
 * That rung finished.
 *
 * `size` is nullable rather than optional: the key is always on the wire, and
 * the value is null when the render raised or produced a file that failed
 * validation. Those two cases are what `fits: false` cannot distinguish.
 */
export interface RungResultEvent {
  stage: 'rung_result'
  rung: number
  size: number | null
  fits: boolean
}

/** Terminal success, carrying everything the result panel needs. */
export interface DoneEvent {
  stage: 'done'
  hit_target: boolean
  final_bytes: number
  original_bytes: number
  target_bytes: number
  method: CompressMethod
  warnings: string[]
}

/** Terminal failure, carrying the message shown to the user. */
export interface ErrorEvent {
  stage: 'error'
  message: string
}

/**
 * Everything that can arrive on the SSE stream.
 *
 * Adding a stage to the backend and to this union makes TypeScript point at
 * every switch that does not handle it yet.
 */
export type ProgressEvent =
  | StartEvent
  | LosslessEvent
  | RungStartEvent
  | RungResultEvent
  | DoneEvent
  | ErrorEvent
