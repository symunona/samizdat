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

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  BASE_URL, ROOT, sleep, resetTestEnv, startServer, pairDevice, launchBrowser,
  newConnectedPage, seedTextDoc, seedTextDocs, seedVideoDoc, seedHighlight, seedLLMHealth,
  seedPipeline, seedJob, seedActiveJob, seedFeed,
  startStubLLM, setStubLLMFailing, STUB_LLM_MODELS, STUB_LLM_PORT, STUB_DIGEST_MATCH, STUB_DIGEST_TOPIC, STUB_DIGEST_DIFF,
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
// Its OWN document: a highlight seeded onto TEXT_DOC shows up as an extra card in
// that document's viewer, which shifts which <mark> the annotation checks tap first.
const PROV_DOC_ID = 'dddddddd-0000-4000-8000-000000000007'
const PROV_DOC = {
  id: PROV_DOC_ID,
  title: 'Provenance Source',
  canonicalUrl: 'https://example.com/provenance-source',
  markdown: '# Provenance Source\n\nThe document a machine-written summary was made from.',
}
const PROV_HL_ID = 'ffffffff-0000-4000-8000-000000000009'
const PROV_HL_TITLE = 'Provenance Card'
const PROV_MODEL = 'qwen3:4b-instruct-ctx7k'
// Its own prose, never HL_BODY: an annotation marks EVERY copy of its anchor text it
// can find, so a second card repeating that body puts a stray <mark> in the feed and
// the annotation checks tap the wrong one.
const PROV_HL_BODY = [
  'Summary card whose provenance the overlay has to spell out.',
  '',
  'The body only has to be long enough that the feed card clips it and renders the ' +
    'More affordance the overlay opens from, so this paragraph keeps going past the ' +
    'eight hundred character threshold with prose that appears nowhere else in the ' +
    'fixtures. Nothing here is anchored by any annotation, nothing here repeats the ' +
    'release-notes card, and nothing here is meant to be read: it exists so the card ' +
    'clips, shows More, and opens the highlight overlay where the model name, the ' +
    'provider, the token cap, the temperature and the token counts of the call that ' +
    'wrote this summary are supposed to appear on a single dim line under the body. ' +
    'One more paragraph of nothing in particular carries the body over the eight ' +
    'hundred character clip threshold, which is what makes the card render the More ' +
    'affordance this check taps to reach the overlay in the first place.',
].join('\n')
// The shape `pipeline.highlightProvenance` writes: what ACTUALLY served the call.
const PROV_METADATA = JSON.stringify({
  model: PROV_MODEL, provider: 'ollama-xayah', step: 'llm_summarize',
  max_tokens: 512, temperature: 0.25, tokens_in: 5120, tokens_out: 180, prompt_sha: 'a3f19c2d',
})
const DELETE_HL_TITLE = 'Tap To Delete'

// The WebView highlight card lost its swipe-triage; this one is dragged (must not
// move) and then deleted through the footer button (the capability must survive).
const NOSWIPE_HL_ID = 'ffffffff-0000-4000-8000-000000000005'
const NOSWIPE_HL_TITLE = 'Gesture Free Card'

// Note-indicator triple: one annotated, one bare (the negative half), one annotated
// AND pinned — pinned is applied last and must stay SOLID so the two read apart.
const NOTED_HL_ID = 'ffffffff-0000-4000-8000-000000000006'
const NOTED_HL_TITLE = 'Card With A Note'
const PLAIN_HL_ID = 'ffffffff-0000-4000-8000-000000000007'
const PLAIN_HL_TITLE = 'Card Without A Note'
const PINNED_NOTED_HL_ID = 'ffffffff-0000-4000-8000-000000000008'
const PINNED_NOTED_HL_TITLE = 'Starred And Noted Card'

// The four extra cards on TEXT_DOC. `noted` drives the annotation seeded for them.
const CARD_HLS = [
  { id: NOSWIPE_HL_ID, title: NOSWIPE_HL_TITLE, body: 'A card a horizontal drag must never move.' },
  { id: NOTED_HL_ID, title: NOTED_HL_TITLE, body: 'A card someone wrote a note on.', noted: true },
  { id: PLAIN_HL_ID, title: PLAIN_HL_TITLE, body: 'A card nobody wrote a note on.' },
  { id: PINNED_NOTED_HL_ID, title: PINNED_NOTED_HL_TITLE, body: 'A card that is starred and noted.', pinned: 1, noted: true },
]

// `t.colors.accent` (src/theme.ts) as the browser reports it.
const ACCENT_RGB = 'rgb(232, 116, 59)'

// Date fixtures: a document published in JANUARY carrying highlights ingested in
// April / May / June. Every date is unambiguous, and none of them is "now", so a card
// printing the publication date (the old bug) or the wrong row is visible at a glance.
const DATED_DOC_ID = 'dddddddd-0000-4000-8000-000000000007'
const DATED_PUBLISHED_AT = '2026-01-05T12:00:00Z'
const DATED_DOC = {
  id: DATED_DOC_ID,
  title: 'Dated Article',
  canonicalUrl: 'https://example.com/dated-article',
  markdown: '# Dated Article\n\nPublished long before any of its highlights were ingested.',
  publishedAt: DATED_PUBLISHED_AT,
}
// Seeded in a SHUFFLED order on purpose: insertion order must not be what the feed
// renders — `created_at DESC` must be.
const DATE_HLS = [
  { id: 'ffffffff-0000-4000-8000-00000000000b', title: 'Ingested In May', createdAt: '2026-05-10T12:00:00Z' },
  { id: 'ffffffff-0000-4000-8000-00000000000c', title: 'Ingested In April', createdAt: '2026-04-01T12:00:00Z' },
  { id: 'ffffffff-0000-4000-8000-00000000000a', title: 'Ingested In June', createdAt: '2026-06-15T12:00:00Z' },
]
// Newest first — what the rendered feed must match.
const DATE_HLS_BY_INGEST = [...DATE_HLS].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

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

// ── Documents "Add URL" → reject a relative path · cancel a pending scrape ──
// A vault path pasted into the URL box used to queue a scrape that burned the
// whole retry schedule before dying. It must fail in the input, queueing nothing.
// A real URL whose fetch hangs (blackholed IP) must be cancellable from its
// pending row, and must not come back on the next poll.
const RELATIVE_PATH = 'org/99-samizdat/documents/2016-W24/dive-in.md'
const HANG_URL = 'http://10.255.255.1/e2e-cancel'

