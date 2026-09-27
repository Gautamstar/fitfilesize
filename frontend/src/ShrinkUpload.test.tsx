/**
 * The smaller copy of a big photo (lib/shrink.ts) is what gets uploaded, but
 * the visitor still sees their own file's size, and a limit the copy cannot
 * serve sends the original before the run starts.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { deleteJob, startCompress, uploadFile } from './lib/api'

const original = new File([new Uint8Array(5_000_000)], 'photo.jpg', { type: 'image/jpeg' })
const copy = new File([new Uint8Array(1_200_000)], 'photo.jpg', { type: 'image/jpeg' })

vi.mock('./lib/shrink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/shrink')>()
  return {
    ...actual,
    shrinkForUpload: vi.fn(async () => ({ file: copy, width: 3000, height: 2250 })),
  }
})

const upload = (id: string, size: number) => ({
  job_id: id, kind: 'image', filename: 'photo.jpg', size_bytes: size, pages: 1,
  width: 3000, height: 2250, image_share: 1, has_forms: false, expires_in: 1800,
})

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>()
  return {
    ...actual,
    warmUp: vi.fn(),
    uploadFile: vi.fn(),
    deleteJob: vi.fn(async () => {}),
    analyzeJob: vi.fn(async () => ({ job_id: 'copy', original_bytes: 1_200_000, floor_estimate: 20_000 })),
    startCompress: vi.fn(async () => ({ job_id: 'x', status: 'queued' })),
  }
})
// The run's progress is not what this tests.
vi.mock('./hooks/useProgressStream', () => ({
  LOST_MESSAGE: '',
  useProgressStream: () => ({
    steps: [],
    search: { rungs: null, target: null, lossless: null, points: {}, current: null },
    attempts: 0,
    result: null,
    error: null,
    expiresAt: null,
  }),
}))
vi.mock('@vercel/analytics/react', () => ({ Analytics: () => null }))
vi.mock('@vercel/speed-insights/react', () => ({ SpeedInsights: () => null }))
vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  },
)

beforeEach(() => {
  vi.mocked(uploadFile).mockReset()
  vi.mocked(uploadFile).mockResolvedValueOnce(upload('copy', 1_200_000) as never)
  vi.mocked(uploadFile).mockResolvedValueOnce(upload('orig', 5_000_000) as never)
  vi.mocked(startCompress).mockClear()
  vi.mocked(deleteJob).mockClear()
})

async function drop() {
  const { default: App } = await import('./App')
  render(<App path="/compress-jpg-to-200kb" />)
  const input = document.querySelector('input[type=file]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [original] } })
  await screen.findByRole('button', { name: 'Compress' })
}

it('uploads the copy and shows the size of the file the visitor chose', async () => {
  await drop()
  expect(vi.mocked(uploadFile).mock.calls[0][0]).toBe(copy)
  expect(document.querySelector('.file-meta')?.textContent).toMatch(/^4\.8 MB/)
  // The page's 200 KB is well under the copy, so its head-start uses it.
  expect(startCompress).toHaveBeenCalledWith('copy', 200_000, null, undefined, true, null)
})

it('sends the original for a limit the copy is too close to', async () => {
  await drop()
  fireEvent.click(screen.getByRole('button', { name: '1 MB' }))
  fireEvent.click(screen.getByRole('button', { name: 'Compress' }))
  await vi.waitFor(() => expect(startCompress).toHaveBeenLastCalledWith('orig', 1_000_000, null, undefined, false, null))
  expect(vi.mocked(uploadFile).mock.calls[1][0]).toBe(original)
  expect(deleteJob).toHaveBeenCalledWith('copy')
})

it('keeps the copy for the limit it was made for', async () => {
  await drop()
  fireEvent.click(screen.getByRole('button', { name: 'Compress' }))
  await vi.waitFor(() => expect(startCompress).toHaveBeenLastCalledWith('copy', 200_000, null, undefined, false, null))
  expect(uploadFile).toHaveBeenCalledTimes(1)
})
