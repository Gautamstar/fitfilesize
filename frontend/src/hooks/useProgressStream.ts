/**
 * Subscribes to the job's progress stream and turns the raw events into
 * display-ready state.
 *
 * An EventSource is a live network connection that has to be closed when the
 * component goes away, or every new job leaks a socket. useEffect's cleanup
 * function is what owns that, which is why this is a hook.
 *
 * The stream is not trusted on its own. Server-Sent Events travel as a long
 * lived text/event-stream response, and plenty of things in the middle will
 * quietly hold that open while delivering nothing: corporate proxies that
 * buffer, some mobile networks, privacy extensions. A client that only listens
 * would sit on "Working on it" forever with no way to find out otherwise. So a
 * poll starts if the stream has said nothing by STREAM_GRACE_MS, and whichever
 * one reports a terminal state first wins.
 */

import { useEffect, useRef, useState } from 'react'
import { eventsUrl, getJob } from '../lib/api'
import { fmt } from '../lib/format'
import type { DoneEvent, JobState, ProgressEvent } from '../types/api'

/** How long to let the stream prove itself before polling as well. */
const STREAM_GRACE_MS = 6000

/** Poll interval once the fallback is running. */
const POLL_MS = 2500

/** One line in the progress list. */
export interface ProgressStep {
  id: number
  text: string
  /** 'pending' renders muted; a rung flips to 'done' when its result lands. */
  status: 'pending' | 'done'
  /** Set on rung results: did this rung come in under the target? */
  tag?: 'under' | 'over'
}

/** One rung of the ladder as the search has seen it. */
export interface RungPoint {
  rung: number
  /** Output size, or null when the render failed. */
  size: number | null
  fits: boolean
  /** Human-readable settings, e.g. "1800 px, quality 70". Empty for known rungs. */
  label: string
  /** Measured before this run (the analyze step's floor), not rendered by it. */
  known: boolean
  /** 1 for the first rung this run rendered, 2 for the next, and so on. */
  order: number | null
}

/** Structured view of the rung search, for SearchLadder. */
export interface SearchState {
  /** Ladder length, from the `search` event. Null until the search starts. */
  rungs: number | null
  target: number | null
  /** Size after the lossless pass, when there was one. */
  lossless: number | null
  points: Record<number, RungPoint>
  /** The rung being rendered right now. */
  current: { rung: number; label: string } | null
}

export interface StreamState {
  steps: ProgressStep[]
  search: SearchState
  /** How many attempts have started, for the "Attempt 2 of at most 5" line. */
  attempts: number
  /** Set once the job finishes successfully. */
  result: DoneEvent | null
  /** Set if the job failed. */
  error: string | null
  /** Epoch ms when the stored file is deleted, from the `state` event. */
  expiresAt: number | null
}

const EMPTY_SEARCH: SearchState = {
  rungs: null,
  target: null,
  lossless: null,
  points: {},
  current: null,
}

