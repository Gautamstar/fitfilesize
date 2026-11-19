const box = document.getElementById('enabled')
chrome.storage.local.get({ enabled: true }).then((s) => (box.checked = s.enabled))
box.addEventListener('change', () => chrome.storage.local.set({ enabled: box.checked }))
