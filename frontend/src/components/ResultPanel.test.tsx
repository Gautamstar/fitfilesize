import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ResultPanel } from './ResultPanel'
import type { DoneEvent } from '../types/api'

const done = (over: Partial<DoneEvent> = {}): DoneEvent => ({
  stage: 'done',
  hit_target: true,
  final_bytes: 47_600,
  original_bytes: 1_000_000,
  target_bytes: 50_000,
  method: 'rung:4',
  warnings: [],
  ...over,
})

function setup(props: Partial<Parameters<typeof ResultPanel>[0]> = {}) {
  const onDelete = vi.fn()
  render(
    <ResultPanel
      jobId="j1"
      result={done()}
      secondsLeft={600}
      onRetry={() => {}}
      onDelete={onDelete}
      filename="photo.png"
      kind="image"
      {...props}
    />,
  )
  return onDelete
}

describe('ResultPanel', () => {
  it('leads with the limit, the pixels and the format', () => {
    setup({ resize: { width: 200, height: 230, fit: 'crop' }, minBytes: 20_480 })
    expect(screen.getByRole('heading', { name: 'Fits under 50 KB' })).toBeTruthy()
    expect(screen.getByText(/between 20 KB and 50 KB/)).toBeTruthy()
    expect(screen.getByText('200 × 230')).toBeTruthy()
    // A PNG cut to a pixel size comes back as a JPEG.
    expect(screen.getByText('JPEG')).toBeTruthy()
  })

  it('keeps the format of a file that was not cut to a pixel size', () => {
    setup()
    expect(screen.getByText('PNG')).toBeTruthy()
  })

  it('previews without counting a download', () => {
    setup()
    const img = screen.getByRole('img', { name: 'The compressed photo.png' })
    expect(img.getAttribute('src')).toMatch(/\/download\?preview=1$/)
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toMatch(/\/download$/)
  })

  it('says when the file could not reach the limit', () => {
    setup({ result: done({ hit_target: false, final_bytes: 80_000, method: 'floor' }) })
    expect(screen.getByRole('heading', { name: 'As small as it goes' })).toBeTruthy()
    expect(screen.getByText(/over your 50 KB limit/)).toBeTruthy()
  })

  it('asks before deleting', () => {
    const onDelete = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Delete now' }))
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledOnce()
  })
})
