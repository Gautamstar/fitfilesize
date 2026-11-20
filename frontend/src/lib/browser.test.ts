import { describe, expect, it } from 'vitest'
import { canInstallExtension } from './browser'

const UA = {
  desktopChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  desktopEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  desktopFirefox:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
  desktopSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
}

const brands = (...names: string[]) => names.map((brand) => ({ brand }))

describe('canInstallExtension, from the user agent string', () => {
  it('says yes for desktop Chrome', () => {
    expect(canInstallExtension({ userAgent: UA.desktopChrome })).toBe(true)
  })
  it('says yes for desktop Edge', () => {
    expect(canInstallExtension({ userAgent: UA.desktopEdge })).toBe(true)
  })
  it('says no for Android Chrome', () => {
    expect(canInstallExtension({ userAgent: UA.androidChrome })).toBe(false)
  })
  it('says no for iPhone Safari', () => {
    expect(canInstallExtension({ userAgent: UA.iphoneSafari })).toBe(false)
  })
  it('says no for desktop Firefox and Safari', () => {
    expect(canInstallExtension({ userAgent: UA.desktopFirefox })).toBe(false)
    expect(canInstallExtension({ userAgent: UA.desktopSafari })).toBe(false)
  })
})

describe('canInstallExtension, from userAgentData', () => {
  it('says yes for desktop Chrome and Edge', () => {
    expect(
      canInstallExtension({
        userAgent: UA.desktopChrome,
        userAgentData: {
          mobile: false,
          platform: 'macOS',
          brands: brands('Google Chrome', 'Chromium'),
        },
      }),
    ).toBe(true)
    expect(
      canInstallExtension({
        userAgent: UA.desktopEdge,
        userAgentData: {
          mobile: false,
          platform: 'Windows',
          brands: brands('Microsoft Edge', 'Chromium'),
        },
      }),
    ).toBe(true)
  })
  it('says no for Android Chrome, phone or tablet', () => {
    for (const mobile of [true, false]) {
      expect(
        canInstallExtension({
          userAgent: UA.androidChrome,
          userAgentData: { mobile, platform: 'Android', brands: brands('Google Chrome', 'Chromium') },
        }),
      ).toBe(false)
    }
  })
})
