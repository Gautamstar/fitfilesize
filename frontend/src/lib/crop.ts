/** Geometry of an exact-size crop, shared by the crop box and its picker. */

/** The server's default crop, CROP_CENTERING in strategies.py. */
export const DEFAULT_FOCUS = { x: 0.5, y: 0.35 }

export interface Focus {
  x: number
  y: number
}

/** Shapes closer than this crop almost nothing, so there is nothing to place. */
const SAME_SHAPE = 0.02

/** The box's size as shares of the picture, and the axis it moves along. */
export function cropFrame(imageW: number, imageH: number, width: number, height: number) {
  const ratio = imageW / imageH
  const target = width / height
  const mismatch = 1 - Math.min(ratio, target) / Math.max(ratio, target)
  if (mismatch <= SAME_SHAPE) return null
  return ratio > target
    ? { w: target / ratio, h: 1, axis: 'x' as const }
    : { w: 1, h: ratio / target, axis: 'y' as const }
}
