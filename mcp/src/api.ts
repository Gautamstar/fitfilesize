/**
 * The FitFileSize API, as the tools use it: upload a file to /api/fit, wait
 * for the result, save it next to the original, and delete the server's copy.
 */

import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

export const DEFAULT_API = 'https://api.fitfilesize.com'

export interface FitRequest {
  path: string
  /** Size limit as the API takes it: "200KB", "1.5MB" or bytes ("200000"). */
  limit: string
  minimum?: string
  width?: number
  height?: number
  fit?: 'crop' | 'pad'
  /** Where to save the result; defaults to "<name>.fit.<ext>" beside the original. */
  output?: string
}

export interface FitResult {
  output: string
  originalBytes: number
  finalBytes: number
  targetBytes: number
  fits: boolean
  warnings: string[]
}

export class FitError extends Error {}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
}

interface Options {
  api?: string
  fetchImpl?: typeof fetch
  /** Poll interval while a long run finishes (ms). */
  pollMs?: number
  /** Give up waiting after this long (ms). */
  timeoutMs?: number
}

async function detail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown }
    if (typeof body.detail === 'string') return body.detail
  } catch {
    // not JSON
  }
  return `the server answered ${res.status}`
}

/** A sentence from an API message: "file is over..." -> "File is over...". */
const sentence = (s: string) => {
  const t = s.trim()
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : t
}

export async function fitFile(req: FitRequest, opts: Options = {}): Promise<FitResult> {
  const api = (opts.api ?? DEFAULT_API).replace(/\/+$/, '')
  const f = opts.fetchImpl ?? fetch
  const pollMs = opts.pollMs ?? 1500
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000

  let info
  try {
    info = await stat(req.path)
  } catch {
    throw new FitError(`No file at ${req.path}. Give the full path to the file.`)
  }
  if (!info.isFile()) throw new FitError(`${req.path} is not a file.`)

  const form = new FormData()
  form.append('file', new Blob([await readFile(req.path)]), basename(req.path))
  form.append('target', req.limit)
  if (req.minimum) form.append('minimum', req.minimum)
  if (req.width !== undefined) form.append('width', String(req.width))
  if (req.height !== undefined) form.append('height', String(req.height))
  if (req.fit) form.append('fit', req.fit)

  let res: Response
  try {
    res = await f(`${api}/api/fit`, { method: 'POST', body: form })
  } catch {
    throw new FitError('Could not reach fitfilesize.com. Check the internet connection and try again.')
  }
  if (res.status !== 200 && res.status !== 202) throw new FitError(sentence(await detail(res)))
  let body = (await res.json()) as {
    job_id: string
    status: string
    status_url?: string
    download_url: string
    fits?: boolean
    original_bytes?: number
    final_bytes?: number
    target_bytes?: number
    warnings?: string[]
  }

  // A long run answers 202 first; poll until it is done.
  const deadline = Date.now() + timeoutMs
  while (body.status !== 'done') {
    if (Date.now() > deadline) throw new FitError('The file is taking too long to compress. Try again later.')
    await new Promise((r) => setTimeout(r, pollMs))
    const st = await f(body.status_url ?? `${api}/api/jobs/${body.job_id}`)
    if (!st.ok) throw new FitError(sentence(await detail(st)))
    const state = (await st.json()) as {
      status: string
      error?: string
      hit_target?: boolean
      size_bytes?: number
      final_bytes?: number
      target_bytes?: number
      warnings?: string[]
    }
    if (state.status === 'error') throw new FitError(sentence(state.error ?? 'compression failed'))
    body = {
      ...body,
      status: state.status,
      fits: state.hit_target,
      original_bytes: state.size_bytes,
      final_bytes: state.final_bytes,
      target_bytes: state.target_bytes,
      warnings: state.warnings,
    }
  }

  const dl = await f(body.download_url)
  if (!dl.ok) throw new FitError(sentence(await detail(dl)))
  const bytes = new Uint8Array(await dl.arrayBuffer())
  const type = (dl.headers.get('content-type') ?? '').split(';')[0].trim()
  const ext = EXTENSIONS[type] ?? extname(req.path)
  const output =
    req.output ?? join(dirname(req.path), `${basename(req.path, extname(req.path))}.fit${ext}`)
  await writeFile(output, bytes)

  // The result is saved here; nothing needs to stay on the server.
  await f(`${api}/api/jobs/${body.job_id}`, { method: 'DELETE' }).catch(() => undefined)

  return {
    output,
    originalBytes: body.original_bytes ?? info.size,
    finalBytes: bytes.length,
    targetBytes: body.target_bytes ?? 0,
    fits: body.fits ?? false,
    warnings: (body.warnings ?? []).map(sentence),
  }
}
