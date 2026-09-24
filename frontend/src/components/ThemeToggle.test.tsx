import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { THEME_KEY, toggleTheme } from '../lib/theme'
import { ThemeToggle } from './ThemeToggle'

function systemPrefersDark(dark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: dark && query.includes('dark'), media: query })),
  )
}

// An in-memory localStorage. Newer Node versions ship their own global
// localStorage, which is inert without --localstorage-file and shadows
// jsdom's, so the tests bring one that behaves the same everywhere.
function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  }
}

let storage: ReturnType<typeof memoryStorage>

beforeEach(() => {
  delete document.documentElement.dataset.theme
  storage = memoryStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('starts from the system theme and flips it', () => {
  systemPrefersDark(true)
  expect(toggleTheme()).toBe('light')
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(toggleTheme()).toBe('dark')
})

it('remembers the choice for the next visit', () => {
  systemPrefersDark(false)
  toggleTheme()
  expect(storage.getItem(THEME_KEY)).toBe('dark')
})

it('still switches when storage is blocked', () => {
  systemPrefersDark(false)
  vi.spyOn(storage, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  expect(toggleTheme()).toBe('dark')
  expect(document.documentElement.dataset.theme).toBe('dark')
})

it('renders both icons and one labelled button, so SSR and hydration agree', () => {
  systemPrefersDark(false)
  const { container } = render(<ThemeToggle />)
  expect(container.querySelector('.icon-sun')).not.toBeNull()
  expect(container.querySelector('.icon-moon')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /light and dark/ }))
  expect(document.documentElement.dataset.theme).toBe('dark')
})
