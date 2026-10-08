/** Terminal error state, with the only way forward being to start again. */

import { sentence } from '../lib/format'
import { useFocusOnMount } from '../hooks/useFocusOnMount'

interface ErrorPanelProps {
  message: string
  onRestart: () => void
}

export function ErrorPanel({ message, onRestart }: ErrorPanelProps) {
  const headRef = useFocusOnMount<HTMLHeadingElement>()
  return (
    <div className="panel">
      <h2 ref={headRef} tabIndex={-1} className="result-title short">
        That did not work
      </h2>
      <p className="result-detail" role="alert">
        {sentence(message)}
      </p>
      <div className="actions">
        <button type="button" className="btn-primary" onClick={onRestart}>
          Start over
        </button>
      </div>
    </div>
  )
}
