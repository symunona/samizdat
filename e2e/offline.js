#!/usr/bin/env node
// Offline-first acceptance test (Phase 1). Drives the REAL web UI, asserts the VISIBLE
// result while offline, then reconnects and asserts the SERVER DB actually received the
// writes (read the rows back via REST and diff).
//
// Walkthrough: load a document ONLINE (populates the local store via pull-sync) →
// setOfflineMode(true) → star a highlight, delete a highlight, create an annotation
// (the hard case: a selection crossing an inline <a>), tag a highlight — each asserted
// VISIBLE with no network → reload while still offline (proves the changes survive a
// store-driven re-render / app restart) → setOfflineMode(false) → the outbox pusher
// drains → assert the server rows via REST.
//
// Run via: just e2e-offline   (requires server bin + web build in app/dist)

import {
  BASE_URL, sleep, resetTestEnv, startServer, pairDevice, launchBrowser,
  newConnectedPage, seedTextDoc, seedHighlight, seedTag, makeCleanup,
} from './harness.js'

const DOC_ID = 'dddddddd-0000-4000-8000-0000000000f1'
const HL_STAR = 'ffffffff-0000-4000-8000-00000000aa01' // starred offline
const HL_DEL = 'ffffffff-0000-4000-8000-00000000aa02'  // deleted offline
const HL_TAG = HL_STAR                                  // tagged offline (same card we star)
const TAG_ID = 'ffffffff-0000-4000-8000-00000000bb01'
const TAG_NAME = 'research'
const NOTE = 'offline annotation crossing the link'

const DOC = {
  id: DOC_ID,
  title: 'Offline Article',
  canonicalUrl: 'https://example.com/offline-article',
  markdown: [
    '# Offline Article',
    '',
    'Today the Go team ships **Go 1.21**, which you can get by ' +
      '[visiting the download page](https://go.dev/dl/) right now.',
  ].join('\n'),
}

let browser = null
let serverProc = null
const cleanup = makeCleanup(() => ({ browser, serverProc }))
process.on('exit', () => { if (serverProc) { try { process.kill(-serverProc.pid, 'SIGKILL') } catch {} } })
process.on('SIGINT', async () => { await cleanup(); process.exit(130) })
process.on('SIGTERM', async () => { await cleanup(); process.exit(143) })

const results = []
function pass(name) { console.log(`  PASS ${name}`); results.push({ ok: true }) }
function fail(name, detail) { console.error(`  FAIL ${name}\n    ${detail}`); results.push({ ok: false }) }
async function check(name, fn) {
  try { const e = await fn(); if (e) fail(name, e); else pass(name) }
  catch (e) { fail(name, e.stack || e.message) }
}

// Wait for the article webview + its highlight cards to render.
async function waitViewer(page) {
  await page.waitForFunction(() => {
    const ifr = document.querySelector('iframe')
    return ifr && ifr.contentDocument &&
      ifr.contentDocument.getElementById('sam-article') &&
      ifr.contentDocument.querySelectorAll('.hl-card').length >= 2
  }, { timeout: 15000 })
}

// Read the persisted zustand store out of the web AsyncStorage (localStorage).
async function readStore(page) {
  return page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.includes('samizdat_sync_store')) {
        try { return JSON.parse(localStorage.getItem(k)).state } catch { return null }
      }
    }
    return null
  })
}

async function api(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return res.json()
}

