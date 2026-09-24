/**
 * Post-build: one HTML file per search landing page, plus sitemap and robots.
 *
 * Every landing page runs the same bundle; what differs is the <head>. Search
 * engines rank a page on its title, description and canonical URL, and most
 * link previews never run JavaScript, so those have to be in the HTML itself
 * rather than set by React after load. This copies dist/index.html to
 * dist/<slug>/index.html with the head rewritten for that page.
 *
 * VITE_SITE_URL (e.g. https://fitfilesize.com) makes the canonical, og:url and
 * sitemap URLs absolute. Without it the pages are still written, but those
 * three are skipped, since a relative canonical or sitemap entry is invalid.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

// loadEnv reads the same .env files Vite does, and real env vars (Vercel's)
// take precedence, so local builds and deploys agree.
const env = loadEnv('production', root, 'VITE_')
const siteUrl = (env.VITE_SITE_URL ?? '').trim().replace(/\/+$/, '')

const { pages, faq } = JSON.parse(
  readFileSync(join(root, 'src/lib/landing-pages.json'), 'utf8'),
)
const base = readFileSync(join(dist, 'index.html'), 'utf8')
const siteName =
  base.match(/<meta\s+name="application-name"\s+content="([^"]*)"/)?.[1] ?? 'FitFileSize'
const homeTitle = base.match(/<title>([^<]*)<\/title>/)?.[1] ?? siteName

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// "</" inside inline JSON would end the script tag early.
const jsonLd = (obj) =>
  `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`

function render({ path, title, description }) {
  const url = siteUrl ? siteUrl + path : ''
  const tags = [
    url && `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeHtml(siteName)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    url && `<meta property="og:url" content="${url}" />`,
    `<meta name="twitter:card" content="summary" />`,
    jsonLd({
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: siteName,
      ...(url && { url }),
      description,
      applicationCategory: 'UtilitiesApplication',
      operatingSystem: 'Any',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    }),
    // Mirrors the FAQ the page renders; Google only honours FAQ markup that
    // matches visible content.
    jsonLd({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map(({ q, a }) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
    }),
  ].filter(Boolean)

  const html = base
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
      `<meta name="description" content="${escapeHtml(description)}" />`,
    )
    .replace('</head>', `    ${tags.join('\n    ')}\n  </head>`)

  if (html.includes(`<title>${escapeHtml(title)}</title>`) === false) {
    throw new Error(`could not set <title> for ${path}; did index.html change shape?`)
  }
  return html
}

const homeDescription =
  base.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1] ?? ''
writeFileSync(
  join(dist, 'index.html'),
  render({ path: '/', title: homeTitle, description: homeDescription }),
)

for (const page of pages) {
  const dir = join(dist, page.slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'index.html'),
    render({
      path: `/${page.slug}`,
      title: `${page.heading} | Free, no sign-up | ${siteName}`,
      description: page.description,
    }),
  )
}

const paths = ['/', ...pages.map((p) => `/${p.slug}`), '/privacy.html', '/terms.html']
if (siteUrl) {
  const urls = paths.map((p) => `  <url><loc>${siteUrl}${p}</loc></url>`).join('\n')
  writeFileSync(
    join(dist, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  )
}
writeFileSync(
  join(dist, 'robots.txt'),
  `User-agent: *\nAllow: /\n${siteUrl ? `\nSitemap: ${siteUrl}/sitemap.xml\n` : ''}`,
)

console.log(
  `seo-pages: wrote ${pages.length} landing pages` +
    (siteUrl ? `, sitemap for ${siteUrl}` : ' (VITE_SITE_URL unset: no canonical URLs or sitemap)'),
)
