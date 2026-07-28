/**
 * Pure helpers ported from the old static/app.js.
 *
 * These are the same functions you already wrote in JavaScript, with types
 * added. Nothing here touches React or the DOM, which is exactly why they
 * live in their own file: pure functions are easy to reason about and easy
 * to test.
 */

/** Number of discrete positions on the target slider. app.js:19 */
export const SLIDER_STEPS = 1000

/** Preset chip values, in MB. app.js:20 */
export const PRESETS_MB = [2, 4, 5, 10, 25]

/** Lossless pass plus at most 4 rungs (binary search over 12). app.js:21 */
export const MAX_ATTEMPTS = 5

/** Human-readable byte size, e.g. 1536 -> "1.5 KB". app.js:53-61 */
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
 * a range that might span 100 KB to 100 MB. app.js:153-162
 */
export function sliderToBytes(pos: number, lo: number, hi: number): number {
  return Math.round(lo * Math.pow(hi / lo, pos / SLIDER_STEPS))
}

export function bytesToSlider(bytes: number, lo: number, hi: number): number {
  const clamped = Math.min(Math.max(bytes, lo), hi)
  return Math.round((SLIDER_STEPS * Math.log(clamped / lo)) / Math.log(hi / lo))
}

export interface TierHint {
  text: string
  below: boolean
}

/** Plain-language description of what a given target will do. app.js:164-174 */
export function tierHint(
  target: number,
  floor: number,
  originalBytes: number,
): TierHint {
  if (target < floor) {
    return {
      text:
        'Below the estimated floor. You will get the smallest file possible ' +
        `instead, about ${fmt(floor)}.`,
      below: true,
    }
  }
  const ratio = target / originalBytes
  if (ratio >= 0.75)
    return { text: 'Light touch. Mostly structural cleanup, images stay sharp.', below: false }
  if (ratio >= 0.45)
    return { text: 'Balanced. Modest downsampling, fine for print and screen.', below: false }
  if (ratio >= 0.25)
    return { text: 'Aggressive. Images get visibly softer but stay readable.', below: false }
  return { text: 'Maximum squeeze. Screen-reading quality.', below: false }
}

/** mm:ss for the auto-delete countdown. app.js:421-427 */
export function formatCountdown(secondsLeft: number): string {
  const m = Math.floor(secondsLeft / 60)
  const s = String(secondsLeft % 60).padStart(2, '0')
  return `${m}:${s}`
}
