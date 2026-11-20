import { render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EXTENSION_URL, ExtensionNote } from './ExtensionNote'

const DESKTOP_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const DESKTOP_FIREFOX =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'

afterEach(() => {
  vi.unstubAllGlobals()
})

function asBrowser(userAgent: string) {
  vi.stubGlobal('navigator', { userAgent })
}

it('links to the store in a new tab in desktop Chrome', () => {
  asBrowser(DESKTOP_CHROME)
  const { getByRole } = render(<ExtensionNote where="result" />)
  const link = getByRole('link', { name: 'Add to Chrome' })
  expect(link.getAttribute('href')).toBe(EXTENSION_URL)
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toContain('noopener')
})

it('shows nothing in Android Chrome or desktop Firefox', () => {
  for (const ua of [ANDROID_CHROME, DESKTOP_FIREFOX]) {
    asBrowser(ua)
    const { container, unmount } = render(<ExtensionNote where="page" />)
    expect(container.innerHTML).toBe('')
    unmount()
  }
})
