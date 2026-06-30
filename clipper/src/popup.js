// Save to Sam — popup dropdown.
// Renders one row per connected instance (save / open), an update-available row
// when the server bundles a newer extension, extra items on Sam-instance tabs,
// and a Connect row when the current tab is an unconnected Sam origin.

const { API, hostOf, getInstances, removeInstance, cmpVersion } = globalThis.SamInstances
const menu = document.getElementById('menu')
const myVersion = chrome.runtime.getManifest().version

function el(tag, cls, html) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html != null) e.innerHTML = html
  return e
}

function item({ ico, label, sub, cls, onClick }) {
  const b = el('button', `item${cls ? ' ' + cls : ''}`)
  b.appendChild(el('span', 'ico', ico || ''))
  const body = el('span')
  body.appendChild(document.createTextNode(label))
  if (sub) body.appendChild(el('span', 'sub', sub))
  b.appendChild(body)
  b.addEventListener('click', onClick)
  return b
}

function sep() { return el('div', 'sep') }
function group(text) { return el('div', 'group', text) }

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

async function lookup(origin, token, url) {
  try {
    const res = await fetch(`${origin}${API}/documents/by-url?url=${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 404) return null
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

async function remoteVersion(origin) {
  try {
    const res = await fetch(`${origin}${API}/extension/version`)
    if (!res.ok) return null
    return (await res.json()).version
  } catch { return null }
}

async function isSamOrigin(origin) {
  try {
    const res = await fetch(`${origin}/api/v1/health`, { credentials: 'omit' })
    if (!res.ok) return false
    const h = await res.json()
    return h && h.app === 'samizdat'
  } catch { return false }
}

function close() { window.close() }

async function render() {
  const tab = await activeTab()
  const url = tab && tab.url
  const isHttp = !!url && /^https?:\/\//.test(url)
  const tabOrigin = isHttp ? new URL(url).origin : ''
  const instances = await getInstances()
  const multi = instances.length > 1

  menu.replaceChildren()

  if (instances.length === 0) {
    menu.appendChild(el('div', 'empty',
      'No Sam connected. Open your Samizdat instance and click <b>Connect extension</b> in Settings.'))
    menu.appendChild(item({
      ico: '⚙', label: 'Settings', onClick: () => chrome.runtime.openOptionsPage(),
    }))
    // Still offer to connect if this very tab is a Sam origin.
    if (isHttp && await isSamOrigin(tabOrigin)) {
      menu.appendChild(item({
        ico: '＋', label: `Connect ${hostOf(tabOrigin)}`,
        sub: 'opens its Settings to pair', onClick: () => { chrome.tabs.create({ url: tabOrigin }); close() },
      }))
    }
    return
  }

  // One save/open row per connected instance.
  for (const inst of instances) {
    const doc = isHttp ? await lookup(inst.origin, inst.token, url) : null
    if (doc) {
      menu.appendChild(item({
        ico: '✓', cls: 'primary',
        label: multi ? `Open in ${inst.hostname}` : 'Open in Samizdat',
        onClick: () => { chrome.tabs.create({ url: `${inst.origin}/document/${doc.id}` }); close() },
      }))
    } else {
      menu.appendChild(item({
        ico: '＋', cls: 'primary',
        label: multi ? `Save to ${inst.hostname}` : 'Save as document to Samizdat',
        sub: isHttp ? null : 'no page to save',
        onClick: () => {
          if (!isHttp) return
          chrome.runtime.sendMessage({ type: 'sam-save', origin: inst.origin, token: inst.token, tabId: tab.id, url })
          close()
        },
      }))
    }
  }

  // Connect row when the current tab is a Sam origin we are not yet paired to.
  if (isHttp && !instances.some((x) => x.origin === tabOrigin) && await isSamOrigin(tabOrigin)) {
    menu.appendChild(sep())
    menu.appendChild(item({
      ico: '＋', label: `Connect ${hostOf(tabOrigin)}`,
      sub: 'new Sam detected — pair it', onClick: () => { chrome.tabs.create({ url: tabOrigin }); close() },
    }))
  }

  // Extra items when the current tab IS a connected Sam instance (host page).
  const here = instances.find((x) => x.origin === tabOrigin)
  if (here) {
    menu.appendChild(sep())
    menu.appendChild(group(here.hostname))
    menu.appendChild(item({
      ico: '⌂', label: 'Open dashboard',
      onClick: () => { chrome.tabs.create({ url: here.origin }); close() },
    }))
    menu.appendChild(item({
      ico: '⚙', label: 'Manage instances',
      onClick: () => chrome.runtime.openOptionsPage(),
    }))
    menu.appendChild(item({
      ico: '⊘', label: 'Disconnect this instance',
      onClick: async () => { await removeInstance(here.origin); render() },
    }))
  } else {
    menu.appendChild(sep())
    menu.appendChild(item({
      ico: '⚙', label: 'Manage instances',
      onClick: () => chrome.runtime.openOptionsPage(),
    }))
  }

  // Update check against each instance — show one row for the newest available.
  let best = null
  await Promise.all(instances.map(async (inst) => {
    const rv = await remoteVersion(inst.origin)
    if (rv && cmpVersion(rv, myVersion) > 0 && (!best || cmpVersion(rv, best.version) > 0)) {
      best = { version: rv, origin: inst.origin, hostname: inst.hostname }
    }
  }))
  if (best) {
    menu.appendChild(sep())
    menu.appendChild(item({
      ico: '↓', cls: 'update', label: `Download new version (v${best.version})`,
      sub: `you have v${myVersion} · from ${best.hostname}`,
      onClick: () => { chrome.tabs.create({ url: `${best.origin}/extension/sam-chrome.zip` }); close() },
    }))
  }
}

render()
