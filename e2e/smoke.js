#!/usr/bin/env node
// Smoke test: starts test server, pairs a device, navigates all main pages,
// captures JS errors and HTTP failures. Run via: just e2e
//
// This is the shallow net (does every page load without errors?). The DEEP net —
// does select→annotate→highlight actually work? — lives in integration.js (just
// e2e-int), which drives real interactions. Keep them split: a green smoke test is
// NOT proof a feature works (see CLAUDE.md "Testing").
//
// Requires: server binary at server/bin/samizdat, web build at app/dist/

import fs from 'node:fs'
import { join } from 'node:path'
import {
  BASE_URL, sleep, resetTestEnv, startServer, pairDevice, launchBrowser,
  newConnectedPage, seedVideoDoc, makeCleanup,
} from './harness.js'

// A fixed video Document id seeded into the test DB so the video player screen
// (transcript + audio + seeker) is exercised by the smoke test.
const VIDEO_DOC_ID = 'eeeeeeee-0000-4000-8000-000000000001'

// Pages to visit: [path, description]
const PAGES = [
  ['/', 'root / connect'],
  ['/starred', 'starred'],
  ['/archived', 'archived'],
  ['/documents', 'documents'],
  ['/tags', 'tags'],
  ['/jobs', 'jobs'],
  ['/subscriptions', 'subscriptions'],
  ['/pipelines', 'pipelines'],
  [`/document/${VIDEO_DOC_ID}`, 'video document'],
]

let browser = null
let serverProc = null
const cleanup = makeCleanup(() => ({ browser, serverProc }))

process.on('exit', () => { if (serverProc) { try { process.kill(-serverProc.pid, 'SIGKILL') } catch {} } })
process.on('SIGINT', async () => { await cleanup(); process.exit(130) })
process.on('SIGTERM', async () => { await cleanup(); process.exit(143) })

async function runSmoke() {
  resetTestEnv()
  serverProc = await startServer()
  const { token, deviceId } = await pairDevice('smoke-test-device')
  seedVideoDoc(deviceId, VIDEO_DOC_ID)

  console.log('  launching browser...')
  browser = await launchBrowser()

  const errors = []

  for (const [path, label] of PAGES) {
    const { page, errors: pageErrors } = await newConnectedPage(browser, token, deviceId)
    try {
      await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle2', timeout: 15000 })
      await sleep(1500) // let React render + sync settle
    } catch (e) {
      pageErrors.push(`navigation error: ${e.message}`)
    }
    await page.close()

    if (pageErrors.length > 0) {
      console.error(`\n  FAIL [${label}] (${path}):`)
      for (const e of pageErrors) console.error(`    - ${e}`)
      errors.push(...pageErrors.map(e => `[${label}] ${e}`))
    } else {
      console.log(`  PASS [${label}] (${path})`)
    }
  }

  // API contract checks for the rerun-cascade feature (no LLM / network needed;
  // deep cascade semantics are covered by the Go store/pipeline tests).
  errors.push(...await runJobsApiChecks(token))

  // Auto-export: the seeded video Document must land on disk as markdown.
  errors.push(...await runExportChecks(token))

  return errors
}

