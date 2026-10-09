/**
 * "Uploading for a form?" search. Each form and size has its own page, set
 * up with that form's limit and pixel size; this finds it by name.
 *
 * Matches are plain links, so the page they open is the pre-rendered one
 * with its own settings, the same as arriving from a search engine. Enter
 * opens the first match.
 */

import { useId, useRef, useState } from 'react'
import { findPages } from '../lib/findPages'
import { pageSizeLabel, type LandingPage } from '../lib/landing'

function label(page: LandingPage): string {
  return page.title ?? page.linkLabel ?? page.heading
}

export function FormFinder() {
  const [query, setQuery] = useState('')
  const inputId = useId()
  const listId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const matches = findPages(query)
  const typed = query.trim() !== ''

  // Arrow keys move between the input and the matches, as in a list of
  // suggestions; Tab still works as for any links.
  const links = () => [...(listRef.current?.querySelectorAll('a') ?? [])]
  const move = (from: number, by: number) => {
    const all = links()
    const next = from + by
    if (next < 0) document.getElementById(inputId)?.focus()
    else all[Math.min(next, all.length - 1)]?.focus()
  }

  return (
    <div className="finder">
      <label className="finder-label" htmlFor={inputId}>
        Uploading for a form?
      </label>
      <input
        id={inputId}
        className="finder-input"
        type="search"
        autoComplete="off"
        enterKeyHint="go"
        placeholder="IBPS photo, Discord emoji"
        value={query}
        aria-controls={listId}
        aria-describedby={`${listId}-count`}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches[0]) window.location.assign(`/${matches[0].slug}`)
          if (e.key === 'ArrowDown' && matches.length > 0) {
            e.preventDefault()
            move(-1, 1)
          }
        }}
      />
      {/* Only the count is announced: re-reading every match on each key
          press drowns out the typing. */}
      <p id={`${listId}-count`} className="sr-only" aria-live="polite">
        {typed ? `${matches.length} ${matches.length === 1 ? 'page' : 'pages'} found` : ''}
      </p>
      <div id={listId}>
        {typed ? (
          matches.length > 0 ? (
            <ul className="finder-list" ref={listRef}>
              {matches.map((page, i) => (
                <li key={page.slug}>
                  <a
                    href={`/${page.slug}`}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        move(i, e.key === 'ArrowDown' ? 1 : -1)
                      }
                    }}
                  >
                    <span>{label(page)}</span>
                    <span className="finder-spec">
                      {page.spec ? page.spec.join(' · ') : pageSizeLabel(page)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="finder-none">
              No page for that yet. Drop the file below and pick the limit the form gives.
            </p>
          )
        ) : null}
      </div>
    </div>
  )
}
