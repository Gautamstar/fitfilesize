/**
 * The explainer under the dropzone.
 *
 * Rendered only in the 'drop' phase. Once a file is in flight the page should
 * be about that file, so App unmounts this.
 *
 * The FAQ and the size links are there for both people and search engines:
 * the links are how a crawler finds every landing page from any one, and the
 * FAQ answers are in the DOM even while collapsed, matching the FAQPage markup
 * scripts/seo-pages.mjs puts in the head.
 *
 * No scroll-in animation here: these sections are pre-rendered, and anything
 * that starts at opacity 0 is invisible until JavaScript runs, which is the
 * wrong trade for the text search engines and link previews read.
 */

import { useEffect, useRef } from 'react'
import {
  PAGE_GROUPS,
  keepUnits,
  pageFaq,
  pageSizeLabel,
  relatedLinks,
  type LandingPage,
} from '../lib/landing'

/**
 * The three steps, as they go on this page. A page set up for a form or a
 * size has its limit chosen already, so step 2 says so rather than asking
 * the visitor to pick what the page has picked.
 */
function steps(page?: LandingPage) {
  const what = !page
    ? 'A PDF or an image'
    : page.kind === 'pdf'
      ? 'Your PDF'
      : page.group === 'Discord' || page.group === 'GIF'
        ? 'Your GIF or image'
        : 'Your photo or image'
  const second = !page
    ? {
        title: 'Pick your limit',
        body: 'Choose the size the form asks for. We start with a cleanup that changes nothing you can see.',
      }
    : page.spec
      ? {
          title: 'Check the settings',
          body: `This page is set to the ${page.title ?? 'form'} rules. Change them only if yours are different.`,
        }
      : {
          title: 'Check the limit',
          body: `This page is set to ${pageSizeLabel(page)}. Pick another limit if yours is different.`,
        }
  return [
    {
      title: 'Drop your file',
      body: `${what}. It goes over an encrypted connection and nowhere else.`,
    },
    second,
    {
      title: 'Download it',
      body: 'We find the gentlest setting that still fits, and delete everything soon after.',
    },
  ]
}

/** "2026-09-26" as "26 September 2026", the same in every time zone. */
function checkedOn(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const month = new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-GB', {
    month: 'long',
    timeZone: 'UTC',
  })
  return `${d} ${month} ${y}`
}

export function Landing({ page }: { page?: LandingPage }) {
  const related = relatedLinks(page)
  // A form page's spec and own questions say what the steps would.
  const form = Boolean(page?.source)
  // Other pages link to the full list on the home page; open it on arrival.
  const allPages = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (!page && window.location.hash === '#all-pages' && allPages.current) {
      allPages.current.open = true
    }
  }, [page])
  return (
    <div className="landing">
      {/* The one section that differs per page. Everything below is shared,
          so without this Google sees near-duplicates and may index only one. */}
      {page ? (
        <section className="band guide">
          <h2 className="band-title">{page.guide.title}</h2>
          {page.pixels ? <SizeFigure page={page} /> : null}
          {page.guide.paragraphs.map((text) => (
            <p key={text} className="guide-body">
              {keepUnits(text)}
            </p>
          ))}
          <h3 className="guide-tips-title">Tips</h3>
          <ul className="guide-tips">
            {page.guide.tips.map((tip) => (
              <li key={tip}>{keepUnits(tip)}</li>
            ))}
          </ul>
          {page.source ? (
            // Forms change their rules; say where these came from and when.
            <p className="guide-source">
              Requirements from{' '}
              <a href={page.source.url} rel="noopener" target="_blank">
                {page.source.label}
              </a>
              , checked {checkedOn(page.source.checked)}.{' '}
              {page.group === 'Discord'
                ? 'Discord can change its limits, so check its help page if an upload is refused.'
                : 'Forms change their rules, so check the form itself if something is rejected.'}
            </p>
          ) : null}
        </section>
      ) : null}

      {form ? null : (
        <section className="band">
          <h2 className="band-title">How it works</h2>
          <ol className="steps-grid">
            {steps(page).map((step, i) => (
              <li key={step.title} className="step">
                <span className="step-num">{i + 1}</span>
                <h3 className="step-title">{step.title}</h3>
                <p className="step-body">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="band">
        <h2 className="band-title">Questions</h2>
        <div className="faq">
          {pageFaq(page).map((item) => (
            <details key={item.q} className="faq-item">
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="band">
        {related.pages.length ? (
          <>
            <h2 className="band-title">{related.title}</h2>
            {related.group ? <p className="size-group-title">{related.group}</p> : null}
            <PageLinks pages={related.pages} />
          </>
        ) : null}
        {page ? (
          // The full list lives once, on the home page: repeated on every
          // page it was most of each page's text. The sitemap lists them all.
          <p className="all-pages-link">
            <a href="/#all-pages">All sizes and forms</a>
          </p>
        ) : (
          <div className="faq all-pages" id="all-pages">
            <details className="faq-item" ref={allPages}>
              <summary>All pages</summary>
              <div className="all-pages-body">
                {PAGE_GROUPS.map((group) => (
                  <div key={group.title} className="size-group">
                    <p className="size-group-title">{group.title}</p>
                    <PageLinks pages={group.pages} />
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}
      </section>
    </div>
  )
}

function PageLinks({ pages, current }: { pages: LandingPage[]; current?: string }) {
  return (
    <ul className="size-links">
      {pages.map((p) => (
        <li key={p.slug}>
          {/* Plain links, not client-side routing: each page is its own
              prerendered HTML with its own title, which is the point. */}
          <a href={`/${p.slug}`} aria-current={p.slug === current ? 'page' : undefined}>
            {p.linkLabel ?? pageSizeLabel(p)}
          </a>
        </li>
      ))}
    </ul>
  )
}

/**
 * The form's exact pixel size drawn to scale, so its shape (tall photo, wide
 * signature) is plain before the crop box shows it.
 */
function SizeFigure({ page }: { page: LandingPage }) {
  const { width, height } = page.pixels!
  const scale = 120 / Math.max(width, height)
  const w = Math.round(width * scale)
  const h = Math.round(height * scale)
  return (
    <figure className="size-figure">
      <svg width={w + 2} height={h + 2} viewBox={`0 0 ${w + 2} ${h + 2}`} aria-hidden="true">
        <rect x="1" y="1" width={w} height={h} rx="3" />
      </svg>
      <figcaption>
        {width} × {height} pixels
        {page.minKb
          ? `, ${page.minKb} KB to ${page.targetKb} KB`
          : `, up to ${pageSizeLabel(page)}`}
      </figcaption>
    </figure>
  )
}
