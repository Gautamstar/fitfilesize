/**
 * Refuse a file the server would refuse, before uploading it.
 *
 * The server takes files up to a size cap and images up to a pixel count
 * (more would not fit in its memory). It checks both on upload, and stays the
 * authority. But a 108 MP photo is 18 MB: on mobile data that is half a
 * minute of uploading, and one of the visitor's hourly uploads, to be told no.
 * The browser can say the same thing at once. Pixel counts come from the
 * file's header (the first few KB), never from decoding the image, which for
 * a photo that size could take a phone's memory.
 */

import { fmt } from './format'

export interface FileLimits {
  maxBytes: number
  /** Pixel caps: JPEG decodes at reduced size, so it gets a higher one. */
  maxPixels: { jpeg: number; other: number }
}

/**
 * The production values, used until the server's own arrive (see
 * setFileLimits); the page then follows whatever the server says.
 */
let limits: FileLimits = {
  maxBytes: 26_214_400,
  maxPixels: { jpeg: 64_000_000, other: 34_000_000 },
}

export function setFileLimits(next: FileLimits): void {
  limits = next
}

export function fileLimits(): FileLimits {
  return limits
}

export type ImageFormat = 'JPEG' | 'PNG' | 'WEBP' | 'BMP' | 'TIFF'

export interface ImageSize {
  format: ImageFormat
  width: number
  height: number
}

/** Enough for any header, including a JPEG's EXIF block ahead of its size. */
const HEADER_BYTES = 512 * 1024

/** Why the server would refuse this file, or null. Worded as the server words it. */
export async function fileProblem(file: File): Promise<string | null> {
  if (file.size > limits.maxBytes) {
    return `file is over the ${fmt(limits.maxBytes)} upload limit`
  }
  let size: ImageSize | null = null
  try {
    size = await readImageSize(file)
  } catch {
    size = null // unreadable here; the server decides
  }
  if (!size) return null
  const pixels = size.width * size.height
  const cap = size.format === 'JPEG' ? limits.maxPixels.jpeg : limits.maxPixels.other
  if (pixels <= cap) return null
  const mp = Math.round(pixels / 1e6)
  const capMp = Math.floor(cap / 1e6)
  if (size.format === 'JPEG') {
    return `this photo is ${mp} megapixels; the most we can take is ${capMp}. Make it smaller first`
  }
  const jpegMp = Math.floor(limits.maxPixels.jpeg / 1e6)
  return (
    `this image is ${mp} megapixels; the most we can take for a ${size.format} is ${capMp} ` +
    `(${jpegMp} for a JPEG). Save it as a JPEG or make it smaller first`
  )
}

/** Width and height from an image file's header, or null for anything else. */
export async function readImageSize(file: Blob): Promise<ImageSize | null> {
  return parseImageSize(new Uint8Array(await readBytes(file.slice(0, HEADER_BYTES))))
}

function readBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

export function parseImageSize(b: Uint8Array): ImageSize | null {
  const u16be = (i: number) => (b[i] << 8) | b[i + 1]
  const u16le = (i: number) => b[i] | (b[i + 1] << 8)
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3])
  const u32le = (i: number) => ((b[i + 3] << 24) >>> 0) + ((b[i + 2] << 16) | (b[i + 1] << 8) | b[i])
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))
  const size = (format: ImageFormat, width: number, height: number): ImageSize | null =>
    width > 0 && height > 0 ? { format, width, height } : null

  // PNG: signature, then IHDR with width and height first.
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') {
    return size('PNG', u32be(16), u32be(20))
  }

  // JPEG: walk the segments to the frame header (SOFn).
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]
      if (marker === 0xff) {
        i += 1 // fill byte
        continue
      }
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) return size('JPEG', u16be(i + 7), u16be(i + 5))
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2 // no length
        continue
      }
      i += 2 + u16be(i + 2)
    }
    return null
  }

  // WebP: a RIFF container, then one of three bitstream headers.
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4)
    if (chunk === 'VP8 ') return size('WEBP', u16le(26) & 0x3fff, u16le(28) & 0x3fff)
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = u32le(21)
      return size('WEBP', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    if (chunk === 'VP8X') return size('WEBP', u24le(24) + 1, u24le(27) + 1)
    return null
  }

  // BMP: width and height (negative for top-down) in the info header.
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const w = u32le(18) | 0
    const h = u32le(22) | 0
    return size('BMP', Math.abs(w), Math.abs(h))
  }

  // TIFF: the first directory's ImageWidth (256) and ImageLength (257).
  const little = ascii(0, 4) === 'II*\0'
  if (b.length >= 8 && (little || ascii(0, 4) === 'MM\0*')) {
    const r16 = little ? u16le : u16be
    const r32 = little ? u32le : u32be
    const ifd = r32(4)
    if (ifd + 2 > b.length) return null // directory past what was read
    let width = 0
    let height = 0
    const count = r16(ifd)
    for (let n = 0; n < count; n++) {
      const e = ifd + 2 + n * 12
      if (e + 12 > b.length) break
      const tag = r16(e)
      const type = r16(e + 2)
      const value = type === 3 ? r16(e + 8) : r32(e + 8) // SHORT or LONG
      if (tag === 256) width = value
      if (tag === 257) height = value
    }
    return size('TIFF', width, height)
  }

  return null
}
