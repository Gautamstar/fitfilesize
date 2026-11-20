/**
 * Whether this browser can install a Chrome Web Store extension: a desktop
 * Chromium browser (Chrome, Edge, Brave, Opera). Phones and tablets cannot,
 * and neither can Safari or Firefox.
 *
 * Only the browser can tell, so this runs after hydration and never in the
 * pre-rendered HTML.
 */

interface UADataLike {
  mobile?: boolean
  platform?: string
  brands?: { brand: string }[]
}

export interface NavigatorLike {
  userAgent: string
  userAgentData?: UADataLike
}

export function canInstallExtension(nav: NavigatorLike): boolean {
  const data = nav.userAgentData
  if (data && Array.isArray(data.brands)) {
    // An Android tablet reports mobile: false, so its platform decides.
    if (data.mobile || /android|ios/i.test(data.platform ?? '')) return false
    return data.brands.some((b) => b.brand === 'Chromium')
  }
  const ua = nav.userAgent
  if (/Android|iPhone|iPad|iPod|Mobile|CriOS|EdgiOS|FxiOS/.test(ua)) return false
  if (/Firefox\//.test(ua)) return false
  return /(Chrome|Chromium|Edg|OPR)\/\d/.test(ua)
}
