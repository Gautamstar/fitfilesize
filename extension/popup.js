const box = document.getElementById('enabled')
chrome.storage.local.get({ enabled: true }).then((s) => (box.checked = s.enabled))
box.addEventListener('change', () => chrome.storage.local.set({ enabled: box.checked }))
document.getElementById('manual').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('fit.html') })
  window.close()
})

// All other sites: Chrome's own prompt grants the permission, and the
// background worker starts or stops checking those sites to match.
const all = document.getElementById('all')
const ALL_SITES = { origins: ['<all_urls>'] }
chrome.permissions.contains(ALL_SITES).then((on) => (all.checked = on))
all.addEventListener('change', async () => {
  const ok = all.checked ? await chrome.permissions.request(ALL_SITES) : await chrome.permissions.remove(ALL_SITES)
  if (!ok) all.checked = !all.checked
})
