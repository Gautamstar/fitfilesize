import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SearchState } from '../hooks/useProgressStream'
import { SearchLadder } from './SearchLadder'

const SEARCH: SearchState = {
  rungs: 12,
  target: 200_000,
  lossless: null,
  current: null,
  points: {
    11: { rung: 11, size: 17_000, fits: true, label: '', known: true, order: null },
    6: { rung: 6, size: 154_861, fits: true, label: '1800 px, quality 70', known: false, order: 1 },
    5: { rung: 5, size: 242_255, fits: false, label: '2000 px, quality 75', known: false, order: 2 },
  },
}

describe('SearchLadder', () => {
  it('draws a column per setting with status classes', () => {
    const { container } = render(<SearchLadder search={SEARCH} originalBytes={5_000_000} chosenRung={6} />)
    const cols = container.querySelectorAll('.ladder-col')
    expect(cols).toHaveLength(12)
    expect(cols[6]!.getAttribute('class')).toContain('fit')
    expect(cols[6]!.getAttribute('class')).toContain('chosen')
    expect(cols[5]!.getAttribute('class')).toContain('over')
    expect(cols[2]!.getAttribute('class')).toContain('too-big')
    expect(cols[9]!.getAttribute('class')).toContain('not-needed')
    expect(cols[11]!.getAttribute('class')).toContain('known')
  })

  it('never relies on colour alone: glyphs, a caption and a table', () => {
    const { container } = render(<SearchLadder search={SEARCH} originalBytes={5_000_000} chosenRung={6} />)
    const marks = [...container.querySelectorAll('.ladder-mark')].map((m) => m.textContent)
    expect(marks.sort()).toEqual(['✓', '✓', '✗'])
    expect(screen.getByText(/Found it in 2 tries out of 12 settings: setting 7/)).toBeTruthy()
    const rows = container.querySelectorAll('.ladder-table tbody tr')
    expect(rows).toHaveLength(3) // the known floor plus two tries
    expect(rows[1]!.textContent).toContain('7 of 12, 1800 px, quality 70')
    expect(rows[1]!.textContent).toContain('Fits, kept')
  })

  it('explains a column on hover', () => {
    const { container } = render(<SearchLadder search={SEARCH} originalBytes={5_000_000} />)
    const hits = container.querySelectorAll('.ladder-hit')
    fireEvent.mouseEnter(hits[3]!) // setting 3: gentler than a miss
    expect(screen.getByRole('status').textContent).toContain('Skipped: would be too big')
    fireEvent.mouseEnter(hits[7]!) // setting 7: the fit
    expect(screen.getByRole('status').textContent).toContain('Fits under your limit')
  })

  it('renders nothing before the search has started', () => {
    const { container } = render(
      <SearchLadder search={{ ...SEARCH, rungs: null }} originalBytes={5_000_000} />,
    )
    expect(container.innerHTML).toBe('')
  })
})
