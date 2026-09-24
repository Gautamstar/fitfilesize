/**
 * Top-level state machine.
 *
 * A single `phase` value decides what is on screen, and each phase renders
 * exactly one component. Two panels can never show at once, because `phase`
 * cannot hold two values.
 */

import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Analytics } from '@vercel/analytics/react'
import { SpeedInsights } from '@vercel/speed-insights/react'
import { fadeUp } from './anim'
import { Dropzone } from './components/Dropzone'
import { ErrorPanel } from './components/ErrorPanel'
import { Landing } from './components/Landing'
import { LimitChips } from './components/LimitChips'
import { Logo } from './components/Logo'
import { ProgressPanel } from './components/ProgressPanel'
import { ResultPanel } from './components/ResultPanel'
import { TargetPicker } from './components/TargetPicker'
import { TipLink } from './components/TipLink'
import { useCountdown } from './hooks/useCountdown'
import { useProgressStream } from './hooks/useProgressStream'
import { analyzeJob, deleteJob, startCompress, uploadFile } from './lib/api'
import { describeSource, isAcceptedFile } from './lib/format'
import { pageForPath, pageTargetBytes } from './lib/landing'

type Phase = 'drop' | 'analyzing' | 'target' | 'progress' | 'result' | 'error'

/** Set on a search landing page such as /compress-pdf-to-200kb. Fixed per load. */
const LANDING = pageForPath(window.location.pathname)

/**
 * How long an upload may take before we say why. A free-tier backend that has
 * been idle takes up to a minute to wake, and without a word that looks hung.
 */
const SLOW_UPLOAD_MS = 5000

/** Everything we learn about the file from /upload and /analyze. */
interface JobInfo {
  jobId: string
  filename: string
  originalBytes: number
  /** "2.4 MB, 3 pages" or "2.4 MB, 3000 x 2000", built once at upload. */
  meta: string
  floor: number
}

