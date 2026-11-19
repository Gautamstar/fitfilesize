/**
 * Sends a file to the FitFileSize API and brings the fitted one back. It runs
 * here rather than in the page: the API only allows the website's origin, and
 * an extension's own requests to a host it lists are not held to that.
 */
const API = 'https://api.fitfilesize.com'
const POLL_MS = 2000
const POLL_LIMIT_MS = 5 * 60 * 1000

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== 'fit') return false
  fit(message).then(reply, (error) => reply({ error: error.message }))
  return true // reply comes later
})

async function fit({ name, mime, data, target, minimum, width, height, keepFormat, allowJpeg }) {
  const file = await (await fetch(`data:${mime || 'application/octet-stream'};base64,${data}`)).blob()
  const form = new FormData()
  form.append('file', file, name)
  form.append('target', String(target))
  if (minimum) form.append('minimum', String(minimum))
  if (width && height) {
    form.append('width', String(width))
    form.append('height', String(height))
    form.append('keep_format', keepFormat ? 'true' : 'false')
  }
  if (allowJpeg) form.append('allow_jpeg', 'true')

  const res = await fetch(`${API}/api/fit`, { method: 'POST', body: form })
  let body = await res.json().catch(() => ({}))
  if (res.status === 429) throw new Error('The hourly limit is reached. Try again in a while.')
  if (!res.ok) throw new Error(body.detail || `The server answered ${res.status}.`)

  const job = `${API}/api/jobs/${body.job_id}`
  try {
    if (res.status === 202) body = await finished(job)
    const fits = body.fits ?? body.hit_target ?? false
    const finalBytes = body.final_bytes
    if (!fits) return { fits, finalBytes }
    const download = await fetch(`${job}/download`)
    if (!download.ok) throw new Error(`The result could not be fetched (${download.status}).`)
    const blob = await download.blob()
    return { fits, finalBytes, mime: blob.type, data: await base64(blob) }
  } finally {
    // The page now holds the file; nothing needs to stay on the server.
    fetch(job, { method: 'DELETE' }).catch(() => {})
  }
}

/** Polls a slow run until it ends; the job's state has the same fields as a fit. */
async function finished(job) {
  const start = Date.now()
  while (Date.now() - start < POLL_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const state = await (await fetch(job)).json()
    if (state.status === 'done') return state
    if (state.status === 'error') throw new Error(state.error || 'The file could not be compressed.')
  }
  throw new Error('This file is taking too long. Try it on fitfilesize.com.')
}

async function base64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(out)
}
