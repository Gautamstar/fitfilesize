/**
 * Tell search engines that use IndexNow (Bing, Yandex, Seznam, Naver) which
 * pages a merge added or changed, once the site serves them.
 *
 *   node scripts/indexnow.mjs <base-commit>   pages that differ from that commit
 *   node scripts/indexnow.mjs --all           every page in the sitemap
 *
 * Run by .github/workflows/indexnow.yml after a push to main. Vercel deploys
 * the same push on its own, so each page is fetched until it carries its new
 * description before anything is sent: a search engine that crawls at once
 * then sees the new page, not the old one.
 *
 * The key is public by design: IndexNow checks that it is served at
 * https://fitfilesize.com/<key>.txt, which proves the request comes from
 * whoever controls the site.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const KEY = 'b5341fa4ab09bd6765c92b2465d50e07'
const SITE = 'https://fitfilesize.com'
const DATA = 'frontend/src/lib/landing-pages.json'
const WAIT_MS = 15 * 60 * 1000
const POLL_MS = 20 * 1000

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..')

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Pages that are new or differ in any field since `base`. */
export function changedPages(before, after) {
  const old = new Map(before.map((p) => [p.slug, JSON.stringify(p)]))
  return after.filter((p) => old.get(p.slug) !== JSON.stringify(p))
}

function pagesAt(commit) {
  try {
    return JSON.parse(execFileSync('git', ['show', `${commit}:${DATA}`], { cwd: repo })).pages
  } catch {
    return [] // the file did not exist then: every page is new
  }
}

/** True once the live page carries this description, i.e. the new build is out. */
async function isLive(page) {
  try {
    const res = await fetch(`${SITE}/${page.slug}`, { redirect: 'manual' })
    return res.ok && (await res.text()).includes(`content="${escapeHtml(page.description)}"`)
  } catch {
    return false
  }
}

async function waitForDeploy(pages) {
  const deadline = Date.now() + WAIT_MS
  let waiting = pages
  while (waiting.length > 0 && Date.now() < deadline) {
    const live = await Promise.all(waiting.map(isLive))
    waiting = waiting.filter((_, i) => !live[i])
    if (waiting.length > 0) await new Promise((r) => setTimeout(r, POLL_MS))
  }
  return waiting
}

async function main() {
  const arg = process.argv[2]
  if (!arg) throw new Error('usage: indexnow.mjs <base-commit> | --all')
  const current = JSON.parse(readFileSync(join(repo, DATA), 'utf8')).pages

  let urls
  if (arg === '--all') {
    const sitemap = await (await fetch(`${SITE}/sitemap.xml`)).text()
    urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
  } else {
    const pages = changedPages(pagesAt(arg), current)
    if (pages.length === 0) {
      console.log('indexnow: no page changed')
      return
    }
    const late = await waitForDeploy(pages)
    if (late.length > 0) console.log(`indexnow: still old after 15 min: ${late.map((p) => p.slug).join(', ')}`)
    urls = pages.map((p) => `${SITE}/${p.slug}`)
  }

  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: new URL(SITE).host,
      key: KEY,
      keyLocation: `${SITE}/${KEY}.txt`,
      urlList: urls,
    }),
  })
  // 200 and 202 both mean accepted; anything else is worth failing the run for.
  console.log(`indexnow: ${res.status} for ${urls.length} URLs`)
  for (const u of urls) console.log(`  ${u}`)
  if (res.status !== 200 && res.status !== 202) {
    throw new Error(`IndexNow answered ${res.status}: ${await res.text()}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
