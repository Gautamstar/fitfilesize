import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MediaKind, Resize } from '../types/api'
import { TargetPicker } from './TargetPicker'

function setup(
  kind: MediaKind,
  initialResize?: Resize,
  // null for no landing-page preset (undefined would take the default).
  { originalBytes = 3_000_000, floor = 120_000, initialTarget = 50_000 as number | null } = {},
) {
  const onCompress = vi.fn()
  render(
    <TargetPicker
      filename="photo.jpg"
      meta="3.0 MB, 3000 x 2000"
      originalBytes={originalBytes}
      floor={floor}
      kind={kind}
      onCompress={onCompress}
      onCancel={() => {}}
      initialTarget={initialTarget ?? undefined}
      initialResize={initialResize}
    />,
  )
  return onCompress
}

const typeSize = (width: string, height: string) => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Width' }), { target: { value: width } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Height' }), { target: { value: height } })
}

const compress = () => fireEvent.click(screen.getByRole('button', { name: 'Compress' }))

describe('TargetPicker pixel size', () => {
  it('is offered for images only', () => {
    setup('pdf')
    expect(screen.queryByText('Exact size in pixels (optional)')).toBeNull()
  })

  it('sends no resize until both sides are filled in', () => {
    const onCompress = setup('image')
    compress()
    expect(onCompress).toHaveBeenLastCalledWith(expect.any(Number), null)
  })

  it('sends the typed size and fit, and keeps the target in bytes', () => {
    const onCompress = setup('image')
    fireEvent.change(screen.getByRole('textbox', { name: 'Width' }), { target: { value: '200' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Height' }), { target: { value: '230' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Add a white border' }))
    compress()
    const [target, resize] = onCompress.mock.calls.at(-1)!
    expect(resize).toEqual({ width: 200, height: 230, fit: 'pad' })
    // The landing preset survives the slider's range moving under it.
    expect(target).toBe(50_000)
  })

  it('blocks Compress on a half-typed size', () => {
    const onCompress = setup('image')
    fireEvent.change(screen.getByRole('textbox', { name: 'Width' }), { target: { value: '200' } })
    expect(screen.getByText(/Enter both width and height/)).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Compress' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Height' }), { target: { value: '2.5' } })
    expect(button.disabled).toBe(true)
    expect(onCompress).not.toHaveBeenCalled()
  })

  it('lands a chip on its exact limit', () => {
    const onCompress = setup('image')
    fireEvent.click(screen.getByRole('button', { name: '200 KB' }))
    compress()
    expect(onCompress.mock.calls.at(-1)![0]).toBe(200_000)
  })

  it('never raises a picked limit when a large pixel size raises the floor', () => {
    const onCompress = setup('image', undefined, { initialTarget: null })
    fireEvent.click(screen.getByRole('button', { name: '100 KB' }))
    // 3000 x 3000 puts the estimated floor near 560 KB, well above 100 KB.
    typeSize('3000', '3000')
    expect((screen.getByRole('button', { name: '100 KB' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
    compress()
    expect(onCompress.mock.calls.at(-1)![0]).toBe(100_000)
  })

  it('comes back filled in after "Try another size"', () => {
    const onCompress = setup('image', { width: 140, height: 60, fit: 'crop' })
    expect((screen.getByRole('textbox', { name: 'Width' }) as HTMLInputElement).value).toBe('140')
    compress()
    expect(onCompress.mock.calls.at(-1)![1]).toEqual({ width: 140, height: 60, fit: 'crop' })
  })
})

describe('TargetPicker when the file already fits', () => {
  it('says so when the chosen limit is above the file size', () => {
    setup('image', undefined, { originalBytes: 111_000, floor: 20_000, initialTarget: 500_000 })
    expect(screen.getByText(/already under 500 KB/)).toBeTruthy()
  })

  it('says nothing when the file is bigger than the limit', () => {
    setup('image', undefined, { originalBytes: 3_000_000, floor: 20_000, initialTarget: 500_000 })
    expect(screen.queryByText(/already under/)).toBeNull()
    // The landing page's round limit keeps its own number.
    expect(screen.getByText('500 KB', { selector: '.target-value' })).toBeTruthy()
  })
})
