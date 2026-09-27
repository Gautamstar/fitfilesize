/** Outcome, before and after sizes, download link, and the delete countdown. */

import { downloadUrl } from '../lib/api'
import { fmt, fmtLimit, formatCountdown, savedPercent, sentence } from '../lib/format'
import { TIP_ENABLED, TipLink } from './TipLink'
import type { SearchState } from '../hooks/useProgressStream'
import { SearchLadder } from './SearchLadder'
import type { DoneEvent } from '../types/api'

interface ResultPanelProps {
  jobId: string
  result: DoneEvent
  secondsLeft: number | null
  onRetry: () => void
  onDelete: () => void
  /** Run again allowing JPEG, for a PNG that could not fit as a PNG. */
  onConvertToJpeg?: () => void
  /** The run's search, when it had one; shown under "How we found it". */
  search?: SearchState
}

export function ResultPanel({
  jobId,
  result,
  secondsLeft,
  onRetry,
  onDelete,
  onConvertToJpeg,
  search,
}: ResultPanelProps) {
  const offerJpeg = Boolean(result.needs_jpeg && onConvertToJpeg)
  // Fitted as a PNG, but only by shrinking it a lot: a JPEG may keep more.
  const offerSharper = Boolean(result.hit_target && result.png_shrunk && onConvertToJpeg)
  const savedPct = savedPercent(result.final_bytes, result.original_bytes)
  // "rung:6" names the setting the run kept; "floor", "lossless" and "none" keep none.
  const chosenRung = result.method.startsWith('rung:') ? Number(result.method.slice(5)) : null

  return (
    <div className="panel">
      <p className={`badge ${result.hit_target ? 'badge-good' : 'badge-warn'}`}>
        {result.hit_target
          ? `Fits under ${fmtLimit(result.target_bytes)}`
          : `As small as it goes`}
      </p>

      <p className="result-detail">
        {result.hit_target
          ? result.method === 'none'
            ? 'Your file was already under that size, so we left it alone.'
            : `You saved ${savedPct} percent.`
          : offerJpeg
            ? `As a PNG, this is as small as it goes, still over your limit.`
            : `This is as small as this file goes without ruining it. You saved ${savedPct} percent.`}
      </p>

      {offerJpeg ? (
        <div className="convert-offer">
          <p>
            A JPEG can get under {fmtLimit(result.target_bytes)}. It has no transparency, and text
            and sharp edges come out a little softer.
          </p>
          <button type="button" className="btn-primary" onClick={onConvertToJpeg}>
            Convert to JPEG
          </button>
        </div>
      ) : null}

      {offerSharper ? (
        <div className="convert-offer">
          <p>
            To stay a PNG it had to be made smaller in pixels. A JPEG usually keeps more of the
            detail at this size, though it has no transparency.
          </p>
          <button type="button" className="btn-ghost" onClick={onConvertToJpeg}>
            Try it as a JPEG
          </button>
        </div>
      ) : null}

      <div className="sizes">
        <div>
          <span className="size-label">Before</span>
          <span className="size-value">{fmt(result.original_bytes)}</span>
        </div>
        <div>
          <span className="size-label">After</span>
          <span className="size-value">{fmt(result.final_bytes)}</span>
        </div>
      </div>

      {/* The floor case is already stated by the badge, so skip that warning. */}
      <ul className="warnings">
        {result.warnings
          .filter((w) => !w.includes('floor') && !(offerJpeg && w.startsWith('as a PNG')))
          .map((w) => (
            <li key={w}>{sentence(w)}</li>
          ))}
      </ul>

      <div className="actions">
        {/* A plain link, not a fetch: the browser handles the download. */}
        <a className={offerJpeg ? 'btn-ghost' : 'btn-primary'} href={downloadUrl(jobId)}>
          {offerJpeg ? 'Download the PNG anyway' : 'Download'}
        </a>
        <button type="button" className="btn-ghost" onClick={onRetry}>
          Try another size
        </button>
        <button type="button" className="btn-ghost" onClick={onDelete}>
          Delete now
        </button>
      </div>

      {search && search.rungs !== null ? (
        <details className="how-found">
          <summary>How we found it</summary>
          <SearchLadder search={search} originalBytes={result.original_bytes} chosenRung={chosenRung} />
        </details>
      ) : null}

      {secondsLeft !== null ? (
        <p className={`countdown${secondsLeft < 300 ? ' soon' : ''}`}>
          Deleted in {formatCountdown(secondsLeft)}
        </p>
      ) : null}

      {/* Asked only after a win: the one moment the request is reasonable. */}
      {result.hit_target && TIP_ENABLED ? (
        <p className="tip-note">
          Saved you some hassle? <TipLink>Buy me a White Monster</TipLink>
        </p>
      ) : null}
    </div>
  )
}
