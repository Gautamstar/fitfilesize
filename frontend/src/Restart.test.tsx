/**
 * A run the server lost (restart, deploy, forgotten job) starts again once,
 * by itself, with the file still in the page, and never loops.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { startCompress, uploadFile } from './lib/api'

const RESTARTED =
  'The server restarted while your file was being processed, so it was lost. Please upload it again.'
// Which jobs the (mocked) progress stream reports as failed.
const failing = new Map<string, string>()

vi.mock('./hooks/useProgressStream', () => ({
  LOST_MESSAGE: 'The server lost track of your file, so it has to be uploaded again.',
  useProgressStream: (jobId: string | null, enabled: boolean) => ({
    steps: [],
    search: { rungs: null, target: null, lossless: null, points: {}, current: null },
    attempts: 0,
    result: null,
    error: enabled && jobId ? (failing.get(jobId) ?? null) : null,
    expiresAt: null,
  }),
}))

const upload = (id: string) => ({
  job_id: id, kind: 'image', filename: 'photo.jpg', size_bytes: 5_000_000, pages: 1,
  width: 4000, height: 3000, image_share: 1, has_forms: false, expires_in: 1800,
})

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>()
  return {
    ...actual,
    warmUp: vi.fn(),
    uploadFile: vi.fn(),
    analyzeJob: vi.fn(async () => ({ job_id: 'job1', original_bytes: 5_000_000, floor_estimate: 20_000 })),
    startCompress: vi.fn(async () => ({ job_id: 'x', status: 'queued' })),
  }
})
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
  failing.clear()
  vi.mocked(uploadFile).mockReset()
  vi.mocked(uploadFile).mockResolvedValueOnce(upload('job1') as never)
  vi.mocked(uploadFile).mockResolvedValueOnce(upload('job2') as never)
  vi.mocked(startCompress).mockClear()
})

async function compressOnLandingPage() {
  const { default: App } = await import('./App')
  render(<App path="/compress-jpg-to-200kb" />)
  const input = document.querySelector('input[type=file]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['x'], 'photo.jpg', { type: 'image/jpeg' })] } })
  fireEvent.click(await screen.findByRole('button', { name: 'Compress' }))
}

it('starts a lost run again with the same size', async () => {
  failing.set('job1', RESTARTED)
  await compressOnLandingPage()
  await screen.findByText('Finding the best quality that fits') // job2's progress
  expect(uploadFile).toHaveBeenCalledTimes(2)
  expect(startCompress).toHaveBeenLastCalledWith('job2', 200_000, null, undefined, false, null)
  expect(screen.queryByText(/That did not work/)).toBeNull()
})

it('gives up after one restart instead of looping', async () => {
  failing.set('job1', RESTARTED)
  failing.set('job2', RESTARTED)
  await compressOnLandingPage()
  await screen.findByText(/That did not work/)
  expect(uploadFile).toHaveBeenCalledTimes(2)
})

it('does not restart a run that failed for another reason', async () => {
  failing.set('job1', 'This file was too much for the server to process.')
  await compressOnLandingPage()
  await screen.findByText(/That did not work/)
  expect(uploadFile).toHaveBeenCalledTimes(1)
})
