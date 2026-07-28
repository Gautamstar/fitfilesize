/**
 * Outcome, before/after sizes, download link and the delete countdown.
 * Replaces showResult() at static/app.js:370-400.
 */

import { downloadUrl } from '../lib/api'
import { fmt, formatCountdown } from '../lib/format'
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
          : `Could not reach ${fmt(result.target_bytes)}`}
      </p>

      <p className="result-detail">
        {result.hit_target
          ? result.method === 'none'
            ? 'It was already under your target, so it is unchanged.'
            : `Saved ${savedPct} percent.`
          : `This is the smallest we could make it without wrecking it. Saved ${savedPct} percent.`}
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
    </div>
  )
}
