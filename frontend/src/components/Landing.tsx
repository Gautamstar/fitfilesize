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
 */

import { motion } from 'motion/react'
import { fadeUp, inViewProps, stagger } from '../anim'
import { FAQ, LANDING_PAGES, pageSizeLabel, type LandingPage } from '../lib/landing'

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

const SIZE_GROUPS = [
  { title: 'PDF', pages: LANDING_PAGES.filter((p) => p.kind === 'pdf') },
  { title: 'Photos and images', pages: LANDING_PAGES.filter((p) => p.kind === 'image') },
]

export function Landing({ page }: { page?: LandingPage }) {
  return (
    <div className="landing">
      <motion.section className="band" variants={stagger} {...inViewProps}>
        <motion.h2 className="band-title" variants={fadeUp}>
          How it works
        </motion.h2>
        <ol className="steps-grid">
          {STEPS.map((step, i) => (
            <motion.li key={step.title} className="step" variants={fadeUp}>
              <span className="step-num">{i + 1}</span>
              <h3 className="step-title">{step.title}</h3>
              <p className="step-body">{step.body}</p>
            </motion.li>
          ))}
        </ol>
      </motion.section>

      <motion.section className="band" variants={stagger} {...inViewProps}>
        <motion.h2 className="band-title" variants={fadeUp}>
          Questions
        </motion.h2>
        <motion.div className="faq" variants={fadeUp}>
          {FAQ.map((item) => (
            <details key={item.q} className="faq-item">
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </motion.div>
      </motion.section>

      <motion.section className="band" variants={stagger} {...inViewProps}>
        <motion.h2 className="band-title" variants={fadeUp}>
          Common size limits
        </motion.h2>
        {SIZE_GROUPS.map((group) => (
          <motion.div key={group.title} className="size-group" variants={fadeUp}>
            <p className="size-group-title">{group.title}</p>
            <ul className="size-links">
              {group.pages.map((p) => (
                <li key={p.slug}>
                  {/* Plain links, not client-side routing: each page is its own
                      prerendered HTML with its own title, which is the point. */}
                  <a href={`/${p.slug}`} aria-current={p.slug === page?.slug ? 'page' : undefined}>
                    {pageSizeLabel(p)}
                  </a>
                </li>
              ))}
            </ul>
          </motion.div>
        ))}
      </motion.section>
    </div>
  )
}
