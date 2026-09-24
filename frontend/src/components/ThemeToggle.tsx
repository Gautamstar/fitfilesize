/**
 * Light/dark switch in the top bar.
 *
 * Until it is clicked the site follows the system setting. A click stores an
 * explicit choice in localStorage and sets data-theme on <html>, which the
 * dark token block in index.css keys on; the inline script in index.html
 * re-applies it before first paint on the next visit.
 *
 * The button holds both icons and CSS shows the right one, rather than React
 * state picking one. The pre-rendered HTML cannot know the visitor's theme,
 * so an icon chosen in render would mismatch on hydration.
 */

import { toggleTheme } from '../lib/theme'

export function ThemeToggle() {
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label="Switch between light and dark mode"
      title="Switch between light and dark mode"
      onClick={() => toggleTheme()}
    >
      {/* Moon: shown in light mode, offers dark. */}
      <svg className="icon-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
      {/* Sun: shown in dark mode, offers light. */}
      <svg className="icon-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </button>
  )
}
