import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReadingPanel } from './ReadingPanel'

describe('ReadingPanel', () => {
  it('shows the real upload percentage and bytes sent', () => {
    render(<ReadingPanel uploaded={0.5} fileBytes={4_000_000} slow={false} />)
    expect(screen.getByText('Uploading your file')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
    expect(screen.getByText('1.9 MB of 3.8 MB')).toBeTruthy()
  })

  it('claims no percentage while the server reads the file', () => {
    render(<ReadingPanel uploaded={null} fileBytes={4_000_000} slow={false} />)
    expect(screen.getByText('Reading your file')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
  })

  it('says still working only when the upload is not moving', () => {
    const { rerender } = render(<ReadingPanel uploaded={0.4} fileBytes={4_000_000} slow />)
    expect(screen.queryByText(/Still working/)).toBeNull()
    rerender(<ReadingPanel uploaded={0} fileBytes={4_000_000} slow />)
    expect(screen.getByText(/Still working/)).toBeTruthy()
  })

  it('says the file is queued while its analysis waits its turn', () => {
    render(<ReadingPanel uploaded={null} fileBytes={4_000_000} slow={false} queued />)
    expect(screen.getByText(/In the queue/)).toBeTruthy()
    expect(screen.queryByText('Checking how small it can go')).toBeNull()
  })
})