async function runDocumentsAddCancel(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.goto(`${BASE_URL}/documents`, { waitUntil: 'networkidle2', timeout: 15000 })
  await sleep(1500)

  const scrapeJobs = () => page.evaluate(async (base) => {
    const tok = JSON.parse(localStorage.getItem('samizdat_connection')).token
    const r = await fetch(`${base}/api/v1/jobs?kind=scrape_url`, { headers: { Authorization: `Bearer ${tok}` } })
    return r.json()
  }, BASE_URL)
  const submit = async (value) => {
    await page.evaluate((v) => {
      const input = [...document.querySelectorAll('input')].find(i => i.placeholder === 'https://example.com/article')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, v)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, value)
    return clickByText(page, (e) => e.innerText === 'Add URL', 'Add URL button')
  }

  await check('documents: relative path is rejected in the input (no job queued)', async () => {
    if (!await submit(RELATIVE_PATH)) return 'no Add URL button'
    await sleep(400)
    const body = await page.evaluate(() => document.body.innerText)
    if (!/valid http/i.test(body)) return 'no validation message shown'
    return (await scrapeJobs() || []).some(j => (j.payload || '').includes('dive-in.md'))
      ? 'a scrape_url job was queued for the relative path' : null
  })

  await check('documents: ✕ on a pending scrape cancels it for good', async () => {
    if (!await submit(HANG_URL)) return 'no Add URL button'
    const job = await (async () => {
      for (let i = 0; i < 20; i++) {
        const j = (await scrapeJobs() || []).find(x => (x.payload || '').includes('e2e-cancel'))
        if (j) return j
        await sleep(250)
      }
    })()
    if (!job) return 'no scrape_url job for the hanging URL'
    const sel = `[data-testid="cancel-job-${job.id}"]`
    try { await page.waitForSelector(sel, { timeout: 5000 }) } catch { return 'pending row has no cancel button' }
    await page.click(sel)
    try {
      await page.waitForFunction((u) => !document.body.innerText.includes(u), { timeout: 4000 }, HANG_URL)
    } catch { return 'pending row still visible after cancel' }
    // Two poll cycles (3s each while watching): the row must not resurrect.
    await sleep(7000)
    if ((await page.evaluate(() => document.body.innerText)).includes(HANG_URL)) return 'cancelled row came back on poll'
    return (await scrapeJobs() || []).some(j => j.id === job.id) ? 'cancelled job still listed by the API' : null
  })

  if (errors.length) fail('documents add/cancel: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('documents add/cancel: no console/HTTP errors')

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

// The popout (HighlightDetail Modal) is the feed's only iframe.
const popoutOpen = (page) => page.evaluate(() => !!document.querySelector('iframe'))

async function runFeedSwipeArchive(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.setViewport({ width: 900, height: 800 })
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 10000 }, SWIPE_HL_TITLE)
  await sleep(600)

  // RNGH's pan runs outside the RN responder system on web, so a drag that starts on
  // the card body used to end as a press on it — every swipe (and every text selection)
  // opened the popout. Both a short drag (under the swipe threshold) and a full swipe
  // must leave it closed.
  await check('feed: a short horizontal drag on a card does not open the popout', async () => {
    const rect = await cardRect(page, SWIPE_HL_TITLE)
    if (!rect) return 'swipe card not found in the feed'
    await dragX(page, rect, 30)
    if (await popoutOpen(page)) return 'a 30px drag opened the highlight popout'
    const hl = await apiHighlight(page, SWIPE_HL_ID)
    return hl && hl.archived_at ? 'a 30px drag archived the card' : null
  })

  await check('feed: swiping a card right archives it (not deletes)', async () => {
    const rect = await cardRect(page, SWIPE_HL_TITLE)
    if (!rect) return 'swipe card not found in the feed'
    await dragX(page, rect, 220)
    if (await popoutOpen(page)) return 'the swipe also opened the highlight popout'
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

// Anchor an Annotation to a Highlight through the real endpoint. Seeding the row
// directly would skip the `highlight_id` round trip the card's indicator depends on.
async function postAnnotation(token, { documentId, highlightId, exact, note }) {
  const res = await fetch(`${BASE_URL}/api/v1/documents/${documentId}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ exact, note, color: 'yellow', highlight_id: highlightId }),
  })
  if (!res.ok) throw new Error(`POST annotation for ${highlightId}: HTTP ${res.status}`)
  return res.json()
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
      const ifr = document.querySelector('iframe')
      const row = ifr.contentDocument.getElementById('sel-actions')
      return row ? ifr.contentWindow.getComputedStyle(row).display : 'none'
    })
    return disp === 'flex' ? null : `sel-actions display is "${disp}"`
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

// ── Provenance: what model wrote this summary, with what params ───────────────
// A machine-written Highlight carries its provenance in `metadata` (JSON), and the
// overlay is where it shows. The negative half is the point: a highlight whose
// metadata is `{}` (hand-seeded, or written before provenance existed) must render
// NO line at all rather than an empty row of separators.
async function runHighlightProvenance(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.setViewport({ width: 900, height: 2400 })
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 20000 }, PROV_HL_TITLE)

  await openOverlayFor(page, PROV_HL_TITLE)
  await check('hl overlay: provenance names the model that wrote it', async () => {
    const text = await page.evaluate(() => document.body.innerText)
    for (const want of [PROV_MODEL, 'ollama-xayah', '512 tok', 't 0.25', '5.1k→180']) {
      if (!text.includes(want)) return `the provenance line is missing "${want}"`
    }
    return null
  })

  await clickByText(page, e => (e.innerText || '').trim() === '✕', 'close overlay')
  await sleep(400)

  // The control: same overlay, a highlight with no provenance recorded.
  await openOverlayFor(page, 'Go 1.21 Release')
  await check('hl overlay: no provenance recorded renders no line', async () => {
    const text = await page.evaluate(() => document.body.innerText)
    if (text.includes(PROV_MODEL)) return 'the previous card\'s provenance is still on screen'
    if (/\n\s*·/.test(text)) return 'an empty provenance line rendered for a highlight with none'
    return null
  })

  await sleep(300)
  await page.close()
  if (errors.length) throw new Error(`JS errors: ${errors.join(' | ')}`)
}

// Open the "More…" overlay of ONE named card (clickByText would take whichever
// affordance is topmost, which is a different card as fixtures accumulate).
async function openOverlayFor(page, title) {
  const opened = await page.evaluate((src, t) => {
    // eslint-disable-next-line no-eval
    const card = eval('(' + src + ')')(t)
    if (!card) return false
    const more = [...card.querySelectorAll('*')].find(e => (e.innerText || '').trim() === 'More…')
    if (!more) return false
    more.scrollIntoView({ block: 'center' })
    more.click()
    return true
  }, feedCardScript, title)
  if (!opened) throw new Error(`could not open the overlay of "${title}" ("More…" not found)`)
  await waitViewerReady(page)
}

// ── The highlight-details overlay selection lifecycle (the hard case) ──────────
// The overlay (src/HighlightDetail.tsx) hosts the SAME webview bundle as the doc
// viewer, but is STORE-ONLY: its marks derive solely from useSyncStore annotations
// filtered by highlight_id, so a rendered <mark> is itself proof the store carries a
// highlight-anchored annotation (no other source feeds the marks). We drive the real
// feed → overlay → select → annotate path and assert the visible mark.
async function openHighlightOverlay(page) {
  // The feed card clips the long body and shows a "More…" affordance; tapping it opens
  // the selectable overlay (HighlightDetail Modal → iframe). Named, not "the first
  // More…": other long-bodied fixtures render one too.
  await openOverlayFor(page, 'Go 1.21 Release')
}

// Runs in the page: which pieces of the first annotation carry data-noted, and the
// painted ::after dot (width + fill) of the last piece.
function noteDotInfo() {
  const d = document.querySelector('iframe').contentDocument
  const first = d.querySelector('mark[data-ann-id]')
  const pieces = first ? [...d.querySelectorAll(`mark[data-ann-id="${first.dataset.annId}"]`)] : []
  const last = pieces[pieces.length - 1]
  return {
    pieces: pieces.length,
    noted: pieces.map((m, i) => (m.hasAttribute('data-noted') ? i : -1)).filter(i => i >= 0),
    dot: last ? (({ width, backgroundColor }) => `${width} ${backgroundColor}`)(d.defaultView.getComputedStyle(last, '::after')) : '',
  }
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
      const ifr = document.querySelector('iframe')
      const row = ifr.contentDocument.getElementById('sel-actions')
      return row ? ifr.contentWindow.getComputedStyle(row).display : 'none'
    })
    return disp === 'flex' ? null : `sel-actions display is "${disp}"`
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
  // Save with Ctrl+Enter, not the button — the other annotation flows cover the click.
  await page.focus('textarea')
  await page.keyboard.down('Control')
  await page.keyboard.press('Enter')
  await page.keyboard.up('Control')

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

  // 3b. A noted annotation carries the note dot on its LAST piece only, and the dot
  //     actually paints (the ::after box-shadow), not just an attribute.
  await check('hl overlay: noted highlight shows the note dot', async () => {
    const info = await page.evaluate(noteDotInfo)
    if (info.pieces < 2) return `expected multi-piece mark, got ${info.pieces}`
    if (info.noted.join() !== String(info.pieces - 1)) return `data-noted on pieces [${info.noted}], want only the last`
    return /^6px rgb/.test(info.dot) ? null : `note dot not painted ("${info.dot}")`
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
  // 5a. Clear the note (whitespace counts as empty) and save → the dot goes away, the
  //     highlight stays.
  await page.evaluate(() => {
    const ta = document.querySelector('textarea')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, '   ')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.focus('textarea')
  await page.keyboard.down('Control')
  await page.keyboard.press('Enter')
  await page.keyboard.up('Control')
  await check('hl overlay: clearing the note removes the dot', async () => {
    try {
      await page.waitForFunction(() => {
        const d = document.querySelector('iframe').contentDocument
        return d.querySelectorAll('mark[data-ann-id]').length >= 2 && !d.querySelector('mark[data-noted]')
      }, { timeout: 6000 })
      return null
    } catch {
      const info = await page.evaluate(noteDotInfo)
      return `after clearing: ${info.pieces} piece(s), data-noted on [${info.noted}]`
    }
  })
  // Reopen the (now note-less) annotation so the backdrop close below has a panel.
  await page.evaluate(() => {
    const d = document.querySelector('iframe').contentDocument
    d.querySelector('mark[data-ann-id]').dispatchEvent(new d.defaultView.MouseEvent('click', { bubbles: true }))
  })
  await page.waitForSelector('textarea', { timeout: 6000 })

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

// ── The WebView highlight card has NO swipe gesture ───────────────────────────
// A `.hl-card` used to drag left/right for star/delete — a gesture duplicating two
// unconditional footer buttons, so it only bought accidental deletes and a swallowed
// horizontal pan. Removing it is only real if BOTH halves hold: a drag moves nothing,
// and the buttons still do the job the gesture used to.
async function runDocViewerNoSwipe(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.setViewport({ width: 900, height: 800 })
  await page.goto(`${BASE_URL}/document/${TEXT_DOC_ID}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)
  await page.waitForFunction((id) => {
    const d = document.querySelector('iframe').contentDocument
    return !!d.querySelector(`.hl-card[data-id="${id}"]`)
  }, { timeout: 12000 }, NOSWIPE_HL_ID)

  await check('doc viewer: a highlight card claims no touch-action of its own', async () => {
    const ta = await page.evaluate((id) => {
      const d = document.querySelector('iframe').contentDocument
      return d.defaultView.getComputedStyle(d.querySelector(`.hl-card[data-id="${id}"]`)).touchAction
    }, NOSWIPE_HL_ID)
    return ta === 'auto' ? null : `.hl-card sets touch-action: ${ta} — it would swallow the pan again`
  })

  // The removed handlers listened on the frame's own document for
  // pointerdown/pointermove/pointerup, so a stepped pointer drag is exactly what used
  // to translate the card. Sampled at every step: a swipe that snapped back on release
  // would still be a swipe.
  const drag = await page.evaluate((id) => {
    const ifr = document.querySelector('iframe')
    const d = ifr.contentDocument, w = ifr.contentWindow
    const card = d.querySelector(`.hl-card[data-id="${id}"]`)
    const r = card.getBoundingClientRect()
    const y = r.top + Math.min(r.height / 2, 60)
    const x0 = r.left + 30
    const fire = (type, x) => card.dispatchEvent(new w.PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: 1, clientX: x, clientY: y,
    }))
    const transforms = []
    const hints = []
    fire('pointerdown', x0)
    for (let i = 1; i <= 12; i++) {
      fire('pointermove', x0 + (140 * i) / 12)
      transforms.push(card.style.transform)
      hints.push(!!d.getElementById('hl-swipe-hint'))
    }
    fire('pointerup', x0 + 140)
    return {
      transforms,
      hints,
      after: card.style.transform,
      hintAfter: !!d.getElementById('hl-swipe-hint'),
      className: card.className,
    }
  }, NOSWIPE_HL_ID)

  await check('doc viewer: dragging a highlight card 140px right moves nothing', async () => {
    const moved = drag.transforms.find(t => t && t !== 'none')
    if (moved) return `the card translated mid-drag ("${moved}") — the swipe handler is back`
    if (drag.after && drag.after !== 'none') return `the card kept transform "${drag.after}" after pointerup`
    if (/hl-swiping/.test(drag.className)) return 'the card still takes the .hl-swiping class'
    return null
  })

  await check('doc viewer: no #hl-swipe-hint ever exists', async () =>
    drag.hints.some(Boolean) || drag.hintAfter
      ? 'the swipe hint element was created — the swipe UI is back' : null)

  await check('doc viewer: the dragged highlight is still there after pointerup', async () => {
    const present = await page.evaluate((id) => {
      const d = document.querySelector('iframe').contentDocument
      return !!d.querySelector(`.hl-card[data-id="${id}"]`)
    }, NOSWIPE_HL_ID)
    if (!present) return 'the drag removed the card from the list'
    return await apiHighlight(page, NOSWIPE_HL_ID) ? null : 'the drag deleted the highlight on the server'
  })

  await check('doc viewer: the footer trash still deletes the card', async () => {
    const clicked = await page.evaluate((id) => {
      const ifr = document.querySelector('iframe')
      const btn = ifr.contentDocument.querySelector(`.hl-card[data-id="${id}"] [data-action="delete"]`)
      if (!btn) return false
      btn.dispatchEvent(new ifr.contentWindow.MouseEvent('click', { bubbles: true, cancelable: true }))
      return true
    }, NOSWIPE_HL_ID)
    if (!clicked) return 'no footer trash button on the card'
    try {
      await page.waitForFunction((id) => !document.querySelector('iframe').contentDocument
        .querySelector(`.hl-card[data-id="${id}"]`), { timeout: 6000 }, NOSWIPE_HL_ID)
    } catch { return 'the card is still in the list after pressing the trash button' }
    for (let i = 0; i < 20; i++) {
      if (!await apiHighlight(page, NOSWIPE_HL_ID)) return null
      await sleep(300)
    }
    return 'the card vanished locally but the delete never reached the server'
  })

  await sleep(400)
  if (errors.length) fail('doc viewer no-swipe: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('doc viewer no-swipe: no console/HTTP errors')

  await page.close()
}

// ── A highlight carrying a note is marked as such, on BOTH renderers ──────────
// `Annotation.highlight_id` was already synced and nothing read it, so a card you had
// written on looked exactly like one you hadn't. The negative half (a sibling card with
// no note) is what makes this a test rather than a screenshot.
//
// The feed card element: the SMALLEST bordered element wide enough to be the card
// itself — the title Text and the inner badges are unbordered or far narrower.
const feedCardScript = `(t) => {
  const hits = [...document.querySelectorAll('*')]
    .filter(e => e.offsetParent && (e.innerText || '').includes(t))
    .filter(e => {
      const r = e.getBoundingClientRect()
      return r.width > 250 && parseFloat(getComputedStyle(e).borderTopWidth) > 0
    })
  hits.sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height)
  return hits[0] || null
}`

async function feedCardBorder(page, title) {
  return page.evaluate((src, t) => {
    // eslint-disable-next-line no-eval
    const card = eval('(' + src + ')')(t)
    if (!card) return null
    const cs = getComputedStyle(card)
    return { style: cs.borderTopStyle, color: cs.borderTopColor, width: cs.borderTopWidth }
  }, feedCardScript, title)
}

// The note pencil is an icon-font glyph, like the trash one above.
const PENCIL_GLYPH = String.fromCodePoint(
  JSON.parse(readFileSync(
    new URL('../app/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json',
      import.meta.url)))['create-outline'])

async function runFeedNoteIndicator(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.setViewport({ width: 900, height: 1600 })
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForFunction(t => document.body.innerText.includes(t), { timeout: 20000 }, PLAIN_HL_TITLE)
  // The flag comes off the replica, so wait for the pulled annotation to land instead
  // of guessing at a delay. A timeout here is not the verdict — the checks below are.
  await page.waitForFunction((src, t) => {
    // eslint-disable-next-line no-eval
    const card = eval('(' + src + ')')(t)
    return !!card && getComputedStyle(card).borderTopStyle === 'dotted'
  }, { timeout: 25000 }, feedCardScript, NOTED_HL_TITLE).catch(() => {})

  await check('feed: an annotated card is bordered dotted in the accent', async () => {
    const b = await feedCardBorder(page, NOTED_HL_TITLE)
    if (!b) return 'the annotated card never rendered'
    if (b.style !== 'dotted') return `border-style is "${b.style}", expected dotted`
    if (b.color !== ACCENT_RGB) return `border-color is "${b.color}", expected the accent ${ACCENT_RGB}`
    if (parseFloat(b.width) < 2) return `border-width is "${b.width}", expected 2px`
    return null
  })

  await check('feed: a card with no note keeps the plain solid border', async () => {
    const b = await feedCardBorder(page, PLAIN_HL_TITLE)
    if (!b) return 'the un-annotated card never rendered'
    if (b.style !== 'solid') return `an un-annotated card reads "${b.style}" — the indicator marks everything`
    if (b.color === ACCENT_RGB) return 'an un-annotated card is painted in the accent'
    return null
  })

  await check('feed: pinned stays SOLID accent on a card that also has a note', async () => {
    const b = await feedCardBorder(page, PINNED_NOTED_HL_TITLE)
    if (!b) return 'the pinned+annotated card never rendered'
    if (b.color !== ACCENT_RGB) return `pinned border-color is "${b.color}"`
    return b.style === 'solid'
      ? null : `pinned+noted reads "${b.style}" — pinned and noted are no longer tellable apart`
  })

  await check('feed: the note pencil is accented on an annotated card only', async () => {
    const colors = await page.evaluate((src, g, noted, plain) => {
      // eslint-disable-next-line no-eval
      const find = eval('(' + src + ')')
      const pencil = (t) => {
        const card = find(t)
        if (!card) return null
        // LAST match, not the first: the outer Pressable also reads as the glyph, and
        // only the innermost node (the icon-font Text) carries the colour.
        const hits = [...card.querySelectorAll('*')].filter(e => e.innerText === g)
        return hits.length ? getComputedStyle(hits[hits.length - 1]).color : 'none'
      }
      return { noted: pencil(noted), plain: pencil(plain) }
    }, feedCardScript, PENCIL_GLYPH, NOTED_HL_TITLE, PLAIN_HL_TITLE)
    if (colors.noted === null || colors.plain === null) return 'a card under test did not render'
    if (colors.noted === 'none') return 'no note pencil on the annotated card'
    if (colors.noted !== ACCENT_RGB) return `the pencil on an annotated card is "${colors.noted}"`
    if (colors.plain === ACCENT_RGB) return 'the pencil is accented on a card with no note'
    return null
  })

  // Same rule, other renderer: the WebView card is raw DOM built by
  // document-viewer.ts, so it can (and did) drift from the RN one.
  await page.goto(`${BASE_URL}/document/${TEXT_DOC_ID}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)
  await page.waitForFunction((id) => !!document.querySelector('iframe').contentDocument
    .querySelector(`.hl-card[data-id="${id}"]`), { timeout: 12000 }, PLAIN_HL_ID)

  await check('doc viewer: the WebView card mirrors the note indicator', async () => {
    try {
      await page.waitForFunction((id) => {
        const c = document.querySelector('iframe').contentDocument.querySelector(`.hl-card[data-id="${id}"]`)
        return !!c && c.classList.contains('hl-noted')
      }, { timeout: 12000 }, NOTED_HL_ID)
    } catch { return 'the annotated WebView card never got .hl-noted' }
    const st = await page.evaluate((noted, plain) => {
      const d = document.querySelector('iframe').contentDocument
      const cs = el => d.defaultView.getComputedStyle(el)
      const n = d.querySelector(`.hl-card[data-id="${noted}"]`)
      const p = d.querySelector(`.hl-card[data-id="${plain}"]`)
      const btn = n.querySelector('[data-action="annotate"]')
      return {
        noted: { style: cs(n).borderTopStyle, color: cs(n).borderTopColor, width: cs(n).borderTopWidth },
        plainNoted: p.classList.contains('hl-noted'),
        plainStyle: cs(p).borderTopStyle,
        btnColor: cs(btn).color,
        btnTitle: btn.title,
      }
    }, NOTED_HL_ID, PLAIN_HL_ID)
    if (st.noted.style !== 'dotted') return `WebView card border-style is "${st.noted.style}"`
    if (st.noted.color !== ACCENT_RGB) return `WebView card border-color is "${st.noted.color}"`
    if (parseFloat(st.noted.width) < 2) return `WebView card border-width is "${st.noted.width}"`
    if (st.plainNoted) return 'the un-annotated WebView card is marked noted'
    if (st.plainStyle === 'dotted') return 'the un-annotated WebView card is dotted too'
    if (st.btnColor !== ACCENT_RGB) return `the WebView note glyph is "${st.btnColor}", not the accent`
    return st.btnTitle === 'Edit note' ? null : `the note button still reads "${st.btnTitle}"`
  })

  await sleep(400)
  if (errors.length) fail('feed note indicator: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('feed note indicator: no console/HTTP errors')

  await page.close()
}

// ── The card prints the date the list is SORTED by ────────────────────────────
// The feed is `highlights.created_at DESC` and the card used to print
// `documents.published_at`: ordered by one date, labelled with another, so the order
// read as random. The fixture's two dates are months apart, so which one is on screen
// is unambiguous.
async function runFeedDateStamp(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  // Tall enough to lay the whole feed out without scrolling: a programmatic scroll
  // would trip the feed's scroll-past auto-archive and remove the cards under test.
  await page.setViewport({ width: 900, height: 2400 })
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForFunction((titles) => titles.every(t => document.body.innerText.includes(t)),
    { timeout: 20000 }, DATE_HLS.map(h => h.title))

  const newest = DATE_HLS_BY_INGEST[0]
  // Format the two dates with the browser's own locale rules — the assertion is about
  // WHICH date is shown, not about how Intl spells it.
  const want = await page.evaluate((ingested, published) => {
    const DAY = { year: 'numeric', month: 'short', day: 'numeric' }
    return {
      ingested: new Date(ingested).toLocaleString(undefined, DAY),
      published: new Date(published).toLocaleString(undefined, DAY),
    }
  }, newest.createdAt, DATED_PUBLISHED_AT)

  const stamp = await page.evaluate((src, t) => {
    // eslint-disable-next-line no-eval
    const card = eval('(' + src + ')')(t)
    if (!card) return null
    const el = card.querySelector('[title]')
    return {
      cardText: card.innerText,
      text: el ? el.innerText.trim() : null,
      title: el ? el.getAttribute('title') : null,
    }
  }, feedCardScript, newest.title)

  await check('feed: the visible date is the INGEST date, not the publication date', async () => {
    if (!stamp) return 'the dated card never rendered'
    if (stamp.text === null) return `no date stamp on the card: "${stamp.cardText.slice(0, 200)}"`
    if (stamp.text !== want.ingested) return `the card shows "${stamp.text}", expected the ingest date ${want.ingested}`
    if (stamp.cardText.includes(want.published)) return `the publication date ${want.published} is on the card as well`
    return null
  })

  await check('feed: the stamp carries both dates for the reveal', async () => {
    if (!stamp || !stamp.title) return 'the date stamp has no title attribute — nothing reveals the second date'
    if (!stamp.title.includes('Ingested ')) return `the tooltip has no "Ingested" line: "${stamp.title}"`
    if (!stamp.title.includes('Article created ')) return `the tooltip has no "Article created" line: "${stamp.title}"`
    if (!stamp.title.includes(want.ingested)) return `the tooltip does not name the ingest date: "${stamp.title}"`
    if (!stamp.title.includes(want.published)) return `the tooltip does not name the publication date: "${stamp.title}"`
    return null
  })

  await check('feed: the rendered order is created_at DESC', async () => {
    const tops = await page.evaluate((src, titles) => titles.map((t) => {
      // eslint-disable-next-line no-eval
      const card = eval('(' + src + ')')(t)
      return card ? card.getBoundingClientRect().top : null
    }), feedCardScript, [MANUAL_HL_TITLE, ...DATE_HLS_BY_INGEST.map(h => h.title)])
    if (tops.some(t => t === null)) return `a card under test did not render (tops: ${JSON.stringify(tops)})`
    const [now, ...dated] = tops
    for (let i = 1; i < dated.length; i++) {
      if (dated[i] <= dated[i - 1]) {
        return `${DATE_HLS_BY_INGEST[i].title} is not below ${DATE_HLS_BY_INGEST[i - 1].title} ` +
          `(${dated[i - 1]} → ${dated[i]}) — the feed is not ordered by created_at DESC`
      }
    }
    return dated[0] > now ? null : 'a back-dated card sorted above a freshly ingested one'
  })

  await sleep(300)
  if (errors.length) fail('feed date stamp: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('feed date stamp: no console/HTTP errors')

  await page.close()
}

// ── The annotation composer shows what you anchored ───────────────────────────
// Mirrors runSelectionLifecycle's hard case (a span crossing the inline <a>) and then
// asserts the one thing that used to be missing: the panel showing the selected text,
// above the input, on create AND on re-open of a saved mark.
const CONTEXT_NOTE = 'note whose anchor the panel must show'

// The quote block: the deepest element whose text IS the anchored string. RN-Web renders
// <Text numberOfLines={4}> as a clamped div, so the whole string is in textContent even
// when it is visually cut.
// The annotation ids currently marked in the viewer.
async function markIds(page) {
  return page.evaluate(() => [...document.querySelector('iframe').contentDocument
    .querySelectorAll('mark[data-ann-id]')].map(m => m.dataset.annId))
}

async function panelQuote(page, want) {
  return page.evaluate((w) => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim()
    const ta = document.querySelector('textarea')
    const hits = [...document.querySelectorAll('div,span')]
      .filter(e => e.offsetParent && norm(e.textContent) === norm(w))
    const el = hits[hits.length - 1]
    if (!el || !ta) return { found: !!el, textarea: !!ta, panelText: document.body.innerText.slice(-400) }
    return {
      found: true,
      textarea: true,
      beforeInput: !!(el.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING),
      aboveInput: el.getBoundingClientRect().bottom <= ta.getBoundingClientRect().top + 1,
      noteValue: ta.value,
    }
  }, want)
}

async function openAnnPanelOnSelection(page) {
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
  await page.evaluate(() => {
    const ifr = document.querySelector('iframe')
    ifr.contentDocument.getElementById('ann-btn')
      .dispatchEvent(new ifr.contentWindow.MouseEvent('click', { bubbles: true }))
  })
  await page.waitForSelector('textarea', { timeout: 6000 })
  return selText.trim()
}

// ── Selection context menu + AI popout ────────────────────────────────────────
// The "···" beside Annotate opens a configurable action sheet; two of its kinds
// run an LLM call and land in a popout. The whole point of the feature is what
// the reader SEES, so this drives it end to end: select → ··· → pick → answer →
// keep it as an Annotation anchored to the ORIGINAL selection (the reload check
// is what proves the anchor was not disturbed by the wide-context fields).
const CTX_ASK_TITLE = 'E2E Explain'
const CTX_DISABLED_TITLE = 'E2E Never Shown'
const STUB_LLM_PROVIDER = `127.0.0.1:${STUB_LLM_PORT}`

async function putContextMenu(token, menu) {
  const res = await fetch(`${BASE_URL}/api/v1/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ context_menu: menu }),
  })
  if (!res.ok) throw new Error(`PUT context_menu: HTTP ${res.status}`)
  return res.json()
}

