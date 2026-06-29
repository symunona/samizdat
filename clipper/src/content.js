// Save to Sam — content script (runs on <all_urls>).
// Single job: recognize a Samizdat instance by its health marker, remember its
// origin, expose an install/pair marker the settings page can read, and receive
// the device token the settings page posts during auto-pair.

(async function () {
  const origin = location.origin
  if (!origin.startsWith('http')) return

  let health
  try {
    const res = await fetch(`${origin}/api/v1/health`, { credentials: 'omit' })
    if (!res.ok) return
    health = await res.json()
  } catch {
    return
  }
  if (!health || health.app !== 'samizdat') return

  // This origin is a Sam instance. Remember it as the server base if we have
  // none yet (v1 is single-instance — first Sam origin wins).
  const stored = await chrome.storage.local.get(['serverBase', 'deviceToken'])
  if (!stored.serverBase) {
    await chrome.storage.local.set({ serverBase: origin })
  }

  const version = chrome.runtime.getManifest().version
  const mark = () => {
    chrome.storage.local.get(['deviceToken']).then(({ deviceToken }) => {
      const paired = deviceToken ? 'paired' : 'unpaired'
      document.documentElement.dataset.samExt = `${version}:${paired}`
    })
  }
  mark()

  // Settings page → extension: receives the freshly minted device token.
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== origin) return
    const d = event.data
    if (!d || d.type !== 'samizdat-extension-token' || !d.token) return
    await chrome.storage.local.set({ serverBase: origin, deviceToken: d.token })
    mark()
    // Ack so the settings page can flip its UI to "connected".
    window.postMessage({ type: 'samizdat-extension-paired' }, origin)
  })

  // Reflect later token changes (e.g. revoke) into the marker.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.deviceToken) mark()
  })
})()
