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

import { readFileSync, existsSync } from 'node:fs'
import {
  BASE_URL, sleep, resetTestEnv, startServer, pairDevice, launchBrowser,
  newConnectedPage, seedTextDoc, seedTextDocs, seedVideoDoc, seedHighlight, seedLLMHealth,
  seedPipeline, seedJob,
  startStubLLM, STUB_LLM_MODELS,
  makeCleanup,
} from './harness.js'

const VIDEO_DOC_ID = 'eeeeeeee-0000-4000-8000-000000000001'
const TEXT_DOC_ID = 'dddddddd-0000-4000-8000-000000000001'
const FIGURE_DOC_ID = 'dddddddd-0000-4000-8000-000000000002'
const SHORT_DOC_ID = 'dddddddd-0000-4000-8000-000000000003'
const LONG_DOC_ID = 'dddddddd-0000-4000-8000-000000000004'
const PIPELINE_DOC_ID = 'dddddddd-0000-4000-8000-000000000005'
const MANUAL_DOC_ID = 'dddddddd-0000-4000-8000-000000000006'
const PIPE_STEP_JOB_ID = 'bbbbbbbb-0000-4000-8000-000000000001'
const ADDED_VIA_DEVICE = 'kitchen-laptop'
const MANUAL_HL_ID = 'ffffffff-0000-4000-8000-000000000004'
const MANUAL_HL_TITLE = 'Hand Added Card'
const MANUAL_HL_BODY = 'A card whose document no feed produced.'
const HL_ID = 'ffffffff-0000-4000-8000-000000000001'
const SWIPE_HL_ID = 'ffffffff-0000-4000-8000-000000000002'
const DELETE_HL_ID = 'ffffffff-0000-4000-8000-000000000003'
const SWIPE_HL_TITLE = 'Swipe To Archive'
const DELETE_HL_TITLE = 'Tap To Delete'

// Highlight body whose FIRST paragraph crosses bold + link + code (multiple text
// nodes — the hard anchoring case), padded past the 800-char clip threshold so the
// feed card renders a "More…" button that opens the selectable overlay.
const HL_BODY = [
  'Today the Go team ships **Go 1.21**, available from ' +
    '[the download page](https://go.dev/dl/) right now, so grab it early.',
  '',
  'It adds the built-in functions `min`, `max`, and `clear`, alongside a new ' +
    'structured logging package and a slices helper library many teams wanted.',
  '',
  'The standard library also previews loop variable capture fixes, and the toolchain ' +
    'gains forward compatibility so older releases refuse to build newer modules. This ' +
    'paragraph exists purely to push the highlight body past the eight hundred character ' +
    'clip threshold so the card renders a More button the integration test can click to ' +
    'open the selectable overlay where highlight-anchored annotation actually happens. ' +
    'We keep writing here because the clip threshold is eight hundred characters and the ' +
    'earlier paragraphs alone did not clear it, so a few more sentences of perfectly ' +
    'ordinary release-notes prose guarantee the card clips and shows the More affordance ' +
    'that the selection lifecycle depends on to reach the annotation overlay reliably.',
].join('\n')

// Markdown with inline elements (bold + link + code) so a selection spanning them
// crosses MULTIPLE text nodes — the exact case the old single-node highlighter
// silently dropped.
const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// One unit of filler prose, ~a third of a page at the 900×700 test viewport. Page
// mode needs bodies that are genuinely several viewports long, and the `auto`
// checks need one document either side of the 20-page limit.
const FILLER_SECTION = (i) => [
  `## Section ${i + 1}`,
  '',
  `Release engineering notes, part ${i + 1}. The toolchain now refuses to build a ` +
    'module that declares a newer language version, which surfaces mismatches at ' +
    'build time instead of at run time. Vendored dependencies keep their own ' +
    'toolchain lines, so a workspace with mixed versions still resolves ' +
    'deterministically across machines and CI runners.',
  '',
  `Profile-guided optimization graduates in part ${i + 1} as well: a profile ` +
    'collected from production feeds the compiler, which inlines the hot paths it ' +
    'actually sees rather than the ones a heuristic guesses at. Reported gains sit ' +
    'in the low single digits for most services and rather more for parser-heavy ones.',
].join('\n')

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
    '',
    // Hard case for the image lightbox: a figure wrapped in a link. Tapping it must
    // zoom, NOT navigate/open the link sheet. Inline data URI → no network in the test.
    `[![Release diagram](${PIXEL_PNG})](https://go.dev/blog/go1.21)`,
    '',
    // Filler prose — page mode needs a body that is genuinely several viewports
    // long, otherwise "it paginates" and "resize repaginates" are untestable.
    ...Array.from({ length: 12 }, (_, i) => FILLER_SECTION(i)),
  ].join('\n'),
}

// Provenance fixtures: one Document a pipeline pulled in by following a link out of
// TEXT_DOC, one a device added by hand. Only the scrape job that produced them tells
// the two apart, which is exactly what the meta panel has to surface.
const PIPELINE_DOC = {
  id: PIPELINE_DOC_ID,
  title: 'Linked By Pipeline',
  canonicalUrl: 'https://example.com/linked-by-pipeline',
  markdown: '# Linked By Pipeline\n\nA document a pipeline step followed a link to.',
}

const MANUAL_DOC = {
  id: MANUAL_DOC_ID,
  title: 'Added By Hand',
  canonicalUrl: 'https://example.com/added-by-hand',
  markdown: '# Added By Hand\n\nA document pushed to POST /jobs from a device.',
}

// The two ends of the `auto` decision: SHORT is one page, LONG is comfortably past
// the 20-page default. The estimate never has to be exact, only on the right side
// of the threshold.
const SHORT_DOC = {
  id: SHORT_DOC_ID,
  title: 'Short Note',
  canonicalUrl: 'https://example.com/short-note',
  markdown: [
    '# Short Note',
    '',
    'One screen of prose. Under any sane page limit this stays a scrolling reader, ' +
      'because paginating a two-paragraph note is worse than not paginating it.',
    '',
    'A second paragraph, still comfortably inside the first page.',
  ].join('\n'),
}

const LONG_DOC = {
  id: LONG_DOC_ID,
  title: 'Long Report',
  canonicalUrl: 'https://example.com/long-report',
  markdown: ['# Long Report', '', ...Array.from({ length: 90 }, (_, i) => FILLER_SECTION(i))].join('\n'),
}

// What a PDF scrape now produces for a table: the rendered crop, then the same
// table's text lifted out of the prose into a collapsed block (server-side
// `interiorBlock`). Plus a GFM table, which had no CSS at all until this doc.
const FIGURE_DOC = {
  id: FIGURE_DOC_ID,
  title: 'Figure Rendering',
  canonicalUrl: 'https://example.com/figure-rendering',
  markdown: [
    '# Figure Rendering',
    '',
    'The paragraph that introduces the table below.',
    '',
    `![Table 1: Frontier model outputs](${PIXEL_PNG})`,
    '<details><summary>Table 1 — text</summary><pre>Model Own (%) NA<br>GPT 24,763 (.78) 1,136<br>Gemini 20,172 (.64) 1,853</pre></details>',
    '',
    '| Model | Own | NA |',
    '| --- | --- | --- |',
    '| GPT | 24,763 | 1,136 |',
    '| Gemini | 20,172 | 1,853 |',
  ].join('\n'),
}

let browser = null
let serverProc = null
let stubLLM = null
const cleanup = makeCleanup(() => ({ browser, serverProc, stubLLM }))

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

// ── Feed header "+" → add a document by URL ───────────────────────────────────
// The header button is an Ionicon, i.e. a glyph char from the icon font — there is no
// text to match on, so resolve the codepoint from the shipped glyphmap and click the
// element rendering it.
const ADD_GLYPH = String.fromCodePoint(
  JSON.parse(readFileSync(
    new URL('../app/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json',
      import.meta.url))).add)
// clickByText stringifies the matcher and evals it in the page, so the glyph has to be
// baked into the source — a closure over ADD_GLYPH doesn't survive the trip.
const matchAddGlyph = new Function('e', `return e.innerText === ${JSON.stringify(ADD_GLYPH)}`)

