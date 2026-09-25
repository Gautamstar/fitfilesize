/**
 * Live progress while the ladder runs.
 *
 * Steps and the search state arrive from useProgressStream as plain data. This
 * component only renders them, so all the stream handling stays in one place.
 */

import { MAX_ATTEMPTS, fmtLimit } from '../lib/format'
import type { ProgressStep, SearchState } from '../hooks/useProgressStream'
import { SearchLadder } from './SearchLadder'

interface ProgressPanelProps {
  filename: string
  targetBytes: number
  originalBytes: number
  steps: ProgressStep[]
  attempts: number
  search: SearchState
}

export function ProgressPanel({
  filename,
  targetBytes,
  originalBytes,
  steps,
  attempts,
  search,
}: ProgressPanelProps) {
  const headline =
    attempts > 0 ? `Attempt ${attempts} of at most ${MAX_ATTEMPTS}` : 'Working on it'

  return (
    <div className="panel">
      <header className="file-head">
        <h2 className="file-name">{filename}</h2>
        <p className="file-meta">target {fmtLimit(targetBytes)}</p>
      </header>

      {/* Once the rung search starts, draw it; before that (or for a run that
          never searches, like a lossless-only one) the step list says enough. */}
      {search.rungs !== null ? (
        <SearchLadder search={search} originalBytes={originalBytes} />
      ) : (
        <>
          <p className="progress-headline">{headline}</p>
          <StepList steps={steps} />
        </>
      )}
    </div>
  )
}

function StepList({ steps }: { steps: ProgressStep[] }) {
  return (
    <ul className="steps">
      {steps.map((step) => (
        // key must be stable and unique so React can track list items
        // across re-renders. The monotonic id from the hook does that.
        <li key={step.id} className={step.status === 'pending' ? 'pending' : 'done'}>
          {step.text}
          {step.status === 'pending' ? <span className="ellipsis"> ...</span> : null}
          {step.tag ? (
            <span className={`tag ${step.tag}`}>
              {step.tag === 'under' ? ' under target' : ' over target'}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
