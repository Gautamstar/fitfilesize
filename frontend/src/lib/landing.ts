/**
 * Search landing pages: /compress-pdf-to-200kb and friends.
 *
 * Every page is the same app with a target preset and its own copy. The data
 * lives in landing-pages.json because scripts/seo-pages.mjs reads it too, to
 * stamp each page's <title>, meta tags and the sitemap at build time.
 */

import { limitLabel } from './format'
import data from './landing-pages.json'

export interface LandingPage {
  slug: string
  kind: 'pdf' | 'image'
  /**
   * Heading for this page's link under "Common size limits". Pages without
   * one are grouped by kind. Set it when the kind alone would list the same
   * size twice, as with "PNG" pages next to the JPG ones.
   */
  group?: string
  /** The limit as a portal states it: 200 for "200 KB", 1000 for "1 MB". */
  targetKb: number
  heading: string
  description: string
  blurb: string
  /** The page's own section: what fits at this size and how to get there. */
  guide: {
    title: string
    paragraphs: string[]
    tips: string[]
  }
}

export interface FaqItem {
  q: string
  a: string
}

export const LANDING_PAGES = data.pages as LandingPage[]
export const FAQ: FaqItem[] = data.faq

/** The landing page for a URL path, ignoring a trailing slash. */
export function pageForPath(pathname: string): LandingPage | undefined {
  const slug = pathname.replace(/^\/+|\/+$/g, '')
  return LANDING_PAGES.find((p) => p.slug === slug)
}

/**
 * Target in bytes for a page. Portals disagree on whether a KB is 1000 or 1024
 * bytes, so aim under the stricter reading: 200 KB means 200,000 bytes, which
 * passes a check done either way.
 */
export function pageTargetBytes(page: LandingPage): number {
  return page.targetKb * 1000
}

/** Short chip label: "200 KB", "1 MB". */
export function pageSizeLabel(page: LandingPage): string {
  return limitLabel(pageTargetBytes(page))
}

/**
 * Glue a number to its unit ("200 KB", "50 dpi") with a no-break space, so a
 * line never ends on the number and starts the next with the unit.
 */
export function keepUnits(text: string): string {
  return text.replace(/(\d) (KB|MB|dpi|pixels)\b/g, '$1\u00a0$2')
}