async function runAddUrlSheet(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2', timeout: 15000 })
  await sleep(1500)

  await check('feed: header + opens the add-URL sheet', async () => {
    if (!await clickByText(page, matchAddGlyph, 'header + button')) return 'no + button in header'
    try {
      await page.waitForFunction(() => document.body.innerText.includes('Add document'), { timeout: 4000 })
      return null
    } catch { return 'add-URL sheet did not open' }
  })

  const typeUrl = async (value) => page.evaluate((v) => {
    const input = [...document.querySelectorAll('input')].find(i => i.placeholder?.startsWith('https://'))
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)

  await check('feed: junk input is rejected in-sheet (no job queued)', async () => {
    await typeUrl('not a url')
    if (!await clickByText(page, (e) => e.innerText === 'Add', 'Add button')) return 'no Add button'
    await sleep(400)
    const body = await page.evaluate(() => document.body.innerText)
    if (!/valid http/i.test(body)) return 'no validation message shown'
    if (!body.includes('Add document')) return 'sheet closed on invalid input'
    return null
  })

  await check('feed: submitting a URL closes the sheet and shows a pending scrape card', async () => {
    await typeUrl('https://example.com/e2e-add-url')
    if (!await clickByText(page, (e) => e.innerText === 'Add', 'Add button')) return 'no Add button'
    try {
      await page.waitForFunction(() =>
        !document.body.innerText.includes('Add document') &&
        /Reading as document|Ready — tap to open/.test(document.body.innerText), { timeout: 6000 })
    } catch {
      return `no scrape card after submit: "${(await page.evaluate(() => document.body.innerText)).slice(0, 120)}"`
    }
    // and the job really reached the server
    const jobs = await page.evaluate(async (base) => {
      const tok = JSON.parse(localStorage.getItem('samizdat_connection')).token
      const r = await fetch(`${base}/api/v1/jobs?kind=scrape_url`, { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, BASE_URL)
    return (jobs || []).some(j => (j.payload || '').includes('e2e-add-url'))
      ? null : 'no scrape_url job for the submitted URL'
  })

  if (errors.length) fail('feed add-URL: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('feed add-URL: no console/HTTP errors')

  await page.close()
}

// ── Feed swipe = archive · footer trash = delete (touch included) ─────────────
// The destructive action must NOT sit on the easiest gesture: a swipe archives
// (reversible, "Unread"), and delete is an explicit button that touch devices used
// to be denied entirely. Both assertions are visible-result assertions — an
// archive/delete that only reaches the API but never repaints is the bug this
// guards.
const TRASH_GLYPH = String.fromCodePoint(
  JSON.parse(readFileSync(
    new URL('../app/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json',
      import.meta.url)))['trash-outline'])

// Rect of the feed card carrying `title` — the smallest element wide enough to be
// the card itself rather than the title text inside it.
async function cardRect(page, title) {
  return page.evaluate((t) => {
    const hits = [...document.querySelectorAll('*')]
      .filter(e => e.offsetParent && (e.innerText || '').includes(t))
      .map(e => e.getBoundingClientRect())
      .filter(r => r.width > 250 && r.height > 40)
      .sort((a, b) => a.height - b.height)
    if (!hits.length) return null
    const r = hits[0]
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, title)
}

// A real pointer drag — RNGH's pan is driven by pointer events, so a synthetic
// MouseEvent never activates it. Steps matter: one big jump is a teleport, not a pan.
async function dragX(page, rect, dx) {
  const y = rect.y + Math.min(rect.height / 2, 60)
  const x = rect.x + 30
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(x + (dx * i) / 12, y)
    await sleep(16)
  }
  await sleep(120)
  await page.mouse.up()
  await sleep(500)
}

async function runFeedSwipeArchive(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.setViewport({ width: 900, height: 800 })
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 10000 }, SWIPE_HL_TITLE)
  await sleep(600)

  await check('feed: swiping a card right archives it (not deletes)', async () => {
    const rect = await cardRect(page, SWIPE_HL_TITLE)
    if (!rect) return 'swipe card not found in the feed'
    await dragX(page, rect, 220)
    const body = await page.evaluate(() => document.body.innerText)
    if (body.includes('deleted')) return 'swipe deleted the highlight instead of archiving it'
    if (!body.includes('Unread')) return 'no Unread affordance — the card was not archived'
    if (!body.includes(SWIPE_HL_TITLE)) return 'card vanished from the feed instead of dimming in place'
    const hl = await apiHighlight(page, SWIPE_HL_ID)
    return hl && hl.archived_at ? null : 'archived_at never reached the server'
  })

  await check('feed: Unread puts the archived card back', async () => {
    if (!await clickByText(page, (e) => e.innerText === 'Unread', 'Unread button')) return 'no Unread button'
    await sleep(700)
    if ((await page.evaluate(() => document.body.innerText)).includes('Unread')) return 'Unread button still shown'
    const hl = await apiHighlight(page, SWIPE_HL_ID)
    return hl && !hl.archived_at ? null : 'archived_at still set on the server'
  })

  if (errors.length) fail('feed swipe: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('feed swipe: no console/HTTP errors')
  await page.close()
}

// Same feed, emulated as a touch device: `isTouchDevice()` reads `pointer: coarse`,
// which is what used to hide the trash button on every phone.
async function runTouchDelete(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.emulate({
    viewport: { width: 420, height: 900, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
  })
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 10000 }, DELETE_HL_TITLE)

  await check('feed (touch): the browser really reports a coarse pointer', async () =>
    await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)
      ? null : 'touch emulation did not make the pointer coarse — the check below proves nothing')

  await check('feed (touch): the card footer shows a delete button', async () => {
    const n = await page.evaluate((g) => [...document.querySelectorAll('*')]
      .filter(e => e.offsetParent && e.innerText === g).length, TRASH_GLYPH)
    return n > 0 ? null : 'no trash button rendered on a touch device'
  })

  await check('feed (touch): tapping it shows the undo-able deleted card', async () => {
    // Scoped to THIS card's trash — every card has one, and a global click would
    // delete an arbitrary row while the assertions below still passed.
    const clicked = await page.evaluate((t, g) => {
      const card = [...document.querySelectorAll('*')]
        .filter(e => e.offsetParent && (e.innerText || '').includes(t))
        .filter(e => [...e.querySelectorAll('*')].some(c => c.innerText === g))
        .sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)[0]
      const btn = card && [...card.querySelectorAll('*')].find(c => c.innerText === g)
      if (!btn) return false
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return true
    }, DELETE_HL_TITLE, TRASH_GLYPH)
    if (!clicked) return 'no trash button inside the target card'
    await sleep(500)
    const body = await page.evaluate(() => document.body.innerText)
    if (!/deleted/.test(body)) return 'no "deleted" state after tapping delete'
    if (!/Undo/.test(body)) return 'no Undo affordance'
    return null
  })

  await check('feed (touch): Undo cancels the delete before it reaches the server', async () => {
    if (!await clickByText(page, (e) => e.innerText === 'Undo', 'Undo button')) return 'no Undo button'
    await sleep(6000) // outlive the 5s delete timer — it must never fire
    const body = await page.evaluate(() => document.body.innerText)
    if (/deleted/.test(body)) return 'card is still in the deleted state after Undo'
    if (!body.includes(DELETE_HL_TITLE)) return 'card did not come back after Undo'
    const hl = await apiHighlight(page, DELETE_HL_ID)
    return hl ? null : 'the highlight was deleted on the server despite Undo'
  })

  if (errors.length) fail('feed touch delete: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('feed touch delete: no console/HTTP errors')
  await page.close()
}

// Read one highlight back through the API (the feed list endpoint hides archived
// rows, so ask for both lists).
async function apiHighlight(page, id) {
  return page.evaluate(async (base, hlId) => {
    const tok = JSON.parse(localStorage.getItem('samizdat_connection')).token
    const h = { Authorization: `Bearer ${tok}` }
    for (const path of ['/api/v1/highlights?limit=200', '/api/v1/highlights?archived=1&limit=200']) {
      const r = await fetch(base + path, { headers: h })
      if (!r.ok) continue
      const rows = await r.json()
      const hit = (rows || []).find(x => x.id === hlId)
      if (hit) return hit
    }
    return null
  }, BASE_URL, id)
}

// ── Provenance on the meta panel ──────────────────────────────────────────────
// "Where did this come from" is derived server-side from the scrape job, so the
// only proof is the rendered panel: a pipeline-pulled document must name the
// pipeline AND link back to the document whose link it followed; a hand-added one
// must name the device. Reading the API would prove nothing about the panel.
async function runAddedVia(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 10000 }, MANUAL_HL_TITLE)

  // The feed badges a card with where its document came from. A feed document shows
  // the feed; one added by hand must say so rather than showing nothing.
  await check('feed: a hand-added document is badged "manual"', async () => {
    // The smallest element containing the title is the title itself — match on the
    // body too so the match is the whole card (badges included).
    const cardText = await page.evaluate((t, b) => {
      const card = [...document.querySelectorAll('*')]
        .filter(e => e.offsetParent && (e.innerText || '').includes(t) && (e.innerText || '').includes(b))
        .sort((a, b2) => a.getBoundingClientRect().height - b2.getBoundingClientRect().height)[0]
      return card ? card.innerText : ''
    }, MANUAL_HL_TITLE, MANUAL_HL_BODY)
    if (!cardText) return 'the card never rendered'
    return /manual/i.test(cardText) ? null : `card carries no provenance badge: "${cardText.slice(0, 160)}"`
  })

  await page.goto(`${BASE_URL}/document/${PIPELINE_DOC_ID}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)

  // Anchored on the SOURCE row: the panel also carries a "▶ Pipeline" action button,
  // so a bare /Pipeline/ over the whole panel passes on a document that says "Manual".
  await check('meta panel: a pipeline-pulled document says so', async () => {
    if (!await openMetaPanel(page)) return 'meta panel did not open'
    const body = await page.evaluate(() => document.body.innerText)
    const row = new RegExp(`Source\\s+Pipeline\\s+${PIPE_NAME}\\s+from ${TEXT_DOC.title}`, 'i')
    return row.test(body) ? null : `Source row does not name pipeline + linking document: "${body.slice(0, 400)}"`
  })

  await check('meta panel: the link back opens the document it came from', async () => {
    const matcher = new Function('e', `return (e.innerText || '').trim() === ${JSON.stringify(`from ${TEXT_DOC.title}`)}`)
    if (!await clickByText(page, matcher, 'linking document')) return 'no link back to the linking document'
    await sleep(1200)
    const url = await page.evaluate(() => location.pathname)
    if (!url.includes(TEXT_DOC_ID)) return `stayed on ${url}`
    const body = await page.evaluate(() => document.body.innerText)
    return body.includes(TEXT_DOC.title) ? null : 'navigated but the linking document did not render'
  })

  await page.goto(`${BASE_URL}/document/${MANUAL_DOC_ID}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)

  await check('meta panel: a hand-added document names the device', async () => {
    if (!await openMetaPanel(page)) return 'meta panel did not open'
    const body = await page.evaluate(() => document.body.innerText)
    const row = new RegExp(`Source\\s+Manual\\s+added from ${ADDED_VIA_DEVICE}`, 'i')
    return row.test(body) ? null : `Source row does not read a manual add: "${body.slice(0, 400)}"`
  })
  await closeMetaPanel(page)

  if (errors.length) fail('added via: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('added via: no console/HTTP errors')
  await page.close()
}

// A PDF figure must read as one framed object with its text subordinate to it,
// and a GFM table must have borders. Assert COMPUTED style — the markup can be
// perfect while the stylesheet never reaches the frame.
async function runFigureRendering(token, deviceId) {
  const { page } = await newConnectedPage(browser, token, deviceId)
  await page.goto(`${BASE_URL}/document/${FIGURE_DOC_ID}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)

  const style = await page.evaluate(() => {
    const d = document.querySelector('iframe').contentDocument
    const cs = el => (el ? d.defaultView.getComputedStyle(el) : null)
    const det = d.querySelector('#sam-article details')
    const img = cs(d.querySelector('#sam-article img'))
    const td = cs(d.querySelector('#sam-article td'))
    const tbl = cs(d.querySelector('#sam-article table'))
    return {
      imgBorder: img && img.borderTopWidth,
      imgPad: img && img.paddingTop,
      hasDetails: !!det,
      detailsOpen: det ? det.open : null,
      detailsBorder: det ? cs(det).borderLeftWidth : null,
      summaryText: det ? det.querySelector('summary').textContent : null,
      // textContent, not innerText: the block is collapsed, so it has no layout
      // and innerText would read empty on working code.
      preText: det ? det.querySelector('pre').textContent : null,
      preRows: det ? det.querySelectorAll('pre br').length + 1 : 0,
      tableCollapse: tbl && tbl.borderCollapse,
      tdBorder: td && td.borderTopWidth,
    }
  })

  await check('a figure is framed like a quotation', async () =>
    style.imgBorder !== '0px' && style.imgPad !== '0px'
      ? null : `img has no frame (border ${style.imgBorder}, padding ${style.imgPad})`)

  await check("a figure's interior text renders collapsed under it", async () => {
    if (!style.hasDetails) return 'the <details> block did not survive markdown rendering'
    if (style.detailsOpen) return 'the block is expanded by default — it must be subordinate'
    if (style.detailsBorder === '0px') return 'the block has no rule marking it as an aside'
    return style.summaryText.includes('Table 1') ? null : `summary reads "${style.summaryText}"`
  })

  await check("a figure's interior text stays searchable and keeps its rows", async () => {
    if (!style.preText || !style.preText.includes('24,763')) return 'the numbers are gone from the DOM'
    // One <br> per printed row — a single blob of numbers is the bug this replaced.
    return style.preRows >= 3 ? null : `rows were glued: ${style.preRows} row(s)`
  })

  await check('a markdown table has borders', async () =>
    style.tableCollapse === 'collapse' && style.tdBorder !== '0px'
      ? null : `table unstyled (collapse ${style.tableCollapse}, td border ${style.tdBorder})`)
}

// ── The document-viewer selection lifecycle (the hard case) ───────────────────
// Tapping an image in the document body must pop the host lightbox. The <img> lives in
// raw DOM inside the viewer iframe/WebView, so the only proof is: click INSIDE the frame,
// assert the overlay appears OUTSIDE it (in the RN host document).
async function runImageLightbox(token, deviceId) {
  const { page } = await newConnectedPage(browser, token, deviceId)
  await page.goto(`${BASE_URL}/document/${TEXT_DOC_ID}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)

  await check('document body renders the linked figure', async () => {
    const n = await page.evaluate(() =>
      document.querySelector('iframe').contentDocument.querySelectorAll('#sam-article a img').length)
    return n === 1 ? null : `expected 1 linked <img> in the article, got ${n}`
  })

  await page.evaluate(() => {
    const ifr = document.querySelector('iframe')
    const img = ifr.contentDocument.querySelector('#sam-article a img')
    img.dispatchEvent(new ifr.contentWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
  })

  await check('tapping a figure opens the lightbox in the host', async () => {
    try {
      await page.waitForSelector('[data-testid="image-lightbox-close"]', { timeout: 6000 })
    } catch { return 'no lightbox overlay after image click' }
    const src = await page.evaluate(() => {
      const i = document.querySelector('img')
      return i ? i.getAttribute('src') : null
    })
    return src && src.startsWith('data:image/png') ? null : `lightbox image src is "${String(src).slice(0, 40)}"`
  })

  await check('the wrapping link did NOT fire (image tap wins over link_press)', async () => {
    const sheet = await page.evaluate(() =>
      [...document.querySelectorAll('*')].some(e => e.offsetParent && e.innerText === 'Read as document'))
    return sheet ? 'LinkActionSheet opened — the <a> swallowed the image tap' : null
  })

  await page.click('[data-testid="image-lightbox-close"]')
  await check('closing the lightbox removes the overlay', async () => {
    try {
      await page.waitForFunction(() =>
        !document.querySelector('[data-testid="image-lightbox-close"]'), { timeout: 4000 })
    } catch { return 'lightbox still mounted after pressing ✕' }
    return null
  })
}

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

// ── The highlight-details overlay selection lifecycle (the hard case) ──────────
// The overlay (src/HighlightDetail.tsx) hosts the SAME webview bundle as the doc
// viewer, but is STORE-ONLY: its marks derive solely from useSyncStore annotations
// filtered by highlight_id, so a rendered <mark> is itself proof the store carries a
// highlight-anchored annotation (no other source feeds the marks). We drive the real
// feed → overlay → select → annotate path and assert the visible mark.
async function openHighlightOverlay(page) {
  // The feed card clips the long body and shows a "More…" affordance; tapping it opens
  // the selectable overlay (HighlightDetail Modal → iframe).
  const opened = await clickByText(page, e => (e.innerText || '').trim() === 'More…', 'More… (open overlay)')
  if (!opened) throw new Error('could not open highlight overlay ("More…" not found)')
  await waitViewerReady(page)
}

async function runHighlightSelectionLifecycle(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2', timeout: 15000 })
  // Wait for the seeded highlight card to land in the feed.
  await page.waitForFunction(() => document.body.innerText.includes('Go 1.21 Release'), { timeout: 12000 })

  await openHighlightOverlay(page)

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

  await check('hl overlay: selection crosses inline elements', async () =>
    selText.includes('download page') ? null : `selection did not cross the link: "${selText}"`)

  await check('hl overlay: Annotate button appears', async () => {
    const disp = await page.evaluate(() => {
      const b = document.querySelector('iframe').contentDocument.getElementById('ann-btn')
      return b ? b.style.display : 'none'
    })
    return disp === 'block' ? null : `ann-btn display is "${disp}"`
  })

  // 2. Click Annotate → the overlay's AnnotationPanel opens. Type a note, Save.
  await page.evaluate(() => {
    const ifr = document.querySelector('iframe')
    ifr.contentDocument.getElementById('ann-btn')
      .dispatchEvent(new ifr.contentWindow.MouseEvent('click', { bubbles: true }))
  })
  const NOTE = 'highlight anchored multinode note'
  await page.waitForSelector('textarea', { timeout: 6000 })
  // Set the value through React's own setter instead of page.type: keystroke-by-keystroke
  // typing into this controlled textarea drops characters on a loaded box, so Save
  // persisted a truncated note (a different prefix each run) and the reopen check flaked.
  await page.evaluate((note) => {
    const ta = document.querySelector('textarea')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, note)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }, NOTE)
  await page.waitForFunction((note) => document.querySelector('textarea')?.value === note,
    { timeout: 6000 }, NOTE)
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(e => e.innerText && e.innerText.trim() === 'Save' && e.offsetParent)
    el.click()
  })

  // 3. The mark must RENDER — multi-piece because the span crosses the link. This alone
  //    proves the store now holds an annotation with this highlight_id (the marks source).
  await check('hl overlay: multi-node selection renders a highlight', async () => {
    try {
      await page.waitForFunction(() =>
        document.querySelector('iframe').contentDocument.querySelectorAll('mark[data-ann-id]').length > 0,
        { timeout: 6000 })
    } catch { return 'no <mark> rendered after save' }
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

  // 4. Persistence via the STORE: close the overlay, reopen it, the mark must re-anchor
  //    (the fresh iframe seeds marks from useSyncStore — no reload, no network needed).
  await clickByText(page, e => (e.innerText || '').trim() === '✕', 'close overlay')
  await sleep(400)
  await openHighlightOverlay(page)
  await check('hl overlay: highlight persists in the store across reopen', async () => {
    try {
      await page.waitForFunction(() =>
        document.querySelector('iframe').contentDocument.querySelectorAll('mark[data-ann-id]').length >= 2,
        { timeout: 6000 })
      return null
    } catch { return 'marks did not re-render on reopen (store anchoring lost)' }
  })

  // 5. Tap a mark → the edit panel reopens with the saved note.
  await page.evaluate(() => {
    const d = document.querySelector('iframe').contentDocument
    d.querySelector('mark[data-ann-id]').dispatchEvent(new d.defaultView.MouseEvent('click', { bubbles: true }))
  })
  await check('hl overlay: tapping a highlight reopens its note', async () => {
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
  // Close the edit panel (backdrop) before the offline leg.
  await page.evaluate(() => {
    const bd = [...document.querySelectorAll('*')].find(e => {
      const st = getComputedStyle(e)
      return st.position === 'fixed' && st.backgroundColor.includes('rgba(0, 0, 0, 0.5')
    })
    if (bd) bd.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await sleep(300)

  // 5b. Tap a LINK inside the overlay → the link-action sheet must render ON TOP of the
  //     overlay. The overlay is a <Modal> (own window / body portal), so a plain zIndex'd
  //     sibling sheet drew behind it — the sheet is a Modal for exactly this reason.
  await page.evaluate(() => {
    const ifr = document.querySelector('iframe')
    const d = ifr.contentDocument
    const a = d.querySelector('#sam-article a[href^="http"]')
    // cancelable: the bundle's delegated handler preventDefault()s the anchor; without
    // it the synthetic click navigates the frame instead of posting link_press.
    a.dispatchEvent(new ifr.contentWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await check('hl overlay: link sheet renders above the overlay', async () => {
    try {
      await page.waitForFunction(() => document.body.innerText.includes('Read as document'), { timeout: 6000 })
    } catch { return 'link-action sheet never appeared' }
    const top = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('div,span')]
        .find(e => (e.innerText || '').trim() === 'Read as document' && e.offsetParent)
      if (!btn) return { err: 'no button' }
      const r = btn.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return { covered: !(btn === hit || btn.contains(hit) || hit.contains(btn)), tag: hit && hit.tagName }
    })
    if (top.err) return top.err
    return top.covered ? `sheet button is covered (top element: ${top.tag})` : null
  })
  await clickByText(page, e => (e.innerText || '').trim() === 'Cancel', 'close link sheet')
  await sleep(300)

  // 6. OFFLINE create: force the app offline, reopen the overlay, select DIFFERENT text
  //    and annotate. mut.createAnnotation is store+outbox (no fetch), so the mark must
  //    still render — proving the highlight-anchored annotation lands in the store with
  //    NO network, carrying highlight_id (else the marks filter would drop it).
  await page.evaluate(() => localStorage.setItem('samizdat_force_offline', '1'))
  await sleep(200)
  // Reopen — still store-driven; the prior mark should already be there.
  await openHighlightOverlay(page)
  const beforeOffline = await page.evaluate(() =>
    new Set([...document.querySelector('iframe').contentDocument.querySelectorAll('mark[data-ann-id]')].map(m => m.dataset.annId)).size)

  const offText = await page.evaluate(() => {
    const ifr = document.querySelector('iframe')
    const d = ifr.contentDocument, w = ifr.contentWindow
    // Second paragraph, which carries the inline `code` spans — cross into one.
    const ps = d.querySelectorAll('#sam-article p')
    const p = ps[1] || ps[0]
    const code = p.querySelector('code') || p
    const r = d.createRange()
    r.setStart(p.firstChild, 0)
    const endNode = code.firstChild || code
    r.setEnd(endNode, Math.min(3, (endNode.nodeValue || 'xxx').length))
    const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r)
    const t = sel.toString()
    d.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }))
    return t
  })
  await check('hl overlay (offline): selection crosses inline code', async () =>
    offText.length > 0 ? null : 'empty offline selection')

  await page.evaluate(() => {
    const ifr = document.querySelector('iframe')
    ifr.contentDocument.getElementById('ann-btn')
      .dispatchEvent(new ifr.contentWindow.MouseEvent('click', { bubbles: true }))
  })
  await page.waitForSelector('textarea', { timeout: 6000 })
  await page.type('textarea', 'created while offline')
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(e => e.innerText && e.innerText.trim() === 'Save' && e.offsetParent)
    el.click()
  })
  await check('hl overlay (offline): store-only create renders a new mark', async () => {
    try {
      await page.waitForFunction((n) =>
        new Set([...document.querySelector('iframe').contentDocument.querySelectorAll('mark[data-ann-id]')].map(m => m.dataset.annId)).size > n,
        { timeout: 6000 }, beforeOffline)
      return null
    } catch {
      const now = await page.evaluate(() =>
        new Set([...document.querySelector('iframe').contentDocument.querySelectorAll('mark[data-ann-id]')].map(m => m.dataset.annId)).size)
      return `offline create did not add a mark (had ${beforeOffline}, now ${now})`
    }
  })
  await page.evaluate(() => localStorage.removeItem('samizdat_force_offline'))

  await sleep(500)
  if (errors.length) fail('hl overlay: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('hl overlay: no console/HTTP errors')

  await page.close()
}

