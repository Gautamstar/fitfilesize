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
import { ProgressPanel } from './components/ProgressPanel'
import { ResultPanel } from './components/ResultPanel'
import { TargetPicker } from './components/TargetPicker'
import { useCountdown } from './hooks/useCountdown'
import { useProgressStream } from './hooks/useProgressStream'
import { analyzeJob, deleteJob, startCompress, uploadPdf } from './lib/api'

type Phase = 'drop' | 'analyzing' | 'target' | 'progress' | 'result' | 'error'

/** Everything we learn about the file from /upload and /analyze. */
interface JobInfo {
  jobId: string
  filename: string
  originalBytes: number
  pages: number
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
    reset('That file expired and was deleted. Upload it again if you still need it.'),
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

    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      setDropError('That does not look like a PDF.')
      return
    }

    setPhase('analyzing')
    try {
      const up = await uploadPdf(file)
      const an = await analyzeJob(up.job_id)
      setJob({
        jobId: up.job_id,
        filename: up.filename,
        originalBytes: up.size_bytes,
        pages: up.pages,
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
            <p className="progress-headline">Reading the file...</p>
          </div>
        )

      case 'target':
        return job ? (
          <TargetPicker
            filename={job.filename}
            originalBytes={job.originalBytes}
            pages={job.pages}
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
        <h1>FitPDF</h1>
        <p className="tagline">
          Compress a PDF to fit under a target size, or find out honestly that it cannot.
        </p>
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
      </main>

      <footer className="site-foot">
        <p>
          Your original is deleted 5 minutes after compression finishes, the compressed file
          after 10.
        </p>
      </footer>
    </div>
  )
}

export default App
