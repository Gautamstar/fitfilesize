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

describe('FormFinder keyboard', () => {
  it('moves from the input into the matches with the arrow keys', () => {
    render(<FormFinder />)
    const input = screen.getByLabelText('Uploading for a form?')
    fireEvent.change(input, { target: { value: 'ibps' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const links = screen.getAllByRole('link')
    expect(document.activeElement).toBe(links[0])
    fireEvent.keyDown(links[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(links[1])
    fireEvent.keyDown(links[1], { key: 'ArrowUp' })
    fireEvent.keyDown(links[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(input)
  })

  it('announces how many pages match', () => {
    render(<FormFinder />)
    fireEvent.change(screen.getByLabelText('Uploading for a form?'), { target: { value: 'ibps' } })
    expect(screen.getByText('2 pages found')).toBeTruthy()
  })
})
