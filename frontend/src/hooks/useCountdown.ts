/**
 * Ticks down to the job's auto-delete time. Replaces startCountdown() /
 * stopCountdown() at static/app.js:418-440.
 *
 * Same lifecycle problem as the SSE hook: setInterval keeps firing forever
 * unless something clears it. useEffect's cleanup does that automatically.
 */

import { useEffect, useState } from 'react'

/**
 * @param expiresAt epoch ms when the file is deleted, or null to stay idle
 * @param onExpire  fired once when the countdown reaches zero
 * @returns seconds remaining, or null when idle
 */
export function useCountdown(expiresAt: number | null, onExpire?: () => void): number | null {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)

  useEffect(() => {
    if (expiresAt === null) {
      setSecondsLeft(null)
      return
    }

    let fired = false

    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left <= 0 && !fired) {
        fired = true
        onExpire?.()
      }
    }

    tick() // paint immediately rather than waiting a full second
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
    // onExpire is deliberately not a dependency: callers usually pass an inline
    // arrow, and including it would restart the interval on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt])

  return secondsLeft
}
