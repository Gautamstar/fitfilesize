/**
 * The finished file. It leads with what the visitor will be checked on, the
 * size against their limit, and the pixels and format where those were set,
 * then the download. How much was saved is a detail, not the point.
 */

import { useState } from 'react'
import { downloadUrl } from '../lib/api'
import { fmt, fmtLimit, formatCountdown, outputFormat, savedPercent, sentence } from '../lib/format'
import { useFocusOnMount } from '../hooks/useFocusOnMount'
import { TIP_ENABLED, TipLink } from './TipLink'
import type { SearchState } from '../hooks/useProgressStream'
import { SearchLadder } from './SearchLadder'
import type { DoneEvent, MediaKind, Resize } from '../types/api'

/** Formats a browser can show in an <img>. */
const SHOWABLE = new Set(['JPEG', 'PNG', 'GIF', 'WebP', 'BMP'])

interface ResultPanelProps {
  jobId: string
  result: DoneEvent
  secondsLeft: number | null
  onRetry: () => void
  onDelete: () => void
  /** The run's search, when it had one; shown under "How we found it". */
  search?: SearchState
  /** The uploaded file's name, which decides the format it comes back in. */
  filename: string
  kind: MediaKind
  /** The exact pixel size the run was given, if any. */
  resize?: Resize | null
  /** The minimum the run was given (a form page's), if any. */
  minBytes?: number | null
  /** The form the page is set up for, when its settings were used. */
  formName?: string | null
  /** Whether a pixel-size run kept the file's format (see outputFormat). */
  keepFormat?: boolean
}

export function ResultPanel({
  jobId,
  result,
  secondsLeft,
  onRetry,
  onDelete,
  search,
  filename,
  kind,
  resize = null,
  minBytes = null,
  formName = null,
  keepFormat = false,
}: ResultPanelProps) {
  const titleRef = useFocusOnMount<HTMLHeadingElement>()
  const [confirming, setConfirming] = useState(false)
  const savedPct = savedPercent(result.final_bytes, result.original_bytes)
  // "rung:6" names the setting the run kept; "floor", "lossless" and "none" keep none.
  const chosenRung = result.method.startsWith('rung:') ? Number(result.method.slice(5)) : null
  const format = kind === 'pdf' ? 'PDF' : outputFormat(filename, resize, keepFormat)
  const showPreview = kind === 'image' && SHOWABLE.has(format)
  const limit = fmtLimit(result.target_bytes)
  const min = minBytes ? fmtLimit(Math.round(minBytes / 1024) * 1000) : null
  const near = (bound: number) => Math.abs(result.final_bytes - bound) < bound * 0.03
  const nearEdge = near(result.target_bytes) || (minBytes !== null && near(minBytes))

  const title = result.hit_target ? `Fits under ${limit}` : 'As small as it goes'

  // The floor case is already said by the title and the size line.
  const notes = result.warnings.filter((w) => !w.includes('floor'))

  return (
    <div className="panel">
      <div className={`result-head${showPreview ? ' with-preview' : ''}`}>
        {showPreview ? (
          <div className="result-preview">
            {/* ?preview=1: showing it here is not a download, and is not counted. */}
            <img src={`${downloadUrl(jobId)}?preview=1`} alt={`The compressed ${filename}`} />
          </div>
        ) : null}
        <div className="result-main">
          <h2
            ref={titleRef}
            tabIndex={-1}
            className={`result-title ${result.hit_target ? 'good' : 'short'}`}
          >
            {title}
          </h2>
          {formName ? <p className="result-form">Made with the {formName} settings</p> : null}
          <ul className="checks">
            <li className={result.hit_target ? 'ok' : 'short'}>
              <CheckIcon ok={result.hit_target} />
              <span>
                <strong>{fmt(result.final_bytes)}</strong>
                {/* Right at a limit, the rounded size reads as touching it; the
                    exact count shows which side it is on. */}
                {nearEdge ? ` (${result.final_bytes.toLocaleString('en')} bytes)` : null}
                {result.hit_target
                  ? min
                    ? `, between ${min} and ${limit}`
                    : `, under ${limit}`
                  : `, over your ${limit} limit`}
              </span>
            </li>
            {resize ? (
              <li className="ok">
                <CheckIcon ok />
                <span>
                  <strong>
                    {resize.width} × {resize.height}
                  </strong>{' '}
                  pixels
                </span>
              </li>
            ) : null}
            {/* A check when the form's own settings made it, whose rules name
                this format; otherwise just the fact. */}
            <li className={formName ? 'ok' : 'plain'}>
              {formName ? <CheckIcon ok /> : <FileIcon />}
              <span>
                <strong>{format}</strong>
              </span>
            </li>
          </ul>
        </div>
      </div>

      <p className="result-detail" role="status">
        {result.method === 'none'
          ? 'Your file was already under that size, so we left it alone.'
          : `${fmt(result.original_bytes)} before, ${fmt(result.final_bytes)} after: ${savedPct} percent smaller.`}
      </p>

      {notes.length > 0 ? (
        <ul className={result.hit_target ? 'notes' : 'warnings'}>
          {notes.map((w) => (
            <li key={w}>{sentence(w)}</li>
          ))}
        </ul>
      ) : null}

      <div className="actions">
        {/* A plain link, not a fetch: the browser handles the download. */}
        <a className="btn-primary btn-wide" href={downloadUrl(jobId)}>
          Download
        </a>
        <button type="button" className="btn-ghost" onClick={onRetry}>
          Try another size
        </button>
      </div>

      {search && search.rungs !== null ? (
        <details className="how-found">
          <summary>How we found it</summary>
          <SearchLadder
            search={search}
            originalBytes={result.original_bytes}
            chosenRung={chosenRung}
          />
        </details>
      ) : null}

      <div className="result-foot">
        {secondsLeft !== null ? (
          <p className={`countdown${secondsLeft < 300 ? ' soon' : ''}`}>
            Deleted in {formatCountdown(secondsLeft)}
          </p>
        ) : null}
        {/* Not beside Download: one slip there would lose the file. */}
        {confirming ? (
          <p className="delete-confirm">
            Delete your files now?{' '}
            <button type="button" className="link-button danger" onClick={onDelete}>
              Delete
            </button>{' '}
            <button type="button" className="link-button" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </p>
        ) : (
          <button type="button" className="link-button" onClick={() => setConfirming(true)}>
            Delete now
          </button>
        )}
      </div>

      {/* Asked only after a win: the one moment the request is reasonable. */}
      {result.hit_target && TIP_ENABLED ? (
        <p className="tip-note">
          Saved you some hassle? <TipLink>Buy me a White Monster</TipLink>
        </p>
      ) : null}
    </div>
  )
}

function CheckIcon({ ok }: { ok: boolean }) {
  return (
    <svg className="check-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="9" fill="currentColor" opacity="0.14" />
      <path
        d={ok ? 'm6 10.2 2.6 2.6L14 7.4' : 'M10 5.5v5.5m0 3v.1'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg className="check-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M6 2.5h5.5L15 6v11.5H6zM11.5 2.5V6H15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}