// ── Page mode ─────────────────────────────────────────────────────────────────
// Pagination happens inside the viewer frame; the toggle lives in the RN meta panel.
// So every assertion here crosses the boundary: drive the host control, assert what
// the frame actually laid out (and that the frame's own interactions still work).
const pageTotal = (page) => page.evaluate(() => {
  const ind = document.querySelector('iframe').contentDocument.getElementById('pg-ind')
  const m = /(\d+)\s*\/\s*(\d+)/.exec(ind ? ind.textContent : '')
  return m ? { idx: Number(m[1]), total: Number(m[2]) } : null
})

// Open the ⋮ meta panel, press one segment of the Flow/Auto/Page control, close it.
// clickByText stringifies the matcher and evals it in the page, so the label has to
// be baked into the source — a closure over it doesn't survive the trip.
async function openMetaPanel(page) {
  if (!await clickByText(page, e => (e.innerText || '').trim() === '⋮', 'meta panel ⋮')) return false
  await sleep(500)
  return true
}

async function closeMetaPanel(page) {
  const stillOpen = await page.evaluate(() => document.body.innerText.includes('Document info'))
  if (stillOpen) {
    await clickByText(page, e => (e.innerText || '').trim() === '×', 'close meta panel')
    await sleep(400)
  }
}

