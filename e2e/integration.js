#!/usr/bin/env node
// Integration test: drives REAL user interactions in the web build (RN-Web), not
// just page loads. The document viewer runs the SAME webview bundle
// (app/src/webview/document-viewer.ts) on web (iframe) and native (WebView), so
// exercising it here genuinely guards the shared select→annotate→highlight path.
//
// Philosophy (see CLAUDE.md "Testing"): start from the API to set up state, then
// ALWAYS drive the actual interaction and assert the VISIBLE result. Creating a row
// via POST proves the server, not the feature — the highlight bug threw nothing and
// returned HTTP 200, so an error-absence check passed on totally broken code.
//
// Run via: just e2e-int   (requires server bin + web build in app/dist)

import {
  BASE_URL, sleep, resetTestEnv, startServer, pairDevice, launchBrowser,
  newConnectedPage, seedTextDoc, seedVideoDoc, makeCleanup,
} from './harness.js'

const VIDEO_DOC_ID = 'eeeeeeee-0000-4000-8000-000000000001'
const TEXT_DOC_ID = 'dddddddd-0000-4000-8000-000000000001'

// Markdown with inline elements (bold + link + code) so a selection spanning them
// crosses MULTIPLE text nodes — the exact case the old single-node highlighter
// silently dropped.
const TEXT_DOC = {
  id: TEXT_DOC_ID,
  title: 'Integration Article',
  canonicalUrl: 'https://example.com/integration-article',
  markdown: [
    '# Integration Article',
    '',
    'Today the Go team is thrilled to release **Go 1.21**, which you can get by ' +
      '[visiting the download page](https://go.dev/dl/) right now. It ships the new ' +
      'built-in functions `min`, `max`, and `clear`.',
    '',
    'The standard library gains packages for structured logging and slices, and a ' +
      'preview of loop variable capture fixes.',
  ].join('\n'),
}

let browser = null
let serverProc = null
const cleanup = makeCleanup(() => ({ browser, serverProc }))

process.on('exit', () => { if (serverProc) { try { process.kill(-serverProc.pid, 'SIGKILL') } catch {} } })
process.on('SIGINT', async () => { await cleanup(); process.exit(130) })
process.on('SIGTERM', async () => { await cleanup(); process.exit(143) })

const results = []
function pass(name) { console.log(`  PASS ${name}`); results.push({ name, ok: true }) }
function fail(name, detail) { console.error(`  FAIL ${name}\n    ${detail}`); results.push({ name, ok: false }) }
async function check(name, fn) {
  try {
    const err = await fn()
    if (err) fail(name, err)
    else pass(name)
  } catch (e) {
    fail(name, e.message)
  }
}

// Click an RN-Web Pressable matched by a predicate. The Pressable host is the element
// carrying cursor:pointer (its nested Text inherits it; its non-pressable wrapper View
// does not). Dispatch a single plain `click` on the LARGEST such element — RN-Web fires
// onPress on click; one click = one press (a pointer sequence or a trailing double
// event double-submits, and pointerup alone doesn't press).
async function clickByText(page, matchFn, label) {
  const ok = await page.evaluate((src) => {
    // eslint-disable-next-line no-eval
    const match = eval('(' + src + ')')
    const hits = [...document.querySelectorAll('*')]
      .filter(e => e.offsetParent && match(e))
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    if (!hits.length) return false
    const pointer = hits.filter(e => getComputedStyle(e).cursor === 'pointer')
    const pool = pointer.length ? pointer : hits
    const el = pool.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
      return pointer.length ? rb.width * rb.height - ra.width * ra.height : ra.width * ra.height - rb.width * rb.height
    })[0]
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }, matchFn.toString())
  if (!ok) { fail(`click: ${label}`, 'no clickable element'); return false }
  return true
}

// Wait until the doc viewer's iframe has booted the webview bundle (article body +
// the ann-btn injected by document-viewer.ts).
async function waitViewerReady(page) {
  await page.waitForFunction(() => {
    const ifr = document.querySelector('iframe')
    return ifr && ifr.contentDocument &&
      ifr.contentDocument.getElementById('sam-article') &&
      ifr.contentDocument.getElementById('ann-btn')
  }, { timeout: 12000 })
}