const EMPTY: StreamState = {
  steps: [],
  search: EMPTY_SEARCH,
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

    let settled = false
    let heardFromStream = false
    let pollTimer: number | undefined
    let graceTimer: number | undefined

    const stop = () => {
      settled = true
      es.close()
      window.clearInterval(pollTimer)
      window.clearTimeout(graceTimer)
    }

    /** Turn a terminal JobState into the same shape a `done` event carries. */
    const resultFromState = (st: JobState): DoneEvent => ({
      stage: 'done',
      hit_target: st.hit_target ?? false,
      final_bytes: st.final_bytes ?? 0,
      original_bytes: st.size_bytes,
      target_bytes: st.target_bytes ?? 0,
      method: st.method ?? 'none',
      warnings: st.warnings ?? [],
    })

    const settleFromState = (st: JobState) => {
      if (settled) return
      setState((s) => ({ ...s, expiresAt: Date.now() + st.expires_in * 1000 }))
      if (st.status === 'done') {
        setState((s) => ({ ...s, result: resultFromState(st) }))
        stop()
      } else if (st.status === 'error') {
        setState((s) => ({ ...s, error: st.error ?? 'compression failed' }))
        stop()
      }
    }

    const startPolling = () => {
      if (settled || pollTimer !== undefined) return
      pollTimer = window.setInterval(async () => {
        try {
          settleFromState(await getJob(jobId))
        } catch {
          // A failed poll says nothing conclusive, so keep trying until the
          // job resolves or the component unmounts.
        }
      }, POLL_MS)
    }

    // If the stream has produced nothing by now, something between here and the
    // server is eating it. Poll instead rather than waiting on it forever.
    graceTimer = window.setTimeout(() => {
      if (!heardFromStream) startPolling()
    }, STREAM_GRACE_MS)

    const addStep = (text: string, status: ProgressStep['status'] = 'done') => {
      const id = nextId.current++
      setState((s) => ({ ...s, steps: [...s.steps, { id, text, status }] }))
      return id
    }

    // Default (unnamed) events carry the ProgressEvent union.
    es.onmessage = (msg) => {
      heardFromStream = true
      if (settled) return
      const ev: ProgressEvent = JSON.parse(msg.data)

      // Switching on the literal `stage` field narrows the union, so each
      // branch below sees only the fields that stage actually carries.
      switch (ev.stage) {
        case 'start': {
          const target = ev.target_bytes
          setState((s) => ({ ...s, search: { ...s.search, target } }))
          addStep(`Starting, target ${fmt(target)}`)
          break
        }

        case 'lossless': {
          const size = ev.size
          setState((s) => ({ ...s, attempts: s.attempts + 1, search: { ...s.search, lossless: size } }))
          addStep(`Cleanup pass brought it to ${fmt(size)}`)
          break
        }

        case 'search': {
          const { rungs, known } = ev
          setState((s) => {
            const points = { ...s.search.points }
            for (const k of known) {
              points[k.rung] = {
                rung: k.rung,
                size: k.size,
                fits: s.search.target !== null && k.size <= s.search.target,
                label: '',
                known: true,
                order: null,
              }
            }
            return { ...s, search: { ...s.search, rungs, points } }
          })
          break
        }

        case 'rung_start': {
          setState((s) => ({ ...s, attempts: s.attempts + 1 }))
          // Every kind of run shares this stage, so `stage` cannot separate
          // them. The `in` operator narrows the union to the right variant.
          const label =
            'width' in ev
              ? `Trying ${ev.width} x ${ev.height}, quality ${ev.quality}`
              : 'max_edge' in ev
                ? `Trying ${ev.max_edge}px wide, quality ${ev.quality}`
                : `Trying ${ev.color_dpi} DPI, JPEG quality ${ev.jpeg_q}`
          addStep(label, 'pending')
          const rung = ev.rung
          const short =
            'width' in ev
              ? `${ev.width} x ${ev.height}, quality ${ev.quality}`
              : 'max_edge' in ev
                ? `${ev.max_edge} px, quality ${ev.quality}`
                : `${ev.color_dpi} DPI, quality ${ev.jpeg_q}`
          setState((s) => ({ ...s, search: { ...s.search, current: { rung, label: short } } }))
          break
        }

        case 'rung_result': {
          // A rung's result lands after its start, so fill in the most recent
          // pending step rather than appending a second line for it.
          const size = ev.size
          const fits = ev.fits
          const rung = ev.rung
          setState((s) => {
            const tried = Object.values(s.search.points).filter((p) => !p.known).length
            const label = s.search.current?.rung === rung ? s.search.current.label : ''
            const search: SearchState = {
              ...s.search,
              current: null,
              points: {
                ...s.search.points,
                [rung]: { rung, size, fits, label, known: false, order: tried + 1 },
              },
            }
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
            return { ...s, steps, search }
          })
          break
        }

        case 'done': {
          // The `state` event on connect carried the pending window, since
          // the job had not finished yet; completion restarts the clock.
          const expiresAt = ev.expires_in !== undefined ? Date.now() + ev.expires_in * 1000 : null
          setState((s) => ({ ...s, result: ev, expiresAt: expiresAt ?? s.expiresAt }))
          stop()
          break
        }

        case 'error':
          setState((s) => ({ ...s, error: ev.message || 'compression failed' }))
          stop()
          break
      }
    }

    // A named `state` event arrives on connect, and again if the job was
    // already finished before we subscribed (e.g. after a page reload).
    es.addEventListener('state', (msg) => {
      heardFromStream = true
      settleFromState(JSON.parse((msg as MessageEvent).data) as JobState)
    })

    es.onerror = () => {
      // EventSource reconnects on its own, and after a `done` the server closes
      // the response, so an error here is routine rather than a failure. What it
      // does mean is that the stream is not currently carrying anything, so
      // start polling rather than betting on the reconnect succeeding.
      if (!settled) startPolling()
    }

    // Cleanup: runs when jobId changes, enabled flips, or the component
    // unmounts. Without this, every new job leaks a connection and a timer.
    return stop
  }, [jobId, enabled])

  return state
}