async function setReadingMode(page, label) {
  if (!await openMetaPanel(page)) return false
  const matcher = new Function('e', `return (e.innerText || '').trim() === ${JSON.stringify(label)}`)
  const ok = await clickByText(page, matcher, `${label} segment`)
  await sleep(400)
  // The panel doesn't dismiss itself — it would cover the frame for later checks.
  await closeMetaPanel(page)
  return ok
}

// The single info line under the segmented control (it names the resolution + limit).
const readingInfo = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find(e =>
    e.children.length === 0 && /pages here|Continuous scrolling|Paginates documents/.test(e.innerText || ''))
  return el ? el.innerText.trim() : ''
})

const isPaginated = (page) => page.evaluate(() =>
  document.querySelector('iframe').contentDocument.documentElement.classList.contains('pg'))

async function waitPaginated(page, want, timeout = 5000) {
  try {
    await page.waitForFunction((w) =>
      document.querySelector('iframe').contentDocument.documentElement.classList.contains('pg') === w,
      { timeout }, want)
    return null
  } catch {
    return `viewer is ${await isPaginated(page) ? 'paginated' : 'continuous'}, expected ${want ? 'paginated' : 'continuous'}`
  }
}

// Vertical scrollability of the frame's document + horizontal of its body: the two
// switch places between the modes (scrolling reader vs paginated reader).
const frameOverflow = (page) => page.evaluate(() => {
  const d = document.querySelector('iframe').contentDocument
  return {
    v: d.documentElement.scrollHeight - d.documentElement.clientHeight,
    h: d.body.scrollWidth - d.body.clientWidth,
  }
})

