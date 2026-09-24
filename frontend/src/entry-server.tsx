/**
 * Build-time renderer. `vite build --ssr` bundles this for Node, and
 * scripts/seo-pages.mjs calls render() once per page to put the page's real
 * content into its HTML, so crawlers and link previews see text without
 * running any JavaScript. The browser then hydrates it (see main.tsx).
 */

import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import App from './App'

export function render(path: string): string {
  return renderToString(
    <StrictMode>
      <App path={path} />
    </StrictMode>,
  )
}
