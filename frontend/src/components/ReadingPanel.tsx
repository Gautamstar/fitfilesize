/**
 * Upload and analysis, before the size picker.
 *
 * The upload has a real percentage (the browser reports bytes sent). The
 * analysis that follows reports nothing until it is done, so its bar moves
 * without claiming a number rather than inventing one.
 */

import { fmt } from '../lib/format'

interface ReadingPanelProps {
  /** Share of the file sent, 0 to 1; null once the upload is done. */
  uploaded: number | null
  fileBytes: number
  slow: boolean
}

export function ReadingPanel({ uploaded, fileBytes, slow }: ReadingPanelProps) {
  const uploading = uploaded !== null
  const pct = uploading ? Math.round(uploaded * 100) : null
  // A slow upload that is visibly moving is just a big file on a slow
  // connection. The waking-server note is for when nothing moves at all.
  const stalled = !uploading || uploaded === 0 || uploaded >= 1

  return (
    <div className="panel">
      <p className="progress-headline">{uploading ? 'Uploading your file' : 'Reading your file'}</p>
      <div
        className={`read-bar${uploading ? '' : ' indeterminate'}`}
        role="progressbar"
        aria-label={uploading ? 'Upload progress' : 'Reading your file'}
        aria-valuemin={uploading ? 0 : undefined}
        aria-valuemax={uploading ? 100 : undefined}
        aria-valuenow={pct ?? undefined}
      >
        <div className="read-bar-fill" style={uploading ? { width: `${pct}%` } : undefined} />
      </div>
      <p className="read-meta">
        {uploading
          ? `${fmt(Math.round(fileBytes * (uploaded as number)))} of ${fmt(fileBytes)}`
          : 'Checking how small it can go'}
      </p>
      {slow && stalled ? (
        <p className="slow-note">
          Still working. If nobody has used the site for a while, the server takes up to a minute
          to wake up.
        </p>
      ) : null}
    </div>
  )
}
