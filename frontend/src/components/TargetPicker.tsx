/**
 * Target-size slider with preset chips, and for images an optional exact
 * pixel size.
 *
 * The target in bytes and the typed pixel size are the only state. The
 * slider position, every label, the fill width, the hatched floor zone and
 * the active chip are derived from them during render, so none of them can
 * drift out of sync.
 */

import { useId, useState } from 'react'
import type { MediaKind, Resize } from '../types/api'
import {
  LIMIT_PRESETS,
  SLIDER_STEPS,
  bytesToSlider,
  fmt,
  fmtLimit,
  limitLabel,
  sentence,
  presetToSlider,
  resizedFloor,
  sliderToBytes,
  tierHint,
} from '../lib/format'

/** The backend refuses sides longer than this (MAX_RESIZE_EDGE). */
const MAX_PIXELS = 4000

/**
 * Bottom of the slider: below the floor, so the hatched zone is visible.
 * `top` is the largest target, the original size.
 */
function sliderLow(floor: number, top: number, initialTarget?: number): number {
  let lo = Math.max(Math.floor(floor * 0.4), 1024)
  // Guard the degenerate case where the floor estimate is at or above the
  // top of the range.
  if (lo >= top) lo = Math.max(Math.floor(top * 0.4), 512)
  // Stretch down to a landing page's preset so it is reachable, e.g. a 20 KB
  // signature page for a file whose floor is estimated at 100 KB.
  if (initialTarget && initialTarget < lo) lo = Math.max(initialTarget, 512)
  return lo
}

/** Both sides filled in with whole numbers the backend accepts, or null. */
function parseResize(width: string, height: string, fit: Resize['fit']): Resize | null {
  const w = Number(width)
  const h = Number(height)
  const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_PIXELS
  return width && height && ok(w) && ok(h) ? { width: w, height: h, fit } : null
}

interface TargetPickerProps {
  filename: string
  /** Pre-rendered "2.4 MB, 3 pages" or "2.4 MB, 3000 x 2000". */
  meta: string
  originalBytes: number
  floor: number
  kind: MediaKind
  onCompress: (targetBytes: number, resize: Resize | null) => void
  onCancel: () => void
  warning?: string | null
  busy?: boolean
  /** Preselected target from a landing page such as /compress-pdf-to-200kb. */
  initialTarget?: number
  /** Exact pixel size carried over from the last run ("Try another size"). */
  initialResize?: Resize | null
  /** A form's minimum size, when the page has one; the file is padded up to it. */
  minBytes?: number | null
}

