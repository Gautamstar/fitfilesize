/**
 * Which sites the checker runs on beyond the built-in ones: every site the
 * person has allowed, one at a time from the popup, or all of them at once.
 * Shared by the background worker and the popup; plain functions so they can
 * be tested in Node.
 */
;(function (root) {
  const OWN = ['*://fitfilesize.com/*', '*://*.fitfilesize.com/*']
  const EVERY_SITE = ['<all_urls>', '*://*/*']

  /** The match pattern that allows one site, or null for pages that cannot have one. */
  function sitePattern(url) {
    let u
    try {
      u = new URL(url)
    } catch {
      return null
    }
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return null
    return `*://${u.hostname}/*`
  }

  /** Whether a page's host is covered by a pattern like "*://*.gov.in/*" or "*://example.com/*". */
  function hostMatches(url, pattern) {
    let host
    try {
      host = new URL(url).hostname
    } catch {
      return false
    }
    const m = /^\*:\/\/(\*\.)?([^/]+)\/\*$/.exec(pattern)
    if (!m) return false
    return host === m[2] || (Boolean(m[1]) && host.endsWith(`.${m[2]}`))
  }

  /** Whether the checker runs on this page without any permission from the person. */
  function isBuiltIn(url, builtIn) {
    return builtIn.some((pattern) => hostMatches(url, pattern))
  }

  /**
   * The content script to register for the sites the person allowed, from the
   * origins Chrome says are granted; null when there are none beyond the
   * built-in sites.
   */
  function sitesPlan(granted, builtIn) {
    const skip = new Set([...builtIn, ...OWN])
    if (granted.some((o) => EVERY_SITE.includes(o))) {
      // The built-in sites already have it, and the website does this itself.
      return { matches: ['<all_urls>'], excludeMatches: [...builtIn, ...OWN] }
    }
    const extra = granted.filter((o) => !skip.has(o) && !/fitfilesize\.com\//.test(o))
    return extra.length ? { matches: [...new Set(extra)].sort() } : null
  }

  const api = { sitePattern, hostMatches, isBuiltIn, sitesPlan, EVERY_SITE }
  root.FitFileSizeSites = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
