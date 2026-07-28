/**
 * The short explainer under the dropzone.
 *
 * Rendered only in the 'drop' phase. Once a file is in flight the page should
 * be about that file, so App unmounts this.
 */

import { motion } from 'motion/react'
import { fadeUp, inViewProps, stagger } from '../anim'

const STEPS = [
  'Lossless cleanup first, which changes nothing you can see. Often that is enough.',
  'If not, a search over twelve settings finds the gentlest one that fits your target.',
  'If nothing fits, you get the smallest possible file and a clear warning, not a silent failure.',
]

const FORMATS = ['PDF', 'JPEG', 'PNG', 'WebP', 'TIFF', 'BMP']

export function Landing() {
  return (
    <div className="landing">
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
    </div>
  )
}
