/** Terminal error state. Replaces fail() / panel-error at static/app.js:83-87. */

interface ErrorPanelProps {
  message: string
  onRestart: () => void
}

export function ErrorPanel({ message, onRestart }: ErrorPanelProps) {
  return (
    <div className="panel">
      <p className="badge badge-warn">Something went wrong</p>
      <p className="result-detail">{message}</p>
      <div className="actions">
        <button type="button" className="btn-primary" onClick={onRestart}>
          Start over
        </button>
      </div>
    </div>
  )
}
