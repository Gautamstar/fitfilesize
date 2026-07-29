/** Terminal error state, with the only way forward being to start again. */

interface ErrorPanelProps {
  message: string
  onRestart: () => void
}

export function ErrorPanel({ message, onRestart }: ErrorPanelProps) {
  return (
    <div className="panel">
      <p className="badge badge-warn">That did not work</p>
      <p className="result-detail">{message}</p>
      <div className="actions">
        <button type="button" className="btn-primary" onClick={onRestart}>
          Start over
        </button>
      </div>
    </div>
  )
}