async function runPageMode(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.setViewport({ width: 900, height: 700 })
  await page.goto(`${BASE_URL}/document/${TEXT_DOC_ID}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)

  await check('meta panel: the Page segment paginates the document', async () => {
    if (!await setReadingMode(page, 'Page')) return 'no Page segment in the meta panel'
    const err = await waitPaginated(page, true)
    if (err) return err
    const p = await pageTotal(page)
    if (!p) return 'no page indicator rendered'
    if (p.total < 2) return `document did not paginate (indicator says ${p.idx}/${p.total})`
    // Reading direction flipped: a page is one viewport tall, pages run sideways.
    const o = await frameOverflow(page)
    if (o.v > 2) return `document still scrolls vertically by ${o.v}px in page mode`
    if (o.h < 10) return `body has no horizontal page overflow (${o.h}px)`
    return null
  })

  await check('page mode: text selection still raises the Annotate button', async () => {
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
    if (!selText.includes('download page')) return `selection did not cross the link: "${selText}"`
    const disp = await page.evaluate(() => {
      const b = document.querySelector('iframe').contentDocument.getElementById('ann-btn')
      return b ? b.style.display : '(no button)'
    })
    if (disp !== 'block') return `ann-btn display is "${disp}" — selection broken by page mode`
    await page.evaluate(() => {
      const w = document.querySelector('iframe').contentWindow
      w.getSelection().removeAllRanges()
      w.document.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }))
    })
    return null
  })

  await check('page mode: tapping a figure still opens the lightbox', async () => {
    await page.evaluate(() => {
      const ifr = document.querySelector('iframe')
      ifr.contentDocument.querySelector('#sam-article a img')
        .dispatchEvent(new ifr.contentWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    try {
      await page.waitForSelector('[data-testid="image-lightbox-close"]', { timeout: 5000 })
    } catch { return 'no lightbox overlay after image click in page mode' }
    await page.click('[data-testid="image-lightbox-close"]')
    await sleep(300)
    return null
  })

  await check('page mode: ArrowRight inside the frame advances the page', async () => {
    const before = await pageTotal(page)
    await page.evaluate(() => {
      const ifr = document.querySelector('iframe')
      ifr.contentDocument.dispatchEvent(
        new ifr.contentWindow.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    await sleep(600)
    const after = await pageTotal(page)
    if (!after || after.idx !== before.idx + 1) {
      return `page index went ${before && before.idx} → ${after && after.idx}`
    }
    const left = await page.evaluate(() => document.querySelector('iframe').contentDocument.body.scrollLeft)
    return left > 0 ? null : 'indicator advanced but the body never scrolled'
  })

  await check('page mode: ArrowLeft goes back', async () => {
    const before = await pageTotal(page)
    await page.evaluate(() => {
      const ifr = document.querySelector('iframe')
      ifr.contentDocument.dispatchEvent(
        new ifr.contentWindow.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    await sleep(600)
    const after = await pageTotal(page)
    return after && after.idx === before.idx - 1 ? null : `page index went ${before.idx} → ${after && after.idx}`
  })

  await check('page mode: a narrower viewport recalculates the page count', async () => {
    const before = await pageTotal(page)
    await page.setViewport({ width: 480, height: 620 })
    await sleep(1200) // > the 150ms resize throttle
    const after = await pageTotal(page)
    if (!after) return 'page indicator disappeared after resize'
    if (after.total <= before.total) {
      return `narrower viewport did not add pages (${before.total} → ${after.total})`
    }
    return after.idx >= 1 && after.idx <= after.total ? null : `page index ${after.idx} out of range`
  })

  await check('page mode: switching to Flow restores continuous scrolling', async () => {
    if (!await setReadingMode(page, 'Flow')) return 'no Flow segment in the meta panel'
    const err = await waitPaginated(page, false)
    if (err) return err
    const o = await frameOverflow(page)
    if (o.v < 100) return `document is not vertically scrollable again (overflow ${o.v}px)`
    if (o.h > 2) return `body still has horizontal page overflow (${o.h}px)`
    return null
  })

  await sleep(400)
  if (errors.length) fail('page mode: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('page mode: no console/HTTP errors')

  await page.close()
}

// ── Settings: the Services group + LLM provider health ────────────────────────
// The failure this guards is silent: a provider that ran out of credits only ever
// showed up as a dead Job. So the checks assert the VISIBLE row text, and that a
// staged failure paints the drawer dot.
const ANTHROPIC_CREDIT_ERR =
  'anthropic 400: {"type":"error","error":{"type":"invalid_request_error",' +
  '"message":"Your credit balance is too low to access the Anthropic API."}}'

async function settingsText(page) {
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle2', timeout: 15000 })
  await sleep(1800) // service queries (proxy / export / llm) settle
  return page.evaluate(() => document.body.innerText)
}

// ── the replica is a real database, not a snapshot ────────────────────────────
// The blob store's defining failure: a write that never reached disk looked fine until
// the next launch, and the frozen cursor made the phone re-pull the same delta forever.
// So this drives the whole loop through the UI — pull, RELOAD with the network cut,
// mutate offline, RELOAD again — because the only proof a row reached SQLite is that a
// cold start finds it. Every assertion below is on what renders, with no network at all.
const DB_LAYER_NOTE = 'note written with the network cut'

async function runDbLayer(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)

  // Online once — the pull is what fills the replica. The list itself comes off the
  // network here, so it proves nothing yet; the wait after it is for the sync delta to
  // land in SQLite, which is what every offline assertion below actually reads.
  await page.goto(`${BASE_URL}/documents`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForFunction(t => document.body.innerText.includes(t), { timeout: 15000 }, TEXT_DOC.title)
    .catch(() => {})
  await sleep(5000)

  // Cut the network and RELOAD. Nothing below can come from the server.
  await page.evaluate(() => localStorage.setItem('samizdat_force_offline', '1'))
  await page.goto(`${BASE_URL}/documents`, { waitUntil: 'domcontentloaded', timeout: 20000 })

  await check('db layer: the documents list renders from SQLite with no network', async () => {
    try {
      await page.waitForFunction(t => document.body.innerText.includes(t), { timeout: 12000 }, TEXT_DOC.title)
    } catch {
      const txt = await page.evaluate(() => document.body.innerText)
      return `seeded document not listed offline: ${txt.slice(0, 300)}`
    }
    return null
  })

  await check('db layer: a note written offline shows up at once', async () => {
    await page.goto(`${BASE_URL}/notes`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await sleep(800)
    if (!await clickByText(page, e => e.getAttribute('aria-label') === 'New note', 'new-note FAB')) {
      return 'no new-note button on Notes'
    }
    await page.waitForSelector('textarea', { timeout: 6000 })
    await page.type('textarea', DB_LAYER_NOTE)
    if (!await clickByText(page, e => e.innerText === 'Save', 'save note')) return 'no Save button'
    try {
      await page.waitForFunction(t => document.body.innerText.includes(t), { timeout: 8000 }, DB_LAYER_NOTE)
    } catch { return 'the note never appeared in the list' }
    return null
  })

  await check('db layer: the offline note survives a reload (it really reached SQLite)', async () => {
    await page.goto(`${BASE_URL}/notes`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    try {
      await page.waitForFunction(t => document.body.innerText.includes(t), { timeout: 12000 }, DB_LAYER_NOTE)
    } catch {
      const txt = await page.evaluate(() => document.body.innerText)
      return `the note vanished on reload — it was never written: ${txt.slice(0, 300)}`
    }
    return null
  })

  // Back online: the queued intent must reach the server, which is the other half of
  // durability — a lost outbox row means the note only ever existed on this device.
  await page.evaluate(() => localStorage.removeItem('samizdat_force_offline'))
  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 })

  await check('db layer: the queued note is pushed once the network is back', async () => {
    // A standalone note has no parent document, so the sync feed is where it shows up.
    const since = encodeURIComponent('1970-01-01T00:00:00Z')
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${BASE_URL}/api/v1/sync?since=${since}`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) {
        const { annotations = [] } = await res.json()
        const mine = annotations.filter(a => a.note === DB_LAYER_NOTE)
        if (mine.length === 1) return null
        if (mine.length > 1) return `${mine.length} copies of the note on the server, expected 1`
      }
      await sleep(500)
    }
    return 'the offline note never reached the server'
  })

  const unexpected = errors.filter(e => !/Failed to fetch|simulated offline/i.test(e))
  if (unexpected.length) fail('db layer: no unrelated console/HTTP errors', unexpected.slice(0, 4).join(' | '))
  else pass('db layer: no unrelated console/HTTP errors')

  await page.close()
}

// ── a replica far bigger than the old blob cap ────────────────────────────────
// Android's AsyncStorage caps the whole database at 6MB; past it every write rejected.
// Rows in SQLite have no such ceiling, so the guard is simply: pull a corpus that would
// have blown the old store, and assert nothing broke — no write-failure card, and the
// list still renders every document.
const BULK_DOCS = 50
const BULK_TITLE = i => `Bulk Document ${String(i).padStart(2, '0')}`

