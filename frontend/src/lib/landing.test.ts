import { describe, expect, it } from 'vitest'
import { presetToSlider, sliderToBytes } from './format'
import { LANDING_PAGES, keepUnits, pageForPath, pageSizeLabel, pageTargetBytes } from './landing'

describe('pageForPath', () => {
  it('finds a landing page with or without a trailing slash', () => {
    expect(pageForPath('/compress-pdf-to-200kb')?.targetKb).toBe(200)
    expect(pageForPath('/compress-pdf-to-200kb/')?.targetKb).toBe(200)
  })

  it('returns nothing for the home page and unknown paths', () => {
    expect(pageForPath('/')).toBeUndefined()
    expect(pageForPath('/nope')).toBeUndefined()
  })
})

describe('landing page data', () => {
  it('has unique slugs that name their own size', () => {
    const slugs = LANDING_PAGES.map((p) => p.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const page of LANDING_PAGES) {
      // The URL and the preset must agree: /…-to-200kb targets 200 KB.
      const label = pageSizeLabel(page).replace(' ', '').toLowerCase()
      expect(page.slug.endsWith(label)).toBe(true)
    }
  })

  it('never lists the same size twice under one link group', () => {
    const seen = new Set<string>()
    for (const page of LANDING_PAGES) {
      const key = `${page.group ?? page.kind} ${page.targetKb}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  it('aims under the stricter kilobyte', () => {
    const page = pageForPath('/compress-pdf-to-200kb')!
    expect(pageTargetBytes(page)).toBe(200_000)
  })
})

describe('presetToSlider', () => {
  it('never lands above the limit, for every page and a range of files', () => {
    for (const page of LANDING_PAGES) {
      const limit = pageTargetBytes(page)
      for (const [lo, hi] of [
        [1024, 50 * 1024 * 1024],
        [Math.floor(limit * 0.4), limit * 3],
        [limit, limit * 1.01],
      ]) {
        const bytes = sliderToBytes(presetToSlider(limit, lo, hi), lo, hi)
        expect(bytes).toBeLessThanOrEqual(limit)
        // And not needlessly far under it: within one slider step.
        expect(bytes).toBeGreaterThan(limit * 0.98)
      }
    }
  })
})

describe('keepUnits', () => {
  it('glues sizes to their units and leaves other spaces alone', () => {
    expect(keepUnits('under 200 KB at 50 dpi, 1 MB or 800 pixels')).toBe(
      'under 200\u00a0KB at 50\u00a0dpi, 1\u00a0MB or 800\u00a0pixels',
    )
  })
})

describe('landing page guides', () => {
  it('gives every page its own guide, so the pages are not near-duplicates', () => {
    const bodies = LANDING_PAGES.map((p) => [...p.guide.paragraphs, ...p.guide.tips].join(' '))
    expect(new Set(bodies).size).toBe(LANDING_PAGES.length)
    for (const page of LANDING_PAGES) {
      expect(page.guide.paragraphs.length).toBeGreaterThan(0)
      expect(page.guide.tips.length).toBeGreaterThan(0)
    }
  })
})
