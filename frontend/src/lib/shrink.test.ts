/**
 * When the page may send a smaller copy of a photo, and when it must send the
 * original. The drawing itself needs a real browser (live and local runs
 * cover it); these are the rules that keep the server's answer the same.
 */

import { describe, expect, it } from 'vitest'
import { HEADROOM, SHRINK_EDGE, jpegOrientation, needsOriginal, worthShrinking } from './shrink'

/** A JPEG header with an EXIF orientation tag, in either byte order. */
function exifJpeg(orientation: number, littleEndian = false): Uint8Array {
  const u16 = (n: number) => (littleEndian ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff])
  const u32 = (n: number) =>
    littleEndian ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24] : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
  const tiff = [
    ...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...u16(1), // one entry
    ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0,
    ...u32(0),
  ]
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const len = app1.length + 2
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, ...app1, 0xff, 0xda, 0, 2])
}

describe('jpegOrientation', () => {
  it('reads the tag in both byte orders', () => {
    expect(jpegOrientation(exifJpeg(6))).toBe(6)
    expect(jpegOrientation(exifJpeg(8, true))).toBe(8)
  })

  it('is 1 without EXIF', () => {
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1)
  })
})

const photo = { format: 'JPEG' as const, width: 4032, height: 3024 }

describe('worthShrinking', () => {
  it('shrinks a big photo for a small limit', () => {
    expect(worthShrinking(photo, 5_000_000, 200_000)).toBe(true)
  })

  it('sends the file itself otherwise', () => {
    // A limit near the file: the server may want pixels the copy drops.
    expect(worthShrinking(photo, 5_000_000, 2_000_000)).toBe(false)
    // "Other": no limit known yet.
    expect(worthShrinking(photo, 5_000_000, null)).toBe(false)
    // Small enough to upload quickly anyway.
    expect(worthShrinking(photo, 1_000_000, 50_000)).toBe(false)
    // Already about the copy's size.
    expect(worthShrinking({ ...photo, width: SHRINK_EDGE, height: 2000 }, 5_000_000, 50_000)).toBe(false)
    // Not a JPEG (a PNG may be see-through), or not read.
    expect(worthShrinking({ ...photo, format: 'PNG' }, 5_000_000, 50_000)).toBe(false)
    expect(worthShrinking(null, 5_000_000, 50_000)).toBe(false)
  })
})

describe('needsOriginal', () => {
  const copy = { file: new File([new Uint8Array(1_200_000)], 'a.jpg'), width: 3000, height: 2250 }

  it('keeps the copy for limits well under it', () => {
    expect(needsOriginal(copy, 100_000, null)).toBe(false)
    expect(needsOriginal(copy, 1_200_000 / HEADROOM, null)).toBe(false)
  })

  it('sends the original for a limit too close to the copy', () => {
    expect(needsOriginal(copy, 500_000, null)).toBe(true)
  })

  it('sends the original for more pixels than the copy holds', () => {
    expect(needsOriginal(copy, 50_000, { width: 600, height: 600, fit: 'crop' })).toBe(false)
    // A crop fills the frame, so the shorter side decides.
    expect(needsOriginal(copy, 50_000, { width: 2400, height: 2400, fit: 'crop' })).toBe(true)
    // A white border fits the whole picture inside instead.
    expect(needsOriginal(copy, 50_000, { width: 2400, height: 2400, fit: 'pad' })).toBe(false)
  })
})
