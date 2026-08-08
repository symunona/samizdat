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
async function waitViewer(page, minCards = 2) {
  await page.waitForFunction((n) => {
    const ifr = document.querySelector('iframe')
    return ifr && ifr.contentDocument &&
      ifr.contentDocument.getElementById('sam-article') &&
      ifr.contentDocument.querySelectorAll('.hl-card').length >= n
  }, { timeout: 15000 }, minCards)
}

// What one highlight card in the article webview currently shows. The replica is a real
// database now, so nothing can be read out of localStorage — the rendered card IS the
// assertion surface, which is the stronger test anyway.
async function readCard(page, id) {
  return page.evaluate((hlId) => {
    const d = document.querySelector('iframe').contentDocument
    const card = [...d.querySelectorAll('.hl-card')].find(c => c.querySelector(`[data-id="${hlId}"]`))
    if (!card) return null
    const pin = card.querySelector(`.hl-pin-btn[data-id="${hlId}"]`)
    return {
      pinned: !!pin && pin.className.includes('pinned'),
      // The chip renders as `#name` (mirrors the RN card) — compare on the name.
      tags: [...card.querySelectorAll('.hl-tag-chip')].map(c => c.textContent.trim().replace(/^#/, '')),
    }
  }, id)
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

  // Wait until pull-sync has populated the replica — offline pin/tag depend on the row
  // and the tag existing locally. The Tags screen renders from the replica and nothing
  // else, so the seeded tag appearing there IS the proof the delta landed (one payload
  // carries documents, highlights and tags together).
  await page.goto(`${BASE_URL}/tags`, { waitUntil: 'networkidle2', timeout: 20000 })
  await page.waitForFunction(
    (name) => document.body.innerText.includes(name), { timeout: 15000 }, TAG_NAME,
  )
  await page.goto(`${BASE_URL}/document/${DOC_ID}`, { waitUntil: 'networkidle2', timeout: 20000 })
  await waitViewer(page)

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

  // ── SURVIVES RESTART — a REAL cold start, not a proxy for one. The app is reloaded
  //    with the network simulated away (samizdat_force_offline, so the server-hosted
  //    bundle still loads but nothing can be fetched), which means every card below is
  //    rendered from SQLite and nothing else. This is what the old blob store lost:
  //    a write that never reached disk looked fine until the next launch. ──
  await page.setOfflineMode(false)
  await page.evaluate(() => localStorage.setItem('samizdat_force_offline', '1'))
  await page.goto(`${BASE_URL}/document/${DOC_ID}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await waitViewer(page, 1)

  await check('restart offline: the star survived', async () => {
    const card = await readCard(page, HL_STAR)
    if (!card) return 'starred highlight card is gone after restart'
    return card.pinned ? null : 'highlight came back unpinned after restart'
  })
  await check('restart offline: the applied tag survived', async () => {
    const card = await readCard(page, HL_TAG)
    return card?.tags.includes(TAG_NAME) ? null : `tag chip missing after restart (got ${JSON.stringify(card?.tags)})`
  })
  await check('restart offline: the deletion survived', async () => {
    return (await readCard(page, HL_DEL)) ? 'deleted highlight came back after restart' : null
  })
  await check('restart offline: the annotation survived', async () => {
    const marks = await page.evaluate(() =>
      document.querySelector('iframe').contentDocument.querySelectorAll('mark[data-ann-id]').length)
    return marks > 0 ? null : 'annotation mark is gone after restart'
  })

  // ── GO ONLINE — drop the simulator and reload so the ConnectionProvider reconnects
  //    promptly; the outbox pusher then drains the queued writes to the server. That
  //    the queue itself survived the restart above is what makes this possible. ──
  await page.evaluate(() => localStorage.removeItem('samizdat_force_offline'))
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
  // The queue drained exactly once: a replayed intent that was never dequeued locally
  // would duplicate the row on the server, which is the failure an in-memory-only outbox
  // produces after a restart.
  await check('outbox drained exactly once (no duplicate replay)', async () => {
    await sleep(2000)
    const anns = await api(`/api/v1/documents/${DOC_ID}/annotations`, token)
    const mine = anns.filter(a => a.note === NOTE)
    return mine.length === 1 ? null : `${mine.length} copies of the annotation on the server, expected 1`
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
