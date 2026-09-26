/**
 * The head-start run: started once the file is read, but only for a size the
 * visitor chose (a landing page's, or a chip they clicked), never for the
 * home page's default.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { startCompress, uploadFile } from './lib/api'

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>()
  return {
    ...actual,
    warmUp: vi.fn(),
    uploadFile: vi.fn(async () => ({
      job_id: 'job1', kind: 'image', filename: 'photo.jpg', size_bytes: 5_000_000, pages: 1,
      width: 4000, height: 3000, image_share: 1, has_forms: false, expires_in: 1800,
    })),
    analyzeJob: vi.fn(async () => ({ job_id: 'job1', original_bytes: 5_000_000, floor_estimate: 20_000 })),
    startCompress: vi.fn(async () => ({ job_id: 'job1', status: 'queued' })),
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
  vi.mocked(startCompress).mockClear()
  vi.mocked(uploadFile).mockClear()
})

async function dropPhoto() {
  const input = document.querySelector('input[type=file]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['x'], 'photo.jpg', { type: 'image/jpeg' })] } })
  await screen.findByRole('button', { name: 'Compress' })
}

it('starts no head-start for the home page default size', async () => {
  const { default: App } = await import('./App')
  render(<App path="/" />)
  await dropPhoto()
  expect(startCompress).not.toHaveBeenCalled()
})

it('starts one for a size clicked before upload', async () => {
  const { default: App } = await import('./App')
  render(<App path="/" />)
  fireEvent.click(screen.getByRole('button', { name: '500 KB' }))
  await dropPhoto()
  expect(startCompress).toHaveBeenCalledWith('job1', 500_000, null, undefined, true, null)
})

it("starts one for a landing page's size", async () => {
  const { default: App } = await import('./App')
  render(<App path="/compress-jpg-to-200kb" />)
  await dropPhoto()
  expect(startCompress).toHaveBeenCalledWith('job1', 200_000, null, undefined, true, null)
})

it('refuses an image with too many pixels without uploading it', async () => {
  // A PNG header claiming 7000 x 5000 (35 MP; the cap for PNG is 34).
  const header = new Uint8Array(33)
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(header.buffer).setUint32(16, 7000)
  new DataView(header.buffer).setUint32(20, 5000)
  const { default: App } = await import('./App')
  render(<App path="/" />)
  const input = document.querySelector('input[type=file]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([header], 'huge.png', { type: 'image/png' })] } })
  expect(await screen.findByText(/35 megapixels/)).toBeTruthy()
  expect(uploadFile).not.toHaveBeenCalled()
})

it("sends a form page's pixel size and minimum, which Compress sends too", async () => {
  const { default: App } = await import('./App')
  render(<App path="/ibps-signature" />)
  await dropPhoto()
  const form = [{ width: 140, height: 60, fit: 'crop' }, undefined] as const
  expect(startCompress).toHaveBeenCalledWith('job1', 20_000, ...form, true, 10_240)
  fireEvent.click(screen.getByRole('button', { name: 'Compress' }))
  expect(startCompress).toHaveBeenLastCalledWith('job1', 20_000, ...form, false, 10_240)
  expect(screen.queryByText(/already under/)).toBeNull()
})
