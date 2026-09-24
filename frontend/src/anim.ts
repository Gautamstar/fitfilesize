// Shared motion presets: small rises, soft easing, quick stagger.
// Kept small so motion supports the content instead of performing.
import type { Variants } from 'motion/react'

export const EASE = [0.22, 1, 0.36, 1] as const

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.55, ease: EASE },
  },
}

export const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07 } },
}

/** Reveal a section the first time it scrolls into view, then leave it alone. */
export const inViewProps = {
  initial: 'hidden' as const,
  whileInView: 'show' as const,
  viewport: { once: true, margin: '-60px' },
}
