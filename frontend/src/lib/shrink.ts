/**
 * A smaller copy of a big photo, made in the browser, to upload in its place.
 *
 * A form that wants 50 KB is usually given a 5 to 12 MB phone photo, and the
 * upload is the slowest part of the visit, most of all on mobile data. When
 * the limit is far below the file, the server ends up at a few thousand
 * pixels anyway, so the page sends a copy at SHRINK_EDGE instead: the same
 * answer for a fraction of the bytes.
 *
 * "The same answer" is checked, not assumed. The copy is kept at a quality
 * above every rung the server tries, and only used when it is still
 * HEADROOM times the limit: the server's answer is then a rung at or below
 * SHRINK_EDGE, which the copy holds in full. A limit or pixel size picked
 * later that the copy cannot serve sends the original after all
 * (needsOriginal). Anything that goes wrong here also sends the original.
 *
 * Why always SHRINK_EDGE, even for a 20 KB limit: the browser shrinks a
 * picture a little differently from the server, so a copy near the size of
 * the answer shifts which rung fits, sometimes a step down. Over 4 photos and
 * 6 limits from 20 KB to 1 MB, copies sized down to the limit changed 6 of 24
 * answers; the SHRINK_EDGE copy, which the server shrinks further itself,
 * changed 1 (a step up, still under the limit).
 */

import { readImageSize, type ImageSize } from './fileCheck'
import type { Resize } from '../types/api'

/** Longest side of the copy: the server's 3000 px rung, kept in full. */
export const SHRINK_EDGE = 3000
/** Above the best quality the server's ladder uses (92). */
const QUALITY = 0.95
/** The copy must stay this many times the limit (see the note above). */
export const HEADROOM = 3
/** Smaller files upload quickly anyway. */
const MIN_BYTES = 1_500_000
/** A slow phone gives up on the copy and sends the original. */
const TIMEOUT_MS = 8000

export interface Shrunk {
  file: File
  /** The copy's size, upright. */
  width: number
  height: number
}

/**
 * The EXIF orientation of a JPEG (1 to 8), or 1 when it has none. The copy is
 * drawn upright and carries no EXIF, so this is how the page checks the
 * browser really did turn it.
 */
export function jpegOrientation(b: Uint8Array): number {
  let i = 2
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]
    const len = (b[i + 2] << 8) | b[i + 3]
    if (marker === 0xda || marker === 0xd9) break // pixel data: no EXIF ahead
    const exif = i + 4
    if (
      marker === 0xe1 &&
      b[exif] === 0x45 && b[exif + 1] === 0x78 && b[exif + 2] === 0x69 && b[exif + 3] === 0x66
    ) {
      const t = exif + 6 // TIFF header
      const le = b[t] === 0x49
      const u16 = (k: number) => (le ? b[k] | (b[k + 1] << 8) : (b[k] << 8) | b[k + 1])
      const u32 = (k: number) =>
        le
          ? (b[k] | (b[k + 1] << 8) | (b[k + 2] << 16) | (b[k + 3] << 24)) >>> 0
          : ((b[k] << 24) | (b[k + 1] << 16) | (b[k + 2] << 8) | b[k + 3]) >>> 0
      const ifd = t + u32(t + 4)
      const count = u16(ifd)
      for (let n = 0; n < count; n++) {
        const entry = ifd + 2 + n * 12
        if (entry + 10 > b.length) break
        if (u16(entry) === 0x0112) {
          const v = u16(entry + 8)
          return v >= 1 && v <= 8 ? v : 1
        }
      }
      return 1
    }
    i += 2 + len
  }
  return 1
}

/** Whether a copy is worth making for this file and limit. */
export function worthShrinking(size: ImageSize | null, bytes: number, limit: number | null): boolean {
  return (
    size !== null &&
    size.format === 'JPEG' &&
    limit !== null &&
    bytes > MIN_BYTES &&
    bytes > HEADROOM * limit &&
    Math.max(size.width, size.height) > SHRINK_EDGE * 1.1
  )
}

/**
 * Whether a run needs the original rather than the copy: a limit the copy is
 * too close to, or a pixel size bigger than the copy holds.
 */
export function needsOriginal(shrunk: Shrunk, target: number, resize: Resize | null): boolean {
  if (target * HEADROOM > shrunk.file.size) return true
  if (!resize) return false
  const sx = resize.width / shrunk.width
  const sy = resize.height / shrunk.height
  return (resize.fit === 'crop' ? Math.max(sx, sy) : Math.min(sx, sy)) > 1
}

/** A smaller copy of `file` to upload for `limit`, or null to send the original. */
export async function shrinkForUpload(file: File, limit: number | null): Promise<Shrunk | null> {
  try {
    const head = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer())
    const size = await readImageSize(file)
    if (!worthShrinking(size, file.size, limit) || !size) return null
    const turned = jpegOrientation(head) >= 5
    const upright = turned ? { w: size.height, h: size.width } : { w: size.width, h: size.height }

    let timer = 0
    const timeout = new Promise<null>((resolve) => {
      timer = window.setTimeout(() => resolve(null), TIMEOUT_MS)
    })
    const copy = await Promise.race([draw(file, upright, HEADROOM * (limit as number)), timeout])
    window.clearTimeout(timer)
    // Too close to the limit to be sure of the server's answer (see draw),
    // or not enough smaller to be worth it.
    if (!copy || copy.file.size > file.size * 0.7) {
      return null
    }
    return copy
  } catch {
    return null
  }
}

async function draw(
  file: File,
  upright: { w: number; h: number },
  minBytes: number,
): Promise<Shrunk | null> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    // A browser that did not turn the picture the way EXIF says would upload
    // it sideways, with no EXIF left to fix it. Send the original instead.
    if (bitmap.width !== upright.w || bitmap.height !== upright.h) return null
    const copy = await encode(file, bitmap, SHRINK_EDGE)
    return copy && copy.file.size >= minBytes ? copy : null
  } finally {
    bitmap.close()
  }
}

async function encode(file: File, bitmap: ImageBitmap, edge: number): Promise<Shrunk | null> {
  const scale = edge / Math.max(bitmap.width, bitmap.height)
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, width, height)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', QUALITY),
  )
  canvas.width = canvas.height = 0 // let go of the pixels now, not at GC
  if (!blob) return null
  return { file: new File([blob], file.name, { type: 'image/jpeg' }), width, height }
}
