/**
 * Target-size slider with preset chips. Replaces openTargetPicker(),
 * buildChips() and onSliderInput() at static/app.js:149-255.
 *
 * The old code recomputed labels by writing textContent into six elements on
 * every input event. Here the slider position is one piece of state and every
 * label is derived from it during render, so they cannot drift out of sync.
 */

import { useMemo, useState } from 'react'
import {
  PRESETS_MB,
  SLIDER_STEPS,
  bytesToSlider,
  fmt,
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
}: TargetPickerProps) {
  // Slider spans from below the floor (so the hatched zone is visible) up to
  // the original size. app.js:181-184
  const { lo, hi } = useMemo(() => {
    let lower = Math.max(Math.floor(floor * 0.4), 1024)
    // Guard the degenerate case where the floor estimate is at or above the
    // original file size.
    if (lower >= originalBytes) lower = Math.max(Math.floor(originalBytes * 0.4), 512)
    return { lo: lower, hi: originalBytes }
  }, [floor, originalBytes])

  // Default target: 4 MB when that makes sense, else 60% of original.
  // app.js:201-205. The function form of useState runs this once, not on
  // every render.
  const [pos, setPos] = useState(() => {
    const fourMB = 4 * 1024 * 1024
    let def = fourMB > floor && fourMB < originalBytes ? fourMB : Math.round(originalBytes * 0.6)
    if (def < lo) def = lo
    return bytesToSlider(def, lo, hi)
  })

  // Everything below is derived from `pos`. No manual DOM updates anywhere.
  const target = sliderToBytes(pos, lo, hi)
  const hint = tierHint(target, floor, originalBytes)
  const fillPct = (pos / SLIDER_STEPS) * 100
  const hatchPct = floor <= lo ? 0 : Math.min(100, (bytesToSlider(floor, lo, hi) / SLIDER_STEPS) * 100)

  return (
    <div className="panel">
      <header className="file-head">
        <h2 className="file-name">{filename}</h2>
        <p className="file-meta">{meta}</p>
      </header>

      <p className="target-value">{fmt(target)}</p>
      <p className={`target-hint${hint.below ? ' below-floor' : ''}`}>{hint.text}</p>

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
          // Active when within 2% of the current target. app.js:249
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
