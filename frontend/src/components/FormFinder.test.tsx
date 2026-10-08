import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FormFinder } from './FormFinder'
import { findPages } from '../lib/findPages'

describe('findPages', () => {
  it('finds a form by any word of its name', () => {
    expect(findPages('ibps photo').map((p) => p.slug)).toContain('ibps-photo')
    expect(findPages('emoji').map((p) => p.slug)).toContain('discord-emoji-gif')
  })

  it('puts forms before plain size pages', () => {
    const found = findPages('photo')
    expect(found[0].title).toBeTruthy()
  })

  it('finds nothing for nothing typed', () => {
    expect(findPages('  ')).toEqual([])
  })
})

describe('FormFinder', () => {
  it('lists matches as links to their pages', () => {
    render(<FormFinder />)
    fireEvent.change(screen.getByLabelText('Uploading for a form?'), {
      target: { value: 'sbi signature' },
    })
    const link = screen.getByRole('link', { name: /SBI signature/ })
    expect(link.getAttribute('href')).toBe('/sbi-signature')
  })

  it('says so when nothing matches', () => {
    render(<FormFinder />)
    fireEvent.change(screen.getByLabelText('Uploading for a form?'), {
      target: { value: 'zzzz' },
    })
    expect(screen.getByText(/No page for that yet/)).toBeTruthy()
  })
})
