/** Finding a form or size page by name, for the search on the home page. */

import { LANDING_PAGES, type LandingPage } from './landing'

const MAX_MATCHES = 6

function searchText(page: LandingPage): string {
  return [page.title, page.linkLabel, page.heading, page.slug.replace(/-/g, ' ')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

const INDEX = LANDING_PAGES.map((page) => ({ page, text: searchText(page) }))

/** Pages whose name holds every word typed, forms first. */
export function findPages(query: string): LandingPage[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return INDEX.filter(({ text }) => words.every((w) => text.includes(w)))
    .map(({ page }) => page)
    .sort((a, b) => Number(Boolean(b.title)) - Number(Boolean(a.title)))
    .slice(0, MAX_MATCHES)
}