// ── Per-page interaction checks ───────────────────────────────────────────────
// Each visits a page and asserts a REAL rendered landmark, not just "no errors".
// `assert` runs in the page and returns an error string, or null on success.
const PAGES = [
  { path: '/documents', label: 'documents list',
    assert: () => document.body.innerText.includes('Integration Article')
      ? null : 'seeded doc title not shown in list' },
  { path: '/tags', label: 'tags', landmark: /tag/i },
  { path: '/jobs', label: 'jobs', landmark: /job|queue|empty|no /i },
  { path: '/subscriptions', label: 'subscriptions', landmark: /subscription|feed|empty|no /i },
  { path: '/pipelines', label: 'pipelines', landmark: /pipeline|step|empty|no /i },
  { path: '/starred', label: 'starred', landmark: /star|empty|no |nothing/i },
  { path: '/archived', label: 'archived', landmark: /archiv|empty|no |nothing/i },
]

async function runPageChecks(token, deviceId) {
  for (const spec of PAGES) {
    await check(`page: ${spec.label}`, async () => {
      const { page, errors } = await newConnectedPage(browser, token, deviceId)
      try {
        await page.goto(`${BASE_URL}${spec.path}`, { waitUntil: 'networkidle2', timeout: 15000 })
        await sleep(1200)
        // Not stuck on a spinner / disconnected state.
        const body = await page.evaluate(() => document.body.innerText || '')
        if (/not connected|failed to/i.test(body)) return `page shows error/disconnected state: "${body.slice(0, 80)}"`
        if (body.trim().length < 10) return 'page rendered no content'
        if (spec.assert) {
          const e = await page.evaluate(spec.assert)
          if (e) return e
        } else if (spec.landmark) {
          if (!spec.landmark.test(body)) return `landmark ${spec.landmark} not found in page text`
        }
        if (errors.length) return `console/HTTP errors: ${errors.slice(0, 3).join(' | ')}`
        return null
      } finally {
        await page.close()
      }
    })
  }
}

