/**
 * Live progress while the ladder runs: one bar and a line saying what is
 * happening. The rung-by-rung chart is kept for the result ("How we found
 * it"), where there is time to read it; while waiting, a visitor mostly
 * wants to see it moving and roughly how far along it is.
 *
 * Search state arrives from useProgressStream as plain data; runProgress()
 * turns it into the bar's position.
 */

import { useEffect, useRef, useState } from 'react'
import { fmtLimit } from '../lib/format'
import { runProgress } from '../lib/search'
import type { SearchState } from '../hooks/useProgressStream'

interface ProgressPanelProps {
  filename: string
  targetBytes: number
  search: SearchState
}

/** Silence after which the panel says the run is slow, not stuck. */
export const QUIET_MS = 45_000

export function ProgressPanel({ filename, targetBytes, search }: ProgressPanelProps) {
  const { fraction, tries } = runProgress(search)
  // Any change in the search restarts the clock. A server that has stopped
  // for good is caught elsewhere (the run fails or the job disappears); this
  // only keeps a long wait from looking like a hang.
  const [quiet, setQuiet] = useState(false)
  const signature = `${search.rungs}:${tries}:${search.current?.rung}:${Object.keys(search.points).length}:${search.lossless}`
  useEffect(() => {
    setQuiet(false)
    const timer = window.setTimeout(() => setQuiet(true), QUIET_MS)
    return () => window.clearTimeout(timer)
  }, [signature])
  // The estimate of work ahead can grow when a guess misses; the bar never
  // moves back, it waits for the work to catch up instead.
  const shown = useRef(0)
  shown.current = Math.max(shown.current, fraction)
  const pct = Math.round(shown.current * 100)

  const status =
    search.rungs === null
      ? search.lossless !== null
        ? 'Cleanup pass done, still over your limit. Compressing...'
        : 'Getting started...'
      : fraction >= 1
        ? 'Found it. Getting your file ready...'
        : search.current
          ? `Try ${tries}: ${search.current.label}...`
          : tries > 0
            ? `Try ${tries} done. Narrowing it down...`
            : 'Compressing...'

  return (
    <div className="panel">
      <header className="file-head">
        <h2 className="file-name">{filename}</h2>
        <p className="file-meta">target {fmtLimit(targetBytes)}</p>
      </header>

      <p className="progress-headline">Finding the best quality that fits</p>
      <div
        className={`read-bar run-bar${search.current || search.rungs === null ? ' working' : ''}`}
        role="progressbar"
        aria-label="Compression progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="read-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="read-meta" aria-live="polite">
        {status}
      </p>
      {quiet ? (
        <p className="slow-note">
          Taking longer than usual. Big files can take a minute or two, and it is still working.
        </p>
      ) : null}
    </div>
  )
}
