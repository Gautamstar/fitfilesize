import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProgressPanel } from './ProgressPanel'

const waiting = { rungs: null, target: null, lossless: null, points: {}, current: null }

describe('ProgressPanel', () => {
  it('says the run is queued while other runs go first', () => {
    render(<ProgressPanel filename="a.jpg" targetBytes={100_000} search={waiting} queued />)
    expect(screen.getByText(/In the queue/)).toBeTruthy()
  })

  it('says it is starting once the run is no longer queued', () => {
    render(<ProgressPanel filename="a.jpg" targetBytes={100_000} search={waiting} />)
    expect(screen.getByText('Getting started...')).toBeTruthy()
  })
})
