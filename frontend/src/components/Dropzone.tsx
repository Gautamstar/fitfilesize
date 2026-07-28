/**
 * File picker with drag-and-drop. Replaces the dropzone listeners at
 * static/app.js:95-113.
 *
 * In the old code you wired six addEventListener calls by hand and toggled a
 * CSS class imperatively. Here the drag state is just a boolean in React
 * state, and the class name is computed from it during render.
 */

import { useRef, useState } from 'react'

interface DropzoneProps {
  onFile: (file: File) => void
  /** Validation or upload error to show under the zone. */
  error?: string | null
  disabled?: boolean
}

export function Dropzone({ onFile, error, disabled = false }: DropzoneProps) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const openPicker = () => {
    if (!disabled) inputRef.current?.click()
  }

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0]
    if (file) onFile(file)
  }

  return (
    <div className="panel">
      <div
        className={`dropzone${dragOver ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        aria-disabled={disabled}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openPicker()
          }
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragEnter={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          handleFiles(e.dataTransfer.files)
        }}
      >
        <p className="drop-title">Drop a PDF here</p>
        <p className="drop-sub">or click to choose one</p>

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          // Clearing the value lets the user pick the SAME file again after an
          // error; without it the change event would not fire a second time.
          onChange={(e) => {
            handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {error ? <p className="error-text">{error}</p> : null}
    </div>
  )
}
