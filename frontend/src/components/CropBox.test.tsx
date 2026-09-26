/**
 * The crop box sends the server the same fraction ImageOps.fit takes as
 * `centering`, and stays out of the way until the visitor moves it, so an
 * untouched crop still matches a head-start run.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TargetPicker } from './TargetPicker'
import { cropFrame } from '../lib/crop'
import type { Resize } from '../types/api'

describe('cropFrame', () => {
  it('fills the height of a picture wider than the frame, and moves sideways', () => {
    expect(cropFrame(3000, 2000, 200, 200)).toEqual({ w: 2 / 3, h: 1, axis: 'x' })
  })

  it('fills the width of a picture taller than the frame, and moves up and down', () => {
    expect(cropFrame(2000, 3000, 200, 100)).toEqual({ w: 1, h: 1 / 3, axis: 'y' })
  })

  it('has nothing to place when the shapes match', () => {
    expect(cropFrame(3000, 2000, 600, 400)).toBeNull()
    expect(cropFrame(3000, 2000, 600, 405)).toBeNull()
  })
})

function setup(initialResize: Resize = { width: 200, height: 200, fit: 'crop' }) {
  const onCompress = vi.fn()
  render(
    <TargetPicker
      filename="photo.jpg"
      meta="3.0 MB, 3000 x 2000"
      originalBytes={3_000_000}
      floor={120_000}
      kind="image"
      onCompress={onCompress}
      onCancel={() => {}}
      initialTarget={50_000}
      initialResize={initialResize}
      preview="blob:photo"
    />,
  )
  // jsdom loads no pictures: stand in for a 3000 x 2000 photo arriving.
  const img = document.querySelector('.crop-frame img') as HTMLImageElement
  Object.defineProperty(img, 'naturalWidth', { value: 3000 })
  Object.defineProperty(img, 'naturalHeight', { value: 2000 })
  fireEvent.load(img)
  return onCompress
}

const compress = () => fireEvent.click(screen.getByRole('button', { name: 'Compress' }))

describe('the crop box in the picker', () => {
  it('asks for the server default until it is moved', () => {
    const onCompress = setup()
    expect(screen.getByRole('slider', { name: /crop position/i })).toBeTruthy()
    compress()
    expect(onCompress.mock.calls.at(-1)![1]).toEqual({ width: 200, height: 200, fit: 'crop' })
  })

  it('sends where the visitor moved it', () => {
    const onCompress = setup()
    const box = screen.getByRole('slider', { name: /left to right/i })
    fireEvent.keyDown(box, { key: 'Home' })
    compress()
    expect(onCompress.mock.calls.at(-1)![1]).toEqual({
      width: 200,
      height: 200,
      fit: 'crop',
      crop_x: 0,
      crop_y: 0.35,
    })
    fireEvent.keyDown(box, { key: 'ArrowRight' })
    expect(box.getAttribute('aria-valuenow')).toBe('5')
  })

  it('keeps a position from the last run', () => {
    const onCompress = setup({ width: 200, height: 200, fit: 'crop', crop_x: 1, crop_y: 0.35 })
    expect(screen.getByRole('slider', { name: /crop position/i }).getAttribute('aria-valuenow')).toBe('100')
    compress()
    expect(onCompress.mock.calls.at(-1)![1]).toMatchObject({ crop_x: 1 })
  })

  it('goes away with a white border, and sends no position', () => {
    const onCompress = setup({ width: 200, height: 200, fit: 'crop', crop_x: 1, crop_y: 0.35 })
    fireEvent.click(screen.getByRole('radio', { name: 'Add a white border' }))
    expect(screen.queryByRole('slider', { name: /crop position/i })).toBeNull()
    compress()
    expect(onCompress.mock.calls.at(-1)![1]).toEqual({ width: 200, height: 200, fit: 'pad' })
  })
})