export function TargetPicker({
  filename,
  meta,
  originalBytes,
  floor,
  kind,
  onCompress,
  onCancel,
  warning,
  busy = false,
  initialTarget,
  initialResize,
  minBytes = null,
}: TargetPickerProps) {
  // Exact pixel size, images only. Kept as typed text so a half-typed number
  // is not rewritten under the cursor; `resize` is the parsed result.
  const [widthText, setWidthText] = useState(initialResize ? String(initialResize.width) : '')
  const [heightText, setHeightText] = useState(initialResize ? String(initialResize.height) : '')
  const [fit, setFit] = useState<Resize['fit']>(initialResize?.fit ?? 'crop')
  const resize = kind === 'image' ? parseResize(widthText, heightText, fit) : null
  const resizeIncomplete = kind === 'image' && !resize && Boolean(widthText || heightText)
  const fitName = useId()

  // At a fixed pixel size the file's own floor no longer applies; the pixel
  // count decides how small it can get.
  const floorFor = (r: Resize | null) => (r ? resizedFloor(r.width, r.height) : floor)
  const effectiveFloor = floorFor(resize)
  // A form's exact pixel size changes the file whatever its size, so its own
  // limit stays on offer even for a file already under it.
  const formPixels = kind === 'image' && Boolean(initialResize) && initialTarget !== undefined
  const hi = formPixels ? Math.max(originalBytes, initialTarget as number) : originalBytes

  // The slider's bottom only ever moves down. A large pixel size raises the
  // floor estimate, and if that raised the bottom, a limit already picked
  // below it (a 100 KB chip, say) would be pushed up with it, and the file
  // would come back over the visitor's limit.
  const [lo, setLo] = useState(() => sliderLow(effectiveFloor, hi, initialTarget))

  // Default target: the landing page's size when the file is bigger than it,
  // else 4 MB when that makes sense, else 60% of original. A preset below the
  // floor is kept: the visitor came for that size, and the floor is only an
  // estimate. The function form of useState runs this once, not on every render.
  //
  // The target is held in bytes, not as a slider position: setting a pixel
  // size moves the slider's range, and a position would then point at a
  // different size. A preset or chip stays exactly its limit this way.
  const [chosen, setChosen] = useState(() => {
    if (initialTarget && (initialTarget < originalBytes || formPixels)) return initialTarget
    const fourMB = 4 * 1024 * 1024
    const def =
      fourMB > effectiveFloor && fourMB < originalBytes ? fourMB : Math.round(originalBytes * 0.6)
    return sliderToBytes(bytesToSlider(def, lo, hi), lo, hi)
  })

  const changeResize = (w: string, h: string, f: Resize['fit']) => {
    setWidthText(w)
    setHeightText(h)
    setFit(f)
    const next = parseResize(w, h, f)
    setLo((current) => Math.min(current, sliderLow(floorFor(next), hi, initialTarget)))
  }

  const alreadyFits = !formPixels && initialTarget !== undefined && initialTarget >= originalBytes

  const chipLimits = LIMIT_PRESETS.filter((bytes) => bytes < originalBytes)

  // Everything below is derived from `chosen`. `lo` never rises, so the
  // clamp below never lifts a target the visitor picked.
  const target = Math.min(Math.max(chosen, lo), hi)
  const pos = presetToSlider(target, lo, hi)
  const hint = tierHint(target, originalBytes)
  const fillPct = (pos / SLIDER_STEPS) * 100
  const hatchPct =
    effectiveFloor <= lo
      ? 0
      : Math.min(100, (bytesToSlider(effectiveFloor, lo, hi) / SLIDER_STEPS) * 100)

  return (
    <div className="panel">
      <header className="file-head">
        <h2 className="file-name">{filename}</h2>
        <p className="file-meta">{meta}</p>
      </header>

      {/* The limit picked before upload (or the landing page's size) is at or
          above the file itself: say it already fits rather than quietly
          suggesting a smaller size and squeezing a file that needed nothing. */}
      {alreadyFits ? (
        <p className="already-fits">
          <strong>
            Your file is {fmt(originalBytes)}, already under {fmtLimit(initialTarget as number)}.
          </strong>{' '}
          You can upload it as it is. To make it smaller anyway, pick a size below.
        </p>
      ) : null}

      <p className="target-value">{fmtLimit(target)}</p>
      {minBytes && kind === 'image' && target > minBytes ? (
        <p className="target-min">
          This form also needs at least {fmtLimit(Math.round(minBytes / 1024) * 1000)}. If the
          file comes out smaller, we pad it up to that without changing the picture.
        </p>
      ) : null}
      {/* The hint compares the limit with the file as it is; at a set pixel
          size the file is rebuilt, and the comparison says nothing. */}
      {resize ? null : <p className="target-hint">{hint}</p>}

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
          onChange={(e) => setChosen(sliderToBytes(Number(e.target.value), lo, hi))}
          aria-label="Target file size"
        />
        <div className="track-labels">
          <span>{fmt(lo)}</span>
          <span>{fmt(hi)}</span>
        </div>
        <p className="floor-note">
          {resize
            ? `at ${resize.width} x ${resize.height} it goes down to about ${fmt(effectiveFloor)}`
            : `this file goes down to about ${fmt(floor)}`}
        </p>
      </div>

      {/* Limits the file already fits under are left out rather than shown
          disabled: a row of dead buttons is noise, and the answer for those
          is simply "you don't need this". */}
      {chipLimits.length > 0 ? <p className="chips-label">Common limits</p> : null}
      <div className="chips">
        {chipLimits.map((bytes) => {
          const outOfRange = bytes < lo
          const disabled = outOfRange
          const belowFloor = !disabled && bytes < effectiveFloor
          // Chips land on a hard limit the same way the landing presets do,
          // so a chip is active exactly when the slider sits on its position.
          const chipPos = presetToSlider(bytes, lo, hi)
          const active = !disabled && pos === chipPos

          return (
            <button
              key={bytes}
              type="button"
              className={`chip${active ? ' active' : ''}${belowFloor ? ' below-floor' : ''}`}
              disabled={disabled}
              title={
                outOfRange
                  ? 'out of range for this file'
                  : belowFloor
                    ? 'below the estimated floor'
                    : undefined
              }
              aria-pressed={active}
              onClick={() => setChosen(bytes)}
            >
              {limitLabel(bytes)}
            </button>
          )
        })}
      </div>

      {kind === 'image' ? (
        // Collapsed unless already in use: most visitors only need a size in
        // bytes, and exam and ID forms that want pixels say so explicitly.
        <details className="resize" open={Boolean(initialResize)}>
          <summary>Exact size in pixels (optional)</summary>
          <p className="resize-note">
            For forms that ask for set dimensions, like a 200 x 230 photo. The result is a JPEG.
          </p>
          <div className="resize-row">
            <label>
              <span>Width</span>
              <input
                className="custom-limit-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="200"
                value={widthText}
                aria-invalid={resizeIncomplete}
                onChange={(e) => changeResize(e.target.value, heightText, fit)}
              />
            </label>
            <span className="resize-x" aria-hidden="true">
              x
            </span>
            <label>
              <span>Height</span>
              <input
                className="custom-limit-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="230"
                value={heightText}
                aria-invalid={resizeIncomplete}
                onChange={(e) => changeResize(widthText, e.target.value, fit)}
              />
            </label>
          </div>
          <fieldset className="resize-fit">
            <legend>If the shape is different</legend>
            <label>
              <input
                type="radio"
                name={fitName}
                checked={fit === 'crop'}
                onChange={() => changeResize(widthText, heightText, 'crop')}
              />
              Crop to fill
            </label>
            <label>
              <input
                type="radio"
                name={fitName}
                checked={fit === 'pad'}
                onChange={() => changeResize(widthText, heightText, 'pad')}
              />
              Add a white border
            </label>
          </fieldset>
          {resizeIncomplete ? (
            <p className="custom-limit-error">
              Enter both width and height, as whole numbers up to {MAX_PIXELS.toLocaleString('en')}.
            </p>
          ) : null}
        </details>
      ) : null}

      {warning ? <p className="error-text">{sentence(warning)}</p> : null}

      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || resizeIncomplete}
          onClick={() => onCompress(target, resize)}
        >
          {busy ? 'Starting...' : 'Compress'}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
