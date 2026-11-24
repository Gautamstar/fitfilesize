const box = document.getElementById('enabled')
chrome.storage.local.get({ enabled: true }).then((s) => (box.checked = s.enabled))
box.addEventListener('change', () => chrome.storage.local.set({ enabled: box.checked }))
document.getElementById('manual').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('fit.html') })
  window.close()
})

const { sitePattern, isBuiltIn } = globalThis.FitFileSizeSites
const all = document.getElementById('all')
const ALL_SITES = { origins: ['<all_urls>'] }

// Chrome's own prompt grants a site; the background worker then starts
// checking it, including pages already open there.
all.addEventListener('change', async () => {
  const ok = all.checked ? await chrome.permissions.request(ALL_SITES) : await chrome.permissions.remove(ALL_SITES)
  if (!ok) all.checked = !all.checked
  showSite()
})

// This site: the tab the popup was opened on (activeTab lets the popup see its address).
const site = document.getElementById('site')
const thisSite = document.getElementById('this-site')
const note = document.getElementById('site-note')
let pattern = null

async function showSite() {
  const everySite = await chrome.permissions.contains(ALL_SITES)
  all.checked = everySite
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  pattern = sitePattern(tab?.url)
  if (!pattern) return (site.hidden = true)
  document.getElementById('host').textContent = new URL(tab.url).hostname
  site.hidden = false
  const builtIn = isBuiltIn(tab.url, chrome.runtime.getManifest().content_scripts[0].matches)
  if (builtIn || everySite) {
    thisSite.checked = true
    thisSite.disabled = true
    note.textContent = builtIn ? 'This site is checked from the start.' : 'Checked, because "Also on all other sites" is on.'
    return
  }
  thisSite.disabled = false
  thisSite.checked = await chrome.permissions.contains({ origins: [pattern] })
  note.textContent = 'Chrome asks for permission to read pages on this one site. It is used only to find the limit next to an upload box.'
}

thisSite.addEventListener('change', async () => {
  const origins = { origins: [pattern] }
  const ok = thisSite.checked ? await chrome.permissions.request(origins) : await chrome.permissions.remove(origins)
  if (!ok) thisSite.checked = !thisSite.checked
})

showSite()
