/**
 * Everything below the dropzone on a fresh page load.
 *
 * Rendered only in the 'drop' phase. Once a file is in flight the page should
 * be about that file, not about the pitch, so App unmounts this.
 */

import { motion } from 'motion/react'
import { fadeUp, inViewProps, stagger } from '../anim'

const STEPS = [
  {
    title: 'Lossless first',
    body:
      'Structure-only cleanup that changes nothing you can see. PDFs get object ' +
      'streams and unused resources stripped; JPEGs get re-encoded from their ' +
      'existing coefficients, so the pixels come out bit-identical. Often this ' +
      'alone is enough.',
  },
  {
    title: 'Then a search, not a guess',
    body:
      'Still too big means a binary search over twelve settings, from barely ' +
      'touched to heavily downsampled, to find the gentlest one that fits under ' +
      'your target. Twelve options, at most four attempts.',
  },
  {
    title: 'An honest floor',
    body:
      'If nothing fits, you get the smallest achievable file and a clear warning ' +
      'that your target was not reachable. No pretending a 6 MB file is 4 MB.',
  },
]

const LIMITS = [
  { label: 'Immigration portals', value: '4 MB' },
  { label: 'Job applications', value: '5 MB' },
  { label: 'University forms', value: '2 MB' },
  { label: 'Email attachments', value: '25 MB' },
]

export function Landing() {
  return (
    <div className="landing">
      <motion.section className="band" variants={stagger} {...inViewProps}>
        <motion.h2 className="band-title" variants={fadeUp}>
          How it works
        </motion.h2>
        <ol className="steps-grid">
          {STEPS.map((step, i) => (
            <motion.li key={step.title} className="step" variants={fadeUp}>
              <span className="step-num">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="step-title">{step.title}</h3>
              <p className="step-body">{step.body}</p>
            </motion.li>
          ))}
        </ol>
      </motion.section>

      <motion.section className="band" variants={stagger} {...inViewProps}>
        <motion.h2 className="band-title" variants={fadeUp}>
          Why the floor matters
        </motion.h2>
        <motion.p className="pitch" variants={fadeUp}>
          Most compressors hand you a smaller file and call it done. If it is still
          over the limit, that is your problem to discover on the upload page.
        </motion.p>
        <motion.p className="pitch-sub" variants={fadeUp}>
          This one estimates the smallest your file can realistically go before you
          pick a target, marks that region on the slider, and tells you plainly when
          you have asked for something impossible. Knowing a file will not fit is
          more useful than a file that does not fit.
        </motion.p>
      </motion.section>

      <motion.section className="band" variants={stagger} {...inViewProps}>
        <motion.h2 className="band-title" variants={fadeUp}>
          Built for upload limits
        </motion.h2>
        <ul className="limits">
          {LIMITS.map((limit) => (
            <motion.li key={limit.label} className="limit" variants={fadeUp}>
              <span className="limit-value">{limit.value}</span>
              <span className="limit-label">{limit.label}</span>
            </motion.li>
          ))}
        </ul>
      </motion.section>

      <motion.section className="band" variants={stagger} {...inViewProps}>
        <div className="facts">
          <motion.div className="fact" variants={fadeUp}>
            <h3 className="fact-title">Nothing is kept</h3>
            <p className="fact-body">
              Your original is deleted five minutes after the run finishes, the
              compressed file after ten. No account, no sign-in, no tracking.
            </p>
          </motion.div>
          <motion.div className="fact" variants={fadeUp}>
            <h3 className="fact-title">PDFs and images</h3>
            <p className="fact-body">
              PDF, JPEG, PNG, WebP, TIFF and BMP. Photos go through the same search,
              stepping down dimensions and quality instead of page DPI.
            </p>
          </motion.div>
        </div>
      </motion.section>
    </div>
  )
}