// ── The document-viewer selection lifecycle (the hard case) ───────────────────
async function runSelectionLifecycle(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.goto(`${BASE_URL}/document/${TEXT_DOC_ID}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)

  // 1. Select text spanning bold + link (multiple text nodes), fire mouseup.
  const selText = await page.evaluate(() => {
    const ifr = document.querySelector('iframe')
    const d = ifr.contentDocument, w = ifr.contentWindow
    const p = d.querySelector('#sam-article p')
    const link = p.querySelector('a')
    const r = d.createRange()
    r.setStart(p.firstChild, 0)
    const endNode = link.nextSibling && link.nextSibling.nodeType === 3 ? link.nextSibling : link.firstChild
    r.setEnd(endNode, Math.min(5, (endNode.nodeValue || 'xxxxx').length))
    const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r)
    const t = sel.toString()
    d.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }))
    return t
  })

  await check('selection spans multiple text nodes (crosses inline elements)', async () => {
    // sanity: the selection must actually cross the link, else the test is trivial
    return selText.includes('download page') ? null : `selection did not cross the link: "${selText}"`
  })

  await check('Annotate button appears at the selection', async () => {
    const disp = await page.evaluate(() => {
      const b = document.querySelector('iframe').contentDocument.getElementById('ann-btn')
      return b ? b.style.display : 'none'
    })
    return disp === 'block' ? null : `ann-btn display is "${disp}"`
  })

  // 2. Click Annotate → parent opens the panel. Type a note, Save.
  await page.evaluate(() => {
    const ifr = document.querySelector('iframe')
    ifr.contentDocument.getElementById('ann-btn')
      .dispatchEvent(new ifr.contentWindow.MouseEvent('click', { bubbles: true }))
  })
  const NOTE = 'integration multinode note'
  await page.waitForSelector('textarea', { timeout: 6000 })
  await page.type('textarea', NOTE)
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(e => e.innerText && e.innerText.trim() === 'Save' && e.offsetParent)
    el.click()
  })

  // 3. The highlight must RENDER — and because the span crosses a link it must be
  //    wrapped as multiple <mark> pieces sharing one data-ann-id.
  await check('multi-node selection renders a highlight', async () => {
    try {
      await page.waitForFunction(() =>
        document.querySelector('iframe').contentDocument.querySelectorAll('mark[data-ann-id]').length > 0,
        { timeout: 6000 })
    } catch { return 'no <mark> rendered after save (regression: single-node-only highlighter)' }
    const info = await page.evaluate((sel) => {
      const d = document.querySelector('iframe').contentDocument
      const marks = [...d.querySelectorAll('mark[data-ann-id]')]
      const byId = {}
      marks.forEach(m => { (byId[m.dataset.annId] = byId[m.dataset.annId] || []).push(m) })
      const ids = Object.keys(byId)
      const pieces = ids.length ? byId[ids[0]] : []
      const joined = pieces.map(m => m.innerText).join('').replace(/\s+/g, ' ').trim()
      const touchesLink = pieces.some(m => m.closest('a') || m.querySelector('a'))
      return { idCount: ids.length, pieceCount: pieces.length, joined, touchesLink, want: sel.replace(/\s+/g, ' ').trim() }
    }, selText)
    if (info.idCount < 1) return 'no annotation id rendered'
    if (info.pieceCount < 2) return `expected multi-piece mark, got ${info.pieceCount} piece(s) — inline element not wrapped`
    if (!info.touchesLink) return 'no mark piece wraps the link text'
    if (!info.joined.includes(info.want.slice(0, 30))) return `rendered marks "${info.joined}" don't match selection "${info.want}"`
    return null
  })

  // 4. Persistence: reload the document, the mark must re-anchor and render.
  await page.reload({ waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)
  await check('highlight persists across reload', async () => {
    try {
      await page.waitForFunction(() =>
        document.querySelector('iframe').contentDocument.querySelectorAll('mark[data-ann-id]').length >= 2,
        { timeout: 6000 })
      return null
    } catch { return 'marks did not re-render after reload (anchoring lost)' }
  })

  // 5. Tap a mark → the edit panel reopens with the saved note.
  await page.evaluate(() => {
    const d = document.querySelector('iframe').contentDocument
    const m = d.querySelector('mark[data-ann-id]')
    m.dispatchEvent(new d.defaultView.MouseEvent('click', { bubbles: true }))
  })
  await check('tapping a highlight reopens its note', async () => {
    try {
      await page.waitForFunction((note) => {
        const ta = document.querySelector('textarea')
        return ta && ta.value === note
      }, { timeout: 6000 }, NOTE)
      return null
    } catch {
      const val = await page.evaluate(() => document.querySelector('textarea')?.value ?? '(no textarea)')
      return `edit panel note mismatch: "${val}"`
    }
  })

  // 6. Delete via the panel (··· more-menu → Delete) → all marks for that id removed.
  await clickByText(page, e => /^[.·]{3}$/.test((e.innerText || '').trim()), 'more-menu toggle')
  await sleep(400)
  await clickByText(page, e => /delete/i.test((e.innerText || '').trim()) && (e.innerText || '').trim().length < 20, 'Delete item')
  await check('deleting the note removes every mark piece', async () => {
    try {
      await page.waitForFunction(() =>
        document.querySelector('iframe').contentDocument.querySelectorAll('mark[data-ann-id]').length === 0,
        { timeout: 6000 })
      return null
    } catch {
      const n = await page.evaluate(() => document.querySelector('iframe').contentDocument.querySelectorAll('mark[data-ann-id]').length)
      return `${n} mark(s) still present after delete`
    }
  })

  // Let the delete request settle before the error check + close, else closing the
  // page can abort the in-flight DELETE (net::ERR_ABORTED) — a race, not a real error.
  await sleep(700)
  if (errors.length) fail('doc viewer: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('doc viewer: no console/HTTP errors')

  await page.close()
}

async function main() {
  console.log('\n=== Samizdat integration test ===\n')
  try {
    resetTestEnv()
    serverProc = await startServer()
    const { token, deviceId } = await pairDevice('integration-device')
    seedVideoDoc(deviceId, VIDEO_DOC_ID)
    seedTextDoc(TEXT_DOC)

    console.log('  launching browser...')
    browser = await launchBrowser()

    await runPageChecks(token, deviceId)
    await runSelectionLifecycle(token, deviceId)

    const failed = results.filter(r => !r.ok)
    if (failed.length) {
      console.error(`\n=== FAILED ===\n${failed.length}/${results.length} check(s) failed.`)
      process.exitCode = 1
    } else {
      console.log(`\n=== PASSED ===\nAll ${results.length} interaction checks passed.`)
    }
  } catch (e) {
    console.error('\n=== ERROR ===\n' + e.stack)
    process.exitCode = 1
  } finally {
    await cleanup()
  }
}

main()
