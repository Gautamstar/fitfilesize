/**
 * The FitFileSize mark: a page with an arrow settling onto a line, i.e. a file
 * brought down under a limit. Same drawing as public/favicon.svg, but coloured
 * from the theme tokens so it follows light and dark mode.
 */

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="logo-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M11 6.5h7l5.5 5.5v13a1.5 1.5 0 0 1-1.5 1.5H11A1.5 1.5 0 0 1 9.5 25V8A1.5 1.5 0 0 1 11 6.5z" fill="var(--on-accent)" />
      <path d="M18 6.5V11a1 1 0 0 0 1 1h4.5" fill="var(--accent-tint)" />
      <path
        d="M13.25 16.25 16.5 19.5l3.25-3.25M13.25 22.5h6.5"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
