/**
 * Light/dark choice, stored per browser. Used by ThemeToggle; the inline
 * script in index.html (and in the privacy and terms pages) reads the same
 * key to apply the choice before first paint.
 */

export const THEME_KEY = 'fitfilesize-theme'

type Theme = 'light' | 'dark'

function currentTheme(): Theme {
  const chosen = document.documentElement.dataset.theme
  if (chosen === 'light' || chosen === 'dark') return chosen
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    // Storage blocked: the choice lasts for this page view only.
  }
  // The browser chrome colour follows the page, not the system, once chosen.
  const page = getComputedStyle(document.documentElement).getPropertyValue('--page').trim()
  if (page) {
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', page))
  }
  return next
}
