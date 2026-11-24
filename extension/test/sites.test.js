const test = require('node:test')
const assert = require('node:assert/strict')
const { sitePattern, isBuiltIn, sitesPlan } = require('../sites.js')
const manifest = require('../manifest.json')

const builtIn = manifest.content_scripts[0].matches
const API = 'https://api.fitfilesize.com/*'

test('one site is allowed by its host name, on http and https', () => {
  assert.equal(sitePattern('https://www.naukri.com/jobs/apply?id=4'), '*://www.naukri.com/*')
  assert.equal(sitePattern('http://localhost:8765/form.html'), '*://localhost/*')
})

test('pages that cannot be allowed have no pattern', () => {
  for (const url of ['chrome://extensions/', 'chrome-extension://abc/fit.html', 'file:///tmp/a.html', 'about:blank', '', undefined]) {
    assert.equal(sitePattern(url), null, String(url))
  }
})

test('built-in sites are recognised, including subdomains', () => {
  assert.ok(isBuiltIn('https://ibpsonline.ibps.in/crpcsaxvjun26/', builtIn))
  assert.ok(isBuiltIn('https://ssc.gov.in/login', builtIn))
  assert.ok(isBuiltIn('https://cdn.digialm.com/EForms/page', builtIn))
  assert.ok(!isBuiltIn('https://www.naukri.com/', builtIn))
  assert.ok(!isBuiltIn('https://notgov.in.example.com/', builtIn))
  assert.ok(!isBuiltIn('chrome://extensions/', builtIn))
})

test('nothing extra is registered when only the built-in sites and the API are granted', () => {
  assert.equal(sitesPlan([API, ...builtIn], builtIn), null)
  assert.equal(sitesPlan([], builtIn), null)
})

test('each allowed site is registered, once', () => {
  const plan = sitesPlan([API, ...builtIn, '*://www.naukri.com/*', '*://ircc.canada.ca/*', '*://www.naukri.com/*'], builtIn)
  assert.deepEqual(plan, { matches: ['*://ircc.canada.ca/*', '*://www.naukri.com/*'] })
})

test('the website is never registered, even when allowed', () => {
  assert.equal(sitesPlan(['*://fitfilesize.com/*', '*://www.fitfilesize.com/*'], builtIn), null)
})

test('allowing every site registers one script that skips the built-in sites and the website', () => {
  const plan = sitesPlan([API, '<all_urls>', '*://www.naukri.com/*'], builtIn)
  assert.deepEqual(plan.matches, ['<all_urls>'])
  for (const pattern of builtIn) assert.ok(plan.excludeMatches.includes(pattern))
  assert.ok(plan.excludeMatches.includes('*://fitfilesize.com/*'))
})
