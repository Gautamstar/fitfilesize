/**
 * The tools through a real MCP client connection, against a stand-in API:
 * what an assistant sends, what reaches the server, and what is saved.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Form } from '../src/forms.js'
import { findForm, loadForms, resetForms } from '../src/forms.js'
import { createServer } from '../src/server.js'

const FORMS: Form[] = [
  {
    id: 'ibps-signature', name: 'IBPS signature', kind: 'image',
    requirements: ['JPEG', '140 × 60 pixels', '10 KB to 20 KB'],
    limit_bytes: 20_000, min_bytes: 10_240, width: 140, height: 60,
    source: 'https://ibps.example/guide.pdf', checked: '2026-09-26', page: 'https://fitfilesize.com/ibps-signature',
  },
]

interface Call { method: string; url: string; fields?: Record<string, string> }

/** A stand-in for the FitFileSize API that records what it was sent. */
function fakeApi({ pending = 0, fail }: { pending?: number; fail?: { status: number; detail: string } } = {}) {
  const calls: Call[] = []
  let polls = 0
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const call: Call = { method, url }
    if (init?.body instanceof FormData) {
      call.fields = Object.fromEntries(
        [...init.body.entries()].filter(([, v]) => typeof v === 'string') as [string, string][],
      )
    }
    calls.push(call)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/api/fit')) {
      if (fail) return json({ detail: fail.detail }, fail.status)
      const base = { job_id: 'j1', download_url: 'https://api.test/api/jobs/j1/download' }
      return pending
        ? json({ ...base, status: 'compressing', status_url: 'https://api.test/api/jobs/j1' }, 202)
        : json({ ...base, status: 'done', fits: true, original_bytes: 5000, final_bytes: 1200, target_bytes: 20_000, warnings: [] })
    }
    if (url.endsWith('/api/jobs/j1') && method === 'GET') {
      polls += 1
      return json(
        polls < pending
          ? { status: 'compressing' }
          : { status: 'done', hit_target: true, size_bytes: 5000, final_bytes: 1200, target_bytes: 20_000, warnings: ['padded to 10.0 KB to meet the minimum size'] },
      )
    }
    if (url.endsWith('/download')) return new Response(new Uint8Array(1200), { headers: { 'content-type': 'image/jpeg' } })
    if (method === 'DELETE') return json({ deleted: true })
    return json({ detail: 'not found' }, 404)
  }) as typeof fetch
  return { fetchImpl, calls }
}

async function connect(fetchImpl: typeof fetch) {
  const server = createServer({ api: 'https://api.test', fetchImpl, pollMs: 1, loadFormsImpl: async () => FORMS })
  const client = new Client({ name: 'test', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

// callTool's result type also allows a legacy shape without `content`.
const text = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n')

let dir: string
let photo: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ffs-mcp-'))
  photo = join(dir, 'sign.png')
  await writeFile(photo, new Uint8Array(5000))
})
afterEach(() => resetForms())

describe('fit_file', () => {
  it('sends the limit, saves the result beside the original, and deletes the server copy', async () => {
    const api = fakeApi()
    const client = await connect(api.fetchImpl)
    const r = await client.callTool({ name: 'fit_file', arguments: { path: photo, limit: '200KB' } })
    expect(r.isError).toBeFalsy()
    expect(api.calls[0].fields).toMatchObject({ target: '200KB' })
    const out = join(dir, 'sign.fit.jpg') // the result's own type, not the original's
    expect((await readFile(out)).length).toBe(1200)
    expect(text(r)).toContain(`Saved ${out}`)
    expect(api.calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://api.test/api/jobs/j1' })
  })

  it("applies a form's limit, minimum and pixels", async () => {
    const api = fakeApi()
    const client = await connect(api.fetchImpl)
    const r = await client.callTool({ name: 'fit_file', arguments: { path: photo, form: 'IBPS Signature' } })
    expect(r.isError).toBeFalsy()
    expect(api.calls[0].fields).toMatchObject({ target: '20000', minimum: '10240', width: '140', height: '60' })
    expect(text(r)).toContain('for IBPS signature')
  })

  it('waits for a long run to finish', async () => {
    const api = fakeApi({ pending: 3 })
    const client = await connect(api.fetchImpl)
    const r = await client.callTool({ name: 'fit_file', arguments: { path: photo, form: 'ibps-signature' } })
    expect(r.isError).toBeFalsy()
    expect(api.calls.filter((c) => c.method === 'GET' && c.url.endsWith('/api/jobs/j1')).length).toBe(3)
    expect(text(r)).toContain('Note: Padded to 10.0 KB')
  })

  it("passes on the server's reason for refusing a file", async () => {
    const api = fakeApi({ fail: { status: 422, detail: 'this photo is 108 megapixels; the most we can take is 64' } })
    const client = await connect(api.fetchImpl)
    const r = await client.callTool({ name: 'fit_file', arguments: { path: photo, limit: '1MB' } })
    expect(r.isError).toBe(true)
    expect(text(r)).toBe('This photo is 108 megapixels; the most we can take is 64.')
  })

  it.each([
    [{ limit: '1MB', form: 'ibps-signature' }, /either `limit`/],
    [{}, /either `limit`/],
    [{ form: 'passport' }, /No form called "passport". Known forms: ibps-signature/],
    [{ limit: '1MB', width: 100 }, /both `width` and `height`/],
  ])('refuses %j', async (extra, message) => {
    const api = fakeApi()
    const client = await connect(api.fetchImpl)
    const r = await client.callTool({ name: 'fit_file', arguments: { path: photo, ...extra } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(message)
    expect(api.calls).toEqual([]) // nothing uploaded
  })

  it('asks for a full path rather than guessing where a relative one points', async () => {
    const api = fakeApi()
    const client = await connect(api.fetchImpl)
    const r = await client.callTool({ name: 'fit_file', arguments: { path: 'sign.png', limit: '1MB' } })
    expect(text(r)).toMatch(/full path/)
    expect(api.calls).toEqual([])
  })

  it('says so when the file does not exist', async () => {
    const client = await connect(fakeApi().fetchImpl)
    const r = await client.callTool({ name: 'fit_file', arguments: { path: join(dir, 'nope.jpg'), limit: '1MB' } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/No file at/)
  })
})

describe('list_forms and the form list', () => {
  it('lists each form with its rules and source', async () => {
    const client = await connect(fakeApi().fetchImpl)
    const r = await client.callTool({ name: 'list_forms', arguments: {} })
    expect(text(r)).toContain('ibps-signature: IBPS signature. JPEG, 140 × 60 pixels, 10 KB to 20 KB.')
    expect(text(r)).toContain('https://ibps.example/guide.pdf')
  })

  it('uses the live list when the site answers', async () => {
    const live = (async () => new Response(JSON.stringify({ forms: FORMS }))) as unknown as typeof fetch
    expect((await loadForms(live, 'https://site.test/forms.json')).map((f) => f.id)).toEqual(['ibps-signature'])
  })

  it('falls back to the bundled copy when the site cannot be reached', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const forms = await loadForms(down, 'https://site.test/forms.json')
    expect(forms.length).toBeGreaterThan(5)
    expect(findForm(forms, 'us-visa-photo-ds160')?.width).toBe(600)
  })
})
