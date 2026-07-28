/**
 * Subscribes to the job's SSE progress stream and turns the raw events into
 * display-ready state. Replaces openStream() at static/app.js:292-366.
 *
 * The whole reason this is a hook and not plain code: an EventSource is a live
 * network connection that MUST be closed when the component goes away, or you
 * leak a socket every time the user starts a new job. useEffect's cleanup
 * function is React's mechanism for exactly that.
 */

import { useEffect, useRef, useState } from 'react'
import { eventsUrl } from '../lib/api'
import { fmt } from '../lib/format'
import type { DoneEvent, JobState, ProgressEvent } from '../types/api'

/** One line in the progress list. */
export interface ProgressStep {
  id: number
  text: string
  /** 'pending' renders muted; a rung flips to 'done' when its result lands. */
  status: 'pending' | 'done'
  /** Set on rung results: did this rung come in under the target? */
  tag?: 'under' | 'over'
}

export interface StreamState {
  steps: ProgressStep[]
  /** How many attempts have started, for the "Attempt 2 of at most 5" line. */
  attempts: number
  /** Set once the job finishes successfully. */
  result: DoneEvent | null
  /** Set if the job failed. */
  error: string | null
  /** Epoch ms when the stored file is deleted, from the `state` event. */
  expiresAt: number | null
}

const EMPTY: StreamState = {
  steps: [],
  attempts: 0,
  result: null,
  error: null,
  expiresAt: null,
}

/**
 * Pass a jobId to start streaming, or null to stay idle.
 *
 * `enabled` lets the caller keep the hook mounted but disconnected, which is
 * what we want between runs: the component tree stays put, the socket does not.
 */
export function useProgressStream(jobId: string | null, enabled: boolean): StreamState {
  const [state, setState] = useState<StreamState>(EMPTY)

  // Monotonic id for step keys. A ref, not state, because bumping it must not
  // trigger a re-render on its own.
  const nextId = useRef(0)

  useEffect(() => {
    if (!jobId || !enabled) return

    // Fresh run: clear anything left from the previous job.
    setState(EMPTY)
    nextId.current = 0

    const es = new EventSource(eventsUrl(jobId))

    const addStep = (text: string, status: ProgressStep['status'] = 'done') => {
      const id = nextId.current++
      setState((s) => ({ ...s, steps: [...s.steps, { id, text, status }] }))
      return id
    }

    // Default (unnamed) events carry the ProgressEvent union.
    es.onmessage = (msg) => {
      const ev: ProgressEvent = JSON.parse(msg.data)

      // Switching on the literal `stage` field narrows the union, so each
      // branch below sees only the fields that stage actually carries.
      switch (ev.stage) {
        case 'start':
          addStep(`Starting, target ${fmt(ev.target_bytes)}`)
          break

        case 'lossless':
          setState((s) => ({ ...s, attempts: s.attempts + 1 }))
          addStep(`Lossless cleanup pass: ${fmt(ev.size)}`)
          break

        case 'rung_start':
          setState((s) => ({ ...s, attempts: s.attempts + 1 }))
          addStep(
            `Trying ${ev.color_dpi} DPI, JPEG quality ${ev.jpeg_q}`,
            'pending',
          )
          break

        case 'rung_result': {
          // Update the most recent pending step in place, the way the old code
          // mutated currentRungLi.
          const size = ev.size
          const fits = ev.fits
          setState((s) => {
            const steps = [...s.steps]
            for (let i = steps.length - 1; i >= 0; i--) {
              const step = steps[i]
              if (step && step.status === 'pending') {
                steps[i] =
                  size === null
                    ? { ...step, status: 'done', text: `${step.text}: failed, skipping` }
                    : {
                        ...step,
                        status: 'done',
                        text: `${step.text} gives ${fmt(size)}`,
                        tag: fits ? 'under' : 'over',
                      }
                break
              }
            }
            return { ...s, steps }
          })
          break
        }

        case 'done':
          setState((s) => ({ ...s, result: ev }))
          es.close()
          break

        case 'error':
          setState((s) => ({ ...s, error: ev.message || 'compression failed' }))
          es.close()
          break
      }
    }

    // A named `state` event arrives on connect, and again if the job was
    // already finished before we subscribed (e.g. after a page reload).
    es.addEventListener('state', (msg) => {
      const st: JobState = JSON.parse((msg as MessageEvent).data)

      setState((s) => ({ ...s, expiresAt: Date.now() + st.expires_in * 1000 }))

      if (st.status === 'done') {
        setState((s) => ({
          ...s,
          result: {
            stage: 'done',
            hit_target: st.hit_target ?? false,
            final_bytes: st.final_bytes ?? 0,
            original_bytes: st.size_bytes,
            target_bytes: st.target_bytes ?? 0,
            method: st.method ?? 'none',
            warnings: st.warnings ?? [],
          },
        }))
        es.close()
      } else if (st.status === 'error') {
        setState((s) => ({ ...s, error: st.error ?? 'compression failed' }))
        es.close()
      }
    })

    es.onerror = () => {
      // EventSource reconnects on its own. If the job finished while we were
      // disconnected, the `state` event on reconnect resolves it.
    }

    // Cleanup: runs when jobId changes, enabled flips, or the component
    // unmounts. Without this, every new job leaks the previous connection.
    return () => es.close()
  }, [jobId, enabled])

  return state
}
