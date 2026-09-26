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

import { FAQ, LANDING_PAGES, keepUnits, pageSizeLabel, type LandingPage } from '../lib/landing'

const STEPS = [
  {
    title: 'Drop your file',
    body: 'A PDF or an image. It goes over an encrypted connection and nowhere else.',
  },
  {
    title: 'Pick your limit',
    body: 'Choose the size the form asks for. We start with a cleanup that changes nothing you can see.',
  },
  {
    title: 'Download it',
    body: 'If it needs more, we find the gentlest quality setting that still fits, and delete everything soon after.',
  },
]

const KIND_GROUP = { pdf: 'PDF', image: 'Photos and images' }

// In the order the groups first appear in the page data.
const SIZE_GROUPS = [...new Set(LANDING_PAGES.map(groupOf))].map((title) => ({
  title,
  pages: LANDING_PAGES.filter((p) => groupOf(p) === title),
}))

function groupOf(page: LandingPage): string {
  return page.group ?? KIND_GROUP[page.kind]
}

/** "2026-09-26" as "26 September 2026", the same in every time zone. */
function checkedOn(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const month = new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })
  return `${d} ${month} ${y}`
}

export function Landing({ page }: { page?: LandingPage }) {
  return (
    <div className="landing">
      {/* The one section that differs per page. Everything below is shared,
          so without this Google sees near-duplicates and may index only one. */}
      {page ? (
        <section className="band guide">
          <h2 className="band-title">{page.guide.title}</h2>
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
              , checked {checkedOn(page.source.checked)}. Forms change their rules, so check the
              form itself if something is rejected.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="band">
        <h2 className="band-title">
          How it works
        </h2>
        <ol className="steps-grid">
          {STEPS.map((step, i) => (
            <li key={step.title} className="step">
              <span className="step-num">{i + 1}</span>
              <h3 className="step-title">{step.title}</h3>
              <p className="step-body">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="band">
        <h2 className="band-title">
          Questions
        </h2>
        <div className="faq">
          {FAQ.map((item) => (
            <details key={item.q} className="faq-item">
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="band">
        <h2 className="band-title">
          Common size limits
        </h2>
        {SIZE_GROUPS.map((group) => (
          <div key={group.title} className="size-group">
            <p className="size-group-title">{group.title}</p>
            <ul className="size-links">
              {group.pages.map((p) => (
                <li key={p.slug}>
                  {/* Plain links, not client-side routing: each page is its own
                      prerendered HTML with its own title, which is the point. */}
                  <a href={`/${p.slug}`} aria-current={p.slug === page?.slug ? 'page' : undefined}>
                    {p.linkLabel ?? pageSizeLabel(p)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  )
}
