// Save to Sam — service worker.
// Tracks, per tab, whether the active URL is already a Document on each
// connected Samizdat instance, flips the toolbar icon, and badges the instance
// count when more than one is connected. Saving + polling lives here (outlives
// the popup); the popup only triggers it and renders the dropdown.

importScripts('instances.js')
const { API, getInstances, cmpVersion } = globalThis.SamInstances

const ICONS = {
  off: iconSet('sam-off'),
  normal: iconSet('sam'),
  check: iconSet('sam-check'),
}

function iconSet(name) {
  return {
    16: `icons/${name}-16.png`,
    32: `icons/${name}-32.png`,
    48: `icons/${name}-48.png`,
    128: `icons/${name}-128.png`,
  }
}

// tabId -> { perOrigin: { [origin]: {state, docId} } }
const tabState = new Map()

function isHttp(url) {
  return !!url && (url.startsWith('http://') || url.startsWith('https://'))
}

async function setIcon(tabId, key, title) {
  try {
    await chrome.action.setIcon({ tabId, path: ICONS[key] })
    if (title) await chrome.action.setTitle({ tabId, title })
  } catch { /* tab gone */ }
}

async function setBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeText({ tabId, text: text || '' })
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: color || '#555' })
  } catch { /* tab gone */ }
}

// Resting badge = instance count when >1 connected, else nothing.
function restingBadge(count) {
  return count > 1 ? String(count) : ''
}

// GET /documents/by-url — returns the Document or null (404). Throws otherwise.
async function lookup(origin, token, url) {
  const res = await fetch(`${origin}${API}/documents/by-url?url=${encodeURIComponent(url)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`by-url ${res.status}`)
  return res.json()
}

// Probe the active URL against every connected instance, update icon + badge.
async function checkTab(tabId, url) {
  const instances = await getInstances()
  const count = instances.length

  if (count === 0) {
    tabState.delete(tabId)
    await setIcon(tabId, 'off', 'Save to Sam — open your Sam to connect')
    await setBadge(tabId, '')
    return
  }
  if (!isHttp(url)) {
    tabState.delete(tabId)
    await setIcon(tabId, 'off', 'Save to Sam')
    await setBadge(tabId, restingBadge(count))
    return
  }

  const perOrigin = {}
  let anySaved = false
  await Promise.all(instances.map(async (inst) => {
    try {
      const doc = await lookup(inst.origin, inst.token, url)
      if (doc) {
        perOrigin[inst.origin] = { state: 'saved', docId: doc.id }
        anySaved = true
      } else {
        perOrigin[inst.origin] = { state: 'not_saved' }
      }
    } catch {
      perOrigin[inst.origin] = { state: 'error' }
    }
  }))
  tabState.set(tabId, { perOrigin })

  if (anySaved) await setIcon(tabId, 'check', 'Open in Sam')
  else await setIcon(tabId, 'normal', 'Save to Sam')
  await setBadge(tabId, restingBadge(count))
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function showToast(tabId, text) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'sam-toast', text })
  } catch { /* no content script on this page */ }
}

// POST /jobs scrape_url to one instance, poll by-url, toast the page on success.
async function save(origin, token, tabId, url) {
  const instances = await getInstances()
  const count = instances.length

  await setIcon(tabId, 'normal', 'Saving to Sam…')
  await setBadge(tabId, '…', '#d64541')

  try {
    const res = await fetch(`${origin}${API}/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'scrape_url', url }),
    })
    if (res.status !== 202 && !res.ok) throw new Error(`jobs ${res.status}`)
  } catch {
    await setBadge(tabId, '!', '#c0392b')
    await setIcon(tabId, 'normal', 'Save failed — click to retry')
    await sleep(2000)
    await setBadge(tabId, restingBadge(count))
    return
  }

  await showToast(tabId, 'URL added to stream')

  // Scrape runs async — poll for the Document a handful of times.
  for (let i = 0; i < 12; i++) {
    await sleep(2000)
    try {
      const doc = await lookup(origin, token, url)
      if (doc) {
        const st = tabState.get(tabId) || { perOrigin: {} }
        st.perOrigin[origin] = { state: 'saved', docId: doc.id }
        tabState.set(tabId, st)
        await setIcon(tabId, 'check', 'Open in Sam')
        await setBadge(tabId, '✓', '#2ecc71')
        await sleep(1500)
        await setBadge(tabId, restingBadge(count))
        return
      }
    } catch { /* keep polling */ }
  }
  // Queued but not visible yet — no error.
  await setBadge(tabId, restingBadge(count))
  await setIcon(tabId, 'normal', 'Queued in Sam — reload to check')
}

// ── messages from the popup ───────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'sam-save') {
    save(msg.origin, msg.token, msg.tabId, msg.url)
    sendResponse({ ok: true })
    return false
  }
  return false
})

// ── tab/config events ─────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete') checkTab(tabId, tab.url)
})

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId)
    checkTab(tabId, tab.url)
  } catch { /* tab gone */ }
})

chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId))

// Re-probe all tabs when the instance list changes (pair / disconnect).
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return
  if (!changes.instances && !changes.serverBase && !changes.deviceToken) return
  const tabs = await chrome.tabs.query({})
  for (const t of tabs) if (t.id != null) checkTab(t.id, t.url)
})
