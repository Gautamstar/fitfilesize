/** Outcome, before and after sizes, download link, and the delete countdown. */

import { downloadUrl } from '../lib/api'
import { fmt, formatCountdown } from '../lib/format'
import { TIP_ENABLED, TipLink } from './TipLink'
import type { DoneEvent } from '../types/api'

interface ResultPanelProps {
  jobId: string
  result: DoneEvent
  secondsLeft: number | null
  onRetry: () => void
  onDelete: () => void
}

export function ResultPanel({ jobId, result, secondsLeft, onRetry, onDelete }: ResultPanelProps) {
  const savedPct = Math.round(100 * (1 - result.final_bytes / result.original_bytes))

  return (
    <div className="panel">
      <p className={`badge ${result.hit_target ? 'badge-good' : 'badge-warn'}`}>
        {result.hit_target
          ? `Fits under ${fmt(result.target_bytes)}`
          : `As small as it goes`}
      </p>

      <p className="result-detail">
        {result.hit_target
          ? result.method === 'none'
            ? 'Your file was already under that size, so we left it alone.'
            : `You saved ${savedPct} percent.`
          : `This is as small as this file goes without ruining it. You saved ${savedPct} percent.`}
      </p>

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
          .filter((w) => !w.includes('floor'))
          .map((w) => (
            <li key={w}>{w}</li>
          ))}
      </ul>

      <div className="actions">
        {/* A plain link, not a fetch: the browser handles the download. */}
        <a className="btn-primary" href={downloadUrl(jobId)}>
          Download
        </a>
        <button type="button" className="btn-ghost" onClick={onRetry}>
          Try another size
        </button>
        <button type="button" className="btn-ghost" onClick={onDelete}>
          Delete now
        </button>
      </div>

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