function App() {
  const [phase, setPhase] = useState<Phase>('drop')
  const [job, setJob] = useState<JobInfo | null>(null)
  const [targetBytes, setTargetBytes] = useState(0)
  const [dropError, setDropError] = useState<string | null>(null)
  const [targetWarning, setTargetWarning] = useState<string | null>(null)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [slowUpload, setSlowUpload] = useState(false)
  // The limit picked before upload. A landing page preselects its own; null
  // means "Other", and the picker then suggests a size from the file.
  const [limit, setLimit] = useState<number | null>(LANDING ? pageTargetBytes(LANDING) : 1_000_000)

  const streaming = phase === 'progress' || phase === 'result'
  const stream = useProgressStream(job?.jobId ?? null, streaming)

  const reset = useCallback((message?: string) => {
    setPhase('drop')
    setJob(null)
    setTargetBytes(0)
    setTargetWarning(null)
    setFatalError(null)
    setDropError(message ?? null)
  }, [])

  const secondsLeft = useCountdown(phase === 'result' ? stream.expiresAt : null, () =>
    reset('We deleted that file. Upload it again if you still need it.'),
  )

  // Move the machine forward when the stream reaches a terminal event.
  useEffect(() => {
    if (stream.result) setPhase('result')
  }, [stream.result])

  useEffect(() => {
    if (stream.error) {
      setFatalError(stream.error)
      setPhase('error')
    }
  }, [stream.error])

  // Upload, then analyze, then show the picker.
  const handleFile = async (file: File) => {
    setDropError(null)

    if (!isAcceptedFile(file)) {
      setDropError('We can take a PDF, JPEG, PNG, WebP, TIFF or BMP.')
      return
    }

    setPhase('analyzing')
    const slowTimer = window.setTimeout(() => setSlowUpload(true), SLOW_UPLOAD_MS)
    try {
      let up
      try {
        up = await uploadFile(file)
      } finally {
        window.clearTimeout(slowTimer)
        setSlowUpload(false)
      }
      const an = await analyzeJob(up.job_id)
      setJob({
        jobId: up.job_id,
        filename: up.filename,
        originalBytes: up.size_bytes,
        meta: describeSource(up.kind, up.size_bytes, up.pages, up.width, up.height),
        floor: an.floor_estimate,
      })
      setPhase('target')
    } catch (err) {
      setDropError(err instanceof Error ? err.message : 'upload failed')
      setPhase('drop')
    }
  }

  // Queue the run and switch to the live progress view.
  const handleCompress = async (target: number) => {
    if (!job) return
    setTargetWarning(null)
    setTargetBytes(target)
    try {
      await startCompress(job.jobId, target)
      setPhase('progress')
    } catch (err) {
      setTargetWarning(err instanceof Error ? err.message : 'could not start compression')
    }
  }

  const handleDelete = async () => {
    if (job) {
      try {
        await deleteJob(job.jobId)
      } catch {
        // Already gone is fine.
      }
    }
    reset()
  }

  // One panel per phase. Pulled out so the animation wrapper below stays
  // readable and so `phase` is the single thing deciding what is on screen.
  const panel = () => {
    switch (phase) {
      case 'drop':
        return (
          <Dropzone onFile={handleFile} error={dropError}>
            <LimitChips
              value={limit}
              onChange={setLimit}
              extra={LANDING ? pageTargetBytes(LANDING) : undefined}
            />
          </Dropzone>
        )

      case 'analyzing':
        return (
          <div className="panel">
            <p className="progress-headline">Reading your file</p>
            {slowUpload ? (
              <p className="slow-note">
                Still working. If nobody has used the site for a while, the server takes up to a
                minute to wake up.
              </p>
            ) : null}
          </div>
        )

      case 'target':
        return job ? (
          <TargetPicker
            filename={job.filename}
            meta={job.meta}
            originalBytes={job.originalBytes}
            floor={job.floor}
            warning={targetWarning}
            onCompress={handleCompress}
            onCancel={() => reset()}
            initialTarget={limit ?? undefined}
          />
        ) : null

      case 'progress':
        return job ? (
          <ProgressPanel
            filename={job.filename}
            targetBytes={targetBytes}
            steps={stream.steps}
            attempts={stream.attempts}
          />
        ) : null

      case 'result':
        return job && stream.result ? (
          <ResultPanel
            jobId={job.jobId}
            result={stream.result}
            secondsLeft={secondsLeft}
            onRetry={() => setPhase('target')}
            onDelete={handleDelete}
          />
        ) : null

      case 'error':
        return <ErrorPanel message={fatalError ?? 'compression failed'} onRestart={() => reset()} />
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="FitFileSize home">
          <Logo />
          <span className="brand-name">FitFileSize</span>
        </a>
        <p className="topbar-note">Free · No sign-up</p>
      </header>

      <motion.section className="hero" variants={fadeUp} initial="hidden" animate="show">
        {/* On a landing page the H1 is the search phrase itself, since that is
            what the visitor typed and what the page should rank for. */}
        <h1>{LANDING?.heading ?? 'Make any file fit the upload limit'}</h1>
        <p className="tagline">
          {LANDING?.blurb ??
            'Compress a PDF or image to the exact size a form asks for. Free, no sign-up, and your file is deleted within minutes.'}
        </p>
      </motion.section>

      <main>
        {/* mode="wait" lets the outgoing panel finish before the next rises in,
            so the two never overlap mid-transition. */}
        <AnimatePresence mode="wait">
          <motion.div
            key={phase}
            variants={fadeUp}
            initial="hidden"
            animate="show"
            exit={{ opacity: 0, y: -8, transition: { duration: 0.18 } }}
          >
            {panel()}
          </motion.div>
        </AnimatePresence>

        {phase === 'drop' ? (
          <ul className="trust">
            <li>
              <TrustIcon d="M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6l-7-3z" />
              Deleted within 10 minutes
            </li>
            <li>
              <TrustIcon d="M20 6 9 17l-5-5" />
              Free, no watermark
            </li>
            <li>
              <TrustIcon d="M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0zm8-4v4l3 2" />
              Quality kept where possible
            </li>
          </ul>
        ) : null}

        {/* Pitch belongs on a fresh page only. Once a file is in flight the
            page should be about that file. */}
        {phase === 'drop' ? <Landing page={LANDING} /> : null}
      </main>

      <footer className="site-foot">
        <a className="brand brand-small" href="/">
          <Logo size={20} />
          <span className="brand-name">FitFileSize</span>
        </a>
        <p>
          We delete your original 5 minutes after the run finishes, and the compressed file
          after 10.
        </p>
        <nav className="foot-links" aria-label="Site">
          <a href="/privacy.html">Privacy</a>
          <a href="/terms.html">Terms</a>
          <TipLink>Support FitFileSize</TipLink>
        </nav>
      </footer>

      {/* Both are cookieless and record no per-visitor identity, which keeps the
          page consistent with what it promises about the files themselves.
          Analytics gives traffic and referrers; SpeedInsights reports Core Web
          Vitals measured on real visits rather than a synthetic run. */}
      <Analytics />
      <SpeedInsights />
    </div>
  )
}

/** A small line icon for the trust row. Decorative: the text says it all. */
function TrustIcon({ d }: { d: string }) {
  return (
    <svg className="trust-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default App
