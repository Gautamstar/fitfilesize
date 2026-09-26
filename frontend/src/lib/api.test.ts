/**
 * Retries: a dropped connection or a 502-504 (the host swapping instances,
 * the server briefly busy) should cost a moment, not the visitor's run.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError, getJob, startCompress } from './api'

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const fail = (status: number, detail = 'nope') => ({
  ok: false,
  status,
  json: async () => ({ detail }),
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(10_000)
  return p
}

it('retries a busy server and succeeds', async () => {
  fetchMock.mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(ok({ job_id: 'j1' }))
  const res = await settle(getJob('j1'))
  expect(res).toEqual({ job_id: 'j1' })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('retries a dropped connection', async () => {
  fetchMock
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(ok({ job_id: 'j1' }))
  expect(await settle(getJob('j1'))).toEqual({ job_id: 'j1' })
})

it('gives up after two retries with a plain message', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
  const p = getJob('j1').catch((e) => e)
  const err = await settle(p)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(String(err.message)).toMatch(/couldn't reach the server/)
})

it('does not retry a real answer', async () => {
  fetchMock.mockResolvedValue(fail(404, 'job not found'))
  const err = await settle(getJob('j1').catch((e) => e))
  expect(err).toBeInstanceOf(ApiError)
  expect(err.status).toBe(404)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('treats "already in progress" after a retried Compress as done', async () => {
  // The first try reached the server but its answer was lost.
  fetchMock.mockResolvedValueOnce(fail(502)).mockResolvedValueOnce(fail(409, 'already in progress'))
  await expect(settle(startCompress('j1', 200_000))).resolves.toBeDefined()
})

it('still reports "already in progress" on a first try', async () => {
  fetchMock.mockResolvedValueOnce(fail(409, 'a compression run is already in progress'))
  const err = await settle(startCompress('j1', 200_000).catch((e) => e))
  expect(err).toBeInstanceOf(ApiError)
  expect(err.status).toBe(409)
})
