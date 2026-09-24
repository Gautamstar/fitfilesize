/**
 * Tip link to a Stripe Payment Link.
 *
 * The URL comes from VITE_TIP_URL at build time. Unset means no link anywhere,
 * so the component can sit in the tree before the Stripe side exists.
 */

import type { ReactNode } from 'react'

const TIP_URL = (import.meta.env.VITE_TIP_URL ?? '').trim()

/** For callers that wrap the link in copy, which must vanish along with it. */
export const TIP_ENABLED = TIP_URL !== ''

export function TipLink({ children }: { children: ReactNode }) {
  if (!TIP_URL) return null
  return (
    <a className="tip-link" href={TIP_URL} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}