async function main() {
  console.log('Offline-first walkthrough (port 8766)')
  resetTestEnv()
  serverProc = await startServer()
  const { token, deviceId } = await pairDevice('offline-e2e')

  seedTextDoc(DOC)
  seedTag({ id: TAG_ID, name: TAG_NAME })
  seedHighlight({ id: HL_STAR, documentId: DOC_ID, title: 'Star me', body: 'Highlight one to star and tag.' })
  seedHighlight({ id: HL_DEL, documentId: DOC_ID, title: 'Delete me', body: 'Highlight two to delete.' })

  browser = await launchBrowser()
  const { page } = await newConnectedPage(browser, token, deviceId)
  await page.goto(`${BASE_URL}/document/${DOC_ID}`, { waitUntil: 'networkidle2', timeout: 20000 })
  await waitViewer(page)

  // Wait until pull-sync has populated the store with the highlight + tag — offline
  // pin/tag depend on the row/tag existing locally.
  await page.waitForFunction(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.includes('samizdat_sync_store')) {
        const st = JSON.parse(localStorage.getItem(k)).state
        return st && st.highlights && st.highlights['ffffffff-0000-4000-8000-00000000aa01'] &&
          st.tags && st.tags['ffffffff-0000-4000-8000-00000000bb01']
      }
    }
    return false
  }, { timeout: 15000 })

  // ── GO OFFLINE ──
  await page.setOfflineMode(true)
  await sleep(300)

  // A) Star HL_STAR — click the webview pin button; assert it flips to pinned VISIBLY.
  await check('offline: star a highlight (visible)', async () => {
    await page.evaluate((id) => {
      const d = document.querySelector('iframe').contentDocument
      d.querySelector(`.hl-pin-btn[data-id="${id}"]`)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, HL_STAR)
    try {
      await page.waitForFunction((id) => {
        const d = document.querySelector('iframe').contentDocument
        const b = d.querySelector(`.hl-pin-btn[data-id="${id}"]`)
        return b && b.className.includes('pinned')
      }, { timeout: 5000 }, HL_STAR)
    } catch { return 'pin button never showed the pinned state offline' }
    return null
  })

  // B) Delete HL_DEL — click the webview delete button; assert the card disappears.
  await check('offline: delete a highlight (visible)', async () => {
    await page.evaluate((id) => {
      const d = document.querySelector('iframe').contentDocument
      d.querySelector(`.hl-delete-btn[data-id="${id}"]`)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, HL_DEL)
    try {
      await page.waitForFunction((id) => {
        const d = document.querySelector('iframe').contentDocument
        return !d.querySelector(`.hl-card [data-id="${id}"]`)
      }, { timeout: 5000 }, HL_DEL)
    } catch { return 'deleted highlight card still present offline' }
    return null
  })

  // C) Annotate — select across the inline <a> (hard case), Annotate, type, Save.
  await check('offline: create an annotation crossing a link (visible)', async () => {
    const selText = await page.evaluate(() => {
      const ifr = document.querySelector('iframe')
      const d = ifr.contentDocument, w = ifr.contentWindow
      const p = d.querySelector('#sam-article p')
      const r = d.createRange()
      r.selectNodeContents(p) // spans the plain text AND the inline <a> — the hard case
      const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r)
      const t = sel.toString()
      d.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }))
      return t
    })
    if (!/download page/i.test(selText)) return `selection did not cross the link: "${selText}"`
    await page.evaluate(() => {
      const ifr = document.querySelector('iframe')
      ifr.contentDocument.getElementById('ann-btn')
        .dispatchEvent(new ifr.contentWindow.MouseEvent('click', { bubbles: true }))
    })
    await page.waitForSelector('textarea', { timeout: 6000 })
    await page.type('textarea', NOTE)
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(e => e.innerText && e.innerText.trim() === 'Save' && e.offsetParent)
      el.click()
    })
    try {
      await page.waitForFunction(() =>
        document.querySelector('iframe').contentDocument.querySelectorAll('mark[data-ann-id]').length > 0,
        { timeout: 6000 })
    } catch { return 'annotation mark never rendered offline' }
    return null
  })

  // D) Tag HL_STAR — open its tag selector, apply the seeded tag; assert the chip shows.
  await check('offline: tag a highlight (visible)', async () => {
    await page.evaluate((id) => {
      const d = document.querySelector('iframe').contentDocument
      d.querySelector(`.hl-icon-btn[data-action="tags"][data-id="${id}"]`)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, HL_TAG)
    // Wait for the tag selector modal to open (its "Tags" title), then tap the tag row.
    try {
      await page.waitForFunction(() =>
        [...document.querySelectorAll('*')].some(e => e.offsetParent && e.innerText && e.innerText.trim() === 'Tags'),
        { timeout: 6000 })
    } catch { return 'tag selector modal did not open' }
    await page.waitForFunction((name) =>
      [...document.querySelectorAll('*')].some(e => e.offsetParent && e.innerText && e.innerText.trim() === name),
      { timeout: 6000 }, TAG_NAME)
    await page.evaluate((name) => {
      // The RN-Web Pressable (its onPress handler) is the cursor:pointer element — click
      // the largest such match, not the inner Text leaf (which has no handler).
      const hits = [...document.querySelectorAll('*')].filter(e => e.offsetParent && e.innerText && e.innerText.trim() === name)
      const ptr = hits.filter(e => getComputedStyle(e).cursor === 'pointer')
      const pool = ptr.length ? ptr : hits
      const el = pool.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
        return rb.width * rb.height - ra.width * ra.height
      })[0]
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, TAG_NAME)
    await sleep(200)
    // Close the modal (✕).
    await page.evaluate(() => {
      const x = [...document.querySelectorAll('*')].find(e => e.offsetParent && e.innerText && e.innerText.trim() === '✕')
      if (x) x.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    try {
      await page.waitForFunction((id) => {
        const d = document.querySelector('iframe').contentDocument
        const card = [...d.querySelectorAll('.hl-card')].find(c => c.querySelector(`[data-id="${id}"]`))
        return card && card.querySelector('.hl-tag-chip')
      }, { timeout: 6000 }, HL_TAG)
    } catch { return 'tag chip never rendered on the highlight card offline' }
    return null
  })

  // Durability: the outbox holds the un-pushed intents (persisted).
  await check('offline: outbox holds pending intents', async () => {
    const st = await readStore(page)
    const kinds = (st?.outbox ?? []).map(i => i.kind)
    const need = ['hl_pin', 'hl_delete', 'ann_create', 'hl_tag_add']
    const missing = need.filter(k => !kinds.includes(k))
    return missing.length ? `outbox missing ${missing.join(',')} (have: ${kinds.join(',')})` : null
  })

  // ── SURVIVES RESTART — the persisted store (AsyncStorage/localStorage) is exactly
  //    what a cold app start rehydrates from. Assert the durable state carries every
  //    offline change: the annotation row, the pin, the applied tag, and the deletion.
  //    (A full page reload can't test this on web — offline blocks fetching the
  //    server-hosted app bundle itself; a phone runs a native bundle. The persisted
  //    blob is the correct, network-free proxy for restart survival.) ──
  await check('offline: persisted store carries every change (survives restart)', async () => {
    const st = await readStore(page)
    if (!st) return 'no persisted store found'
    const ann = Object.values(st.annotations || {}).find(a => a.note === NOTE && a.document_id === DOC_ID)
    if (!ann) return 'annotation not in persisted store'
    if (st.highlights?.[HL_STAR]?.pinned !== 1) return `pinned not persisted (got ${st.highlights?.[HL_STAR]?.pinned})`
    if (st.highlights?.[HL_DEL]) return 'deleted highlight still in persisted store'
    if (!(st.highlightTags?.[HL_TAG] || []).includes(TAG_ID)) return 'applied tag not in persisted store'
    // Dirty flags guard these rows from a concurrent pull clobbering them until pushed.
    if (!(`ann:${ann.id}` in (st.dirty || {}))) return 'annotation not marked dirty'
    if (!(`hl:${HL_STAR}` in (st.dirty || {}))) return 'starred highlight not marked dirty'
    return null
  })

  // ── GO ONLINE — reload online so the ConnectionProvider reconnects promptly; the
  //    outbox pusher then drains the queued writes to the server. ──
  await page.setOfflineMode(false)
  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 })

  // Poll the SERVER (via REST) until the pusher has flushed the annotation.
  let synced = false
  for (let i = 0; i < 40 && !synced; i++) {
    try {
      const anns = await api(`/api/v1/documents/${DOC_ID}/annotations`, token)
      if (anns.some(a => a.note === NOTE)) synced = true
    } catch { /* retry */ }
    if (!synced) await sleep(500)
  }

  await check('server: annotation was pushed', async () => {
    const anns = await api(`/api/v1/documents/${DOC_ID}/annotations`, token)
    return anns.some(a => a.note === NOTE) ? null : `annotation not on server (got ${anns.length} rows)`
  })
  await check('server: highlight star was pushed', async () => {
    const hls = await api(`/api/v1/documents/${DOC_ID}/highlights`, token)
    const h = hls.find(x => x.id === HL_STAR)
    if (!h) return 'starred highlight missing on server'
    return h.pinned === 1 ? null : `highlight pinned=${h.pinned}, expected 1`
  })
  await check('server: highlight delete was pushed', async () => {
    const hls = await api(`/api/v1/documents/${DOC_ID}/highlights`, token)
    return hls.some(x => x.id === HL_DEL) ? 'deleted highlight still present on server' : null
  })
  await check('server: highlight tag was pushed', async () => {
    const tags = await api(`/api/v1/highlights/${HL_TAG}/tags`, token)
    return tags.some(t => t.name === TAG_NAME) ? null : `tag not applied on server (got ${JSON.stringify(tags.map(t => t.name))})`
  })
  await check('outbox drained after reconnect', async () => {
    // give the pusher a beat to finish the tail of the queue
    for (let i = 0; i < 20; i++) {
      const st = await readStore(page)
      if ((st?.outbox ?? []).length === 0) return null
      await sleep(500)
    }
    const st = await readStore(page)
    return `outbox still has ${(st?.outbox ?? []).length} intent(s): ${(st?.outbox ?? []).map(i => i.kind).join(',')}`
  })

  // ── FEED OFFLINE (via the LS offline simulator) ── proves the FEED renders from the
  // cached store on a COLD load with no network — not just after an online render.
  // Uses the samizdat_force_offline switch (not setOfflineMode, which would block the
  // page reload from fetching the server-hosted bundle).
  await check('offline (sim): feed renders cached highlights on cold load', async () => {
    await page.evaluate(() => localStorage.setItem('samizdat_force_offline', '1'))
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForFunction(
      () => /Star me|Failed to load highlights/.test(document.body.innerText),
      { timeout: 15000 },
    )
    const t = await page.evaluate(() => document.body.innerText)
    await page.evaluate(() => localStorage.removeItem('samizdat_force_offline'))
    if (/Failed to load highlights/.test(t)) return 'feed showed the error screen offline instead of the cached feed'
    if (!/Star me/.test(t)) return 'seeded highlight not visible on the offline feed'
    return null
  })

  await page.close()
  await cleanup()

  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1) })
