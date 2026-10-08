/**
 * "Uploading for a form?" search. Each form and size has its own page, set
 * up with that form's limit and pixel size; this finds it by name.
 *
 * Matches are plain links, so the page they open is the pre-rendered one
 * with its own settings, the same as arriving from a search engine. Enter
 * opens the first match.
 */

import { useId, useState } from 'react'
import { findPages } from '../lib/findPages'
import { pageSizeLabel, type LandingPage } from '../lib/landing'

function label(page: LandingPage): string {
  return page.title ?? page.linkLabel ?? page.heading
}

export function FormFinder() {
  const [query, setQuery] = useState('')
  const inputId = useId()
  const listId = useId()
  const matches = findPages(query)
  const typed = query.trim() !== ''

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
        placeholder="IBPS photo, SSC signature, Discord emoji"
        value={query}
        aria-controls={listId}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches[0]) window.location.assign(`/${matches[0].slug}`)
        }}
      />
      <div id={listId} aria-live="polite">
        {typed ? (
          matches.length > 0 ? (
            <ul className="finder-list">
              {matches.map((page) => (
                <li key={page.slug}>
                  <a href={`/${page.slug}`}>
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
