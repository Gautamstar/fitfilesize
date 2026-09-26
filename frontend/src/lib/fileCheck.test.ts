/**
 * Header reading on real files from real encoders (Pillow): every format the
 * site takes, the JPEG variants phones produce, and all three WebP layouts.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { fileLimits, fileProblem, parseImageSize, readImageSize, setFileLimits } from './fileCheck'
import alphaWebp from './__fixtures__/alpha.webp?inline'
import baselineJpg from './__fixtures__/baseline.jpg?inline'
import exifJpg from './__fixtures__/exif.jpg?inline'
import imageBmp from './__fixtures__/image.bmp?inline'
import imagePng from './__fixtures__/image.png?inline'
import losslessWebp from './__fixtures__/lossless.webp?inline'
import lossyWebp from './__fixtures__/lossy.webp?inline'
import progressiveJpg from './__fixtures__/progressive.jpg?inline'

// Loaded as data URLs (Vite's ?inline), so no file system access is needed.
const FIXTURES: Record<string, string> = {
  'alpha.webp': alphaWebp,
  'baseline.jpg': baselineJpg,
  'exif.jpg': exifJpg,
  'image.bmp': imageBmp,
  'image.png': imagePng,
  // Vite has no asset type for TIFF, so the header Pillow wrote (through the
  // first directory, which holds the size) is inlined here.
  'little.tif':
    'data:image/tiff;base64,SUkqAAgAAAAKAAABBAABAAAAJQAAAAEBBAABAAAAFwAAAAIBAwADAAAAhgAAAAMBAwABAAAAAQAAAAYBAwABAAAAAgAAABEBBAABAAAAjAAAABUBAwABAAAAAwAAABYBBAABAAAAFwAAABcBBAABAAAA+QkAABwBAwABAAAAAQAAAA==',
  'lossless.webp': losslessWebp,
  'lossy.webp': lossyWebp,
  'progressive.jpg': progressiveJpg,
}

const fixture = (name: string): Uint8Array<ArrayBuffer> => {
  const base64 = FIXTURES[name].split(',')[1]
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

describe('parseImageSize', () => {
  it.each([
    ['baseline.jpg', 'JPEG'],
    ['progressive.jpg', 'JPEG'],
    ['exif.jpg', 'JPEG'], // a 30 KB EXIF block before the frame header
    ['image.png', 'PNG'],
    ['lossy.webp', 'WEBP'],
    ['lossless.webp', 'WEBP'],
    ['alpha.webp', 'WEBP'], // extended layout (VP8X)
    ['image.bmp', 'BMP'],
    ['little.tif', 'TIFF'],
  ])('reads %s', (name, format) => {
    // Stored size, not the upright one: a turned photo has the same pixels.
    expect(parseImageSize(fixture(name))).toEqual({ format, width: 37, height: 23 })
  })

  it('reads a big-endian TIFF', () => {
    // "MM", directory at 8 with two entries: width 3000 (SHORT), height 70000 (LONG).
    const b = new Uint8Array(8 + 2 + 24)
    b.set([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 2])
    b.set([0x01, 0x00, 0, 3, 0, 0, 0, 1, 0x0b, 0xb8, 0, 0], 10)
    b.set([0x01, 0x01, 0, 4, 0, 0, 0, 1, 0x00, 0x01, 0x11, 0x70], 22)
    expect(parseImageSize(b)).toEqual({ format: 'TIFF', width: 3000, height: 70000 })
  })

  it('says nothing about a PDF or a truncated image', () => {
    expect(parseImageSize(new TextEncoder().encode('%PDF-1.7\n'))).toBeNull()
    expect(parseImageSize(fixture('baseline.jpg').subarray(0, 40))).toBeNull()
  })
})

describe('fileProblem', () => {
  const saved = fileLimits()
  afterEach(() => setFileLimits(saved))

  const file = (bytes: Uint8Array<ArrayBuffer>, name: string) => new File([bytes], name)

  it('passes a file within every limit', async () => {
    expect(await fileProblem(file(fixture('image.png'), 'a.png'))).toBeNull()
  })

  it('refuses an image with too many pixels, as the server words it', async () => {
    setFileLimits({ ...saved, maxPixels: { jpeg: 800, other: 500 } })
    expect(await fileProblem(file(fixture('baseline.jpg'), 'a.jpg'))).toMatch(
      /^this photo is \d+ megapixels; the most we can take is/,
    )
    expect(await fileProblem(file(fixture('image.png'), 'a.png'))).toMatch(
      /for a PNG .* for a JPEG\)\. Save it as a JPEG/,
    )
  })

  it('uses the higher cap for a JPEG', async () => {
    setFileLimits({ ...saved, maxPixels: { jpeg: 1000, other: 500 } }) // 37 x 23 = 851
    expect(await fileProblem(file(fixture('baseline.jpg'), 'a.jpg'))).toBeNull()
    expect(await fileProblem(file(fixture('image.png'), 'a.png'))).not.toBeNull()
  })

  it('refuses a file over the upload size', async () => {
    setFileLimits({ ...saved, maxBytes: 100 })
    expect(await fileProblem(file(fixture('baseline.jpg'), 'a.jpg'))).toBe(
      'file is over the 100 B upload limit',
    )
  })

  it('leaves a PDF to the server', async () => {
    const pdf = new File(['%PDF-1.7\n'], 'a.pdf')
    expect(await readImageSize(pdf)).toBeNull()
    expect(await fileProblem(pdf)).toBeNull()
  })
})
