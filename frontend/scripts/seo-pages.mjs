/**
 * Post-build: pre-render every page to real HTML, plus 404, sitemap and robots.
 *
 * Each page runs the same bundle. What differs is its <head> (title,
 * description, canonical, social tags) and its content, which is rendered
 * here by the SSR build of src/entry-server.tsx and put inside #root. Crawlers
 * that do not run JavaScript, and every link preview, then see the page's
 * actual text; in the browser, main.tsx hydrates it.
 *
 * VITE_SITE_URL (e.g. https://fitfilesize.com) makes the canonical, og:url,
 * og:image and sitemap URLs absolute. Without it the pages are still written,
 * but those are skipped, since relative ones are invalid there.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnv } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const ssrDir = join(root, 'dist-ssr')

// loadEnv reads the same .env files Vite does, and real env vars (Vercel's)
// take precedence, so local builds and deploys agree.
const env = loadEnv('production', root, 'VITE_')
const siteUrl = (env.VITE_SITE_URL ?? '').trim().replace(/\/+$/, '')

const { updated, pages, faq } = JSON.parse(
  readFileSync(join(root, 'src/lib/landing-pages.json'), 'utf8'),
)
const base = readFileSync(join(dist, 'index.html'), 'utf8')
const siteName =
  base.match(/<meta\s+name="application-name"\s+content="([^"]*)"/)?.[1] ?? 'FitFileSize'
const homeTitle = base.match(/<title>([^<]*)<\/title>/)?.[1] ?? siteName
const homeDescription = base.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1] ?? ''

const { render } = await import(pathToFileURL(join(ssrDir, 'entry-server.js')).href)

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// "</" inside inline JSON would end the script tag early.
const jsonLd = (obj) =>
  `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`

// The Latin subset of the body font is needed for the first paint of every
// page. Preloading it lets the download start with the HTML instead of after
// the CSS has been fetched and parsed.
const fontFile = readdirSync(join(dist, 'assets')).find((f) =>
  /^plus-jakarta-sans-latin-wght-normal-.*\.woff2$/.test(f),
)
const fontPreload = fontFile
  ? `<link rel="preload" href="/assets/${fontFile}" as="font" type="font/woff2" crossorigin />`
  : ''

function setHead(html, { title, description, extra = [] }) {
  const out = html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
      `<meta name="description" content="${escapeHtml(description)}" />`,
    )
    .replace('</head>', `    ${[fontPreload, ...extra].filter(Boolean).join('\n    ')}\n  </head>`)
  if (!out.includes(`<title>${escapeHtml(title)}</title>`)) {
    throw new Error(`could not set <title> to "${title}"; did index.html change shape?`)
  }
  return out
}

function renderPage({ path, title, description }) {
  const url = siteUrl ? siteUrl + path : ''
  const image = siteUrl ? `${siteUrl}/og.png` : ''
  const extra = [
    url && `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeHtml(siteName)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    url && `<meta property="og:url" content="${url}" />`,
    image && `<meta property="og:image" content="${image}" />`,
    image && `<meta property="og:image:width" content="1200" />`,
    image && `<meta property="og:image:height" content="630" />`,
    image &&
      `<meta property="og:image:alt" content="${escapeHtml(siteName)}: make any file fit the upload limit" />`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
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
    // Mirrors the FAQ the page renders; search engines only honour FAQ
    // markup that matches visible content.
    jsonLd({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map(({ q, a }) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
    }),
  ]

  const body = render(path)
  const html = setHead(base, { title, description, extra }).replace(
    '<div id="root"></div>',
    `<div id="root">${body}</div>`,
  )
  if (!html.includes(body)) throw new Error(`could not fill #root for ${path}`)
  return html
}

writeFileSync(
  join(dist, 'index.html'),
  renderPage({ path: '/', title: homeTitle, description: homeDescription }),
)

for (const page of pages) {
  const dir = join(dist, page.slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'index.html'),
    renderPage({
      path: `/${page.slug}`,
      title: `${page.heading} | Free, no sign-up | ${siteName}`,
      description: page.description,
    }),
  )
}

// A real 404, served by Vercel with a 404 status for any unknown path. Plain
// HTML with the app's stylesheet and no app script: nothing here needs React,
// and hydrating would render the home page over it. noindex keeps it out of
// search results.
const sizeLinks = pages
  .map(
    (p) =>
      `<li><a href="/${p.slug}">${escapeHtml(p.heading.replace(/^Compress an? /, ''))}</a></li>`,
  )
  .join('')
const notFound = setHead(base.replace(/\s*<script type="module"[^>]*><\/script>/g, ''), {
  title: `Page not found | ${siteName}`,
  description: `This page does not exist. ${siteName} compresses a PDF or image to fit any upload limit.`,
  extra: ['<meta name="robots" content="noindex" />'],
}).replace(
  '<div id="root"></div>',
  `<div id="root"><div class="shell">
      <header class="topbar"><a class="brand" href="/"><img src="/favicon.svg" width="28" height="28" alt="" /><span class="brand-name">${escapeHtml(siteName)}</span></a></header>
      <section class="hero"><h1>Page not found</h1><p class="tagline">That address does not exist here. You can compress a file from the <a href="/">home page</a>, or jump to a common size limit:</p></section>
      <ul class="notfound-links">${sizeLinks}</ul>
    </div></div>`,
)
writeFileSync(join(dist, '404.html'), notFound)

const entries = ['/', ...pages.map((p) => `/${p.slug}`), '/privacy.html', '/terms.html']
if (siteUrl) {
  const urls = entries
    .map((p) => `  <url><loc>${siteUrl}${p}</loc><lastmod>${updated}</lastmod></url>`)
    .join('\n')
  writeFileSync(
    join(dist, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  )
}
writeFileSync(
  join(dist, 'robots.txt'),
  `User-agent: *\nAllow: /\n${siteUrl ? `\nSitemap: ${siteUrl}/sitemap.xml\n` : ''}`,
)

// The SSR bundle is only a build tool; nothing serves it.
if (existsSync(ssrDir)) rmSync(ssrDir, { recursive: true })

console.log(
  `seo-pages: pre-rendered home + ${pages.length} landing pages, 404` +
    (siteUrl ? `, sitemap for ${siteUrl}` : ' (VITE_SITE_URL unset: no canonical URLs or sitemap)'),
)