async function llmCallCount(token) {
  const res = await fetch(`${BASE_URL}/api/v1/settings`, { headers: { Authorization: `Bearer ${token}` } })
  const body = await res.json()
  return body.llm_usage?.total_calls ?? 0
}

// Select across the inline <a> — the hard case: the anchor spans several text
// nodes. Leaves the action row up (the caller reads its geometry, then clicks).
async function selectAcrossLink(page) {
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
  await sleep(200)
  return selText.trim()
}

async function clickSelMore(page) {
  await page.evaluate(() => {
    const ifr = document.querySelector('iframe')
    ifr.contentDocument.getElementById('sel-more-btn')
      .dispatchEvent(new ifr.contentWindow.MouseEvent('click', { bubbles: true }))
  })
  await sleep(500)
}

// Select + open the menu, for the second and later rounds (the first one reads
// the button geometry in between).
async function openSelectionMenu(page) {
  const selText = await selectAcrossLink(page)
  await clickSelMore(page)
  return selText
}

async function runSelectionContextMenu(token, deviceId) {
  await putContextMenu(token, {
    master_prompt: 'You are terse.',
    items: [
      { id: 'copy', kind: 'copy', title: 'Copy to clipboard', enabled: true },
      { id: 'web_search', kind: 'web_search', title: 'Web search', enabled: true },
      {
        id: 'e2e-ask', kind: 'ask', title: CTX_ASK_TITLE, enabled: true,
        template: 'Context: {{selection_wider_context}}\n\nExplain: {{selection}}',
        provider: STUB_LLM_PROVIDER, model: STUB_LLM_MODELS[0],
      },
      { id: 'e2e-off', kind: 'ask', title: CTX_DISABLED_TITLE, enabled: false, template: 'never {{selection}}' },
    ],
  })
  const callsBefore = await llmCallCount(token)

  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.setViewport({ width: 900, height: 900 })
  await page.goto(`${BASE_URL}/document/${TEXT_DOC_ID}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)

  const selText = await selectAcrossLink(page)

  await check('ctx menu: the selection under test crosses the inline link', async () =>
    selText.includes('download page') ? null : `selection did not cross the link: "${selText}"`)

  // Read the row BEFORE opening the menu — picking an action clears the selection
  // and hides the row, so a geometry read after that measures a hidden button.
  await check('ctx menu: ··· sits beside Annotate on a selection', async () => {
    const geom = await page.evaluate(() => {
      const d = document.querySelector('iframe').contentDocument
      const a = d.getElementById('ann-btn'), m = d.getElementById('sel-more-btn')
      if (!a || !m) return null
      const ra = a.getBoundingClientRect(), rm = m.getBoundingClientRect()
      return { ax: ra.left, mx: rm.left, ay: ra.top, my: rm.top, w: rm.width }
    })
    if (!geom) return 'no ··· button in the selection action row'
    if (geom.w <= 0) return 'the ··· button has no size'
    if (geom.mx <= geom.ax) return 'the ··· button is not to the right of Annotate'
    if (Math.abs(geom.my - geom.ay) > 4) return 'the two buttons are not on the same row'
    return null
  })

  await clickSelMore(page)

  await check('ctx menu: the sheet lists the enabled actions only', async () => {
    const txt = await page.evaluate(() => document.body.innerText)
    for (const label of ['Copy to clipboard', 'Web search', CTX_ASK_TITLE]) {
      if (!txt.includes(label)) return `"${label}" is missing from the sheet`
    }
    if (txt.includes(CTX_DISABLED_TITLE)) return 'a disabled action is offered in the sheet'
    return null
  })

  await check('ctx menu: copy reports back to the reader', async () => {
    await page.evaluate(() => {
      document.querySelector('[data-testid="ctxmenu-copy"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    try {
      await page.waitForFunction(() => /Copied|Copy failed/.test(document.body.innerText), { timeout: 4000 })
    } catch { return 'no toast after the copy action' }
    const txt = await page.evaluate(() => document.body.innerText)
    return /Copy failed/.test(txt) ? 'the copy action reported a failure' : null
  })
  await sleep(600)

  // The AI action: select again (the menu consumed the last selection), ask, and
  // watch the popout go loading → answer.
  await openSelectionMenu(page)
  await page.evaluate(() => {
    document.querySelector('[data-testid="ctxmenu-e2e-ask"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })

  await check('ctx menu: the AI popout opens and answers', async () => {
    try {
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="ai-popout-answer"]')?.innerText.includes('stub reply'),
        { timeout: 15000 })
      return null
    } catch {
      const err = await page.evaluate(() =>
        document.querySelector('[data-testid="ai-popout-error"]')?.innerText ?? '(no answer, no error)')
      return `the popout never rendered the reply: ${err}`
    }
  })

  await check('ctx menu: the ask is metered like a pipeline call', async () =>
    (await llmCallCount(token)) === callsBefore + 1
      ? null
      : `llm_usage.total_calls did not advance by exactly 1 (was ${callsBefore})`)

  // Keep it: the answer becomes an Annotation on the ORIGINAL selection.
  await page.evaluate(() => {
    document.querySelector('[data-testid="ai-popout-save"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })

  await check('ctx menu: Save hands the answer to the annotator, prefilled', async () => {
    try {
      await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('stub reply'), { timeout: 6000 })
      return null
    } catch {
      const v = await page.evaluate(() => document.querySelector('textarea')?.value ?? '(no textarea)')
      return `the composer did not open with the answer: "${v}"`
    }
  })

  // Same click shape as the plain selection lifecycle above — a proven press on
  // the panel's Save. Then wait for the panel to close: if it is still up, the
  // press never landed and every assertion below would blame the anchor instead.
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(e => e.innerText && e.innerText.trim() === 'Save' && e.offsetParent)
    el.click()
  })
  await check('ctx menu: the composer saves', async () => {
    try {
      await page.waitForFunction(() => !document.querySelector('textarea'), { timeout: 6000 })
      return null
    } catch { return 'the annotation composer stayed open after Save' }
  })

  let aiAnnId = null
  await check('ctx menu: the kept answer anchors to the original selection', async () => {
    try {
      await page.waitForFunction(() =>
        document.querySelector('iframe').contentDocument.querySelectorAll('mark[data-ann-id]').length > 0,
        { timeout: 6000 })
    } catch { return 'no <mark> after saving the AI answer' }
    // Group by annotation id: other checks' notes leave their own marks in this
    // document, and joining every <mark> on the page would compare a mixture.
    const info = await page.evaluate((want) => {
      const d = document.querySelector('iframe').contentDocument
      const byId = {}
      for (const m of d.querySelectorAll('mark[data-ann-id]')) {
        (byId[m.dataset.annId] = byId[m.dataset.annId] || []).push(m)
      }
      const groups = Object.entries(byId).map(([id, pieces]) => ({
        id,
        joined: pieces.map(m => m.innerText).join('').replace(/\s+/g, ' ').trim(),
        touchesLink: pieces.some(m => m.closest('a') || m.querySelector('a')),
      }))
      return { groups, want: want.replace(/\s+/g, ' ').trim() }
    }, selText)
    const mine = info.groups.find(g => g.joined.includes(info.want.slice(0, 30)))
    if (!mine) return `no mark matches the selection "${info.want}" (have ${JSON.stringify(info.groups.map(g => g.joined))})`
    if (!mine.touchesLink) return 'the mark does not span the inline link — the anchor moved'
    aiAnnId = mine.id
    return null
  })

  // Cold reload: THIS annotation's anchor must still resolve (the wide-context
  // fields must not have leaked into prefix/suffix/pos_*).
  await page.reload({ waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)
  await check('ctx menu: the AI note survives a reload with its anchor intact', async () => {
    if (!aiAnnId) return 'no annotation id was captured before the reload'
    try {
      await page.waitForFunction((id) =>
        document.querySelector('iframe').contentDocument.querySelectorAll(`mark[data-ann-id="${id}"]`).length > 0,
        { timeout: 8000 }, aiAnnId)
      return null
    } catch { return 'the AI note did not re-anchor after reload' }
  })

  // Clean up: later checks read this document without this note. Target it by id —
  // other checks' annotations mark the same page and must not be deleted here.
  await page.evaluate((id) => {
    const d = document.querySelector('iframe').contentDocument
    d.querySelector(`mark[data-ann-id="${id}"]`).dispatchEvent(new d.defaultView.MouseEvent('click', { bubbles: true }))
  }, aiAnnId)
  await page.waitForSelector('textarea', { timeout: 6000 })
  await clickByText(page, e => /^[.·]{3}$/.test((e.innerText || '').trim()), 'more-menu toggle')
  await sleep(400)
  await clickByText(page, e => /delete/i.test((e.innerText || '').trim()) && (e.innerText || '').trim().length < 20, 'Delete item')
  await sleep(700)

  if (errors.length) fail('ctx menu: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('ctx menu: no console/HTTP errors')

  await page.close()
}

// The transcript screen is a SECOND host for the same WebView bundle, and it does
// NOT use the viewer's row: the OS selection toolbar kept landing on it. The viewer
// reports the selection (`selection_bar`) and the host lays every action over the
// footer. If either half drops the message, nothing appears and nothing errors.
async function runTranscriptContextMenu(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.setViewport({ width: 900, height: 900 })
  await page.goto(`${BASE_URL}/document/${VIDEO_DOC_ID}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForFunction(() => {
    const f = document.querySelector('iframe')
    return f && f.contentDocument && f.contentDocument.querySelector('.seg')
  }, { timeout: 15000 })

  const selText = await page.evaluate(() => {
    const f = document.querySelector('iframe')
    const d = f.contentDocument, w = f.contentWindow
    const seg = [...d.querySelectorAll('.seg')].find(x => x.innerText.trim().length > 10)
    const node = seg.firstChild
    const r = d.createRange()
    r.setStart(node, 0)
    r.setEnd(node, Math.min(20, node.nodeValue.length))
    const s = w.getSelection(); s.removeAllRanges(); s.addRange(r)
    d.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }))
    return s.toString()
  })

  await check('transcript: a selection raises the bar over the footer, not the in-viewer row', async () => {
    if (!selText.trim()) return 'nothing was selected in the transcript'
    await page.waitForSelector('[data-testid="ctxmenu-copy"]', { timeout: 3000 }).catch(() => {})
    const info = await page.evaluate(() => {
      const f = document.querySelector('iframe')
      const bar = document.querySelector('[data-testid="selection-bar"]')
      const play = document.querySelector('[data-testid="seek-track"]')
      return {
        row: f.contentWindow.getComputedStyle(f.contentDocument.getElementById('sel-actions')).display,
        bar: bar ? bar.getBoundingClientRect() : null,
        track: play ? play.getBoundingClientRect() : null,
        text: bar ? bar.innerText : '',
        items: [...document.querySelectorAll('[data-testid^="ctxmenu-"]')].map(e => e.getAttribute('data-testid')),
        buttonsSelectable: bar ? [...bar.querySelectorAll('[data-testid^="ctxmenu-"] *, [data-testid^="selection-bar-"] *')]
          .some(e => getComputedStyle(e).userSelect !== 'none') : null,
      }
    })
    if (info.row !== 'none') return `the in-viewer row also shows (${info.row}) — two menus for one selection`
    if (!info.bar) return 'no selection bar on a transcript selection'
    if (!info.text.includes(selText.trim().slice(0, 10))) return `the bar does not echo the selection (reads "${info.text.slice(0, 60)}")`
    if (!info.items.includes('ctxmenu-copy')) return `the bar lists no context-menu items (${JSON.stringify(info.items)})`
    if (!info.track || info.bar.top > info.track.top || info.bar.bottom < info.track.bottom) return 'the bar does not cover the player controls'
    if (info.buttonsSelectable) return 'the bar buttons have selectable labels'
    return null
  })

  await check('transcript: the bar X clears the selection', async () => {
    await page.evaluate(() => {
      document.querySelector('[data-testid="selection-bar"] [aria-label="Clear selection"]')?.click()
    })
    await sleep(300)
    const left = await page.evaluate(() => ({
      bar: !!document.querySelector('[data-testid="selection-bar"]'),
      sel: document.querySelector('iframe').contentWindow.getSelection().toString(),
    }))
    if (left.bar) return 'the bar stayed up after X'
    if (left.sel) return `the transcript selection survived X ("${left.sel}")`
    return null
  })

  if (errors.length) fail('transcript ctx menu: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('transcript ctx menu: no console/HTTP errors')

  await page.close()
}

