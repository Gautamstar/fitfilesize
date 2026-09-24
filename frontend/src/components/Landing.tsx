/**
 * The short explainer under the dropzone.
 *
 * Rendered only in the 'drop' phase. Once a file is in flight the page should
 * be about that file, so App unmounts this.
 *
 * On a search landing page (/compress-pdf-to-200kb) it leads with that page's
 * own copy. The FAQ and the size links are there for both people and search
 * engines: the links are how a crawler finds every landing page from any one.
 */

import { motion } from 'motion/react'
import { fadeUp, inViewProps, stagger } from '../anim'
import { FAQ, LANDING_PAGES, pageSizeLabel, type LandingPage } from '../lib/landing'

const STEPS = [
  'We start with a cleanup that shrinks the file without changing how it looks. Often that is enough on its own.',
  'If it needs more, we try twelve quality settings and give you the gentlest one that still fits your size.',
]

const FORMATS = ['PDF', 'JPEG', 'PNG', 'WebP', 'TIFF', 'BMP']

const SIZE_GROUPS = [
  { title: 'PDF', pages: LANDING_PAGES.filter((p) => p.kind === 'pdf') },
  { title: 'Photos and images', pages: LANDING_PAGES.filter((p) => p.kind === 'image') },
]

export function Landing({ page }: { page?: LandingPage }) {
  return (
    <div className="landing">
      {page ? (
        <motion.section className="band" variants={stagger} {...inViewProps}>
          <motion.p className="band-lede" variants={fadeUp}>
            {page.blurb}
          </motion.p>
        </motion.section>
      ) : null}

      <motion.section className="band" variants={stagger} {...inViewProps}>
        <motion.h2 className="band-title" variants={fadeUp}>
          How it works
        </motion.h2>
        <ol className="steps-grid">
          {STEPS.map((step, i) => (
            <motion.li key={step} className="step" variants={fadeUp}>
              <span className="step-num">{String(i + 1).padStart(2, '0')}</span>
              <p className="step-body">{step}</p>
            </motion.li>
          ))}
        </ol>
      </motion.section>

      <motion.section className="band" variants={stagger} {...inViewProps}>
        <motion.h2 className="band-title" variants={fadeUp}>
          Supported formats
        </motion.h2>
        <motion.ul className="formats" variants={fadeUp}>
          {FORMATS.map((format) => (
            <li key={format}>{format}</li>
          ))}
        </motion.ul>
      </motion.section>

      <motion.section className="band" variants={stagger} {...inViewProps}>
        <motion.h2 className="band-title" variants={fadeUp}>
          Questions
        </motion.h2>
        <dl className="faq">
          {FAQ.map((item) => (
            <motion.div key={item.q} className="faq-item" variants={fadeUp}>
              <dt>{item.q}</dt>
              <dd>{item.a}</dd>
            </motion.div>
          ))}
        </dl>
      </motion.section>

      <motion.section className="band" variants={stagger} {...inViewProps}>
        <motion.h2 className="band-title" variants={fadeUp}>
          Common size limits
        </motion.h2>
        {SIZE_GROUPS.map((group) => (
          <motion.div key={group.title} className="size-group" variants={fadeUp}>
            <p className="size-group-title">{group.title}</p>
            <ul className="formats">
              {group.pages.map((p) => (
                <li key={p.slug} className={p.slug === page?.slug ? 'current' : undefined}>
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