async function runLargeReplica(token, deviceId) {
  // ~60KB of body each, ~3MB of markdown across the corpus: far past the ~2MB per-row
  // limit that used to need chunking, and squarely inside the 6MB whole-DB cap that used
  // to freeze every write once the blob crossed it.
  seedTextDocs(Array.from({ length: BULK_DOCS }, (_, i) => ({
    id: `dddddddd-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
    title: BULK_TITLE(i),
    canonicalUrl: `https://example.com/bulk/${i}`,
    markdown: `# ${BULK_TITLE(i)}\n\n` + FILLER_SECTION(i).repeat(42),
  })))
  console.log(`  seeded ${BULK_DOCS} bulk documents`)

  const { page, errors } = await newConnectedPage(browser, token, deviceId)

  // Clear the local cache first: the replica's cursor has long since passed these rows'
  // timestamps, and — more to the point — a wiped replica re-pulling the WHOLE library
  // in one request is exactly the case the plan flags as the expensive one.
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle2', timeout: 20000 })
  await sleep(1500) // the service queries settle before the Device section is laid out
  if (await clickByText(page, e => e.innerText === 'Clear local cache', 'clear local cache')) {
    await sleep(400)
    await clickByText(page, e => e.innerText === 'Clear cache', 'confirm clear cache')
    await sleep(1500)
  }

  // The list virtualizes, so scrolling to the 50th row proves nothing about the other 49.
  // The search box filters the REPLICA (documents.tsx derives its list from useDocuments),
  // so finding a row by name is a real query against SQLite and dodges the viewport.
  async function findInReplica(title) {
    await page.goto(`${BASE_URL}/documents`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForSelector('[data-testid="doc-search"]', { timeout: 25000 })
    await page.type('[data-testid="doc-search"]', title)
    try {
      await page.waitForFunction(t => document.body.innerText.includes(t), { timeout: 20000 }, title)
      return true
    } catch { return false }
  }

  await check('large replica: the whole corpus pulls without a write failure', async () => {
    // First, last and middle: a partial apply would drop a contiguous run of them.
    for (const i of [0, Math.floor(BULK_DOCS / 2), BULK_DOCS - 1]) {
      if (!await findInReplica(BULK_TITLE(i))) return `${BULK_TITLE(i)} is not in the replica after the pull`
    }
    return null
  })

  await check('large replica: Settings reports no storage problem', async () => {
    await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle2', timeout: 20000 })
    await sleep(1200)
    const card = await page.$$('[data-testid="persist-failure-card"]')
    return card.length ? 'the Device Storage failure card is up after a large pull' : null
  })

  await check('large replica: a cold start reads it all back from SQLite', async () => {
    await page.evaluate(() => localStorage.setItem('samizdat_force_offline', '1'))
    const found = await findInReplica(BULK_TITLE(BULK_DOCS - 1))
    await page.evaluate(() => localStorage.removeItem('samizdat_force_offline'))
    return found ? null : 'the corpus did not survive a reload with no network'
  })

  const unexpected = errors.filter(e => !/Failed to fetch|simulated offline/i.test(e))
  if (unexpected.length) fail('large replica: no unrelated console/HTTP errors', unexpected.slice(0, 4).join(' | '))
  else pass('large replica: no unrelated console/HTTP errors')

  await page.close()
}

// ── the local database can no longer be written ───────────────────────────────
// The bug this guards: zustand's persist dropped the promise setItem() returned, so a
// device past AsyncStorage's 6MB whole-DB cap threw SQLiteFullException on every write
// into total silence — the replica froze for six days and the only symptom was a feed
// that stopped moving. Nothing is asserted from the replica here; the point is what the
// user can SEE, plus that the error really left the device.
async function runPersistFailure(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  // Same shipped, localStorage-keyed seam as the offline simulator (src/offlineSim.ts):
  // every SQL write rejects with SQLITE_FULL, which is what a full disk really raises.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('samizdat_force_storage_full', '1') } catch { /* opaque origin */ }
  })
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForSelector('[data-testid="persist-failure-card"]', { timeout: 10000 }).catch(() => {})
  await sleep(800)
  let txt = await page.evaluate(() => document.body.innerText)

  await check('storage full: Settings says the device storage is full', async () => {
    if (!/Device Storage/.test(txt)) return `no Device Storage card on Settings: ${txt.slice(0, 400)}`
    if (!/Full — offline data is stale/.test(txt)) return 'the card does not say the storage is full and the data stale'
    if (!/disk is full/.test(txt)) return 'the underlying write error is not shown'
    return null
  })

  await check('storage full: the card is honest about what still works', async () => {
    if (!/still\s+sync to the server/.test(txt.replace(/\s+/g, ' '))) return 'the card does not say local changes still sync'
    if (!/out of date/.test(txt)) return 'the card does not say offline reads may be stale'
    return null
  })

  await check('storage full: the card sits in the Services group', async () => {
    const up = txt.toUpperCase()
    const svc = up.indexOf('SERVICES'), prefs = up.indexOf('PREFERENCES')
    const at = txt.indexOf('Device Storage')
    return at > svc && at < prefs ? null : `Device Storage is outside the Services group (at ${at}, group ${svc}..${prefs})`
  })

  await check('storage full: the drawer hamburger shows the degraded dot', async () => {
    const dots = await page.$$('[data-testid="drawer-alert-dot"]')
    return dots.length ? null : 'no drawer alert dot while the replica cannot be saved'
  })

  await check('storage full: an error-level log reached the device-log channel', async () => {
    if (!errors.some(e => /persistHealth/.test(e))) return `nothing logged at error level: ${errors.slice(0, 3).join(' | ')}`
    // debugLog flushes immediately on `error` — the line must reach the server file.
    const f = `tmp/device-logs/integration-device-${deviceId.slice(0, 8)}.ndjson`
    for (let i = 0; i < 20; i++) {
      if (existsSync(f) && /device storage is FULL/.test(readFileSync(f, 'utf8'))) return null
      await sleep(300)
    }
    return `no persist failure in ${f}`
  })

  // Recoverable: free the space, make one more write, and the alarm must clear itself.
  // Clearing the local cache is exactly the remedy the card points at.
  await check('storage recovered: a successful write clears the alert', async () => {
    await page.evaluate(() => localStorage.removeItem('samizdat_force_storage_full'))
    if (!await clickByText(page, e => e.innerText === 'Clear local cache', 'Clear local cache')) return 'no clear-cache button'
    await sleep(400)
    if (!await clickByText(page, e => e.innerText === 'Clear cache', 'confirm clear cache')) return 'confirm dialog did not open'
    await page.waitForFunction(() => !document.querySelector('[data-testid="persist-failure-card"]'), { timeout: 8000 })
      .catch(() => {})
    txt = await page.evaluate(() => document.body.innerText)
    if (/Device Storage/.test(txt)) return 'the Device Storage card is still up after a successful write'
    const dots = await page.$$('[data-testid="drawer-alert-dot"]')
    return dots.length ? 'the drawer dot survived a successful write' : null
  })

  await sleep(300)
  // The write failure is the feature — both the persistHealth alert and the DB layer's
  // own line about it. Assert on everything ELSE staying clean.
  const unexpected = errors.filter(e => !/persistHealth|local write failed|could not open the local replica/.test(e))
  if (unexpected.length) fail('storage full: no unrelated console/HTTP errors', unexpected.slice(0, 4).join(' | '))
  else pass('storage full: no unrelated console/HTTP errors')

  await page.close()
}

async function runSettingsServices(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  let txt = await settingsText(page)

  await check('settings: sections are grouped Services → Preferences → Device', async () => {
    const idx = l => txt.toUpperCase().indexOf(l)
    const [svc, prefs, dev] = ['SERVICES', 'PREFERENCES', 'DEVICE'].map(idx)
    if (svc < 0 || prefs < 0 || dev < 0) return `missing section header(s): services=${svc} prefs=${prefs} device=${dev}`
    if (!(svc < prefs && prefs < dev)) return `sections out of order: services=${svc} prefs=${prefs} device=${dev}`
    return null
  })

  await check('settings: every service card sits inside the Services group', async () => {
    const up = txt.toUpperCase()
    const svc = up.indexOf('SERVICES'), prefs = up.indexOf('PREFERENCES')
    for (const card of ['YouTube Proxy', 'Export Vault', 'Browser Extension', 'LLM Services']) {
      const at = txt.indexOf(card)
      if (at < 0) return `no "${card}" card on Settings`
      if (at < svc || at > prefs) return `"${card}" is outside the Services group (at ${at}, group ${svc}..${prefs})`
    }
    return null
  })

  await check('settings: the configured LLM provider is listed with no calls yet', async () => {
    if (!/127\.0\.0\.1:9/.test(txt)) return 'the configured openai_compat endpoint is not named'
    if (!/test-model/.test(txt)) return 'the provider row does not show its model'
    if (!/No calls yet/.test(txt)) return `expected an idle provider, got: ${txt.slice(txt.indexOf('LLM Services'), txt.indexOf('LLM Services') + 240)}`
    return null
  })

  await check('settings: no degraded dot while every service is healthy', async () => {
    const dots = await page.$$('[data-testid="drawer-alert-dot"]')
    return dots.length ? 'the drawer shows an alert dot with nothing broken' : null
  })

  // A provider that is no longer in config keeps its row (the spend and the error
  // are still history) but must NOT raise an alarm — nothing routes through it.
  const RETIRED_ANTHROPIC = {
    key: 'anthropic',
    provider: 'anthropic',
    calls: 12,
    errors: 1,
    last_ok_at: '2026-08-01T10:00:00Z',
    last_error_at: '2026-08-02T09:00:00Z',
    last_error: ANTHROPIC_CREDIT_ERR,
    last_error_kind: 'quota',
  }
  seedLLMHealth([RETIRED_ANTHROPIC])
  txt = await settingsText(page)

  await check('settings: a provider out of credits reads as out of credits', async () => {
    if (!/Out of credits \/ rate limited/.test(txt)) return `no quota status in: ${txt.slice(txt.indexOf('LLM Services'), txt.indexOf('LLM Services') + 400)}`
    if (!/credit balance is too low/.test(txt)) return 'the provider error body is not shown'
    if (!/anthropic/.test(txt)) return 'the failing provider is not named'
    return null
  })

  // The probe is the ONE active path: a tap, never a render. It must tell the two
  // failure shapes apart — a box with nothing listening vs a box that answered.
  await check('settings: Probe reports each provider live, reachable and not', async () => {
    await clickByText(page, e => e.innerText === 'Probe', 'Probe')
    await page.waitForFunction(() => /Probed:/.test(document.body.innerText), { timeout: 15000 })
    await sleep(300)
    // Read in place: settingsText() re-navigates, and a remount clears the probe
    // results (they are screen state — nothing probes on a render).
    const t = await page.evaluate(() => document.body.innerText)
    const llm = t.slice(t.indexOf('LLM Services'))
    if (!/Probed: Unreachable/.test(llm)) return `the dead-port provider did not probe as unreachable: ${llm.slice(0, 500)}`
    if (!new RegExp(`Probed: ${STUB_LLM_MODELS.length} models`).test(llm)) {
      return `the stub box did not report its model count: ${llm.slice(0, 500)}`
    }
    return null
  })

  await check('settings: a retired provider keeps its history without raising an alarm', async () => {
    if (!/retired/i.test(txt)) return 'the dropped provider is not marked retired'
    const dots = await page.$$('[data-testid="drawer-alert-dot"]')
    return dots.length ? 'a provider nothing routes through raised the drawer dot' : null
  })

  // Now the CONFIGURED endpoint fails — this is the case that must be shouted about.
  seedLLMHealth([RETIRED_ANTHROPIC, {
    key: 'openai_compat@http://127.0.0.1:9/v1',
    provider: 'openai_compat',
    base_url: 'http://127.0.0.1:9/v1',
    calls: 3,
    errors: 3,
    last_error_at: '2026-08-02T09:30:00Z',
    last_error: 'llm: transport failure: openai_compat request: dial tcp 127.0.0.1:9: connect: connection refused',
    last_error_kind: 'transport',
  }])
  txt = await settingsText(page)

  await check('settings: the live provider reports it is unreachable', async () => {
    if (!/Unreachable/.test(txt)) return `no transport status in: ${txt.slice(txt.indexOf('LLM Services'), txt.indexOf('LLM Services') + 400)}`
    if (!/connection refused/.test(txt)) return 'the provider error body is not shown'
    return null
  })

  await check('settings: the failure paints the drawer alert dot', async () => {
    const dots = await page.$$('[data-testid="drawer-alert-dot"]')
    return dots.length ? null : 'no drawer alert dot after a configured provider failed'
  })

  // The whole point of a local primary: how much is it actually serving? The split
  // is per ENDPOINT (12 anthropic + 3 local = 15 → 80% / 20%), not per provider name.
  await check('settings: each endpoint shows its share of all routed calls', async () => {
    for (const want of ['12 calls', '80% routed here', '3 calls', '20% routed here']) {
      if (!txt.includes(want)) return `missing "${want}" in: ${txt.slice(txt.indexOf('LLM Services'), txt.indexOf('LLM Services') + 400)}`
    }
    return null
  })

  await sleep(300)
  if (errors.length) fail('settings services: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('settings services: no console/HTTP errors')

  await page.close()
}

// ── Pipelines: filter summary + the step config editor ───────────────────────
// Two things this guards. (1) The card used to summarize every filter as "all
// documents" because it checked keys the Go filter never had. (2) The prompt that
// decides what a pipeline DOES is now step config, editable here — while the
// api_key in the same config must not reach the DOM at all.
const PIPE_ID = 'cccccccc-0000-4000-8000-000000000001'
const PIPE_FEED_ID = 'aaaaaaaa-0000-4000-8000-0000000000f1'
const PIPE_NAME = 'Integration Summarizer'
const PIPE_PROMPT = 'Summarize the article in three caveman bullets for the integration test.'
const PIPE_SECRET = 'sk-integration-NEVER-RENDER-THIS'
const PIPE_MODEL = 'qwen3:4b-instruct'
// The model is chosen from the picker now, so it must be a model the stub box
// actually serves — that is the whole point of grouping by provider.
const PIPE_NEW_MODEL = STUB_LLM_MODELS[1]
const STUB_PROVIDER_ID = '127.0.0.1:8767'
const PIPE_STEPS = [{ kind: 'llm_summarize', config: { model: PIPE_MODEL, prompt: PIPE_PROMPT, api_key: PIPE_SECRET } }]

const PROMPT_FIELD = '[aria-label="llm_summarize prompt"]'
const MODEL_FIELD = '[aria-label="llm_summarize model"]'
const MODEL_SEARCH = '[aria-label="model search"]'

// The screen lists every pipeline (the highlight fixture seeds one too), so every
// assertion is scoped to the card of the pipeline under test: the SMALLEST element
// holding both its name and the filter line.
const cardScript = `(n) => {
  const hits = [...document.querySelectorAll('div')]
    .filter(e => e.innerText && e.innerText.includes(n) && e.innerText.includes('filter:'))
  hits.sort((a, b) => a.innerText.length - b.innerText.length)
  return hits[0] || null
}`

async function pipelineCardText(page) {
  return page.evaluate((src, n) => {
    // eslint-disable-next-line no-eval
    const card = eval('(' + src + ')')(n)
    return card ? card.innerText : ''
  }, cardScript, PIPE_NAME)
}

async function clickInPipelineCard(page, text) {
  return page.evaluate((src, n, t) => {
    // eslint-disable-next-line no-eval
    const card = eval('(' + src + ')')(n)
    if (!card) return false
    const hits = [...card.querySelectorAll('*')].filter(e => e.innerText === t && e.offsetParent)
    if (!hits.length) return false
    const pointer = hits.filter(e => getComputedStyle(e).cursor === 'pointer')
    const el = (pointer.length ? pointer : hits).sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
      return rb.width * rb.height - ra.width * ra.height
    })[0]
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }, cardScript, PIPE_NAME, text)
}