// Transcript interaction contract: a tap must NOT seek, a selection must stop
// playback and offer "play from here", a jump must leave a way back, and the find
// bar must actually mark segments. Asserted on the messages the iframe really posts
// (a page-level collector), because a broken handler is a silent no-op that returns
// no error and paints nothing.
async function runTranscriptPlayback(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.setViewport({ width: 900, height: 900 })
  await page.goto(`${BASE_URL}/document/${VIDEO_DOC_ID}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForFunction(() => {
    const f = document.querySelector('iframe')
    return f && f.contentDocument && f.contentDocument.querySelector('.seg')
  }, { timeout: 15000 })
  // Collect what the viewer posts out. The host listens to the same events.
  await page.evaluate(() => {
    window.__vmsgs = []
    window.addEventListener('message', e => {
      try { window.__vmsgs.push(JSON.parse(typeof e.data === 'string' ? e.data : JSON.stringify(e.data))) } catch { /* not ours */ }
    })
  })
  const msgs = () => page.evaluate(() => window.__vmsgs)
  const clearMsgs = () => page.evaluate(() => { window.__vmsgs = [] })

  await check('transcript: tapping a line does not seek', async () => {
    await clearMsgs()
    await page.evaluate(() => {
      const f = document.querySelector('iframe')
      const seg = [...f.contentDocument.querySelectorAll('.seg')][2]
      seg.dispatchEvent(new f.contentWindow.MouseEvent('click', { bubbles: true }))
    })
    await sleep(300)
    const seen = await msgs()
    if (seen.some(m => m.type === 'seek')) return 'the tap still posted a seek — tap-to-seek was supposed to move to the ▶ button'
    const time = await page.evaluate(() =>
      [...document.querySelectorAll('*')].map(e => (e.childElementCount === 0 ? e.innerText : '')).find(t => /^\d+:\d\d$/.test(t || '')))
    if (time !== '0:00') return `playback moved on a tap (time reads ${time})`
    return null
  })

  await check('transcript: selecting stops playback and offers play-from-here', async () => {
    await clearMsgs()
    const selText = await page.evaluate(() => {
      const f = document.querySelector('iframe')
      const d = f.contentDocument, w = f.contentWindow
      const seg = [...d.querySelectorAll('.seg')].find(x => x.innerText.trim().length > 10)
      const node = seg.firstChild
      const r = d.createRange()
      r.setStart(node, 0)
      r.setEnd(node, Math.min(20, node.nodeValue.length))
      const s = w.getSelection(); s.removeAllRanges(); s.addRange(r)
      d.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }))
      return s.toString()
    })
    if (!selText.trim()) return 'nothing was selected in the transcript'
    await sleep(300)
    const seen = await msgs()
    if (!seen.some(m => m.type === 'selection_start')) return 'no selection_start — playback would keep running under the selection'
    if (!(await page.$('[data-testid="selection-bar-play"]'))) return 'no play-from-here pill in the selection bar'
    return null
  })

  await check('transcript: ▶ plays from the selected line', async () => {
    const want = await page.evaluate(() => {
      const f = document.querySelector('iframe')
      const seg = [...f.contentDocument.querySelectorAll('.seg')].find(x => x.innerText.trim().length > 10)
      return Number(seg.dataset.startMs)
    })
    const label = await page.$eval('[data-testid="selection-bar-play"]', e => (e.innerText.match(/\d+:\d\d/) || [''])[0])
    await page.click('[data-testid="selection-bar-play"]')
    await sleep(400)
    const fmt = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
    if (label !== fmt(want)) return `the pill reads "${label}", expected the segment's ${fmt(want)}`
    const playing = await page.evaluate(() => document.querySelector('[data-testid="play-toggle"]')?.getAttribute('aria-label'))
    if (playing !== 'Pause') return `playback did not start (toggle reads "${playing}")`
    if (await page.$('[data-testid="selection-bar"]')) return 'the bar stayed up after ▶'
    const t = await page.evaluate(() => document.querySelector('[data-testid="play-toggle"]') && document.querySelector('[data-testid="seek-time"]')?.innerText)
    if (Math.abs(Number(t.split(':')[1]) - Math.floor(want / 1000)) > 2) return `playback is at ${t}, expected near ${fmt(want)}`
    return null
  })

  await check('transcript: a jump leaves a way back', async () => {
    if (await page.$('[data-testid="jump-back"]')) return 'the back pill was showing before any jump'
    await clickByText(page, e => (e.innerText || '').trim() === '+10s', '+10s skip')
    await sleep(400)
    const el = await page.$('[data-testid="jump-back"]')
    if (!el) return 'no "back to" pill after a jump'
    const label = await page.evaluate(e => e.innerText.replace(/\s+/g, ' ').trim(), el)
    if (!/back to \d+:\d\d/i.test(label)) return `the pill reads "${label}"`
    await el.click()
    await sleep(300)
    if (!(await page.$('[data-testid="jump-back"]'))) return 'the pill vanished on use — there is no way back from the way back'
    return null
  })

  await check('transcript: search marks the matching lines', async () => {
    await page.type('[data-testid="transcript-find-input"]', 'Second')
    await sleep(500)
    const one = await page.evaluate(() => {
      const d = document.querySelector('iframe').contentDocument
      return {
        hits: d.querySelectorAll('.seg.find-hit').length,
        current: d.querySelector('.seg.find-current')?.textContent ?? '',
        label: document.querySelector('[data-testid="transcript-find-count"]')?.innerText ?? '',
      }
    })
    if (one.hits !== 1) return `"Second" matched ${one.hits} segments, expected 1`
    if (!one.current.includes('Second line')) return `the current hit is "${one.current}"`
    if (one.label !== '1/1') return `the count reads "${one.label}"`
    return null
  })

  // Enter is the same step the ↓ button posts (onSubmitEditing → findTranscript +1).
  await check('transcript: stepping moves between hits', async () => {
    await page.click('[data-testid="transcript-find-input"]', { clickCount: 3 })
    await page.type('[data-testid="transcript-find-input"]', 'line')
    await sleep(500)
    const read = () => page.evaluate(() => ({
      hits: document.querySelector('iframe').contentDocument.querySelectorAll('.seg.find-hit').length,
      current: document.querySelector('iframe').contentDocument.querySelector('.seg.find-current')?.textContent ?? '',
      label: document.querySelector('[data-testid="transcript-find-count"]')?.innerText ?? '',
    }))
    const before = await read()
    if (before.hits !== 3) return `"line" matched ${before.hits} segments, expected 3`
    if (!before.current) return 'no current hit to step from'
    await page.keyboard.press('Enter')
    await sleep(400)
    const after = await read()
    if (after.current === before.current) return `the step did not move (still "${after.current}")`
    if (after.label === before.label) return `the count did not advance (still "${after.label}")`
    return null
  })

  await check('transcript: hiding the player gives the tabs the screen', async () => {
    const pane = () => page.evaluate(() => document.querySelector('iframe').getBoundingClientRect().height)
    const before = await pane()
    if (!(await page.$('[data-testid="player"]'))) return 'no player to hide'
    await page.click('[data-testid="player-collapse"]')
    await sleep(300)
    const folded = await pane()
    const thumb = await page.$('[data-testid="player"]')
    await page.click('[data-testid="player-collapse"]')
    await sleep(300)
    const back = await pane()
    if (folded < before + 150) return `the transcript grew ${before}px → ${folded}px; expected the player's height back`
    if (thumb) return 'the player thumbnail still shows while hidden'
    if (Math.abs(back - before) > 2) return `unfolding left the transcript at ${back}px, was ${before}px`
    return null
  })

  // ── Player: seek bar, transcript follow, surviving a connection blip ──
  // The fixture audio is a real minute of silence; its three segments are 0–3–6–9s.
  const seekTime = () => page.evaluate(() => document.querySelector('[data-testid="seek-time"]')?.innerText ?? '')
  const secs = t => { const [m, s] = t.split(':').map(Number); return m * 60 + s }
  const setPlaying = async want => {
    const label = await page.evaluate(() => document.querySelector('[data-testid="play-toggle"]')?.getAttribute('aria-label'))
    if ((label === 'Pause') !== want) await page.click('[data-testid="play-toggle"]')
    await sleep(300)
  }
  // Drag the seek bar from one second mark to another with a real pointer.
  const dragSeek = async (fromSec, toSec, { release = true } = {}) => {
    const box = await (await page.$('[data-testid="seek-track"]')).boundingBox()
    const x = sec => box.x + ((sec + 0.4) / 60) * box.width
    const y = box.y + box.height / 2
    await page.mouse.move(x(fromSec), y)
    await page.mouse.down()
    await page.mouse.move(x(toSec), y, { steps: 6 })
    if (release) { await page.mouse.up(); await sleep(300) }
  }
  // What the HOST posts into the viewer (the collector above hears the other way).
  await page.evaluate(() => {
    window.__hostMsgs = []
    document.querySelector('iframe').contentWindow.addEventListener('message', e => {
      try { window.__hostMsgs.push(JSON.parse(e.data)) } catch { /* not ours */ }
    })
  })
  const mediaTimes = () => page.evaluate(() => window.__hostMsgs.filter(m => m.type === 'mediaTime').length)
  const activeSeg = () => page.evaluate(() => {
    const d = document.querySelector('iframe').contentDocument
    const on = [...d.querySelectorAll('.seg.active')]
    return on.length === 1 ? [...d.querySelectorAll('.seg')].indexOf(on[0]) : `${on.length} active`
  })

  await check('player: dragging the seek bar previews, then seeks on release', async () => {
    await setPlaying(false)
    await dragSeek(6, 30, { release: false })
    const mid = await seekTime()
    await page.mouse.up()
    await sleep(400)
    const after = await seekTime()
    if (mid !== '0:30') return `mid-drag the time reads "${mid}", expected the finger's 0:30`
    if (after !== '0:30') return `after release the time reads "${after}", expected 0:30`
    return null
  })

  // Speed lives in its own row above the seek line: steppers either side of the
  // value, and the value itself is the way back to 1×.
  await check('player: speed steps by .1 and .01, and the value resets to 1×', async () => {
    const value = () => page.evaluate(() => document.querySelector('[data-testid="rate-value"]')?.innerText ?? '')
    const top = sel => page.evaluate(q => document.querySelector(q)?.getBoundingClientRect().top ?? -1, `[data-testid="${sel}"]`)
    if ((await value()) !== '1×') return `the speed starts at "${await value()}", expected 1×`
    await page.click('[data-testid="rate-step-0.1"]')
    await page.click('[data-testid="rate-step-0.1"]')
    await page.click('[data-testid="rate-step-0.01"]')
    if ((await value()) !== '1.21×') return `+.1 +.1 +.01 reads "${await value()}", expected 1.21×`
    await page.click('[data-testid="rate-step--0.1"]')
    await page.click('[data-testid="rate-step--0.01"]')
    if ((await value()) !== '1.1×') return `−.1 −.01 reads "${await value()}", expected 1.1×`
    await page.click('[data-testid="rate-value"]')
    if ((await value()) !== '1×') return `tapping the value reads "${await value()}", expected a reset to 1×`
    const [speed, seek, play] = [await top('rate-value'), await top('seek-track'), await top('play-toggle')]
    if (!(speed < seek && seek < play)) return `rows out of order: speed ${speed}, seek ${seek}, play ${play}`
    return null
  })

  await check('player: the transcript is told only when the line changes', async () => {
    await dragSeek(30, 1)
    if ((await activeSeg()) !== 0) return `at 0:01 the active line is ${await activeSeg()}, expected 0`
    const before = await mediaTimes()
    await dragSeek(1, 2)
    const same = (await mediaTimes()) - before
    if (same !== 0) return `a seek inside one line posted ${same} mediaTime message(s)`
    await dragSeek(2, 4)
    const crossed = (await mediaTimes()) - before
    if (crossed !== 1) return `crossing into the next line posted ${crossed} mediaTime message(s), expected 1`
    if ((await activeSeg()) !== 1) return `at 0:04 the active line is ${await activeSeg()}, expected 1`
    return null
  })

  // One failed probe nulls activeUrl. That used to tear the player down: sound
  // stopped and stayed stopped. Force one, let the connection come back, and the
  // audio must still be running from where it was.
  await check('player: playback survives a connection blip', async () => {
    await dragSeek(4, 20)
    await setPlaying(true)
    const probe = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.evaluate(() => localStorage.setItem('samizdat_force_offline', '1'))
    await probe()
    await sleep(1500)
    const during = secs(await seekTime())
    await page.evaluate(() => localStorage.removeItem('samizdat_force_offline'))
    await probe()
    await sleep(1500)
    const t1 = secs(await seekTime())
    await sleep(1500)
    const t2 = secs(await seekTime())
    await setPlaying(false)
    if (during < 21) return `while disconnected the time reads ${during}s — the source was dropped with the connection`
    if (t1 < 21) return `after the blip the time reads ${t1}s — playback did not continue from 0:20`
    if (t2 <= t1) return `after the blip the time is stuck at ${t1}s — the player stopped`
    return null
  })

  if (errors.length) fail('transcript playback: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('transcript playback: no console/HTTP errors')

  await page.close()
}

