// Save to Sam — service worker.
// Per-tab state machine: tracks whether the active tab's URL is already a
// Document on the user's Samizdat instance, flips the toolbar icon, and on
// click either saves the page (scrape_url job) or opens the saved Document.

const API = '/api/v1'

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

// In-memory per-tab cache: tabId -> { state, docId }.
// state: 'saved' | 'not_saved' | 'no_server' | 'unpaired' | 'saving'.
const tabState = new Map()

async function getConfig() {
  const { serverBase, deviceToken } = await chrome.storage.local.get(['serverBase', 'deviceToken'])
  return { serverBase: serverBase || '', deviceToken: deviceToken || '' }
}

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
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: color || '#d64541' })
  } catch { /* tab gone */ }
}

// Probe a single tab and update its icon + cached state.
async function checkTab(tabId, url) {
  if (!isHttp(url)) {
    tabState.delete(tabId)
    await setIcon(tabId, 'off', 'Save to Sam')
    await setBadge(tabId, '')
    return tabState.get(tabId)
  }

  const { serverBase, deviceToken } = await getConfig()
  if (!serverBase) {
    const st = { state: 'no_server' }
    tabState.set(tabId, st)
    await setIcon(tabId, 'off', 'Save to Sam — open your Sam to connect')
    await setBadge(tabId, '')
    return st
  }
  if (!deviceToken) {
    const st = { state: 'unpaired' }
    tabState.set(tabId, st)
    await setIcon(tabId, 'off', 'Save to Sam — click to connect the extension')
    await setBadge(tabId, '')
    return st
  }

  try {
    const doc = await lookup(serverBase, deviceToken, url)
    if (doc) {
      const st = { state: 'saved', docId: doc.id }
      tabState.set(tabId, st)
      await setIcon(tabId, 'check', 'Open in Sam')
      await setBadge(tabId, '')
      return st
    }
    const st = { state: 'not_saved' }
    tabState.set(tabId, st)
    await setIcon(tabId, 'normal', 'Save to Sam')
    await setBadge(tabId, '')
    return st
  } catch (e) {
    const st = { state: 'no_server' }
    tabState.set(tabId, st)
    await setIcon(tabId, 'off', 'Save to Sam — server unreachable')
    await setBadge(tabId, '')
    return st
  }
}

// GET /documents/by-url — returns the Document or null (404). Throws on other errors.
async function lookup(serverBase, token, url) {
  const res = await fetch(`${serverBase}${API}/documents/by-url?url=${encodeURIComponent(url)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`by-url ${res.status}`)
  return res.json()
}

// POST /jobs scrape_url, then poll by-url until the Document appears.
async function save(tabId, url) {
  const { serverBase, deviceToken } = await getConfig()
  if (!serverBase || !deviceToken) return checkTab(tabId, url)

  tabState.set(tabId, { state: 'saving' })
  await setIcon(tabId, 'normal', 'Saving to Sam…')
  await setBadge(tabId, '…', '#d64541')

  try {
    const res = await fetch(`${serverBase}${API}/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'scrape_url', url }),
    })
    if (res.status !== 202 && !res.ok) throw new Error(`jobs ${res.status}`)
  } catch (e) {
    await setBadge(tabId, '!', '#c0392b')
    await setIcon(tabId, 'normal', 'Save failed — click to retry')
    tabState.set(tabId, { state: 'not_saved' })
    return
  }

  // Scrape runs async — poll for the Document a handful of times.
  for (let i = 0; i < 12; i++) {
    await sleep(2000)
    try {
      const doc = await lookup(serverBase, deviceToken, url)
      if (doc) {
        tabState.set(tabId, { state: 'saved', docId: doc.id })
        await setIcon(tabId, 'check', 'Open in Sam')
        await setBadge(tabId, '✓', '#2ecc71')
        await sleep(1500)
        await setBadge(tabId, '')
        return
      }
    } catch { /* keep polling */ }
  }
  // Queued but not visible yet — leave default icon, no error.
  tabState.set(tabId, { state: 'not_saved' })
  await setBadge(tabId, '')
  await setIcon(tabId, 'normal', 'Queued in Sam — reload to check')
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── event wiring ────────────────────────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return
  let st = tabState.get(tab.id)
  if (!st || st.state === 'saving') st = await checkTab(tab.id, tab.url)
  const { serverBase } = await getConfig()

  switch (st.state) {
    case 'saved':
      chrome.tabs.create({ url: `${serverBase}/document/${st.docId}` })
      break
    case 'not_saved':
      await save(tab.id, tab.url)
      break
    case 'unpaired':
      // Settings page mints a token and posts it to the content script.
      chrome.tabs.create({ url: serverBase })
      break
    case 'no_server':
    default:
      chrome.runtime.openOptionsPage()
      break
  }
})

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

// Re-probe all tabs when the config changes (e.g. just got paired).
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return
  if (!changes.deviceToken && !changes.serverBase) return
  const tabs = await chrome.tabs.query({})
  for (const t of tabs) if (t.id != null) checkTab(t.id, t.url)
})
