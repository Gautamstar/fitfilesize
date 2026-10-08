import { useEffect, useRef } from 'react'

/**
 * Focus an element when it first appears. Each phase replaces the whole
 * panel, so without this keyboard and screen-reader users are left on
 * <body> with no word of what changed. The element needs tabIndex={-1}.
 */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  return ref
}