// The editor half: what Settings writes has to be what the reader offers, and it
// has to survive a reload (it is a server row, not screen state).
async function runContextMenuSettings(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.setViewport({ width: 900, height: 1400 })
  await settingsText(page)

  await check('ctx settings: the Context Menu card is in Preferences and collapsed', async () => {
    const txt = await page.evaluate(() => document.body.innerText)
    const up = txt.toUpperCase()
    const at = txt.indexOf('Context Menu')
    if (at < 0) return 'no Context Menu card on Settings'
    const prefs = up.indexOf('PREFERENCES'), dev = up.indexOf('DEVICE')
    if (!(at > prefs && at < dev)) return `the card is outside the Preferences group (at ${at}, group ${prefs}..${dev})`
    if (!/action\(s\) enabled/.test(txt)) return 'the collapsed card does not summarise how many actions are on'
    return null
  })

  await openSettingsCard(page, 'context-menu')

  await check('ctx settings: adding an AI question persists to the server', async () => {
    await page.evaluate(() => {
      document.querySelector('[data-testid="ctxmenu-add"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await sleep(400)
    // Name it, then blur — text fields commit on blur, not per keystroke.
    const named = await page.evaluate((title) => {
      const input = [...document.querySelectorAll('input')].find(i => i.value === 'New question')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, title)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      // React listens for focusout (blur does not bubble), so a bare 'blur' event
      // never reaches onBlur and the field would never commit.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      return true
    }, 'E2E Settings Question')
    if (!named) return 'the new question row did not render an editable title'
    await sleep(800)
    const res = await fetch(`${BASE_URL}/api/v1/settings`, { headers: { Authorization: `Bearer ${token}` } })
    const body = await res.json()
    const items = body.context_menu?.items ?? []
    if (!items.some(i => i.title === 'E2E Settings Question')) {
      return `the server does not have the new item: ${JSON.stringify(items.map(i => i.title))}`
    }
    return null
  })

  await check('ctx settings: the saved menu is still there after a reload', async () => {
    await settingsText(page, { open: ['context-menu'] })
    // An ask item's title is an editable field: its text lives in input.value, which
    // innerText does not contain.
    const titles = await page.evaluate(() => [...document.querySelectorAll('input')].map(i => i.value))
    return titles.includes('E2E Settings Question')
      ? null
      : `the added question is gone after reloading Settings (fields: ${JSON.stringify(titles)})`
  })

  // Leave a minimal menu behind — a stray extra action would show up in the sheet
  // any later check opens.
  await putContextMenu(token, {
    master_prompt: '',
    items: [{ id: 'copy', kind: 'copy', title: 'Copy to clipboard', enabled: true }],
  })

  if (errors.length) fail('ctx settings: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('ctx settings: no console/HTTP errors')

  await page.close()
}

async function runAnnotationSelectionContext(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.setViewport({ width: 900, height: 900 })
  await page.goto(`${BASE_URL}/document/${TEXT_DOC_ID}`, { waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)

  const selText = await openAnnPanelOnSelection(page)

  await check('ann panel: the selection under test crosses the inline link', async () =>
    selText.includes('download page') ? null : `selection did not cross the link: "${selText}"`)

  await check('ann panel: the composer shows the text being anchored, above the input', async () => {
    const q = await panelQuote(page, selText)
    if (!q.textarea) return 'the annotation panel did not open'
    if (!q.found) return `the selected text is nowhere in the panel: "${q.panelText}"`
    if (!q.beforeInput) return 'the quote renders AFTER the note input in document order'
    if (!q.aboveInput) return 'the quote is not laid out above the note input'
    return null
  })

  // Save it, then come back cold: on a reload `pendingSelection` is undefined, so a
  // quote in the edit panel can only have come from the stored `exact`.
  await page.evaluate((note) => {
    const ta = document.querySelector('textarea')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, note)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }, CONTEXT_NOTE)
  await page.waitForFunction((note) => document.querySelector('textarea')?.value === note,
    { timeout: 6000 }, CONTEXT_NOTE)
  // The marks already on screen belong to earlier checks (the viewer marks highlight-card
  // bodies too). Remember them, so the one that APPEARS is this check's own — clicking
  // "the first mark" opens whichever annotation renders first, a stranger's note as soon
  // as another fixture lands above it.
  const marksBefore = await markIds(page)
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(e => e.innerText && e.innerText.trim() === 'Save' && e.offsetParent)
    el.click()
  })
  await page.waitForFunction((before) => [...document.querySelector('iframe').contentDocument
    .querySelectorAll('mark[data-ann-id]')].some(m => !before.includes(m.dataset.annId)),
  { timeout: 8000 }, marksBefore)
  const annId = (await markIds(page)).find(id => !marksBefore.includes(id))

  await page.reload({ waitUntil: 'networkidle2', timeout: 15000 })
  await waitViewerReady(page)
  await page.waitForFunction(() =>
    document.querySelector('iframe').contentDocument.querySelectorAll('mark[data-ann-id]').length > 0,
    { timeout: 8000 })
  await page.waitForFunction((id) =>
    !!document.querySelector('iframe').contentDocument.querySelector(`mark[data-ann-id="${id}"]`),
    { timeout: 8000 }, annId)
  await page.evaluate((id) => {
    const d = document.querySelector('iframe').contentDocument
    d.querySelector(`mark[data-ann-id="${id}"]`).dispatchEvent(new d.defaultView.MouseEvent('click', { bubbles: true }))
  }, annId)
  await page.waitForFunction((note) => document.querySelector('textarea')?.value === note,
    { timeout: 8000 }, CONTEXT_NOTE).catch(() => {})

  await check('ann panel: re-opening a saved mark shows its stored anchor too', async () => {
    const q = await panelQuote(page, selText)
    if (!q.textarea) return 'the edit panel did not open'
    if (q.noteValue !== CONTEXT_NOTE) return `the edit panel holds note "${q.noteValue}"`
    if (!q.found) return `the stored anchor is nowhere in the edit panel: "${q.panelText}"`
    if (!q.beforeInput) return 'the quote renders AFTER the note input in document order'
    if (!q.aboveInput) return 'the quote is not laid out above the note input'
    return null
  })

  // Leave the document as it was found — the later reader-mode checks open it too.
  await clickByText(page, e => /^[.·]{3}$/.test((e.innerText || '').trim()), 'more-menu toggle')
  await sleep(400)
  await clickByText(page, e => /delete/i.test((e.innerText || '').trim()) && (e.innerText || '').trim().length < 20, 'Delete item')
  await sleep(700)

  if (errors.length) fail('ann panel context: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('ann panel context: no console/HTTP errors')

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
      const ifr = document.querySelector('iframe')
      const row = ifr.contentDocument.getElementById('sel-actions')
      return row ? ifr.contentWindow.getComputedStyle(row).display : '(no button)'
    })
    if (disp !== 'flex') return `sel-actions display is "${disp}" — selection broken by page mode`
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

  await check('page mode: PageDown / PageUp turn the page', async () => {
    const press = (key) => page.evaluate((k) => {
      const ifr = document.querySelector('iframe')
      ifr.contentDocument.dispatchEvent(
        new ifr.contentWindow.KeyboardEvent('keydown', { key: k, bubbles: true }))
    }, key)
    const before = await pageTotal(page)
    await press('PageDown')
    await sleep(600)
    const down = await pageTotal(page)
    if (!down || down.idx !== before.idx + 1) return `PageDown: page index went ${before.idx} → ${down && down.idx}`
    await press('PageUp')
    await sleep(600)
    const up = await pageTotal(page)
    return up && up.idx === before.idx ? null : `PageUp: page index went ${down.idx} → ${up && up.idx}`
  })

  await check('page mode: saving an annotation stays on the page', async () => {
    // The hard case: a page whose top paragraph began on the previous one. Its box
    // starts a column back, so anchoring the reader on that element jumped back a page.
    const press = (k) => page.evaluate((key) => {
      const ifr = document.querySelector('iframe')
      ifr.contentDocument.dispatchEvent(new ifr.contentWindow.KeyboardEvent('keydown', { key, bubbles: true }))
    }, k)
    // The checks after this one count pages from the start, at the suite's size.
    const backToFirstPage = async () => {
      for (let p = await pageTotal(page); p && p.idx > 1; p = await pageTotal(page)) {
        await press('PageUp')
        await sleep(400)
      }
      await page.setViewport({ width: 900, height: 700 })
      await sleep(800)
    }
    const straddles = () => page.evaluate(() => {
      const d = document.querySelector('iframe').contentDocument
      const r = d.body.getBoundingClientRect()
      const c = d.caretRangeFromPoint(r.left + 32, r.top + 24)
      const p = c && c.startContainer.parentElement && c.startContainer.parentElement.closest('p')
      return !!p && p.getBoundingClientRect().left < r.left
    })
    // At 900×700 every page of this fixture happens to break between sections;
    // 620 tall breaks mid-paragraph on several.
    await page.setViewport({ width: 900, height: 620 })
    await sleep(800)
    const { total } = await pageTotal(page)
    let found = false
    for (let i = 0; i < total && !(found = await straddles()); i++) {
      await press('PageDown')
      await sleep(500)
    }
    if (!found) {
      await backToFirstPage()
      return 'no page starts mid-paragraph — the fixture cannot exercise the bug'
    }
    const before = await pageTotal(page)
    await page.evaluate(() => {
      const ifr = document.querySelector('iframe')
      const d = ifr.contentDocument, w = ifr.contentWindow
      const br = d.body.getBoundingClientRect()
      const c = d.caretRangeFromPoint(br.left + br.width / 2, br.top + br.height / 2)
      const t = c.startContainer
      const r = d.createRange()
      r.setStart(t, Math.max(0, Math.min(c.startOffset, t.length - 12)))
      r.setEnd(t, Math.min(t.length, r.startOffset + 12))
      const sel = w.getSelection(); sel.removeAllRanges(); sel.addRange(r)
      d.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }))
    })
    await page.evaluate(() => {
      const ifr = document.querySelector('iframe')
      ifr.contentDocument.getElementById('ann-btn')
        .dispatchEvent(new ifr.contentWindow.MouseEvent('click', { bubbles: true }))
    })
    await page.waitForSelector('textarea', { timeout: 6000 })
    await page.evaluate(() => {
      const ta = document.querySelector('textarea')
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(ta, 'page-mode note')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.focus('textarea')
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')
    try {
      await page.waitForFunction(() =>
        document.querySelector('iframe').contentDocument.querySelector('mark[data-noted]'), { timeout: 6000 })
    } catch { return 'no noted <mark> rendered after save' }
    await sleep(600)
    const after = await pageTotal(page)
    await backToFirstPage()
    return after && after.idx === before.idx ? null : `save moved the page ${before.idx} → ${after && after.idx}`
  })

  await check('page mode: keys pressed on the host around the frame turn the page', async () => {
    // Real key presses with focus OUTSIDE the iframe: they land on the host window,
    // which must forward them — the frame's own listener never sees them.
    const focusHost = () => page.evaluate(() => {
      document.querySelector('iframe').blur()
      document.body.focus()
      return document.activeElement && document.activeElement.tagName
    })
    const focused = await focusHost()
    if (focused === 'IFRAME') return 'could not move focus off the iframe'
    const before = await pageTotal(page)
    await page.keyboard.press('ArrowRight')
    await sleep(600)
    const right = await pageTotal(page)
    if (!right || right.idx !== before.idx + 1) return `host ArrowRight: page index went ${before.idx} → ${right && right.idx}`
    await page.keyboard.press('PageDown')
    await sleep(600)
    const down = await pageTotal(page)
    if (!down || down.idx !== right.idx + 1) return `host PageDown: page index went ${right.idx} → ${down && down.idx}`
    await page.keyboard.press('PageUp')
    await sleep(600)
    await page.keyboard.press('ArrowLeft')
    await sleep(600)
    const back = await pageTotal(page)
    if (!back || back.idx !== before.idx) return `host PageUp+ArrowLeft: page index went ${down.idx} → ${back && back.idx}`
    // A focused text field keeps its arrows: no page turn while typing.
    await page.evaluate(() => {
      const inp = document.createElement('input')
      inp.id = 'e2e-host-input'
      document.body.appendChild(inp)
      inp.focus()
    })
    await page.keyboard.press('ArrowRight')
    await sleep(600)
    const typing = await pageTotal(page)
    await page.evaluate(() => document.getElementById('e2e-host-input').remove())
    return typing && typing.idx === before.idx ? null : `ArrowRight in a host input turned the page (${before.idx} → ${typing && typing.idx})`
  })

  await check('page mode: header stays put on page turns; h and a plain tap toggle it', async () => {
    const state = () => page.evaluate(() => {
      const h = document.querySelector('[data-testid="doc-header"]').getBoundingClientRect()
      const f = document.querySelector('iframe').getBoundingClientRect()
      return { shown: h.bottom > 1, hint: !!document.querySelector('[data-testid="header-hotkey-hint"]'), frameTop: f.top, frameH: f.height }
    })
    const frameKey = (k) => page.evaluate((key) => {
      const ifr = document.querySelector('iframe')
      ifr.contentDocument.dispatchEvent(new ifr.contentWindow.KeyboardEvent('keydown', { key, bubbles: true }))
    }, k)
    const tapBlank = () => page.evaluate(() => {
      const ifr = document.querySelector('iframe')
      const w = ifr.contentWindow
      w.getSelection().removeAllRanges()
      // Whatever text sits on the current page, as long as no link/mark/image claims it.
      for (let y = 0.3; y < 0.9; y += 0.1) {
        const el = ifr.contentDocument.elementFromPoint(w.innerWidth / 2, w.innerHeight * y)
        if (!el || el.closest('a, img, mark, button, summary, [data-action]')) continue
        el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }))
        return true
      }
      return false
    })
    const start = await state()
    // The earlier checks turned pages both ways — the old scroll-driven hide fired on those.
    if (!start.shown) return 'header hidden after page turns on a pointer device'
    if (!start.hint) return 'no "h — hide header" hint before the key was ever used'
    await page.evaluate(() => { document.querySelector('iframe').blur(); document.body.focus() })
    await page.keyboard.press('h')
    await sleep(500)
    const hidden = await state()
    if (hidden.shown) return 'host h did not hide the header'
    if (hidden.hint) return 'hint still visible after the first h'
    if (hidden.frameTop !== start.frameTop || hidden.frameH !== start.frameH) {
      return `hiding the header resized the viewer (${start.frameTop}/${start.frameH} → ${hidden.frameTop}/${hidden.frameH})`
    }
    await frameKey('h')
    await sleep(500)
    if (!(await state()).shown) return 'h inside the frame did not show the header'
    if (!await tapBlank()) return 'no plain text on the current page to tap'
    await sleep(500)
    if ((await state()).shown) return 'a plain tap did not hide the header'
    await tapBlank()
    await sleep(500)
    if (!(await state()).shown) return 'a second plain tap did not show the header'
    // Typing h in a field is text, not a toggle.
    await page.evaluate(() => {
      const inp = document.createElement('input')
      inp.id = 'e2e-h-input'
      document.body.appendChild(inp)
      inp.focus()
    })
    await page.keyboard.press('h')
    await sleep(500)
    const typing = await state()
    await page.evaluate(() => document.getElementById('e2e-h-input').remove())
    if (!typing.shown) return 'h typed in an input toggled the header'
    await page.reload({ waitUntil: 'networkidle2', timeout: 15000 })
    await waitViewerReady(page)
    const err = await waitPaginated(page, true)
    if (err) return err
    await sleep(800)
    const after = await state()
    if (after.hint) return 'hint came back after a reload — first use not remembered'
    return after.shown ? null : 'header not shown on reopen'
  })

  await check('page mode: a reload lands on the page you were on', async () => {
    const before = await pageTotal(page)
    if (!before || before.total < 3) return `need ≥3 pages to test restore (${before && before.total})`
    const target = Math.min(before.total, 3)
    await page.evaluate((n) => {
      const ifr = document.querySelector('iframe')
      for (let i = 0; i < n; i++) {
        ifr.contentDocument.dispatchEvent(
          new ifr.contentWindow.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
      }
    }, target - before.idx)
    await sleep(1800) // > the host's 1s progress-save debounce
    const at = await pageTotal(page)
    if (!at || at.idx !== target) return `could not reach page ${target} (on ${at && at.idx})`
    await page.reload({ waitUntil: 'networkidle2', timeout: 15000 })
    await waitViewerReady(page)
    const err = await waitPaginated(page, true)
    if (err) return err
    await sleep(800)
    const after = await pageTotal(page)
    return after && after.idx === target ? null : `reload landed on page ${after && after.idx}, expected ${target}`
  })

  await check('page mode: a narrower viewport recalculates the page count', async () => {
    const before = await pageTotal(page)
    // The character the reader is on (top-left of the page) must still be on screen.
    const probe = await page.evaluate(() => {
      const d = document.querySelector('iframe').contentDocument
      const r = d.body.getBoundingClientRect()
      const c = d.caretRangeFromPoint(r.left + 32, r.top + 24)
      const one = d.createRange()
      one.setStart(c.startContainer, c.startOffset)
      one.setEnd(c.startContainer, Math.min(c.startContainer.length, c.startOffset + 1))
      window.__e2eProbe = one
      return (c.startContainer.nodeValue || '').slice(c.startOffset, c.startOffset + 20)
    })
    await page.setViewport({ width: 480, height: 620 })
    await sleep(1200) // > the 150ms resize throttle
    const after = await pageTotal(page)
    if (!after) return 'page indicator disappeared after resize'
    if (after.total <= before.total) {
      return `narrower viewport did not add pages (${before.total} → ${after.total})`
    }
    if (after.idx < 1 || after.idx > after.total) return `page index ${after.idx} out of range`
    const seen = await page.evaluate(() => {
      const d = document.querySelector('iframe').contentDocument
      const rect = window.__e2eProbe.getClientRects()[0]
      return !!rect && rect.left >= 0 && rect.right <= d.documentElement.clientWidth
    })
    return seen ? null : `"${probe}" was on screen before the resize, not after (page ${after.idx}/${after.total})`
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

// Server Connection / Connected Devices / LLM Services are accordions, collapsed
// on every fresh render — so anything reading their rows must open them first
// (`open: ['llm-services']`). A navigation collapses them again.
async function settingsText(page, { open = [] } = {}) {
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle2', timeout: 15000 })
  await sleep(1800) // service queries (proxy / export / llm) settle
  for (const id of open) await openSettingsCard(page, id)
  return page.evaluate(() => document.body.innerText)
}

async function openSettingsCard(page, testID) {
  const ok = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}-toggle"]`)
    if (!el) return false
    if (el.getAttribute('aria-expanded') !== 'true') el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }, testID)
  if (!ok) fail(`settings: open the "${testID}" card`, 'no accordion header with that testID')
  await sleep(250)
  return ok
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

// ── Settings: what leads the screen, what hides, what round-trips ─────────────
// Three separate promises the layout makes: the build you are running is the first
// thing on the screen, the long status cards are shut until asked, and a preference
// flipped here is a SERVER setting (the auto-archive sweep runs with no phone open),
// so it must survive a reload — an optimistic switch that never reached the server
// looks identical until the next launch.
async function runSettingsLayout(token, deviceId) {
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  const txt = await settingsText(page)

  await check('settings: one Version card leads the screen, app + server together', async () => {
    const ver = txt.indexOf('Version')
    if (ver < 0) return 'no Version card on Settings'
    for (const later of ['Server Connection', 'Services', 'Preferences', 'Connected Devices']) {
      const at = txt.indexOf(later)
      if (at >= 0 && at < ver) return `"${later}" is above the Version card (${at} < ${ver})`
    }
    // The card ends where the next one starts — otherwise "Server Connection"
    // would satisfy the server-version assertion below.
    const end = txt.indexOf('Server Connection')
    const card = txt.slice(ver, end > ver ? end : ver + 300)
    if (!/v\d+\.\d+\.\d+/.test(card)) return 'the installed app version is not shown'
    // The server's version was its own card; it answers the same question.
    if (!/(^|\n)Server(\n|\s)/.test(card)) return `the server version is not in the Version card: ${card}`
    if (/Server Info/.test(txt)) return 'the old Server Info card is still rendered'
    return null
  })

  await check('settings: Server Connection and Connected Devices start collapsed', async () => {
    if (/Disconnect this device[\s\S]*?Paired /.test(txt)) return 'a device row is visible with the card collapsed'
    if (/Trying |Connected to /.test(txt)) return 'the connection detail is visible with the card collapsed'
    if (/Server URLs/.test(txt)) return 'the URL list is visible with the connection card collapsed'
    for (const [id, want] of [['server-connection', /Connected|Offline|Checking/], ['connected-devices', /device/i]]) {
      const el = await page.$(`[data-testid="${id}-toggle"]`)
      if (!el) return `no accordion header for ${id}`
      const summary = await page.evaluate(e => e.innerText, el)
      if (!want.test(summary)) return `${id} summary says nothing useful: "${summary}"`
    }
    return null
  })

  await check('settings: opening Connected Devices reveals this device', async () => {
    await openSettingsCard(page, 'connected-devices')
    const t = await page.evaluate(() => document.body.innerText)
    if (!/this device/.test(t)) return `no device row after expanding: ${t.slice(t.indexOf('Connected Devices'), t.indexOf('Connected Devices') + 200)}`
    return null
  })

  // The URL list is part of the connection, not a card beside it: it is the answer
  // to "why am I connected there / why am I not".
  await check('settings: opening Server Connection reveals where it is connected, and the URL list', async () => {
    await openSettingsCard(page, 'server-connection')
    const t = await page.evaluate(() => document.body.innerText)
    const conn = t.indexOf('Server Connection')
    if (!/Connected to/.test(t)) return `no connection detail after expanding: ${t.slice(conn, conn + 240)}`
    const urls = t.indexOf('Server URLs')
    if (urls < 0) return 'no URL list inside the expanded card'
    if (urls < conn) return 'the URL list renders above the card it belongs to'
    if (!/active/.test(t.slice(urls, urls + 400))) return 'the active URL is not marked'
    return null
  })

  await check('settings: auto-archive is off by default and round-trips to the server', async () => {
    const sel = 'input[aria-label="Auto archive older than 1 month"]'
    const before = await page.$eval(sel, e => e.checked).catch(() => null)
    if (before === null) return 'no auto-archive switch on Settings'
    if (before) return 'auto-archive is on by default — the sweep must be opt-in'
    await page.click(sel)
    await sleep(600)
    const served = await fetch(`${BASE_URL}/api/v1/settings`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
    if (served.auto_archive_enabled !== true) return `the server did not record the flag: ${JSON.stringify(served)}`
    // A reload is the only proof the switch reflects the server, not local state.
    const after = await settingsText(page)
    if (!/On — highlights older than 1 month are archived/.test(after)) {
      return `the reloaded screen does not show it on: ${after.slice(after.indexOf('Auto Archive'), after.indexOf('Auto Archive') + 200)}`
    }
    await page.click(sel)
    await sleep(600)
    return null
  })

  await sleep(300)
  if (errors.length) fail('settings layout: no console/HTTP errors', errors.slice(0, 4).join(' | '))
  else pass('settings layout: no console/HTTP errors')

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
    for (const card of ['YouTube Proxies', 'Export Vault', 'Browser Extension', 'LLM Services']) {
      const at = txt.indexOf(card)
      if (at < 0) return `no "${card}" card on Settings`
      if (at < svc || at > prefs) return `"${card}" is outside the Services group (at ${at}, group ${svc}..${prefs})`
    }
    return null
  })

  // The long status cards open on demand — collapsed, the LLM card must still say
  // which endpoint jobs go to, or collapsing it would hide the one fact worth a glance.
  await check('settings: the LLM card starts collapsed but names its provider', async () => {
    if (/Cumulative usage/.test(txt)) return 'the LLM card is expanded on load'
    if (!/127\.0\.0\.1:9/.test(txt)) return `the collapsed summary does not name the provider: ${txt.slice(txt.indexOf('LLM Services'), txt.indexOf('LLM Services') + 200)}`
    return null
  })

  // Same rule for the proxy card: the test config sets no [ytdlp].proxies, so the
  // one fact worth a glance is that video ingest has no residential egress at all —
  // and a collapsed card that hid it would be worse than no card.
  await check('settings: the proxy card starts collapsed but says ingest is unrouted', async () => {
    const at = txt.indexOf('YouTube Proxies')
    if (at < 0) return 'no "YouTube Proxies" card on Settings'
    if (!/No proxy configured/.test(txt.slice(at, at + 300))) {
      return `the collapsed summary does not report the unconfigured pool: ${txt.slice(at, at + 200)}`
    }
    return null
  })

  await openSettingsCard(page, 'youtube-proxies')

  await openSettingsCard(page, 'llm-services')
  txt = await page.evaluate(() => document.body.innerText)

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
  txt = await settingsText(page, { open: ['llm-services'] })

  await check('settings: a provider out of credits reads as out of credits', async () => {
    if (!/Out of credits \/ rate limited/.test(txt)) return `no quota status in: ${txt.slice(txt.indexOf('LLM Services'), txt.indexOf('LLM Services') + 400)}`
    if (!/credit balance is too low/.test(txt)) return 'the provider error body is not shown'
    if (!/anthropic/.test(txt)) return 'the failing provider is not named'
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
  txt = await settingsText(page, { open: ['llm-services'] })

  await check('settings: the live provider reports it is unreachable', async () => {
    if (!/Unreachable/.test(txt)) return `no transport status in: ${txt.slice(txt.indexOf('LLM Services'), txt.indexOf('LLM Services') + 400)}`
    if (!/connection refused/.test(txt)) return 'the provider error body is not shown'
    return null
  })

  await check('settings: the failure paints the drawer alert dot', async () => {
    const dots = await page.$$('[data-testid="drawer-alert-dot"]')
    return dots.length ? null : 'no drawer alert dot after a configured provider failed'
  })

  // Collapsed, the card must lead with the BROKEN endpoint — a summary showing the
  // healthy default while a pipeline is down is worse than no summary at all.
  await check('settings: the collapsed card summarises the broken provider', async () => {
    const collapsed = await settingsText(page)
    const card = collapsed.slice(collapsed.indexOf('LLM Services'), collapsed.indexOf('LLM Services') + 200)
    if (/Cumulative usage/.test(collapsed)) return 'the LLM card did not collapse on re-render'
    if (!/Unreachable/.test(card)) return `the summary does not name the failure: ${card}`
    return null
  })

  await openSettingsCard(page, 'llm-services')
  txt = await page.evaluate(() => document.body.innerText)

  // The whole point of a local primary: how much is it actually serving? The split
  // is per ENDPOINT (12 anthropic + 3 local = 15 → 80% / 20%), not per provider name.
  await check('settings: each endpoint shows its share of all routed calls', async () => {
    for (const want of ['12 calls', '80% routed here', '3 calls', '20% routed here']) {
      if (!txt.includes(want)) return `missing "${want}" in: ${txt.slice(txt.indexOf('LLM Services'), txt.indexOf('LLM Services') + 400)}`
    }
    return null
  })

  // Check is the ONE active path: a tap, never a render. It must tell the two
  // failure shapes apart — a box with nothing listening vs a box that answered.
  // It runs LAST for a reason: a deep probe writes real calls into the health
  // registry, and routed_share is computed across every endpoint, so probing
  // earlier would move the percentages the check above asserts.
  await check('settings: Check reports each provider live, reachable and not', async () => {
    await clickByText(page, e => e.innerText === 'Check', 'Check')
    await page.waitForFunction(() => /Checked:/.test(document.body.innerText), { timeout: 20000 })
    await sleep(300)
    // Read in place: settingsText() re-navigates, and a remount clears the check
    // results (they are screen state — nothing probes on a render).
    const t = await page.evaluate(() => document.body.innerText)
    const llm = t.slice(t.indexOf('LLM Services'))
    if (!/Checked: Unreachable/.test(llm)) return `the dead-port provider did not check as unreachable: ${llm.slice(0, 500)}`
    if (!new RegExp(`Checked: ${STUB_LLM_MODELS.length} models`).test(llm)) {
      return `the stub box did not report its model count: ${llm.slice(0, 500)}`
    }
    return null
  })

  // The reason Check exists. The status dot is the outcome of the LAST REAL CALL
  // and nothing on a render path can move it, so a provider that failed once
  // stays red long after it recovered (xayah, 2026-08-30). Drive the full round
  // trip through the real button: break the box, Check → red; heal it, Check →
  // green. A shallow probe cannot do either — /models answers throughout.
  // Just the stub's own row. A fixed-width slice bleeds into the NEXT provider
  // (localhost:11434, which is always unreachable in the test config) and every
  // "is it still red?" assertion then reads that row's status instead.
  const STUB_ROW = () => {
    const t = document.body.innerText
    const at = t.indexOf('127.0.0.1:8767')
    if (at < 0) return ''
    const next = t.indexOf('localhost:11434', at)
    return t.slice(at, next < 0 ? at + 200 : next)
  }

  await check('settings: Check paints a box that answers /models but fails calls', async () => {
    setStubLLMFailing(true)
    await clickByText(page, e => e.innerText === 'Check', 'Check')
    await page.waitForFunction(
      () => /127\.0\.0\.1:8767[\s\S]{0,80}Unreachable/.test(document.body.innerText),
      { timeout: 20000 },
    )
    const row = await page.evaluate(STUB_ROW)
    if (!/Unreachable/.test(row)) return `the broken stub did not go red: ${row}`
    return null
  })

  await check('settings: Check clears the red dot once the box works again', async () => {
    setStubLLMFailing(false)
    await clickByText(page, e => e.innerText === 'Check', 'Check')
    await page.waitForFunction(
      () => /127\.0\.0\.1:8767[\s\S]{0,80}Working/.test(document.body.innerText),
      { timeout: 20000 },
    )
    const row = await page.evaluate(STUB_ROW)
    if (/Unreachable/.test(row)) return `the row stayed red after a successful check: ${row}`
    if (!/Working/.test(row)) return `the recovered box does not read as working: ${row}`
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

// ── Digests: create, run, read, disable ───────────────────────────────────────
// The plan's self-test, through the real screens. Three newsletters: Alpha and Beta
// cover the same release in different words, Gamma mentions it too but is NOT in the
// Digest's scope. The stub model groups every item it is SENT that names the release
// into one topic — so the page shows exactly what the server chose to send, and a
// scope leak would put Gamma on it. Beta's Highlight is a list, and only one of its
// lines is about the release: the topic must point at that bullet, not at the card.
// Picking a newsletter is what holds it: once the Digest is saved, a pipeline run
// finishing for Alpha's Document archives Alpha's Highlight, which then reads from
// the issue and from Archived but never from the feed.
// The question compares with earlier Highlights: Alpha and Gamma each covered the
// release before this one, a month ago. Alpha's is the earlier text the topic's diff
// must rest on; Gamma's must stay off the page like the rest of Gamma.
const DG_NAME = 'Launch Watch'
const DG_PROMPT = `Which releases did more than one newsletter cover? Mention ${STUB_DIGEST_MATCH}.`
const DG_FEEDS = {
  alpha: { id: 'aaaaaaaa-0000-4000-8000-0000000000a1', title: 'Alpha Dispatch' },
  beta: { id: 'aaaaaaaa-0000-4000-8000-0000000000a2', title: 'Beta Bulletin' },
  gamma: { id: 'aaaaaaaa-0000-4000-8000-0000000000a3', title: 'Gamma Gazette' },
  // Subscribed, but no Pipeline ever produced a Highlight from it.
  delta: { id: 'aaaaaaaa-0000-4000-8000-0000000000a4', title: 'Delta Drafts' },
}
const DG_DOCS = {
  alpha: { id: 'dddddddd-0000-4000-8000-0000000000a1', title: 'Alpha Issue 12' },
  beta: { id: 'dddddddd-0000-4000-8000-0000000000a2', title: 'Beta Issue 7' },
  gamma: { id: 'dddddddd-0000-4000-8000-0000000000a3', title: 'Gamma Issue 3' },
}
const DG_BETA_BODY_TEXT = 'Beta body paragraph that only the opened Beta Document shows.'
const DG_ALPHA_TEXT = `${STUB_DIGEST_MATCH} 2 ships today with a tokenizer twice as fast.`
const DG_BETA_BULLET_TAIL = 'cut their second major version.'
const DG_BETA_OTHER = 'Unrelated pricing change at a cloud vendor.'
const DG_GAMMA_TEXT = `Gamma also heard about ${STUB_DIGEST_MATCH} from a reader.`
const DG_OLD_DOCS = {
  alpha: { id: 'dddddddd-0000-4000-8000-0000000000b1', title: 'Alpha Issue 8' },
  gamma: { id: 'dddddddd-0000-4000-8000-0000000000b3', title: 'Gamma Issue 1' },
}
const DG_ALPHA_OLD_TEXT = `${STUB_DIGEST_MATCH} 1 shipped with the original tokenizer.`
const DG_GAMMA_OLD_TEXT = `Gamma's first note on ${STUB_DIGEST_MATCH} 1.`
const DG_HISTORY_SWITCH = 'input[aria-label="Question 1 compare with earlier Highlights"]'
const DG_EARLIER_BULLETS = '[aria-label^="Open earlier source:"]'
const DG_SHOTS = join(ROOT, 'tmp', 'screenshots')

const dgField = label => `[aria-label="${label}"]`
const DG_QUESTION_TITLE = 'Shared releases'
const DG_EDITOR_ERROR = '[data-testid="digest-editor-error"]'
// Not the color a first Digest is given when none is picked (red), so a list row in
// this one proves the PICK was stored.
const DG_COLOR = { name: 'green', rgb: 'rgb(74, 222, 128)' }
const DG_HIGHLIGHTS = {
  alpha: 'ffffffff-0000-4000-8000-0000000000a1',
  beta: 'ffffffff-0000-4000-8000-0000000000a2',
  gamma: 'ffffffff-0000-4000-8000-0000000000a3',
}
const dgSwatch = name => dgField(`Digest color ${name}`)
const dgCard = key => `[data-testid="highlight-card-${DG_HIGHLIGHTS[key]}"]`
const background = (page, selector) =>
  page.$eval(selector, el => getComputedStyle(el).backgroundColor).catch(() => null)
const DG_ENABLED_SWITCH = `input[aria-label="Digest enabled ${DG_NAME}"]`
const DG_SCOPE_NOTE = '[data-testid="digest-scope-note"]'
// The run_pipeline_step Job that completes Alpha's pipeline run — where hold acts.
const DG_HOLD_JOB = 'bbbbbbbb-0000-4000-8000-0000000000a1'
const DG_BULLETS = '[aria-label^="Open source:"]'

function seedDigestFixtures() {
  for (const [key, feed] of Object.entries(DG_FEEDS)) {
    seedFeed({ ...feed, url: `https://${key}.example.com/rss` })
  }
  seedTextDocs(Object.entries(DG_DOCS).map(([key, doc]) => ({
    ...doc,
    canonicalUrl: `https://${key}.example.com/${doc.id}`,
    markdown: `# ${doc.title}\n\n${key === 'beta' ? DG_BETA_BODY_TEXT : `Body of ${doc.title}.`}`,
    sourceFeedId: DG_FEEDS[key].id,
  })))
  // Alpha is the newer Highlight, so it is candidate 1 and Beta's bullet comes second.
  const minuteAgo = new Date(Date.now() - 60_000).toISOString()
  seedHighlight({ id: DG_HIGHLIGHTS.alpha, documentId: DG_DOCS.alpha.id, title: 'Alpha lead', body: DG_ALPHA_TEXT })
  seedHighlight({
    id: DG_HIGHLIGHTS.beta, documentId: DG_DOCS.beta.id, title: 'Beta roundup', createdAt: minuteAgo,
    body: `- A quiet week for conference news.\n- [The ${STUB_DIGEST_MATCH} team](https://beta.example.com/z) cut their second major version.\n- ${DG_BETA_OTHER}`,
  })
  seedHighlight({ id: DG_HIGHLIGHTS.gamma, documentId: DG_DOCS.gamma.id, title: 'Gamma aside', body: DG_GAMMA_TEXT })

  // Before the window of a first daily run: history, never a candidate.
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
  seedTextDocs(Object.entries(DG_OLD_DOCS).map(([key, doc]) => ({
    ...doc,
    canonicalUrl: `https://${key}.example.com/${doc.id}`,
    markdown: `# ${doc.title}\n\nBody of ${doc.title}.`,
    sourceFeedId: DG_FEEDS[key].id,
  })))
  seedHighlight({
    id: 'ffffffff-0000-4000-8000-0000000000b1', documentId: DG_OLD_DOCS.alpha.id,
    title: `${STUB_DIGEST_MATCH} 1 launch`, body: DG_ALPHA_OLD_TEXT, createdAt: monthAgo,
  })
  seedHighlight({
    id: 'ffffffff-0000-4000-8000-0000000000b3', documentId: DG_OLD_DOCS.gamma.id,
    title: `${STUB_DIGEST_MATCH} 1 rumours`, body: DG_GAMMA_OLD_TEXT, createdAt: monthAgo,
  })
}

async function apiDigest(token) {
  const res = await fetch(`${BASE_URL}/api/v1/digests`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`GET /api/v1/digests: HTTP ${res.status}`)
  return (await res.json()).find(d => d.name === DG_NAME)
}

async function openDigestEditor(page) {
  await page.goto(`${BASE_URL}/digests`, { waitUntil: 'networkidle2', timeout: 15000 })
  await page.waitForSelector(dgField(`Edit digest ${DG_NAME}`), { timeout: 10000 })
  await page.click(dgField(`Edit digest ${DG_NAME}`))
  await page.waitForSelector(dgField('Question 1 prompt'), { timeout: 6000 })
}

const feedRowText = (page, title) =>
  page.$eval(dgField(`Newsletter ${title}`), el => el.innerText).catch(() => null)
const feedChecked = (page, title) =>
  page.$eval(dgField(`Newsletter ${title}`), el => el.getAttribute('aria-checked')).catch(() => null)

async function runDigests(token, deviceId) {
  seedDigestFixtures()
  mkdirSync(DG_SHOTS, { recursive: true })
  const { page, errors } = await newConnectedPage(browser, token, deviceId)
  await page.setViewport({ width: 900, height: 1100 })
  await page.goto(`${BASE_URL}/digests`, { waitUntil: 'networkidle2', timeout: 15000 })

  await check('digests: a new digest opens empty — no name, no question, no newsletter picked', async () => {
    await page.waitForSelector(dgField('Add digest'), { timeout: 10000 })
    await page.click(dgField('Add digest'))
    await page.waitForSelector(dgField('Digest name'), { timeout: 6000 })
    await page.waitForSelector(dgField(`Newsletter ${DG_FEEDS.alpha.title}`), { timeout: 6000 })
    const form = await page.evaluate(name => ({
      name: document.querySelector(name).value,
      questions: document.querySelectorAll('[aria-label^="Question "]').length,
      newsletters: [...document.querySelectorAll('[aria-label^="Newsletter "]')].map(el => el.getAttribute('aria-checked')),
    }), dgField('Digest name'))
    await page.screenshot({ path: join(DG_SHOTS, 'digests-new-empty.png'), fullPage: true })
    if (form.name !== '') return `the name is prefilled: "${form.name}"`
    if (form.questions !== 0) return `${form.questions} question controls on a new digest, want none`
    if (form.newsletters.length < 4) return `only ${form.newsletters.length} newsletters offered`
    return form.newsletters.every(c => c === 'false') ? null : `a newsletter is already picked: ${form.newsletters}`
  })

  await check('digests: no hold switch — with nothing picked, a note says picking is what holds', async () => {
    if (await page.$('[aria-label="Hold highlights"]')) return 'the editor still offers a hold switch'
    const note = await page.$eval(DG_SCOPE_NOTE, el => el.innerText).catch(() => null)
    if (note === null) return 'no scope note under Newsletters'
    return note.includes('Pick newsletters to keep their Highlights out of the feed')
      ? null : `with nothing picked the note reads "${note}"`
  })

  await check('digests: saving it empty shows the server\'s reason, and saves nothing', async () => {
    // Two refused saves follow: the 400s are the point, not noise for the net below.
    const before = errors.length
    const editorError = () => page.$eval(DG_EDITOR_ERROR, el => el.innerText).catch(() => '')
    await page.click(dgField('Save digest'))
    await page.waitForSelector(DG_EDITOR_ERROR, { timeout: 6000 })
    const noName = await editorError()
    if (!noName.includes('name required')) return `an empty save reads "${noName}"`
    await page.type(dgField('Digest name'), DG_NAME)
    await page.click(dgField('Save digest'))
    try {
      await page.waitForFunction(sel => document.querySelector(sel)?.innerText.includes('at least one enabled question'),
        { timeout: 6000 }, DG_EDITOR_ERROR)
    } catch {
      return `a save with no question reads "${await editorError()}"`
    }
    await page.screenshot({ path: join(DG_SHOTS, 'digests-new-empty-error.png'), fullPage: true })
    await sleep(300)
    errors.length = before
    return await apiDigest(token) ? 'the refused digest was saved anyway' : null
  })

  await check('digests: a newsletter with no Highlights is marked, one with Highlights is not', async () => {
    // The marker is derived from the replica, so it settles once the pull has landed.
    try {
      await page.waitForFunction(sel => {
        const row = document.querySelector(sel)
        return row && !row.innerText.includes('no Highlights yet')
      }, { timeout: 15000 }, dgField(`Newsletter ${DG_FEEDS.alpha.title}`))
    } catch {
      return `"${DG_FEEDS.alpha.title}" has a Highlight but still reads: ${await feedRowText(page, DG_FEEDS.alpha.title)}`
    }
    const empty = await feedRowText(page, DG_FEEDS.delta.title)
    return empty?.includes('no Highlights yet') ? null : `"${DG_FEEDS.delta.title}" has no Highlights but reads: ${empty}`
  })

  await check('digests: fill the editor — one question added by hand, two newsletters, a model', async () => {
    // The name is already in from the refused save above.
    await page.click(dgField('Add question'))
    await page.waitForSelector(dgField('Question 1 prompt'), { timeout: 6000 })
    const blank = await page.evaluate((title, prompt) => [document.querySelector(title).value, document.querySelector(prompt).value],
      dgField('Question 1 title'), dgField('Question 1 prompt'))
    if (blank.some(v => v !== '')) return `"+ Add question" gave a prefilled question: ${JSON.stringify(blank)}`
    await page.type(dgField('Question 1 title'), DG_QUESTION_TITLE)
    await page.type(dgField('Question 1 prompt'), DG_PROMPT)
    if (await page.$eval(DG_HISTORY_SWITCH, el => el.checked)) return 'a new question already compares with earlier Highlights'
    await page.$eval(DG_HISTORY_SWITCH, el => el.click())
    const preselected = await page.$$eval('[aria-label^="Digest color "][aria-selected="true"]', els => els.length)
    if (preselected !== 0) return 'a new digest already has a color selected'
    await page.click(dgSwatch(DG_COLOR.name))
    if (await page.$eval(dgSwatch(DG_COLOR.name), el => el.getAttribute('aria-selected')) !== 'true') {
      return `pressing the ${DG_COLOR.name} swatch did not select it`
    }
    await page.screenshot({ path: join(DG_SHOTS, 'digests-color-picker.png'), fullPage: true })
    await page.click(dgField(`Newsletter ${DG_FEEDS.alpha.title}`))
    await page.click(dgField(`Newsletter ${DG_FEEDS.beta.title}`))
    await page.click(dgField('Digest model'))
    // Search first, as a person would: it also waits out the sheet's slide-in, during
    // which a row is on its way somewhere else and cannot be clicked.
    await page.waitForSelector(MODEL_SEARCH, { timeout: 6000 })
    await sleep(400)
    await page.click(MODEL_SEARCH)
    await page.keyboard.type(STUB_LLM_MODELS[1], { delay: 30 })
    await sleep(400)
    await page.click(`[aria-label="model ${STUB_LLM_MODELS[1]}"]`)
    await sleep(300)
    const model = await page.$eval(dgField('Digest model'), el => el.innerText)
    if (!model.includes(STUB_LLM_MODELS[1]) || !model.includes(STUB_PROVIDER_ID)) {
      return `the model field reads "${model}" after picking ${STUB_LLM_MODELS[1]}`
    }
    await page.screenshot({ path: join(DG_SHOTS, 'digests-editor.png'), fullPage: true })
    await page.click(dgField('Save digest'))
    await page.waitForFunction(() => document.body.innerText.includes('Digest saved'), { timeout: 8000 })
    return null
  })

  await check('digests: the picked color survives a reload — on the list row and in the picker', async () => {
    const saved = await apiDigest(token)
    if (saved?.color !== DG_COLOR.name) return `the server stored the color as "${saved?.color}"`
    await openDigestEditor(page)
    const row = await background(page, `[data-testid="digest-name-${saved.id}"]`)
    if (row !== DG_COLOR.rgb) return `the list row names the digest on ${row}, want ${DG_COLOR.rgb}`
    const selected = await page.$$eval('[aria-label^="Digest color "][aria-selected="true"]', els => els.map(el => el.getAttribute('aria-label')))
    if (selected.length !== 1 || selected[0] !== `Digest color ${DG_COLOR.name}`) return `the picker reloaded with ${JSON.stringify(selected)} selected`
    await page.screenshot({ path: join(DG_SHOTS, 'digests-color-reloaded.png'), fullPage: true })
    return await background(page, dgSwatch(DG_COLOR.name)) === DG_COLOR.rgb ? null : 'the selected swatch is not the color it names'
  })

  await check('digests: the question, the scope and the model survive a reload', async () => {
    await openDigestEditor(page)
    const prompt = await page.$eval(dgField('Question 1 prompt'), el => el.value)
    if (prompt !== DG_PROMPT) return `the prompt reloaded as "${prompt}"`
    if (!await page.$eval(DG_HISTORY_SWITCH, el => el.checked)) return 'the "compare with earlier Highlights" switch reloaded as OFF'
    if (await page.$(dgField('Question 2 prompt'))) return 'a question nobody added is in the editor'
    const checked = {}
    for (const key of ['alpha', 'beta', 'gamma']) checked[key] = await feedChecked(page, DG_FEEDS[key].title)
    if (checked.alpha !== 'true' || checked.beta !== 'true' || checked.gamma !== 'false') {
      return `newsletter scope reloaded as ${JSON.stringify(checked)}`
    }
    const model = await page.$eval(dgField('Digest model'), el => el.innerText)
    if (!model.includes(STUB_LLM_MODELS[1])) return `the model reloaded as "${model}"`
    const txt = await page.evaluate(() => document.body.innerText)
    return /Daily · 07:00/.test(txt) ? null : `the card does not summarize the schedule: ${txt.slice(0, 300)}`
  })

  await check('digests: a run finishing for a picked newsletter holds its Highlight out of the feed', async () => {
    const note = await page.$eval(DG_SCOPE_NOTE, el => el.innerText).catch(() => '')
    if (!note.includes('2 picked')) return `with two newsletters picked the note reads "${note}"`
    // seedHighlight gave Alpha's Highlight a pipeline run with no steps: one tick
    // completes it, and run completion is where hold acts.
    seedActiveJob({ id: DG_HOLD_JOB, kind: 'run_pipeline_step', payload: { pipeline_run_id: `run-${DG_HIGHLIGHTS.alpha}` }, status: 'queued' })
    for (let i = 0; i < 60; i++) {
      const [alpha, beta] = [await apiHighlight(page, DG_HIGHLIGHTS.alpha), await apiHighlight(page, DG_HIGHLIGHTS.beta)]
      if (alpha?.archived_at) return beta?.archived_at ? 'Beta was archived too, though no run of it finished' : null
      await sleep(500)
    }
    return 'the run finished (or never ran) without archiving Alpha\'s Highlight'
  })

  await check('digests: Run now lands on an issue with ONE topic carrying one bullet per newsletter', async () => {
    await page.click(dgField('Run digest now'))
    try {
      await page.waitForFunction(t => document.body.innerText.includes(t), { timeout: 45000 }, STUB_DIGEST_TOPIC.title)
    } catch {
      return `no topic rendered: ${(await page.evaluate(() => document.body.innerText)).slice(0, 400)}`
    }
    await sleep(500)
    await page.screenshot({ path: join(DG_SHOTS, 'digest-issue.png'), fullPage: true })
    if (!new URL(page.url()).pathname.startsWith('/digest/')) return `Run now landed on ${page.url()}`
    const txt = await page.evaluate(() => document.body.innerText)
    if (!txt.includes(`1. ${STUB_DIGEST_TOPIC.title}`) || !txt.includes(STUB_DIGEST_TOPIC.why)) {
      return `the topic's title/why are not shown: ${txt.slice(0, 400)}`
    }
    if (/\n2\. /.test(txt)) return `more than one topic: ${txt.slice(0, 400)}`
    const bullets = await page.$$eval(DG_BULLETS, els => els.map(el => el.innerText))
    if (bullets.length !== 2) return `${bullets.length} bullets under the topic, want 2: ${JSON.stringify(bullets)}`
    if (!bullets[0].includes(DG_ALPHA_TEXT) || !bullets[0].includes(DG_FEEDS.alpha.title)) {
      return `the first bullet is not Alpha's Highlight under its newsletter name: "${bullets[0]}"`
    }
    if (!bullets[1].includes(`The ${STUB_DIGEST_MATCH} team`) || !bullets[1].includes(DG_BETA_BULLET_TAIL)) {
      return `the second bullet is not Beta's release line: "${bullets[1]}"`
    }
    if (/\]\(|^\s*[-*•]/.test(bullets[1])) return `the bullet shows raw markdown: "${bullets[1]}"`
    if (!bullets[1].includes(DG_FEEDS.beta.title)) return `the second bullet does not name its newsletter: "${bullets[1]}"`
    if (txt.includes(DG_BETA_OTHER)) return 'the topic shows the whole Beta Highlight, not the one bullet it cites'
    return null
  })

  await check('digests: nothing from the newsletter outside the scope is on the issue', async () => {
    const txt = await page.evaluate(() => document.body.innerText)
    for (const leak of [DG_FEEDS.gamma.title, DG_DOCS.gamma.title, DG_GAMMA_TEXT, DG_OLD_DOCS.gamma.title, DG_GAMMA_OLD_TEXT]) {
      if (txt.includes(leak)) return `"${leak}" is on the page — Gamma is not in this digest`
    }
    return null
  })

  await check('digests: the topic says what changed since the earlier release, over the dated earlier bullet', async () => {
    const diff = await page.$eval('[data-testid="digest-topic-diff-1"]', el => el.innerText).catch(() => null)
    if (diff === null) return 'the topic shows no diff line'
    if (!diff.includes(`vs ${STUB_DIGEST_DIFF.previous}:`) || !diff.includes(STUB_DIGEST_DIFF.diff)) return `the diff line reads "${diff}"`
    const earlier = await page.$$eval(DG_EARLIER_BULLETS, els => els.map(el => el.innerText))
    if (earlier.length !== 1) return `${earlier.length} earlier bullets under the topic, want 1: ${JSON.stringify(earlier)}`
    if (!earlier[0].includes(DG_ALPHA_OLD_TEXT)) return `the earlier bullet is not Alpha's month-old Highlight: "${earlier[0]}"`
    if (!/Earlier · \d{4}-\d{2}-\d{2}/.test(earlier[0]) || !earlier[0].includes(DG_OLD_DOCS.alpha.title)) {
      return `the earlier bullet does not carry its date and Document: "${earlier[0]}"`
    }
    return null
  })

  const issueUrl = page.url()

  await check('digests: pressing the second bullet opens Beta\'s Document', async () => {
    const bullets = await page.$$(DG_BULLETS)
    await bullets[1].click()
    try {
      await page.waitForFunction(id => location.pathname === `/document/${id}`, { timeout: 8000 }, DG_DOCS.beta.id)
      await waitViewerReady(page)
    } catch {
      return `landed on ${page.url()}, want /document/${DG_DOCS.beta.id}`
    }
    const body = await page.evaluate(() => document.querySelector('iframe').contentDocument.body.innerText)
    return body.includes(DG_BETA_BODY_TEXT) ? null : `the opened Document is not Beta's: "${body.slice(0, 200)}"`
  })

  await check('digests: the issue reads from the replica with the network cut', async () => {
    // Online once more, so the pull that carries the Digest and its issue has landed.
    await page.goto(issueUrl, { waitUntil: 'networkidle2', timeout: 15000 })
    await sleep(5000)
    await page.evaluate(() => localStorage.setItem('samizdat_force_offline', '1'))
    await page.goto(issueUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
    try {
      await page.waitForFunction(t => document.body.innerText.includes(t), { timeout: 12000 }, STUB_DIGEST_TOPIC.title)
    } catch {
      return `no topic offline: ${(await page.evaluate(() => document.body.innerText)).slice(0, 300)}`
    }
    const bullets = await page.$$eval(DG_BULLETS, els => els.map(el => el.innerText))
    await page.screenshot({ path: join(DG_SHOTS, 'digest-issue-offline.png'), fullPage: true })
    if (bullets.length !== 2) return `${bullets.length} bullets offline, want 2`
    if (!bullets[0].includes(DG_ALPHA_TEXT)) return `Alpha's bullet did not resolve from the replica: "${bullets[0]}"`
    if (!bullets[1].includes(DG_DOCS.beta.title)) return `Beta's bullet does not name its Document offline: "${bullets[1]}"`
    const earlier = await page.$$eval(DG_EARLIER_BULLETS, els => els.map(el => el.innerText))
    if (earlier.length !== 1 || !earlier[0].includes(DG_ALPHA_OLD_TEXT) || !/Earlier · \d{4}-\d{2}-\d{2}/.test(earlier[0])) {
      return `the earlier bullet did not resolve from the replica with its date: ${JSON.stringify(earlier)}`
    }
    const txt = await page.evaluate(() => document.body.innerText)
    return txt.includes(DG_NAME) ? null : 'the digest name is not shown offline'
  })
  await page.evaluate(() => localStorage.removeItem('samizdat_force_offline'))

  // The chip is computed from the replica, which the offline check above has shown
  // to hold the Digest and its issue.
  const digestId = (await apiDigest(token))?.id
  const chip = key => `${dgCard(key)} [data-testid="digest-chip-${digestId}"]`
  await check('digests: the feed hides the held Highlight; a cited card carries the chip in its color, an uncited one none', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2', timeout: 15000 })
    try {
      await page.waitForSelector(chip('beta'), { timeout: 15000 })
    } catch {
      const card = await page.$eval(dgCard('beta'), el => el.innerText).catch(() => null)
      return card === null ? 'Beta\'s Highlight card is not in the feed' : `Beta's card has no digest chip: ${card.slice(0, 200)}`
    }
    await page.$eval(chip('beta'), el => el.scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: join(DG_SHOTS, 'feed-digest-chip.png') })
    if (await page.$(dgCard('alpha'))) return 'Alpha\'s Highlight is held, but its card is in the feed'
    const name = await page.$eval(chip('beta'), el => el.innerText.trim())
    if (name !== DG_NAME) return `the chip reads "${name}", want "${DG_NAME}"`
    const color = await background(page, chip('beta'))
    if (color !== DG_COLOR.rgb) return `the chip is ${color}, want ${DG_COLOR.rgb}`
    if (!await page.$(dgCard('gamma'))) return 'Gamma\'s card is not in the feed, so its missing chip proves nothing'
    return await page.$(`${dgCard('gamma')} [data-testid^="digest-chip-"]`) ? 'Gamma was not cited but its card has a chip' : null
  })

  // The run's topic is a card of its own in the feed, its bullets the stored text of the
  // Highlights it cites — Alpha's included, though Alpha's own card is held out.
  const issueId = (await (await fetch(`${BASE_URL}/api/v1/digests/${digestId}/issues`,
    { headers: { Authorization: `Bearer ${token}` } })).json())[0]?.id
  const topicCard = `[data-testid^="digest-topic-card-${issueId}:"]`
  await check('digests: the issue\'s topic is a feed card — title, why, the cited bullets, the chip', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2', timeout: 15000 })
    try {
      await page.waitForSelector(topicCard, { timeout: 15000 })
    } catch {
      return `no topic card in the feed: ${(await page.evaluate(() => document.body.innerText)).slice(0, 300)}`
    }
    await page.$eval(topicCard, el => el.scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: join(DG_SHOTS, 'feed-digest-topic.png') })
    const card = await page.$eval(topicCard, el => el.innerText)
    if (!card.includes(STUB_DIGEST_TOPIC.title) || !card.includes(STUB_DIGEST_TOPIC.why)) {
      return `the card does not show the topic's title and why: "${card.slice(0, 300)}"`
    }
    if (!card.includes(DG_ALPHA_TEXT)) return `the card does not show Alpha's held bullet: "${card.slice(0, 300)}"`
    if (!card.includes(DG_BETA_BULLET_TAIL)) return `the card does not show Beta's cited bullet: "${card.slice(0, 300)}"`
    if (card.includes(DG_ALPHA_OLD_TEXT)) return 'the card shows the earlier (history) bullet; that belongs to the issue'
    if (card.includes(DG_BETA_OTHER)) return 'the card shows the whole Beta Highlight, not the one bullet it cites'
    const chipSel = `${topicCard} [data-testid="digest-chip-${digestId}"]`
    const name = await page.$eval(chipSel, el => el.innerText.trim()).catch(() => null)
    if (name !== DG_NAME) return `the card's chip reads "${name}", want "${DG_NAME}"`
    const color = await background(page, chipSel)
    if (color !== DG_COLOR.rgb) return `the card's chip is ${color}, want ${DG_COLOR.rgb}`
    // Newest in the feed: the issue was written after every seeded Highlight.
    const first = await page.$eval('[data-testid^="digest-topic-card-"], [data-testid^="highlight-card-"]',
      el => el.getAttribute('data-testid'))
    return first?.startsWith(`digest-topic-card-${issueId}:`)
      ? null : `the first card is ${first}, want the topic (window_end is the newest stamp)`
  })

  await check('digests: pressing the topic card opens its issue', async () => {
    // The title text, not the chip: the card itself must lead to the issue. A real
    // click at the title's position, so whatever sits on top of it is what gets it.
    const box = await page.$eval(topicCard, (card, t) => {
      const el = [...card.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent === t)
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }, STUB_DIGEST_TOPIC.title)
    if (!box) return 'the topic title is not on the card'
    await page.mouse.click(box.x, box.y)
    try {
      await page.waitForFunction(t => location.pathname.startsWith('/digest/') && document.body.innerText.includes(t),
        { timeout: 10000 }, STUB_DIGEST_TOPIC.why)
    } catch {
      return `the card led to ${page.url()}`
    }
    const at = new URL(page.url())
    return at.pathname === `/digest/${digestId}` && at.searchParams.get('issue') === issueId
      ? null : `the card led to ${at.pathname}${at.search}, want /digest/${digestId}?issue=${issueId}`
  })

  await check('digests: the held Highlight reads from Archived, with its chip', async () => {
    await page.goto(`${BASE_URL}/archived`, { waitUntil: 'networkidle2', timeout: 15000 })
    try {
      await page.waitForSelector(chip('alpha'), { timeout: 15000 })
    } catch {
      const card = await page.$eval(dgCard('alpha'), el => el.innerText).catch(() => null)
      return card === null ? 'Alpha\'s held Highlight is not in Archived' : `Alpha's archived card has no digest chip: ${card.slice(0, 200)}`
    }
    await page.$eval(chip('alpha'), el => el.scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: join(DG_SHOTS, 'archived-digest-chip.png') })
    return null
  })

  await check('digests: pressing the held Highlight\'s chip opens the issue that cites it', async () => {
    await page.click(chip('alpha'))
    try {
      await page.waitForFunction(t => location.pathname.startsWith('/digest/') && document.body.innerText.includes(t),
        { timeout: 10000 }, STUB_DIGEST_TOPIC.title)
    } catch {
      return `the chip led to ${page.url()}`
    }
    const at = new URL(page.url())
    if (at.pathname !== `/digest/${digestId}` || at.searchParams.get('issue') !== issueId) {
      return `the chip led to ${at.pathname}${at.search}, want /digest/${digestId}?issue=${issueId}`
    }
    const header = await background(page, '[data-testid="digest-issue-name"]')
    return header === DG_COLOR.rgb ? null : `the issue header names the digest on ${header}, want ${DG_COLOR.rgb}`
  })

  await check('digests: disabling in the list survives a reload', async () => {
    await page.goto(`${BASE_URL}/digests`, { waitUntil: 'networkidle2', timeout: 15000 })
    await page.waitForSelector(DG_ENABLED_SWITCH, { timeout: 10000 })
    const txt = await page.evaluate(() => document.body.innerText)
    if (/last issue: none yet/.test(txt)) return 'the card still says no issue was written'
    if (!await page.$eval(DG_ENABLED_SWITCH, el => el.checked)) return 'the digest is not enabled to begin with'
    await page.$eval(DG_ENABLED_SWITCH, el => el.click())
    await page.waitForFunction(sel => document.querySelector(sel)?.checked === false, { timeout: 8000 }, DG_ENABLED_SWITCH)
    if ((await apiDigest(token))?.enabled !== false) return 'the server still has the digest enabled'
    await page.goto(`${BASE_URL}/digests`, { waitUntil: 'networkidle2', timeout: 15000 })
    await page.waitForSelector(DG_ENABLED_SWITCH, { timeout: 10000 })
    await sleep(500)
    await page.screenshot({ path: join(DG_SHOTS, 'digests-list.png'), fullPage: true })
    if (await page.$eval(DG_ENABLED_SWITCH, el => el.checked)) return 'the switch reloaded as ON'
    return /next run: off/.test(await page.evaluate(() => document.body.innerText)) ? null : 'a disabled digest still shows a next run'
  })

  // Both checks below save from the editor, then read the result three ways: the
  // server's row, the list card, and the editor a fresh page load opens.
  const saveDigest = async saved => {
    await page.click(dgField('Save digest'))
    for (let i = 0; i < 40; i++) {
      if (saved(await apiDigest(token))) return true
      await sleep(200)
    }
    return false
  }

  await check('digests: weekly on Tuesday and Friday survives save + reload', async () => {
    await openDigestEditor(page)
    await page.click(dgField('Period weekly'))
    await page.waitForSelector(dgField('Weekday Tue'), { timeout: 6000 })
    // Friday first: the server stores the days sorted, whatever order they were tapped in.
    await page.click(dgField('Weekday Fri'))
    await page.click(dgField('Weekday Tue'))
    if (!await saveDigest(d => d?.period === 'weekly')) return 'the server never saw the digest become weekly'
    const weekdays = JSON.stringify((await apiDigest(token)).weekdays)
    if (weekdays !== '[2,5]') return `the server stored weekdays ${weekdays}, want [2,5]`

    await openDigestEditor(page)
    const card = await page.evaluate(() => document.body.innerText)
    if (!card.includes('Weekly · Tue, Fri · 07:00')) return `the card does not name Tuesday and Friday: ${card.slice(0, 300)}`
    const selected = await page.$$eval('[aria-label^="Weekday "]', els =>
      els.filter(el => el.getAttribute('aria-selected') === 'true').map(el => el.getAttribute('aria-label')))
    await page.screenshot({ path: join(DG_SHOTS, 'digests-weekly.png'), fullPage: true })
    return selected.join() === 'Weekday Tue,Weekday Fri' ? null : `the editor reloaded with ${JSON.stringify(selected)} selected`
  })

  await check('digests: a question added with "+ Add question" survives save + reload', async () => {
    const added = { title: 'Second look', prompt: 'What did only one newsletter notice?' }
    await openDigestEditor(page)
    if (await page.$(dgField('Question 2 prompt'))) return 'the digest already has a second question'
    await page.click(dgField('Add question'))
    await page.waitForSelector(dgField('Question 2 prompt'), { timeout: 6000 })
    await page.type(dgField('Question 2 title'), added.title)
    await page.type(dgField('Question 2 prompt'), added.prompt)
    if (!await saveDigest(d => d?.questions.length === 2)) return 'the server never saw a second question'
    const stored = (await apiDigest(token)).questions[1]
    if (stored.title !== added.title || stored.prompt !== added.prompt || !stored.id || !stored.enabled) {
      return `the server stored the new question as ${JSON.stringify(stored)}`
    }

    await openDigestEditor(page)
    await page.waitForSelector(dgField('Question 2 prompt'), { timeout: 6000 }).catch(() => {})
    const shown = await page.evaluate((title, prompt) => ({
      title: document.querySelector(title)?.value,
      prompt: document.querySelector(prompt)?.value,
    }), dgField('Question 2 title'), dgField('Question 2 prompt'))
    if (shown.title !== added.title || shown.prompt !== added.prompt) return `the editor reloaded it as ${JSON.stringify(shown)}`
    const first = await page.$eval(dgField('Question 1 prompt'), el => el.value)
    return first === DG_PROMPT ? null : `adding a question changed the first one to "${first}"`
  })

  const unexpected = errors.filter(e => !/Failed to fetch|simulated offline/i.test(e))
  if (unexpected.length) fail('digests: no unrelated console/HTTP errors', unexpected.slice(0, 4).join(' | '))
  else pass('digests: no unrelated console/HTTP errors')

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
    // Back-dated so they sort BELOW the four cards above: the feed checks that came
    // first drag/tap the top of the list and a fixture pushing them off-screen would
    // break them.
    for (const [i, h] of CARD_HLS.entries()) {
      seedHighlight({ ...h, documentId: TEXT_DOC_ID, createdAt: `2026-07-0${4 - i}T12:00:00Z` })
    }
    seedTextDoc(PROV_DOC)
    seedHighlight({
      id: PROV_HL_ID, documentId: PROV_DOC_ID, title: PROV_HL_TITLE, body: PROV_HL_BODY,
      metadata: PROV_METADATA, createdAt: '2026-06-01T12:00:00Z',
    })
    // The dates fixture: an article published in January, ingested months later.
    seedTextDoc(DATED_DOC)
    for (const h of DATE_HLS) {
      seedHighlight({ id: h.id, documentId: DATED_DOC_ID, title: h.title, body: `Ingested ${h.createdAt}.`, createdAt: h.createdAt })
    }
    // The note link is real API traffic, not a seeded row — highlight_id has to
    // survive create → sync → replica for the card to know anything. The anchor is a
    // sentinel that appears in NO rendered body on purpose: the viewer marks every
    // annotation whose `exact` it can find, highlight-card bodies included, and a stray
    // <mark> ahead of the article would be the one the selection-lifecycle checks tap
    // (and then delete).
    for (const h of CARD_HLS.filter(x => x.noted)) {
      await postAnnotation(token, { documentId: TEXT_DOC_ID, highlightId: h.id, exact: `unmatched anchor ${h.id}`, note: 'seeded note' })
    }

    console.log('  launching browser...')
    browser = await launchBrowser()

    await runPageChecks(token, deviceId)
    await runAddUrlSheet(token, deviceId)
    await runDocumentsAddCancel(token, deviceId)
    await runFeedSwipeArchive(token, deviceId)
    await runTouchDelete(token, deviceId)
    await runAddedVia(token, deviceId)
    await runImageLightbox(token, deviceId)
    await runFigureRendering(token, deviceId)
    await runSelectionLifecycle(token, deviceId)
    await runHighlightSelectionLifecycle(token, deviceId)
    await runHighlightProvenance(token, deviceId)
    await runAnnotationSelectionContext(token, deviceId)
    await runDocViewerNoSwipe(token, deviceId)
    await runFeedNoteIndicator(token, deviceId)
    await runFeedDateStamp(token, deviceId)
    // Before runSettingsServices: that one permanently seeds a broken LLM provider,
    // which would keep the drawer dot lit for every check after it.
    // Before runSettingsServices for the same reason as runPersistFailure: both read a
    // clean error state.
    await runDbLayer(token, deviceId)
    await runPersistFailure(token, deviceId)
    // Before runSettingsServices too: it reads the Settings screen with every
    // service still healthy.
    await runSettingsLayout(token, deviceId)
    // Before runSettingsServices for the same reason: it reads Settings with every
    // service healthy, and that one seeds a permanently broken provider.
    await runContextMenuSettings(token, deviceId)
    await runSettingsServices(token, deviceId)
    await runPipelineStepsUi(token, deviceId)
    // After runSettingsServices: this one makes a REAL completion through the stub
    // box, and a real call lands in the provider-health registry — where in-memory
    // rows beat seeded ones, so it would move the per-endpoint call counts that
    // check asserts on.
    await runSelectionContextMenu(token, deviceId)
    await runTranscriptContextMenu(token, deviceId)
    await runTranscriptPlayback(token, deviceId)
    // Last: the reading mode persists globally (AsyncStorage → shared localStorage),
    // so leaving it on Page would silently paginate every earlier check's viewer.
    await runPageMode(token, deviceId)
    await runReadingMode(token, deviceId)
    // After runSettingsServices, like the context-menu check: a run is a real
    // completion through the stub box. Late, because its Highlights are the newest
    // cards in the feed and the feed checks above drag and tap the top of the list.
    await runDigests(token, deviceId)
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
