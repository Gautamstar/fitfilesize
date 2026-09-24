/**
 * File picker with drag-and-drop.
 *
 * Drag state is a boolean in React state and the class name is computed from
 * it during render, so the highlight cannot get out of sync with the pointer.
 */

import { useRef, useState, type ReactNode } from 'react'

interface DropzoneProps {
  onFile: (file: File) => void
  /** Validation or upload error to show under the zone. */
  error?: string | null
  disabled?: boolean
  /** Rendered inside the card, under the drop area (the limit chips). */
  children?: ReactNode
}

export function Dropzone({ onFile, error, disabled = false, children }: DropzoneProps) {
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
        <svg className="drop-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <p className="drop-title">Drop your file here</p>
        <p className="drop-sub">
          or <span className="drop-link">choose a file</span> · PDF, JPG, PNG, WebP, TIFF or BMP
        </p>

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf,image/*"
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
      {children}
    </div>
  )
}
