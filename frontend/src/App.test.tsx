/**
 * The "server is waking up" note. A free-tier backend that has been idle takes
 * up to a minute to answer the first upload, and without a word the page looks
 * hung, which is the moment a first-time visitor leaves.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>()
  return {
    ...actual,
    warmUp: vi.fn(),
    // Never settles: the upload is stuck, as it is while the server boots.
    uploadFile: vi.fn(() => new Promise(() => {})),
  }
})

// Vercel's components want a real browser; they are not what this tests.
vi.mock('@vercel/analytics/react', () => ({ Analytics: () => null }))
vi.mock('@vercel/speed-insights/react', () => ({ SpeedInsights: () => null }))

// jsdom has no IntersectionObserver, which motion's whileInView needs for the
// landing bands. Nothing here scrolls, so a stub that never fires is enough.
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

it('explains a slow upload instead of looking hung', async () => {
  const { default: App } = await import('./App')
  render(<App path="/" />)

  const input = document.querySelector('input[type=file]') as HTMLInputElement
  const file = new File(['x'], 'scan.pdf', { type: 'application/pdf' })
  fireEvent.change(input, { target: { files: [file] } })

  // Let the dropzone animate out and the "Reading your file" panel in.
  await screen.findByText('Reading your file')
  expect(screen.queryByText(/wake up/)).toBeNull()

  // The note appears once the upload has been pending for 5 seconds.
  expect(await screen.findByText(/wake up/, undefined, { timeout: 7000 })).toBeTruthy()
}, 10_000)
