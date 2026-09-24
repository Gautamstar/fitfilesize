/**
 * Pure formatting and slider maths.
 *
 * Nothing here touches React or the DOM, which is why it lives in its own
 * file: these functions are easy to reason about and easy to test.
 */

/** Number of discrete positions on the target slider. */
export const SLIDER_STEPS = 1000

/** Preset chip values, in MB. */
export const PRESETS_MB = [2, 4, 5, 10, 25]

/** Lossless pass plus at most 4 rungs, since 12 rungs binary-search in 4. */
export const MAX_ATTEMPTS = 5

/** Human-readable byte size, e.g. 1536 -> "1.5 KB". */
export function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let n = bytes
  for (const u of units) {
    n /= 1024
    if (n < 1024 || u === 'GB') return `${n.toFixed(1)} ${u}`
  }
  // Unreachable, but TypeScript cannot prove the loop always returns.
  return `${bytes} B`
}

/**
 * The slider is logarithmic, not linear, so that dragging feels even across
 * a range that might span 100 KB to 100 MB.
 */
export function sliderToBytes(pos: number, lo: number, hi: number): number {
  return Math.round(lo * Math.pow(hi / lo, pos / SLIDER_STEPS))
}

export function bytesToSlider(bytes: number, lo: number, hi: number): number {
  const clamped = Math.min(Math.max(bytes, lo), hi)
  return Math.round((SLIDER_STEPS * Math.log(clamped / lo)) / Math.log(hi / lo))
}

/**
 * Slider position for a hard limit: the highest position whose size is still
 * at or under `bytes`. bytesToSlider rounds to the nearest position, which can
 * land a few hundred bytes over, and over is exactly what a limit forbids.
 */
export function presetToSlider(bytes: number, lo: number, hi: number): number {
  let pos = bytesToSlider(bytes, lo, hi)
  while (pos > 0 && sliderToBytes(pos, lo, hi) > bytes) pos--
  return pos
}

/** Plain-language description of what a given target will do. */
export function tierHint(target: number, originalBytes: number): string {
  const ratio = target / originalBytes
  if (ratio >= 0.75) return 'Light work. Your images stay sharp at this size.'
  if (ratio >= 0.45) return 'A good middle ground. Still fine to print.'
  if (ratio >= 0.25) return 'Images soften a little here, but stay easy to read.'
  return 'The hardest squeeze. Good for reading on a screen.'
}

/** What the backend will accept, mirroring ACCEPTED_SUFFIXES in web/app.py. */
export const ACCEPTED_EXTENSIONS = [
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.tif',
  '.tiff',
  '.bmp',
]

export function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase()
  if (ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) return true
  // Some browsers report no filename extension for pasted or camera files.
  return file.type === 'application/pdf' || file.type.startsWith('image/')
}

/** "2.4 MB, 3 pages" for PDFs, "2.4 MB, 3000 x 2000" for images. */
export function describeSource(
  kind: 'pdf' | 'image',
  sizeBytes: number,
  pages: number,
  width?: number,
  height?: number,
): string {
  if (kind === 'image' && width && height) {
    return `${fmt(sizeBytes)}, ${width} x ${height}`
  }
  return `${fmt(sizeBytes)}, ${pages} ${pages === 1 ? 'page' : 'pages'}`
}

/** mm:ss for the auto-delete countdown. */
export function formatCountdown(secondsLeft: number): string {
  const m = Math.floor(secondsLeft / 60)
  const s = String(secondsLeft % 60).padStart(2, '0')
  return `${m}:${s}`
}
