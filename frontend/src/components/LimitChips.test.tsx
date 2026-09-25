import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parseLimit } from '../lib/format'
import { LimitChips } from './LimitChips'

describe('parseLimit', () => {
  it('reads KB and MB in 1000-byte units, like the chips', () => {
    expect(parseLimit('150', 'KB')).toBe(150_000)
    expect(parseLimit('1.5', 'MB')).toBe(1_500_000)
    expect(parseLimit(' 1,5 ', 'MB')).toBe(1_500_000)
  })

  it('rejects anything that is not a usable size', () => {
    for (const bad of ['', 'abc', '-5', '1.', '0', '0.5', '1e3']) {
      expect(parseLimit(bad, 'KB')).toBeNull()
    }
    expect(parseLimit('101', 'MB')).toBeNull()
  })
})

describe('LimitChips', () => {
  function setup(value: number | null = 1_000_000) {
    const onChange = vi.fn()
    render(<LimitChips value={value} onChange={onChange} />)
    return onChange
  }

  it('shows no custom box until Other is chosen', () => {
    setup()
    expect(screen.queryByRole('textbox', { name: 'Limit' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    expect(screen.getByRole('textbox', { name: 'Limit' })).toBeTruthy()
  })

  it('reports the typed size in bytes, following the unit', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    const box = screen.getByRole('textbox', { name: 'Limit' })
    fireEvent.change(box, { target: { value: '150' } })
    expect(onChange).toHaveBeenLastCalledWith(150_000)
    fireEvent.change(box, { target: { value: '1.5' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Unit' }), { target: { value: 'MB' } })
    expect(onChange).toHaveBeenLastCalledWith(1_500_000)
  })

  it('flags an invalid entry and falls back to no preset', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    const box = screen.getByRole('textbox', { name: 'Limit' })
    fireEvent.change(box, { target: { value: 'abc' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(box.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(/between 1 KB and 100 MB/)).toBeTruthy()
  })

  it('closes the box again when a preset chip is picked', () => {
    const onChange = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Other' }))
    fireEvent.click(screen.getByRole('button', { name: '200 KB' }))
    expect(onChange).toHaveBeenLastCalledWith(200_000)
    expect(screen.queryByRole('textbox', { name: 'Limit' })).toBeNull()
  })
})
