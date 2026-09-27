import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ResultPanel } from './ResultPanel'
import type { DoneEvent } from '../types/api'

const pngFloor: DoneEvent = {
  stage: 'done',
  hit_target: false,
  final_bytes: 400_000,
  original_bytes: 19_000_000,
  target_bytes: 100_000,
  method: 'floor',
  warnings: ['as a PNG it could not get under your limit (the smallest was 400 KB); a JPEG can go much smaller'],
  needs_jpeg: true,
}

const panel = (result: DoneEvent, onConvertToJpeg = vi.fn()) =>
  render(
    <ResultPanel
      jobId="j"
      result={result}
      secondsLeft={null}
      onRetry={() => {}}
      onDelete={() => {}}
      onConvertToJpeg={onConvertToJpeg}
    />,
  )

describe('ResultPanel', () => {
  it('asks before turning a PNG into a JPEG', () => {
    const convert = vi.fn()
    panel(pngFloor, convert)
    expect(screen.getByText(/A JPEG can get under 100 KB/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Download the PNG anyway' })).toBeTruthy()
    // Said once, in the offer, not again as a warning.
    expect(screen.queryByText(/as a PNG it could not/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Convert to JPEG' }))
    expect(convert).toHaveBeenCalledOnce()
  })

  it('offers a JPEG when a PNG only fitted by shrinking a lot', () => {
    const convert = vi.fn()
    panel({ ...pngFloor, hit_target: true, needs_jpeg: false, png_shrunk: true, method: 'rung:6', warnings: [] }, convert)
    expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try it as a JPEG' }))
    expect(convert).toHaveBeenCalledOnce()
  })

  it('offers nothing when the file fitted', () => {
    panel({ ...pngFloor, hit_target: true, needs_jpeg: false, method: 'rung:0', warnings: [] })
    expect(screen.queryByRole('button', { name: 'Convert to JPEG' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy()
  })
})
