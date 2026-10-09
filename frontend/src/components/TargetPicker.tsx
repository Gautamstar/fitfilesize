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
import { CropBox } from './CropBox'
import { useFocusOnMount } from '../hooks/useFocusOnMount'
import { DEFAULT_FOCUS, type Focus } from '../lib/crop'
import {
  LIMIT_PRESETS,
  parseLimit,
  type LimitUnit,
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
  isHeic,
  isGif,
  holdsTransparency,
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
  /** The dropped image, read locally, to place an exact-size crop on. */
  preview?: string | null
  /**
   * The form a form page is set up for. Its limit and pixel size are already
   * chosen, so the controls for picking others start folded away.
   */
  form?: { name: string } | null
  /**
   * At an exact pixel size, keep a PNG or WebP in its format. False on a form
   * page that asks for JPEG, where the result is a JPEG.
   */
  keepFormat?: boolean
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
  preview = null,
  form = null,
  keepFormat = false,
}: TargetPickerProps) {
  // On a form page the form's settings are the answer; "Change" opens the rest.
  const headRef = useFocusOnMount<HTMLHeadingElement>()
  const [adjusting, setAdjusting] = useState(false)
  // "Other": a limit typed in, for one no chip has (a 45 KB form, 50 MB).
  // Kept as text, so a half-typed "1." is not rewritten under the cursor.
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherText, setOtherText] = useState('')
  const [otherUnit, setOtherUnit] = useState<LimitUnit>('KB')
  const otherId = useId()
  const adjustId = useId()
  // Exact pixel size, images only. Kept as typed text so a half-typed number
  // is not rewritten under the cursor; `resize` is the parsed result.
  const [widthText, setWidthText] = useState(initialResize ? String(initialResize.width) : '')
  const [heightText, setHeightText] = useState(initialResize ? String(initialResize.height) : '')
  const [fit, setFit] = useState<Resize['fit']>(initialResize?.fit ?? 'crop')
  // Where the crop cuts from. Null until the visitor moves the box, so an
  // untouched crop asks for the server's default and matches a head-start.
  const [focus, setFocus] = useState<Focus | null>(
    initialResize?.crop_x !== undefined && initialResize.crop_y !== undefined
      ? { x: initialResize.crop_x, y: initialResize.crop_y }
      : null,
  )
  const parsed = kind === 'image' ? parseResize(widthText, heightText, fit) : null
  const resize =
    parsed && fit === 'crop' && focus ? { ...parsed, crop_x: focus.x, crop_y: focus.y } : parsed
  const resizeIncomplete = kind === 'image' && !resize && Boolean(widthText || heightText)
  const fitName = useId()

  // A GIF stays a GIF at any pixel size, and its border is see-through.
  const gif = isGif(filename)
  const heic = isHeic(filename)
  const jpegFile = /\.jpe?g$/i.test(filename)
  // What an exact size comes back as: a JPEG, unless the page keeps the
  // format (a GIF always keeps it; a HEIC never can).
  const kept = gif || (keepFormat && !heic && !jpegFile)
  const seeThrough = gif || (kept && holdsTransparency(filename))
  // At a fixed pixel size the file's own floor no longer applies; the pixel
  // count decides how small it can get. The estimate is a JPEG's: for a GIF
  // its frames and content decide (0.3 to 3 times off on test GIFs), and a
  // kept PNG depends on its colours, so for those none is shown.
  const floorFor = (r: Resize | null) => (r ? (kept ? 0 : resizedFloor(r.width, r.height)) : floor)
  const effectiveFloor = floorFor(resize)
  // A form's exact pixel size changes the file whatever its size, so its own
  // limit stays on offer even for a file already under it.
  const formPixels = kind === 'image' && Boolean(initialResize) && initialTarget !== undefined
  // A HEIC always becomes a JPEG, usually two to three times its size, so a
  // limit above the HEIC itself still means something.
  const hi = formPixels
    ? Math.max(originalBytes, initialTarget as number)
    : heic
      ? Math.max(originalBytes * 3, initialTarget ?? 0)
      : originalBytes

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
    if (initialTarget && (initialTarget < originalBytes || formPixels || heic)) return initialTarget
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

  const alreadyFits =
    !formPixels && !heic && initialTarget !== undefined && initialTarget >= originalBytes

  // Only limits this file can use: under its size, and at or over its floor
  // (for the format it comes back in, so a BMP screenshot is not offered
  // 20 KB). The slider still reaches below the floor for anyone who insists.
  // The one already picked stays, even if a pixel size then raised the floor.
  // A landing page's own limit joins them, so a 50 KB form offers 50 KB.
  const presets = [...new Set([...LIMIT_PRESETS, ...(initialTarget ? [initialTarget] : [])])].sort(
    (a, b) => a - b,
  )
  const chipLimits = presets.filter(
    (bytes) =>
      (bytes < hi || bytes === initialTarget) && (bytes >= effectiveFloor || bytes === chosen),
  )

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

  const otherInvalid = otherText.trim() !== '' && parseLimit(otherText, otherUnit) === null
  const typeOther = (text: string, unit: LimitUnit) => {
    setOtherText(text)
    setOtherUnit(unit)
    const bytes = parseLimit(text, unit)
    if (bytes === null) return
    // Let the slider reach a typed limit below its range, as a preset does.
    setLo((current) => Math.min(current, Math.max(bytes, 512)))
    setChosen(bytes)
  }

  const cropBox =
    preview && resize && fit === 'crop' ? (
      <CropBox
        src={preview}
        width={resize.width}
        height={resize.height}
        focus={focus ?? DEFAULT_FOCUS}
        onChange={setFocus}
      />
    ) : null

  // The slider, the common limits and the pixel size: everything for
  // choosing settings other than a form page's own.
  const controls = (
    <>
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
          aria-valuetext={fmtLimit(target)}
        />
        <div className="track-labels">
          <span>{fmt(lo)}</span>
          {/* A page's round limit at the top keeps its own number, as the
              big readout shows it ("256 KB", not "250.0 KB"). */}
          <span>{fmtLimit(hi)}</span>
        </div>
        {resize && kept ? null : (
          <p className="floor-note">
            {resize
              ? `At ${resize.width} x ${resize.height} it goes down to about ${fmt(effectiveFloor)}.`
              : `This file goes down to about ${fmt(floor)}.`}{' '}
            {hatchPct > 0 ? 'The hatched part of the bar is smaller than that.' : null}
          </p>
        )}
      </div>

      {/* Limits the file already fits under, or cannot reach, are left out
          rather than shown disabled: a row of dead buttons is noise. */}
      <p className="chips-label">Common limits</p>
      <div className="chips">
        {chipLimits.map((bytes) => {
          const disabled = bytes < lo
          // Chips land on a hard limit the same way the landing presets do,
          // so a chip is active exactly when the slider sits on its position.
          const chipPos = presetToSlider(bytes, lo, hi)
          const active = !disabled && pos === chipPos

          return (
            <button
              key={bytes}
              type="button"
              className={`chip${active ? ' active' : ''}`}
              disabled={disabled}
              title={disabled ? 'out of range for this file' : undefined}
              aria-pressed={active}
              onClick={() => setChosen(bytes)}
            >
              {limitLabel(bytes)}
            </button>
          )
        })}
        <button
          type="button"
          className={`chip${otherOpen ? ' active' : ''}`}
          aria-pressed={otherOpen}
          aria-expanded={otherOpen}
          aria-controls={otherId}
          onClick={() => setOtherOpen((open) => !open)}
        >
          Other
        </button>
      </div>
      {otherOpen ? (
        <div className="custom-limit" id={otherId}>
          <label className="custom-limit-label" htmlFor={`${otherId}-input`}>
            Limit
          </label>
          <div className="custom-limit-row">
            <input
              id={`${otherId}-input`}
              className="custom-limit-input"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="45"
              value={otherText}
              aria-invalid={otherInvalid}
              onChange={(e) => typeOther(e.target.value, otherUnit)}
            />
            <select
              className="custom-limit-unit"
              aria-label="Unit"
              value={otherUnit}
              onChange={(e) => typeOther(otherText, e.target.value as LimitUnit)}
            >
              <option value="KB">KB</option>
              <option value="MB">MB</option>
            </select>
          </div>
          {otherInvalid ? (
            <p className="custom-limit-error">
              Enter a size between 1 KB and 100 MB, like 45 or 1.5.
            </p>
          ) : null}
        </div>
      ) : null}

      {kind === 'image' ? (
        // Collapsed unless already in use: most visitors only need a size in
        // bytes, and exam and ID forms that want pixels say so explicitly.
        <details className="resize" open={Boolean(initialResize)}>
          <summary>Exact size in pixels (optional)</summary>
          <p className="resize-note">
            {gif
              ? 'For set dimensions, like a 128 x 128 emoji. The result is a GIF, still animated.'
              : kept
                ? 'For set dimensions, like a 128 x 128 emoji. The result keeps its format.'
                : 'For forms that ask for set dimensions, like a 200 x 230 photo. The result is a JPEG.'}
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
              {seeThrough ? 'Add a see-through border' : 'Add a white border'}
            </label>
          </fieldset>
          {form ? null : cropBox}
          {resizeIncomplete ? (
            <p className="custom-limit-error">
              Enter both width and height, as whole numbers up to {MAX_PIXELS.toLocaleString('en')}.
            </p>
          ) : null}
        </details>
      ) : null}
    </>
  )

  return (
    <div className="panel">
      <header className="file-head">
        <h2 ref={headRef} tabIndex={-1} className="file-name">
          {filename}
        </h2>
        <p className="file-meta">{meta}</p>
      </header>

      {form ? (
        // The rules are in the heading above the panel; not repeated here.
        <p className="form-set-line">Set to the {form.name} rules above</p>
      ) : null}

      {/* Said before Compress, not after: this is the one format that comes
          back as something else. */}
      {heic ? <p className="convert-note">HEIC photos are saved as JPEG.</p> : null}
      {/* The other change of format, said as plainly: on a page that asks
          for JPEG, a still image cut to an exact size comes back as one, and
          any see-through parts turn white. */}
      {resize && !kept && !heic && !jpegFile ? (
        <p className="convert-note">
          At an exact pixel size the result is a JPEG, so any see-through parts become white.
        </p>
      ) : null}

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
          This form also needs at least {fmtLimit(Math.round(minBytes / 1024) * 1000)}. If the file
          comes out smaller, we pad it up to that without changing the picture.
        </p>
      ) : null}
      {/* The hint compares the limit with the file as it is; at a set pixel
          size the file is rebuilt, and the comparison says nothing. */}
      {resize ? null : <p className="target-hint">{hint}</p>}

      {form ? (
        <>
          {/* Where the crop cuts matters on every form photo, so it stays out
              in the open while the size controls fold away. */}
          {cropBox}
          <button
            type="button"
            className="adjust-toggle"
            aria-expanded={adjusting}
            aria-controls={adjustId}
            onClick={() => setAdjusting((open) => !open)}
          >
            {adjusting ? 'Hide size or pixels' : 'Change size or pixels'}
          </button>
          <div id={adjustId} className="adjust" hidden={!adjusting}>
            {controls}
          </div>
        </>
      ) : (
        controls
      )}

      {warning ? <p className="error-text">{sentence(warning)}</p> : null}

      <div className="actions">
        <button
          type="button"
          className="btn-primary btn-wide"
          disabled={busy || resizeIncomplete}
          onClick={() => onCompress(target, resize)}
        >
          {busy ? 'Starting...' : 'Compress'}
        </button>
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
