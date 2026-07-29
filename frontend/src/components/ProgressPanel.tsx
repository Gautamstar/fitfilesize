/**
 * Live progress while the ladder runs.
 *
 * Steps arrive from useProgressStream as plain data. This component only
 * renders them, so all the stream handling stays in one place.
 */

import { MAX_ATTEMPTS, fmt } from '../lib/format'
import type { ProgressStep } from '../hooks/useProgressStream'

interface ProgressPanelProps {
  filename: string
  targetBytes: number
  steps: ProgressStep[]
  attempts: number
}

export function ProgressPanel({ filename, targetBytes, steps, attempts }: ProgressPanelProps) {
  const headline =
    attempts > 0 ? `Attempt ${attempts} of at most ${MAX_ATTEMPTS}` : 'Working on it'

  return (
    <div className="panel">
      <header className="file-head">
        <h2 className="file-name">{filename}</h2>
        <p className="file-meta">target {fmt(targetBytes)}</p>
      </header>

      <p className="progress-headline">{headline}</p>

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
    </div>
  )
}
