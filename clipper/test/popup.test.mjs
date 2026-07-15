// Logic tests for the popup dropdown (popup.js) — zero-dep, node --test.
//
// popup.js is a type:module script that reads globals (document, window, chrome,
// fetch, globalThis.SamInstances) at import time and calls render() on load. We
// stub those globals, then dynamic-import a cache-busted copy per scenario so
// render() re-runs against the fresh stubs. A minimal DOM shim (only the handful
// of node APIs popup.js touches) lets us assert the rendered rows without a browser.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const POPUP = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'popup.js')).href

// --- minimal DOM ---------------------------------------------------------
class El {
  constructor(tag) { this.tag = tag; this.className = ''; this.innerHTML = ''; this.children = []; this.disabled = false; this._on = {} }
  appendChild(c) { this.children.push(c); return c }
  replaceChildren(...c) { this.children = c }
  addEventListener(ev, fn) { this._on[ev] = fn }
  click() { if (this.disabled) throw new Error('clicked a disabled element'); this._on.click && this._on.click() }
  get textContent() {
    if (this.children.length === 0) return this.innerHTML || ''
    return this.children.map((c) => (c instanceof El ? c.textContent : c.text)).join('')
  }
}
function makeDocument() {
  const menu = new El('div')
  return {
    menu,
    getElementById: (id) => (id === 'menu' ? menu : null),
    createElement: (tag) => new El(tag),
    createTextNode: (text) => ({ text }),
  }
}
// Flatten every button row to { text, cls, disabled, el }.
function rows(menu) {
  const out = []
  const walk = (n) => {
    if (n.tag === 'button') out.push({ text: n.textContent, cls: n.className, disabled: n.disabled, el: n })
    n.children && n.children.forEach((c) => c instanceof El && walk(c))
  }
  menu.children.forEach((c) => c instanceof El && walk(c))
  return out
}

// --- scenario harness ----------------------------------------------------
let bust = 0
async function renderWith({ instances = [], tabUrl = 'https://example.com/article', lookup = () => ({ status: 404 }) }) {
  const doc = makeDocument()
  const calls = { sendMessage: [], tabsCreate: [], close: 0, openOptions: 0 }

  globalThis.document = doc
  globalThis.window = { close: () => { calls.close++ } }
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: '9.9.9' }),      // high → never an update row
      openOptionsPage: () => { calls.openOptions++ },
      sendMessage: (m) => { calls.sendMessage.push(m) },
    },
    tabs: {
      query: async () => [{ id: 7, url: tabUrl }],
      create: (o) => { calls.tabsCreate.push(o.url) },
    },
  }
  globalThis.fetch = async (url) => {
    if (url.includes('/documents/by-url')) { const r = lookup(url); return { status: r.status || 200, ok: (r.status || 200) < 400, json: async () => r.body } }
    if (url.includes('/extension/version')) return { ok: true, json: async () => ({ version: '0.0.1' }) }
    if (url.includes('/api/v1/health')) return { ok: true, json: async () => ({ app: 'not-samizdat' }) } // suppress connect row
    return { ok: false, status: 404, json: async () => ({}) }
  }
  globalThis.SamInstances = {
    API: '/api/v1',
    hostOf: (o) => new URL(o).host,
    getInstances: async () => instances,
    removeInstance: async () => {},
    cmpVersion: (a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
      for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0) }
      return 0
    },
  }

  await import(`${POPUP}?b=${bust++}`)
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  return { rows: rows(doc.menu), calls }
}

const INST = { origin: 'https://sam.example', hostname: 'sam.example', token: 'tok' }

test('no instances → shows "No Sam connected"', async () => {
  const { rows } = await renderWith({ instances: [] })
  assert.ok(rows.some((r) => r.text.includes('Settings')), 'has a Settings row')
  // the empty notice is a div, not a button; assert no Save row leaks through
  assert.ok(!rows.some((r) => /Save/.test(r.text)), 'no Save row without an instance')
})

test('page not yet saved → enabled Save row that saves + closes', async () => {
  const { rows, calls } = await renderWith({ instances: [INST], lookup: () => ({ status: 404 }) })
  const save = rows.find((r) => r.text.includes('Save as document'))
  assert.ok(save, 'Save row present')
  assert.equal(save.disabled, false, 'Save row is enabled')
  save.el.click()
  assert.equal(calls.sendMessage.length, 1, 'one sam-save dispatched')
  assert.equal(calls.sendMessage[0].type, 'sam-save')
  assert.equal(calls.close, 1, 'popup closed after save')
})

test('page already a Document → disabled "Already added" + working Open', async () => {
  const { rows, calls } = await renderWith({ instances: [INST], lookup: () => ({ status: 200, body: { id: 'doc123' } }) })
  const added = rows.find((r) => r.text.includes('Already added'))
  assert.ok(added, '"Already added" row present')
  assert.equal(added.disabled, true, 'Already-added row is DISABLED (cannot re-add)')
  assert.throws(() => added.el.click(), /disabled/, 'clicking the disabled add throws (no handler)')

  const open = rows.find((r) => r.text.includes('Open in Samizdat'))
  assert.ok(open, 'Open row present')
  assert.equal(open.disabled, false)
  open.el.click()
  assert.deepEqual(calls.tabsCreate, ['https://sam.example/document/doc123'], 'Open jumps to the saved doc')
  assert.equal(calls.close, 1, 'popup closed after open')
})

test('no duplicate add path when already saved', async () => {
  const { rows } = await renderWith({ instances: [INST], lookup: () => ({ status: 200, body: { id: 'x' } }) })
  assert.ok(!rows.some((r) => r.text.includes('Save as document')), 'no Save row when already added')
})
