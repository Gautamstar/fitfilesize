import { render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

// TIP_URL is read at import time, so each case imports a fresh module.
async function load(url: string) {
  vi.stubEnv('VITE_TIP_URL', url)
  return import('./TipLink')
}

it('renders nothing when no tip URL is configured', async () => {
  const { TipLink, TIP_ENABLED } = await load('')
  const { container } = render(<TipLink>Tip</TipLink>)
  expect(container.innerHTML).toBe('')
  expect(TIP_ENABLED).toBe(false)
})

it('links out to the payment page in a new tab', async () => {
  const { TipLink } = await load('https://buy.stripe.com/test')
  const { getByRole } = render(<TipLink>Tip</TipLink>)
  const link = getByRole('link', { name: 'Tip' })
  expect(link.getAttribute('href')).toBe('https://buy.stripe.com/test')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
})
