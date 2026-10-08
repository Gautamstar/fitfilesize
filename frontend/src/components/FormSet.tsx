/**
 * What a form page is set up for, shown before upload in place of the limit
 * chips. The form's limit is the only one that passes its check, so offering
 * 100 KB to 2 MB beside a 50 KB rule only invites a rejected upload. The
 * chips stay one click away for anyone who needs another limit.
 */

import { useId, useState, type ReactNode } from 'react'

interface FormSetProps {
  name: string
  /** The usual limit chips, shown after "Use a different limit". */
  children: ReactNode
}

export function FormSet({ name, children }: FormSetProps) {
  const [open, setOpen] = useState(false)
  const id = useId()

  return (
    <div className="form-set form-set-drop">
      {/* The rules themselves are in the heading above; not repeated here. */}
      <p className="form-set-name">Set to the {name} rules above</p>
      <button
        type="button"
        className="adjust-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Hide other limits' : 'Use a different limit'}
      </button>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  )
}
