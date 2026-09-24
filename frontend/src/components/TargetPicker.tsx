/**
 * Target-size slider with preset chips.
 *
 * The slider position is the only state. Every label, the fill width, the
 * hatched floor zone and the active chip are derived from it during render,
 * so none of them can drift out of sync with the others.
 */

import { useMemo, useState } from 'react'
import {
  PRESETS_MB,
  SLIDER_STEPS,
  bytesToSlider,
  fmt,
  presetToSlider,
  sliderToBytes,
  tierHint,
} from '../lib/format'

interface TargetPickerProps {
  filename: string
  /** Pre-rendered "2.4 MB, 3 pages" or "2.4 MB, 3000 x 2000". */
  meta: string
  originalBytes: number
  floor: number
  onCompress: (targetBytes: number) => void
  onCancel: () => void
  warning?: string | null
  busy?: boolean
  /** Preselected target from a landing page such as /compress-pdf-to-200kb. */
  initialTarget?: number
}

export function TargetPicker({
  filename,
  meta,
  originalBytes,
  floor,
  onCompress,
  onCancel,
  warning,
  busy = false,
  initialTarget,
}: TargetPickerProps) {
  // Slider spans from below the floor (so the hatched zone is visible) up to
  // the original size.
  const { lo, hi } = useMemo(() => {
    let lower = Math.max(Math.floor(floor * 0.4), 1024)
    // Guard the degenerate case where the floor estimate is at or above the
    // original file size.
    if (lower >= originalBytes) lower = Math.max(Math.floor(originalBytes * 0.4), 512)
    // Stretch down to a landing page's preset so it is reachable, e.g. a 20 KB
    // signature page for a file whose floor is estimated at 100 KB.
    if (initialTarget && initialTarget < lower) lower = Math.max(initialTarget, 512)
    return { lo: lower, hi: originalBytes }
  }, [floor, originalBytes, initialTarget])

  // Default target: the landing page's size when the file is bigger than it,
  // else 4 MB when that makes sense, else 60% of original. A preset below the
  // floor is kept: the visitor came for that size, and the floor is only an
  // estimate. The function form of useState runs this once, not on every render.
  const [pos, setPos] = useState(() => {
    if (initialTarget && initialTarget < originalBytes) {
      return presetToSlider(initialTarget, lo, hi)
    }
    const fourMB = 4 * 1024 * 1024
    let def = fourMB > floor && fourMB < originalBytes ? fourMB : Math.round(originalBytes * 0.6)
    if (def < lo) def = lo
    return bytesToSlider(def, lo, hi)
  })

  // Everything below is derived from `pos`. No manual DOM updates anywhere.
  const target = sliderToBytes(pos, lo, hi)
  const hint = tierHint(target, originalBytes)
  const fillPct = (pos / SLIDER_STEPS) * 100
  const hatchPct = floor <= lo ? 0 : Math.min(100, (bytesToSlider(floor, lo, hi) / SLIDER_STEPS) * 100)

  return (
    <div className="panel">
      <header className="file-head">
        <h2 className="file-name">{filename}</h2>
        <p className="file-meta">{meta}</p>
      </header>

      <p className="target-value">{fmt(target)}</p>
      <p className="target-hint">{hint}</p>

      <div className="slider-wrap">
        <div className="track">
          <div className="track-hatch" style={{ width: `${hatchPct}%` }} />
          <div className="track-fill" style={{ width: `${fillPct}%` }} />
        </div>
        <input
          type="range"
          min={0}
          max={SLIDER_STEPS}
          value={pos}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-label="Target file size"
        />
        <div className="track-labels">
          <span>{fmt(lo)}</span>
          <span>{fmt(hi)}</span>
        </div>
        <p className="floor-note">
          this file goes down to about {fmt(floor)}
        </p>
      </div>

      <div className="chips">
        {PRESETS_MB.map((mb) => {
          const bytes = mb * 1024 * 1024
          const tooBig = bytes >= originalBytes
          const outOfRange = bytes < lo
          const disabled = tooBig || outOfRange
          const belowFloor = !disabled && bytes < floor
          // Active when within 2% of the current target.
          const active = Math.abs(bytes - target) / bytes < 0.02

          return (
            <button
              key={mb}
              type="button"
              className={`chip${active ? ' active' : ''}${belowFloor ? ' below-floor' : ''}`}
              disabled={disabled}
              title={
                tooBig
                  ? 'already smaller than this'
                  : outOfRange
                    ? 'out of range for this file'
                    : belowFloor
                      ? 'below the estimated floor'
                      : undefined
              }
              onClick={() => setPos(bytesToSlider(bytes, lo, hi))}
            >
              {mb} MB
            </button>
          )
        })}
      </div>

      {warning ? <p className="error-text">{warning}</p> : null}

      <div className="actions">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => onCompress(target)}>
          {busy ? 'Starting...' : 'Compress'}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