async function openPipelineSteps(page) {
  await page.goto(`${BASE_URL}/pipelines`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForFunction(n => document.body.innerText.includes(n), { timeout: 10000 }, PIPE_NAME)
  if (!await clickInPipelineCard(page, '▶ Steps')) return 'no Steps toggle on the pipeline card'
  await page.waitForSelector(PROMPT_FIELD, { timeout: 6000 })
  return null
}

async function seededPipeline(token) {
  const res = await fetch(`${BASE_URL}/api/v1/pipelines`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`GET /api/v1/pipelines: HTTP ${res.status}`)
  return (await res.json()).find(p => p.id === PIPE_ID)
}

async function runPipelineStepsUi(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.goto(`${BASE_URL}/pipelines`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForFunction(n => document.body.innerText.includes(n), { timeout: 10000 }, PIPE_NAME)

  await check('pipelines: a feed-scoped pipeline is not summarized as "all documents"', async () => {
    const txt = await pipelineCardText(page)
    if (!txt) return 'the seeded pipeline card did not render'
    if (/all documents/.test(txt)) return `a source_feed_id filter still reads "all documents": "${txt}"`
    if (!txt.includes(PIPE_FEED_ID)) return `the card does not name the feed it is scoped to: "${txt}"`
    return null
  })

  await check('pipelines: the Steps section shows the prompt the step actually runs', async () => {
    const err = await openPipelineSteps(page)
    if (err) return err
    const prompt = await page.$eval(PROMPT_FIELD, el => el.value)
    if (!prompt.includes('three caveman bullets')) return `the prompt field does not hold the stored prompt: "${prompt.slice(0, 80)}"`
    const txt = await pipelineCardText(page)
    return txt.includes('Summarize') ? null : `the step does not render its catalog label: "${txt.slice(0, 200)}"`
  })

  await check('pipelines: a legacy step api_key is nowhere in the page', async () => {
    const leak = await page.evaluate(secret => {
      const html = document.documentElement.outerHTML
      const values = [...document.querySelectorAll('input,textarea')].map(el => el.value).join('\n')
      return {
        secret: html.includes(secret) || values.includes(secret),
        field: /api[_-]?key/i.test(html),
      }
    }, PIPE_SECRET)
    if (leak.secret) return 'the step api_key value is rendered in the page'
    return leak.field ? 'an api_key field is rendered — it must not exist in the DOM at all' : null
  })

  await check('pipelines: the raw JSON view shows the steps without the credential', async () => {
    if (!await clickInPipelineCard(page, 'raw JSON')) return 'no raw JSON toggle'
    await sleep(300)
    const txt = await pipelineCardText(page)
    if (!txt.includes('"kind": "llm_summarize"')) return `no pretty-printed steps in the raw view: "${txt.slice(-300)}"`
    if (/api_key/i.test(txt)) return 'the raw JSON view leaks the api_key'
    if (!await clickInPipelineCard(page, 'hide raw JSON')) return 'the raw JSON toggle does not close'
    return null
  })

  // The interaction, not the API: the model is picked from a provider-grouped,
  // searchable list, and choosing one must write BOTH model and provider — a model
  // aimed at the wrong endpoint is a 404 that never falls back.
  await check('pipelines: the model field opens a picker grouped by provider', async () => {
    const err = await openPipelineSteps(page)
    if (err) return err
    await page.click(MODEL_FIELD)
    await page.waitForSelector(MODEL_SEARCH, { timeout: 6000 })
    await sleep(400)
    const txt = await page.evaluate(() => document.body.innerText)
    if (!txt.includes(STUB_PROVIDER_ID)) {
      return `the picker does not group by provider (no "${STUB_PROVIDER_ID}" header): ${txt.slice(-400)}`
    }
    for (const m of STUB_LLM_MODELS) {
      if (!txt.includes(m)) return `the picker does not offer "${m}" — the catalog did not reach it`
    }
    return null
  })

  await check('pipelines: searching filters the grouped list down to the match', async () => {
    await page.click(MODEL_SEARCH)
    await page.keyboard.type(PIPE_NEW_MODEL.slice(-5), { delay: 30 })
    await sleep(400)
    const txt = await page.evaluate(() => document.body.innerText)
    if (!txt.includes(PIPE_NEW_MODEL)) return `the searched-for model disappeared: ${txt.slice(-300)}`
    if (txt.includes(STUB_LLM_MODELS[0])) return `search did not filter out "${STUB_LLM_MODELS[0]}"`
    return null
  })

  await check('pipelines: picking a model writes model AND provider, and saving persists both', async () => {
    await page.click(`[aria-label="model ${PIPE_NEW_MODEL}"]`)
    await sleep(300)
    const shown = await page.$eval(MODEL_FIELD, el => el.innerText)
    if (!shown.includes(PIPE_NEW_MODEL)) return `the field still reads "${shown}" after picking`
    await page.click(`[aria-label="Save steps ${PIPE_NAME}"]`)
    await page.waitForFunction(() => document.body.innerText.includes('Steps saved'), { timeout: 8000 })

    const steps = JSON.parse((await seededPipeline(token)).steps)
    if (steps[0]?.config?.model !== PIPE_NEW_MODEL) return `the server kept model "${steps[0]?.config?.model}"`
    if (steps[0]?.config?.provider !== STUB_PROVIDER_ID) {
      return `the provider was not written alongside the model: "${steps[0]?.config?.provider}"`
    }
    if (!String(steps[0]?.config?.prompt || '').includes('three caveman bullets')) return 'saving the model dropped the prompt'
    if (/api_key/i.test((await seededPipeline(token)).steps)) return 'the save did not drop the legacy api_key'
    return null
  })

  await check('pipelines: the picked model is what the editor shows after a reload', async () => {
    const err = await openPipelineSteps(page)
    if (err) return err
    const model = await page.$eval(MODEL_FIELD, el => el.innerText)
    return model.includes(PIPE_NEW_MODEL) ? null : `the model field reloaded as "${model}"`
  })

  await sleep(300)
  if (errors.length) fail('pipeline steps: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('pipeline steps: no console/HTTP errors')

  await page.close()
}

// ── Reading mode: flow / auto / page + the page threshold ─────────────────────
// `auto` is the default: paginate only past the threshold. The decision is made
// inside the frame (only it can measure), so every check here reads the frame's
// resolved state, and the threshold is driven through the real Settings field.
const THRESHOLD_FIELD = '[aria-label="Page threshold"]'
const AUTO_SWITCH = 'input[aria-label="Auto page mode"]'

// `from` is the value the field must already show — the preference hydrates from
// storage a tick after the screen mounts, and typing before that lands would be
// overwritten by the hydrated value.
async function focusThresholdField(page, from) {
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForFunction((sel, v) => document.querySelector(sel)?.value === v,
    { timeout: 8000 }, THRESHOLD_FIELD, from)
  await page.click(THRESHOLD_FIELD, { clickCount: 3 })
}

async function setThreshold(page, value, from) {
  await focusThresholdField(page, from)
  await page.keyboard.type(value, { delay: 150 })
  await sleep(300) // let the last keystroke land before the blur commits it
  await page.keyboard.press('Tab')
  await sleep(400)
  return page.$eval(THRESHOLD_FIELD, el => el.value)
}

async function openDoc(page, docId) {
  await page.goto(`${BASE_URL}/document/${docId}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)
  await sleep(700) // the frame resolves the mode right after `init`
}

async function runReadingMode(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.setViewport({ width: 900, height: 700 })

  // The previous suite left the preference on Flow (global, persisted) — put it
  // back to the default the rest of these checks are about.
  await openDoc(page, SHORT_DOC_ID)
  await check('reading mode: the Auto segment is selectable in the meta panel', async () => {
    if (!await setReadingMode(page, 'Auto')) return 'no Auto segment in the meta panel'
    return waitPaginated(page, false)
  })

  await check('auto: a document under the threshold stays in continuous scroll', async () => {
    await openDoc(page, SHORT_DOC_ID)
    if (await isPaginated(page)) return 'short document paginated under auto'
    const o = await frameOverflow(page)
    return o.h > 2 ? `body has horizontal page overflow (${o.h}px) outside page mode` : null
  })

  await check('auto: the info line names the length, the limit and the resolution', async () => {
    if (!await openMetaPanel(page)) return 'meta panel did not open'
    const line = await readingInfo(page)
    await closeMetaPanel(page)
    if (!/limit 20/.test(line)) return `info line does not name the limit: "${line}"`
    if (!/continuous/.test(line)) return `info line does not report the resolution: "${line}"`
    return /pages here/.test(line) ? null : `info line does not report this document's length: "${line}"`
  })

  await check('auto: a document over the threshold opens paginated', async () => {
    await openDoc(page, LONG_DOC_ID)
    const err = await waitPaginated(page, true)
    if (err) return err
    const p = await pageTotal(page)
    if (!p) return 'no page indicator rendered'
    return p.total > 20 ? null : `long document is only ${p.total} pages — not over the 20-page limit`
  })

  await check('flow overrides length: the long document stays continuous', async () => {
    if (!await setReadingMode(page, 'Flow')) return 'no Flow segment'
    const err = await waitPaginated(page, false)
    if (err) return err
    await openDoc(page, LONG_DOC_ID) // and it stays that way on reopen
    return isPaginated(page).then(p => p ? 'long document paginated under Flow' : null)
  })

  await check('page overrides length: the short document paginates', async () => {
    if (!await setReadingMode(page, 'Page')) return 'no Page segment'
    await openDoc(page, SHORT_DOC_ID)
    const err = await waitPaginated(page, true)
    if (err) return err
    const p = await pageTotal(page)
    return p && p.total >= 1 ? null : 'no page indicator on the short document'
  })

  await check('the reading mode survives a reload', async () => {
    await page.reload({ waitUntil: 'networkidle2', timeout: 15000 })
    await waitViewerReady(page)
    await sleep(700)
    return waitPaginated(page, true)
  })

  await check('settings: the auto switch reflects the mode set in the reader', async () => {
    await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle2', timeout: 15000 })
    await page.waitForSelector(THRESHOLD_FIELD, { timeout: 8000 })
    const txt = await page.evaluate(() => document.body.innerText)
    if (!/Auto Page Mode/.test(txt)) return 'no Auto Page Mode card in Settings'
    if (!/forced on for every document/.test(txt)) return 'card does not report the forced Page mode'
    const on = await page.$eval(AUTO_SWITCH, el => el.checked)
    return on === false ? null : `auto switch reads ${on} while the mode is Page`
  })

  await check('settings: flipping the auto switch on restores auto', async () => {
    await page.$eval(AUTO_SWITCH, el => el.click())
    await sleep(400)
    const txt = await page.evaluate(() => document.body.innerText)
    if (!/documents longer than 20 pages open paginated/.test(txt)) return `card still says: ${txt.slice(0, 200)}`
    await openDoc(page, SHORT_DOC_ID)
    return isPaginated(page).then(p => p ? 'short document still paginated after auto was restored' : null)
  })

  await check('settings: raising the threshold un-paginates the long document', async () => {
    const shown = await setThreshold(page, '200', '20')
    if (shown !== '200') return `threshold field shows "${shown}" after typing 200`
    await openDoc(page, LONG_DOC_ID)
    return isPaginated(page).then(p => p ? 'long document still paginated with a 200-page limit' : null)
  })

  await check('settings: junk in the threshold field never reaches the setting', async () => {
    await focusThresholdField(page, '200')
    await page.keyboard.type('abc', { delay: 150 })
    await sleep(300)
    await page.keyboard.press('Tab')
    await sleep(400)
    const shown = await page.$eval(THRESHOLD_FIELD, el => el.value)
    if (shown !== '200') return `field kept junk: "${shown}"`
    const txt = await page.evaluate(() => document.body.innerText)
    return /longer than 200 pages/.test(txt) ? null : 'the stored threshold changed on junk input'
  })

  await check('settings: lowering the threshold paginates the long document again', async () => {
    const shown = await setThreshold(page, '20', '200')
    if (shown !== '20') return `threshold field shows "${shown}" after typing 20`
    await openDoc(page, LONG_DOC_ID)
    const err = await waitPaginated(page, true)
    if (err) return err
    if (!await openMetaPanel(page)) return 'meta panel did not open'
    const line = await readingInfo(page)
    await closeMetaPanel(page)
    return /limit 20 → paginated/.test(line) ? null : `info line reads "${line}"`
  })

  await sleep(400)
  if (errors.length) fail('reading mode: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('reading mode: no console/HTTP errors')

  await page.close()
}

async function main() {
  console.log('\n=== Samizdat integration test ===\n')
  try {
    resetTestEnv()
    stubLLM = startStubLLM()
    serverProc = await startServer()
    const { token, deviceId } = await pairDevice('integration-device')
    seedVideoDoc(deviceId, VIDEO_DOC_ID)
    seedTextDoc(TEXT_DOC)
    seedTextDoc(FIGURE_DOC)
    seedTextDoc(SHORT_DOC)
    seedTextDoc(LONG_DOC)
    seedHighlight({ id: HL_ID, documentId: TEXT_DOC_ID, title: 'Go 1.21 Release', body: HL_BODY })
    seedHighlight({ id: SWIPE_HL_ID, documentId: TEXT_DOC_ID, title: SWIPE_HL_TITLE, body: 'A card that must archive on swipe, never delete.' })
    seedHighlight({ id: DELETE_HL_ID, documentId: TEXT_DOC_ID, title: DELETE_HL_TITLE, body: 'A card whose only delete path on a phone is the footer button.' })
    seedPipeline({ id: PIPE_ID, name: PIPE_NAME, filter: { source_feed_id: PIPE_FEED_ID }, steps: PIPE_STEPS })
    // Provenance: the scrape jobs are what say where these two documents came from.
    seedTextDoc(PIPELINE_DOC)
    seedTextDoc(MANUAL_DOC)
    seedJob({
      id: PIPE_STEP_JOB_ID, kind: 'run_pipeline_step',
      payload: { pipeline_run_id: 'run-added-via', pipeline_name: PIPE_NAME, document_id: TEXT_DOC_ID, document_title: TEXT_DOC.title, step_index: 0 },
    })
    seedJob({
      id: 'job-scrape-pipeline', kind: 'scrape_url',
      payload: { url: PIPELINE_DOC.canonicalUrl },
      result: { document_id: PIPELINE_DOC_ID },
      parentJobId: PIPE_STEP_JOB_ID,
    })
    seedJob({
      id: 'job-scrape-manual', kind: 'scrape_url',
      payload: { url: MANUAL_DOC.canonicalUrl, device_id: deviceId, device_name: ADDED_VIA_DEVICE },
      result: { document_id: MANUAL_DOC_ID },
    })
    seedHighlight({ id: MANUAL_HL_ID, documentId: MANUAL_DOC_ID, title: MANUAL_HL_TITLE, body: MANUAL_HL_BODY })

    console.log('  launching browser...')
    browser = await launchBrowser()

    await runPageChecks(token, deviceId)
    await runAddUrlSheet(token, deviceId)
    await runFeedSwipeArchive(token, deviceId)
    await runTouchDelete(token, deviceId)
    await runAddedVia(token, deviceId)
    await runImageLightbox(token, deviceId)
    await runFigureRendering(token, deviceId)
    await runSelectionLifecycle(token, deviceId)
    await runHighlightSelectionLifecycle(token, deviceId)
    // Before runSettingsServices: that one permanently seeds a broken LLM provider,
    // which would keep the drawer dot lit for every check after it.
    // Before runSettingsServices for the same reason as runPersistFailure: both read a
    // clean error state.
    await runDbLayer(token, deviceId)
    await runPersistFailure(token, deviceId)
    await runSettingsServices(token, deviceId)
    await runPipelineStepsUi(token, deviceId)
    // Last: the reading mode persists globally (AsyncStorage → shared localStorage),
    // so leaving it on Page would silently paginate every earlier check's viewer.
    await runPageMode(token, deviceId)
    await runReadingMode(token, deviceId)
    // Last: it seeds 50 documents, and every check after it would pay for the pull.
    await runLargeReplica(token, deviceId)

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
