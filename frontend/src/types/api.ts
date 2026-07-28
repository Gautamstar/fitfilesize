/**
 * Hand-written mirror of the FitPDF backend API.
 *
 * These types are ASSERTIONS, not guarantees. `await res.json()` returns `any`,
 * so nothing here is verified at compile time or at runtime. If the Python
 * changes shape and this file does not, TypeScript will happily lie to you.
 * Keep it in sync by hand.
 *
 * Backend source of truth: src/fitpdf/web/app.py
 */

/* ------------------------------------------------------------------ *
 * 1. UploadResponse                                                    *
 *    POST /api/upload                                                  *
 *    Source: app.py:174-182                                            *
 *    All seven fields are always present.                              *
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * 2. AnalyzeResponse                                                   *
 *    POST /api/jobs/{id}/analyze                                       *
 *    Source: app.py:192-196                                            *
 *    Three fields, all always present.                                 *
 * ------------------------------------------------------------------ */

export interface AnalyzeResponse {
  job_id: string
  original_bytes: number
  floor_estimate: number
}

/* ------------------------------------------------------------------ *
 * 3. JobState                                                          *
 *    GET /api/jobs/{id}, and the SSE `state` event                     *
 *    Source: app.py:108-129 (the job_state function)                   *
 *                                                                      *
 *    Read that function carefully. The dict is built in two parts:      *
 *    six keys set unconditionally, then a series of `if key in job`     *
 *    additions. The conditional ones need `?`.                          *
 *                                                                      *
 *    `status` is not `string`. Grep for where status gets set           *
 *    (app.py and jobs.py both do) and write it as a union of string     *
 *    literals so typos become compile errors.                           *
 * ------------------------------------------------------------------ */

/**
 * Every value `status` can hold. Six are set explicitly:
 *   "uploaded"    app.py:167
 *   "analyzed"    app.py:191
 *   "queued"      app.py:208
 *   "compressing" jobs.py:25
 *   "error"       jobs.py:39
 *   "done"        jobs.py:46
 * The seventh is the fallback in `job.get("status", "unknown")` at app.py:112,
 * which reaches the client like any other value, so it belongs in the union.
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
 * How the engine got to the final file (engine.py:179, 190, 239, 250).
 * Three are fixed strings, but the rung case is built with an f-string,
 * `f"rung:{fit}"`, so it is an open family. A template literal type covers
 * that without falling back to plain `string`.
 */
export type CompressMethod =
  | 'none'
  | 'lossless'
  | 'floor'
  | `rung:${number}`

export interface JobState {
  // Always present: the keys in the initial dict at app.py.
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

  // Everything below is added only inside an `if`, so the key can be absent.
  // app.py:118-120, all wrapped in int()
  floor_estimate?: number
  target_bytes?: number
  final_bytes?: number
  rungs_tried?: number

  // app.py:121-122. Stored in Redis as "1"/"0", but the Python sends the
  // result of `== "1"`, and a comparison yields a bool.
  hit_target?: boolean

  // app.py:123-128
  method?: CompressMethod
  error?: string
  warnings?: string[] // engine.py:46, list[str]
}

/* ------------------------------------------------------------------ *
 * 4. ProgressEvent                                                     *
 *    The SSE payloads from GET /api/jobs/{id}/events                    *
 *                                                                      *
 *    Six stages, spread across two files:                               *
 *      - "start", "error", "done"  -> jobs.py:26, 40, 54-67             *
 *      - "lossless", "rung_start", "rung_result"                        *
 *          -> engine.py, emitted through the on_progress callback       *
 *    Cross-check against the old switch in                              *
 *    src/fitpdf/web/static/app.js:301-339.                              *
 *                                                                      *
 *    Write SIX separate types, each with its own literal `stage`, then  *
 *    union them. Do NOT write one interface with everything optional.   *
 *    That literal field is the discriminant: once you switch on         *
 *    ev.stage, TypeScript narrows to the right variant inside each      *
 *    branch and blocks access to fields that stage does not have.       *
 *                                                                      *
 *    Two traps:                                                         *
 *      - rung_result.size: the old code tests `=== null`. Optional and  *
 *        nullable are different types. Pick the right one.              *
 *      - `method` on the done event is also a small set of known        *
 *        strings (app.js:375 compares it to "none"). Check engine.py.   *
 * ------------------------------------------------------------------ */

/**
 * Emitted once when the worker picks up the job. Source: jobs.py:26
 *
 * Note `stage: 'start'` is a LITERAL type, not `string`. That is the whole
 * mechanism: because each variant pins `stage` to one exact value, a
 * `switch (ev.stage)` lets TypeScript narrow the union to a single variant
 * inside each branch. Type it as `string` and narrowing stops working.
 */
export interface StartEvent {
  stage: 'start'
  target_bytes: number
}

/**
 * The pikepdf lossless pass finished. Source: engine.py:185
 *
 * `size` here is a plain `number`. lossless_pass always returns an int, and
 * the emit is unconditional. Contrast with rung_result's `size`, which is
 * documented as `int | None` because a Ghostscript run can fail.
 */
export interface LosslessEvent {
  stage: 'lossless'
  size: number
}

/**
 * A rung of the ladder is about to run. Emitted as
 * {"stage": ..., "rung": i, **rung}, so the settings come from whichever
 * strategy is driving: PDF_RUNGS or IMAGE_RUNGS in strategies.py.
 *
 * Both share `stage: 'rung_start'`, so `stage` alone cannot tell them apart.
 * Narrow with the `in` operator on a field only one of them has:
 *
 *     if ('max_edge' in ev) { ev.quality } else { ev.jpeg_q }
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

export type RungStartEvent = PdfRungStartEvent | ImageRungStartEvent

/**
 * That rung finished. Source: engine.py:213-220
 *
 * `size` is `number | null`, NOT `size?: number`. The emit is unconditional,
 * so the key is always on the wire, but the value is set to None when the
 * Ghostscript run raises or produces an invalid PDF (engine.py:209-212).
 * Key always present, value can be null: that is nullable, not optional.
 */
export interface RungResultEvent {
  stage: 'rung_result'
  rung: number
  size: number | null
  fits: boolean
}

/**
 * Terminal success. Source: jobs.py:54-67
 * Reuses CompressMethod from section 3 rather than redeclaring it.
 */
export interface DoneEvent {
  stage: 'done'
  hit_target: boolean
  final_bytes: number
  original_bytes: number
  target_bytes: number
  method: CompressMethod
  warnings: string[]
}

/** Terminal failure. Source: jobs.py:40 */
export interface ErrorEvent {
  stage: 'error'
  message: string
}

/**
 * Everything that can arrive on the SSE stream.
 *
 * Because every variant pins `stage` to a distinct literal, a
 * `switch (ev.stage)` narrows to exactly one variant per branch: inside
 * `case 'rung_start'` you can read `ev.jpeg_q` with no optional check, and
 * reading `ev.message` there is a compile error. Add a seventh stage to the
 * backend later, put it in this union, and TypeScript will point at every
 * switch that has not been updated.
 */
export type ProgressEvent =
  | StartEvent
  | LosslessEvent
  | RungStartEvent
  | RungResultEvent
  | DoneEvent
  | ErrorEvent
