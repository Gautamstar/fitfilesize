/**
 * A quiet line about the FitFileSize Chrome extension, for browsers that can
 * install it (lib/browser.ts). The server cannot know the browser, so the
 * pre-rendered HTML leaves it out and it appears after hydration, only in
 * places where appearing late moves nothing above it.
 */

import { useSyncExternalStore } from 'react'
import { canInstallExtension } from '../lib/browser'

/** The store listing. */
export const EXTENSION_URL =
  'https://chromewebstore.google.com/detail/eggaonpddehbhjcmckfkgfalnhbkoppi'

const noSubscribe = () => () => {}
const inBrowser = () => canInstallExtension(navigator)
const onServer = () => false

/**
 * True in a desktop Chromium browser. False on the server and during
 * hydration, so the pre-rendered HTML and the first client render match.
 */
function useCanInstallExtension(): boolean {
  return useSyncExternalStore(noSubscribe, inBrowser, onServer)
}

export function ExtensionNote({ where }: { where: 'result' | 'page' }) {
  if (!useCanInstallExtension()) return null
  return (
    <p className={`ext-note ext-note-${where}`}>
      {where === 'result'
        ? 'Filling in a form on a computer? The FitFileSize extension fits a file inside the form’s upload box, using the limit the form states. '
        : 'FitFileSize is also a Chrome extension. It fits a file inside a form’s upload box, using the limit the form states. '}
      <a className="tip-link" href={EXTENSION_URL} target="_blank" rel="noopener">
        Add to Chrome
      </a>
    </p>
  )
}
