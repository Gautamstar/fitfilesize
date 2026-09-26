import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
// Self-hosted rather than from Google Fonts: one less origin to connect to
// before first paint, and one less third party seeing every visit.
import '@fontsource-variable/ibm-plex-sans'
import './index.css'
import App from './App.tsx'
import { warmUp } from './lib/api'

// Outside React so StrictMode's double render cannot send it twice.
warmUp()

const root = document.getElementById('root')!
const app = (
  <StrictMode>
    <App path={window.location.pathname} />
  </StrictMode>
)

// Production pages arrive pre-rendered by scripts/seo-pages.mjs, so React
// attaches to the HTML already there. The dev server serves an empty root.
if (root.hasChildNodes()) {
  hydrateRoot(root, app)
} else {
  createRoot(root).render(app)
}
