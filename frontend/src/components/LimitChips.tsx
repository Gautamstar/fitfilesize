/**
 * "What's your upload limit?" chips, shown before a file is chosen.
 *
 * Most visitors arrive with one number in mind, the limit a form gave them.
 * Showing it up front says at a glance that this site solves that exact
 * problem. The choice only presets the slider after upload; "Other" leaves the
 * picker to suggest a size from the file itself.
 */

import { UPFRONT_LIMITS, limitLabel } from '../lib/format'

interface LimitChipsProps {
  /** Selected limit in bytes, or null for "Other". */
  value: number | null
  onChange: (limit: number | null) => void
  /** A landing page's own limit, added to the list when it is not a default. */
  extra?: number
}

export function LimitChips({ value, onChange, extra }: LimitChipsProps) {
  const limits = [...new Set([...UPFRONT_LIMITS, ...(extra ? [extra] : [])])].sort(
    (a, b) => a - b,
  )

  return (
    <fieldset className="limit-chips">
      <legend>Your upload limit</legend>
      <div className="chips">
        {limits.map((bytes) => (
          <button
            key={bytes}
            type="button"
            className={`chip${value === bytes ? ' active' : ''}`}
            aria-pressed={value === bytes}
            onClick={() => onChange(bytes)}
          >
            {limitLabel(bytes)}
          </button>
        ))}
        <button
          type="button"
          className={`chip${value === null ? ' active' : ''}`}
          aria-pressed={value === null}
          onClick={() => onChange(null)}
        >
          Other
        </button>
      </div>
    </fieldset>
  )
}
