import { describe, expect, it } from 'vitest'
import type { SearchState } from '../hooks/useProgressStream'
import { narrate, runProgress, searchRange, statusOf } from './search'

function state(points: [number, number | null, boolean][], extra: Partial<SearchState> = {}): SearchState {
  return {
    rungs: 12,
    target: 200_000,
    lossless: null,
    current: null,
    points: Object.fromEntries(
      points.map(([rung, size, fits], i) => [
        rung,
        { rung, size, fits, label: `setting ${rung}`, known: false, order: i + 1 },
      ]),
    ),
    ...extra,
  }
}

describe('searchRange', () => {
  it('narrows from both sides as results arrive', () => {
    // 5 too big rules out 0..5; 8 fits rules out 9..11 (stronger than needed).
    const r = searchRange(state([[5, 242_000, false], [8, 60_000, true]]))
    expect(r).toMatchObject({ lo: 6, hi: 7, gentlestFit: 8, settled: false })
  })

  it('is settled once the gentlest fit sits right after a miss', () => {
    const r = searchRange(state([[6, 150_000, true], [5, 242_000, false]]))
    expect(r).toMatchObject({ lo: 6, hi: 5, gentlestFit: 6, settled: true })
  })
})

describe('statusOf', () => {
  it('tells tried, trying, skipped and still-possible rungs apart', () => {
    const s = state([[5, 242_000, false], [8, 60_000, true]], { current: { rung: 6, label: '' } })
    const { lo, hi } = searchRange(s)
    expect(statusOf(5, s, lo, hi)).toBe('over')
    expect(statusOf(8, s, lo, hi)).toBe('fit')
    expect(statusOf(6, s, lo, hi)).toBe('trying')
    expect(statusOf(7, s, lo, hi)).toBe('open')
    expect(statusOf(2, s, lo, hi)).toBe('too-big')
    expect(statusOf(10, s, lo, hi)).toBe('not-needed')
  })

  it('marks a failed render', () => {
    const s = state([[4, null, false]])
    const { lo, hi } = searchRange(s)
    expect(statusOf(4, s, lo, hi)).toBe('failed')
  })
})

describe('narrate', () => {
  it('reports the latest result and what is left', () => {
    expect(narrate(state([[5, 242_000, false]]))).toBe(
      'Setting 6: 236.3 KB, too big. 6 settings left to check.',
    )
  })

  it('says what is being tried', () => {
    const s = state([], { current: { rung: 6, label: '1800 px, quality 70' } })
    expect(narrate(s)).toBe('Trying setting 7 of 12 (1800 px, quality 70)...')
  })

  it('names the answer and how few tries it took', () => {
    const s = state([[6, 150_000, true], [5, 242_000, false]])
    expect(narrate(s, 6)).toBe('Found it in 2 tries out of 12 settings: setting 7, the gentlest that fits.')
  })

  it('is honest when nothing fits', () => {
    expect(narrate(state([[11, 250_000, false]]), null)).toBe(
      'No setting gets under your limit, so we kept the smallest version (1 try).',
    )
  })

  it('covers the cleanup pass before the search starts', () => {
    const s = { ...state([]), rungs: null, lossless: 4_570_000 }
    expect(narrate(s)).toMatch(/^Cleanup pass: 4\.4 MB\. Still over your limit/)
  })
})

describe('runProgress', () => {
  const base: SearchState = { rungs: null, target: 200_000, lossless: null, points: {}, current: null }
  const point = (rung: number, fits: boolean, order: number | null, known = false) => ({
    rung, size: fits ? 100_000 : 300_000, fits, label: '', known, order,
  })

  it('starts near zero before the search is announced', () => {
    expect(runProgress(base).fraction).toBeLessThan(0.1)
  })

  it('moves forward with each try and ends at 1 once settled', () => {
    const floorKnown = { ...base, rungs: 12, points: { 11: point(11, true, null, true) } }
    const a = runProgress(floorKnown).fraction
    const trying = { ...floorKnown, current: { rung: 6, label: '1800 px, quality 70' } }
    const b = runProgress(trying)
    const oneDone = { ...floorKnown, points: { ...floorKnown.points, 6: point(6, true, 1) } }
    const c = runProgress(oneDone).fraction
    const settled = { ...oneDone, points: { ...oneDone.points, 5: point(5, false, 2) } }
    expect(b.tries).toBe(1)
    expect(a).toBeLessThan(b.fraction)
    expect(b.fraction).toBeLessThan(c)
    expect(runProgress(settled)).toEqual({ fraction: 1, tries: 2 })
  })
})