// runExportChecks polls the export stats endpoint until the seeded Document is
// mirrored to disk, then asserts the markdown file exists with our frontmatter.
async function runExportChecks(token) {
  const auth = { Authorization: `Bearer ${token}` }
  const out = []

  // Create an annotation so the note's embedded-callout path is exercised too.
  const noteText = 'smoke-annotation-note'
  try {
    const res = await fetch(`${BASE_URL}/api/v1/documents/${VIDEO_DOC_ID}/annotations`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ exact: 'seeded transcript', note: noteText, media_ts_ms: 1500 }),
    })
    if (!res.ok) out.push(`[export] create annotation HTTP ${res.status}`)
  } catch (e) {
    out.push(`[export] create annotation threw: ${e.message}`)
  }

  let stats = null
  // The exporter sweeps on a ticker; the doc is seeded after startup, so poll.
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/export/stats`, { headers: auth })
      if (!res.ok) { out.push(`[export] stats HTTP ${res.status}`); return out }
      stats = await res.json()
      if (stats.enabled && stats.doc_count >= 1) break
    } catch (e) {
      out.push(`[export] stats threw: ${e.message}`); return out
    }
    await sleep(1000)
  }

  if (!stats || !stats.enabled) {
    out.push('[export] stats not enabled'); return out
  }
  if (stats.doc_count < 1) {
    out.push(`[export] doc_count still 0 after wait (dir ${stats.dir})`); return out
  }
  console.log(`  PASS [export] stats: ${stats.doc_count} doc(s) mirrored`)

  // Structured layout: documents/ and annotations/ subfolders + _index.md.
  try {
    const readMd = (sub) => {
      const dir = join(stats.dir, sub)
      if (!fs.existsSync(dir)) return []
      return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(join(dir, f), 'utf8'))
    }

    const docNote = readMd('documents').find((t) => t.includes('samizdat: export') && t.includes(VIDEO_DOC_ID))
    if (!docNote) out.push(`[export] no documents/ note with id ${VIDEO_DOC_ID}`)
    else console.log('  PASS [export] doc note written to documents/')

    // The annotation must be its own note under annotations/, linked from the doc.
    const annNote = readMd('annotations').find((t) => t.includes('samizdat: export-annotation') && t.includes(noteText))
    if (!annNote) out.push('[export] annotation note missing from annotations/')
    else console.log('  PASS [export] annotation written to annotations/')
    if (stats.annotation_count < 1) out.push(`[export] annotation_count is ${stats.annotation_count}`)
    if (docNote && !docNote.includes('## Annotations')) out.push('[export] doc note missing annotation links')
    else if (docNote) console.log('  PASS [export] doc note links its annotations')

    if (!fs.existsSync(join(stats.dir, '_index.md'))) out.push('[export] _index.md missing')
    else console.log('  PASS [export] _index.md built')
  } catch (e) {
    out.push(`[export] disk check threw: ${e.message}`)
  }

  return out
}

// runJobsApiChecks validates the rerun + history endpoints end-to-end through the
// running server.
async function runJobsApiChecks(token) {
  const auth = { Authorization: `Bearer ${token}` }
  const out = []

  // 1. History listing returns the paged shape with an items array.
  try {
    const res = await fetch(`${BASE_URL}/api/v1/jobs?include_superseded=true&limit=5&offset=0`, { headers: auth })
    if (!res.ok) {
      out.push(`[jobs-api] include_superseded HTTP ${res.status}`)
    } else {
      const body = await res.json()
      if (!Array.isArray(body.items)) out.push('[jobs-api] include_superseded: items not an array')
      else console.log('  PASS [jobs-api] include_superseded returns paged items')
    }
  } catch (e) {
    out.push(`[jobs-api] include_superseded threw: ${e.message}`)
  }

  // 2. Rerun of an unknown job id is a clean 404 (not a 500).
  try {
    const res = await fetch(`${BASE_URL}/api/v1/jobs/does-not-exist/rerun`, { method: 'POST', headers: auth })
    if (res.status !== 404) out.push(`[jobs-api] rerun unknown id: expected 404, got ${res.status}`)
    else console.log('  PASS [jobs-api] rerun unknown id → 404')
  } catch (e) {
    out.push(`[jobs-api] rerun threw: ${e.message}`)
  }

  return out
}

async function main() {
  console.log('\n=== Samizdat smoke test ===\n')

  try {
    const errors = await runSmoke()

    if (errors.length > 0) {
      console.error('\n=== FAILED ===')
      console.error(`${errors.length} error(s) found.`)
      process.exitCode = 1
    } else {
      console.log('\n=== PASSED ===')
      console.log('All pages loaded without JS errors.')
    }
  } catch (e) {
    console.error('\n=== ERROR ===')
    console.error(e.message)
    process.exitCode = 1
  } finally {
    await cleanup()
  }
}

main()
