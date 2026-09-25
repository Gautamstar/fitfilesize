/**
 * "What's your upload limit?" chips, shown before a file is chosen.
 *
 * Most visitors arrive with one number in mind, the limit a form gave them.
 * Showing it up front says at a glance that this site solves that exact
 * problem. The choice only presets the slider after upload.
 *
 * "Other" opens a number box with a KB/MB switch, for limits the chips do not
 * cover (a form asking for 150 KB, say). Left empty, it means "no preset" and
 * the picker suggests a size from the file itself.
 */

import { useId, useState } from 'react'
import { UPFRONT_LIMITS, limitLabel, parseLimit, type LimitUnit } from '../lib/format'

interface LimitChipsProps {
  /** Selected limit in bytes, or null for "Other" with nothing typed yet. */
  value: number | null
  onChange: (limit: number | null) => void
  /** A landing page's own limit, added to the list when it is not a default. */
  extra?: number
}

export function LimitChips({ value, onChange, extra }: LimitChipsProps) {
  const limits = [...new Set([...UPFRONT_LIMITS, ...(extra ? [extra] : [])])].sort(
    (a, b) => a - b,
  )
  // The typed text is kept as text, not bytes, so "1." or "0,5" mid-typing is
  // not rewritten under the visitor's cursor.
  const [custom, setCustom] = useState(false)
  const [text, setText] = useState('')
  const [unit, setUnit] = useState<LimitUnit>('KB')
  const inputId = useId()
  const errorId = useId()

  const showCustom = custom || value === null
  const invalid = text.trim() !== '' && parseLimit(text, unit) === null

  const update = (nextText: string, nextUnit: LimitUnit) => {
    setText(nextText)
    setUnit(nextUnit)
    onChange(parseLimit(nextText, nextUnit))
  }

  return (
    <fieldset className="limit-chips">
      <legend>Your upload limit</legend>
      <div className="chips">
        {limits.map((bytes) => (
          <button
            key={bytes}
            type="button"
            className={`chip${!showCustom && value === bytes ? ' active' : ''}`}
            aria-pressed={!showCustom && value === bytes}
            onClick={() => {
              setCustom(false)
              onChange(bytes)
            }}
          >
            {limitLabel(bytes)}
          </button>
        ))}
        <button
          type="button"
          className={`chip${showCustom ? ' active' : ''}`}
          aria-pressed={showCustom}
          aria-expanded={showCustom}
          aria-controls={inputId}
          onClick={() => {
            setCustom(true)
            onChange(parseLimit(text, unit))
          }}
        >
          Other
        </button>
      </div>

      {showCustom ? (
        <div className="custom-limit">
          <label className="custom-limit-label" htmlFor={inputId}>
            Limit
          </label>
          <div className="custom-limit-row">
            {/* text + inputMode rather than type="number": number inputs
                reject a comma decimal and change value on scroll. */}
            <input
              id={inputId}
              className="custom-limit-input"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="e.g. 150"
              value={text}
              aria-invalid={invalid}
              aria-describedby={invalid ? errorId : undefined}
              onChange={(e) => update(e.target.value, unit)}
            />
            <select
              className="custom-limit-unit"
              aria-label="Unit"
              value={unit}
              onChange={(e) => update(text, e.target.value as LimitUnit)}
            >
              <option value="KB">KB</option>
              <option value="MB">MB</option>
            </select>
          </div>
          {invalid ? (
            <p id={errorId} className="custom-limit-error">
              Enter a size between 1 KB and 100 MB, like 150 or 1.5.
            </p>
          ) : (
            <p className="custom-limit-hint">
              Leave it empty and we will suggest a size once we see your file.
            </p>
          )}
        </div>
      ) : null}
    </fieldset>
  )
}
