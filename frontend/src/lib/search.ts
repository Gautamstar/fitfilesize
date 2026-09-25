/**
 * Reading the rung search's state: which rungs are still possible, what each
 * rung's status is, and a sentence describing where the search stands. Kept
 * apart from SearchLadder so it can be tested without rendering.
 */

import type { SearchState } from '../hooks/useProgressStream'
import { fmt } from './format'

export type RungStatus = 'fit' | 'over' | 'failed' | 'trying' | 'open' | 'too-big' | 'not-needed'

/** What the search has pinned down so far: rungs lo..hi are still possible. */
export function searchRange(search: SearchState) {
  const n = search.rungs ?? 0
  let lo = 0
  let hi = n - 1
  let gentlestFit: number | null = null
  for (const p of Object.values(search.points)) {
    if (p.fits) {
      hi = Math.min(hi, p.rung - 1)
      gentlestFit = gentlestFit === null ? p.rung : Math.min(gentlestFit, p.rung)
    } else {
      lo = Math.max(lo, p.rung + 1)
    }
  }
  return { lo, hi, gentlestFit, settled: lo > hi }
}

export function statusOf(rung: number, search: SearchState, lo: number, hi: number): RungStatus {
  const p = search.points[rung]
  if (p) return p.size === null ? 'failed' : p.fits ? 'fit' : 'over'
  if (search.current?.rung === rung) return 'trying'
  if (rung < lo) return 'too-big'
  if (rung > hi) return 'not-needed'
  return 'open'
}

/** One line saying where the search is, for sighted and screen-reader users alike. */
export function narrate(search: SearchState, chosenRung?: number | null): string {
  const n = search.rungs
  if (n === null) {
    return search.lossless !== null
      ? `Cleanup pass: ${fmt(search.lossless)}. Still over your limit, so the search begins.`
      : 'Getting ready...'
  }
  const { lo, hi, gentlestFit, settled } = searchRange(search)
  const tried = Object.values(search.points).filter((p) => !p.known)
  if (search.current) {
    return `Trying setting ${search.current.rung + 1} of ${n} (${search.current.label})...`
  }
  if (chosenRung !== undefined || settled) {
    const keep = chosenRung ?? gentlestFit
    const tries = `${tried.length} ${tried.length === 1 ? 'try' : 'tries'}`
    return keep === null || keep === undefined
      ? `No setting gets under your limit, so we kept the smallest version (${tries}).`
      : `Found it in ${tries} out of ${n} settings: setting ${keep + 1}, the gentlest that fits.`
  }
  const last = tried.sort((a, b) => (b.order ?? 0) - (a.order ?? 0))[0]
  if (!last) return `Searching ${n} settings for the gentlest one that fits...`
  const verdict = last.size === null ? 'could not be made' : `${fmt(last.size)}, ${last.fits ? 'fits' : 'too big'}`
  const left = hi - lo + 1
  return `Setting ${last.rung + 1}: ${verdict}. ${left} ${left === 1 ? 'setting' : 'settings'} left to check.`
}

/**
 * How far the run is, 0 to 1, for the progress bar, and which try it is on.
 *
 * The number of renders is not known in advance (usually 1 to 4), so the bar
 * cannot be a timer. Instead each finished render fills its share of the
 * work still possibly ahead: the renders a bisection of the settings still
 * open would take, which the guided search usually beats. The render in
 * flight counts as half done so the bar moves when one starts. The first
 * tenth is the run getting started and its cleanup pass. The caller keeps
 * the bar from ever moving back.
 */
export function runProgress(search: SearchState): { fraction: number; tries: number } {
  const tries = Object.values(search.points).filter((p) => !p.known).length
  const started = search.current ? 1 : 0
  if (search.rungs === null) {
    return { fraction: search.lossless !== null ? 0.08 : 0.03, tries }
  }
  const { lo, hi, settled } = searchRange(search)
  if (settled) return { fraction: 1, tries }
  const open = hi - lo + 1
  const ahead = Math.max(1, Math.ceil(Math.log2(open + 1)))
  const done = tries + 0.5 * started
  return { fraction: 0.1 + 0.9 * (done / (tries + ahead)), tries: tries + started }
}
