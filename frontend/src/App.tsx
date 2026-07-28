/**
 * Top-level state machine. Replaces the `state` object plus showPanel() at
 * static/app.js:5-17 and 63-68.
 *
 * The old code hid and unhid five <section> elements by toggling a `hidden`
 * attribute. Here there is a single `phase` value and each phase renders one
 * component. Two panels can never be visible at once, because `phase` cannot
 * hold two values.
 */

import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { fadeUp } from './anim'
import { Dropzone } from './components/Dropzone'
import { ErrorPanel } from './components/ErrorPanel'
import { Landing } from './components/Landing'
import { ProgressPanel } from './components/ProgressPanel'
import { ResultPanel } from './components/ResultPanel'
import { TargetPicker } from './components/TargetPicker'
import { useCountdown } from './hooks/useCountdown'
import { useProgressStream } from './hooks/useProgressStream'
import { analyzeJob, deleteJob, startCompress, uploadFile } from './lib/api'
import { describeSource, isAcceptedFile } from './lib/format'

type Phase = 'drop' | 'analyzing' | 'target' | 'progress' | 'result' | 'error'

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

  // Upload, then analyze, then show the picker. app.js:115-147
  const handleFile = async (file: File) => {
    setDropError(null)

    if (!isAcceptedFile(file)) {
      setDropError('We can take a PDF, JPEG, PNG, WebP, TIFF or BMP.')
      return
    }

    setPhase('analyzing')
    try {
      const up = await uploadFile(file)
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

  // Queue the run and switch to the live progress view. app.js:259-278
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
        return <Dropzone onFile={handleFile} error={dropError} />

      case 'analyzing':
        return (
          <div className="panel">
            <p className="progress-headline">Reading your file</p>
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
      <motion.header className="site-head" variants={fadeUp} initial="hidden" animate="show">
        <p className="eyebrow">PDF and image compression</p>
        <h1>Make it fit.</h1>
        <p className="tagline">Pick a size. Get a file that fits under it.</p>
      </motion.header>

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

        {/* Pitch belongs on a fresh page only. Once a file is in flight the
            page should be about that file. */}
        {phase === 'drop' ? <Landing /> : null}
      </main>

      <footer className="site-foot">
        <p>
          We delete your original 5 minutes after the run finishes, and the compressed file
          after 10.
        </p>
      </footer>
    </div>
  )
}

export default App
