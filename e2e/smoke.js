#!/usr/bin/env node
// Smoke test: starts test server, pairs a device, navigates all main pages,
// captures JS errors and HTTP failures. Run via: just e2e
//
// Requires: server binary at server/bin/samizdat, web build at app/dist/

import puppeteer from 'puppeteer-core'
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dir, '..')

const CHROMIUM = process.env.CHROMIUM_PATH ||
  '/home/symunona/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome'
const SERVER_BIN = join(ROOT, 'server/bin/samizdat')
const TEST_CONFIG = join(ROOT, 'config/config-test.toml')
const TEST_PORT = 8766
const BASE_URL = `http://localhost:${TEST_PORT}`

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

let serverProc = null
let browser = null
let failed = false
let cleaningUp = false

function fail(msg) {
  console.error(`\n  FAIL: ${msg}`)
  failed = true
}

async function cleanup() {
  if (cleaningUp) return
  cleaningUp = true
  if (browser) { try { await browser.close() } catch {} browser = null }
  if (serverProc) {
    try { process.kill(-serverProc.pid, 'SIGTERM') } catch {}
    await sleep(600)
    try { process.kill(-serverProc.pid, 'SIGKILL') } catch {}
    serverProc = null
  }
}

// Synchronous last-resort kill on exit (catches normal exit + uncaught throws)
process.on('exit', () => {
  if (serverProc) { try { process.kill(-serverProc.pid, 'SIGKILL') } catch {} }
})

process.on('SIGINT', async () => { await cleanup(); process.exit(130) })
process.on('SIGTERM', async () => { await cleanup(); process.exit(143) })

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function waitForHealth(maxWaitMs = 8000) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/health`)
      if (res.ok) return true
    } catch { /* not up yet */ }
    await sleep(200)
  }
  return false
}

async function startServer() {
  console.log('  starting test server on port', TEST_PORT, '...')
  serverProc = spawn(SERVER_BIN, ['--config', TEST_CONFIG], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group — lets cleanup kill the whole tree (samizdat + playwright-go + chromium)
  })
  serverProc.stdout.on('data', d => process.stdout.write(`  [server] ${d}`))
  serverProc.stderr.on('data', d => process.stdout.write(`  [server] ${d}`))
  serverProc.on('exit', code => {
    if (code !== null && code !== 0) console.error(`  [server] exited with code ${code}`)
  })

  const up = await waitForHealth()
  if (!up) throw new Error('server did not become healthy within 8s')
  console.log('  server ready')
}

async function pairDevice() {
  // Create a pair code via admin endpoint (localhost-only, no passphrase needed)
  const mintRes = await fetch(`${BASE_URL}/api/v1/admin/pair/new`, { method: 'POST' })
  if (!mintRes.ok) throw new Error(`admin/pair/new failed: ${mintRes.status}`)
  const { code } = await mintRes.json()

  // Pair using the code
  const pairRes = await fetch(`${BASE_URL}/api/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name: 'smoke-test-device' }),
  })
  if (!pairRes.ok) throw new Error(`pair failed: ${pairRes.status}`)
  const { device_token: token, device_id: deviceId } = await pairRes.json()
  console.log(`  paired device ${deviceId}`)
  return { token, deviceId }
}

// seedVideoDoc inserts a video Document (transcript + audio asset) into the test
// DB so the dedicated player screen is covered. There's no API to create video
// Documents directly (ingest needs yt-dlp + a residential proxy), so we seed the
// rows + a placeholder audio file the same way the engine would.
function seedVideoDoc(deviceId) {
  const aid = 'eeeeeeee-0000-4000-8000-0000000000a1'
  const rsid = 'eeeeeeee-0000-4000-8000-0000000000b1'
  const mediaDir = '/tmp/samizdat-test/cache/media'
  fs.mkdirSync(mediaDir, { recursive: true })
  // Placeholder file: makes GET /documents/:id/audio return 200 (no 4xx); the
  // headless run never plays it.
  fs.writeFileSync(join(mediaDir, `${aid}.m4a`), Buffer.alloc(2048))
  const now = new Date().toISOString()
  const segs = [
    { start_ms: 0, end_ms: 3000, text: 'First line of the seeded transcript.' },
    { start_ms: 3000, end_ms: 6000, text: 'Second line follows along with playback.' },
    { start_ms: 6000, end_ms: 9000, text: 'Third line for the smoke test.' },
  ]
  const q = s => s.replace(/'/g, "''")
  const transcript = q(JSON.stringify(segs))
  const markdown = q(segs.map(s => s.text).join('\n'))
  const meta = q(JSON.stringify({ provider: 'youtube', external_id: 'PqtggjVAi8M', duration_ms: 9000, transcript_status: 'subs' }))
  const cu = 'https://www.youtube.com/watch?v=SMOKETEST01'
  const sql = `
INSERT OR REPLACE INTO documents (id,canonical_url,title,markdown,fetched_at,excerpt,hero_image_url,author,published_at,source_feed_id,content_hash,media_type,media_metadata,transcript,created_at,updated_at,rev,deleted_at)
VALUES ('${VIDEO_DOC_ID}','${cu}','Smoke Video','${markdown}','${now}','','','Smoke',NULL,NULL,'smokehash','video','${meta}','${transcript}','${now}','${now}',1,NULL);
INSERT OR REPLACE INTO media_assets (id,document_id,original_url,local_path,kind,width,height,created_at,updated_at,rev,deleted_at)
VALUES ('${aid}','${VIDEO_DOC_ID}','${cu}#audio','media/${aid}.m4a','audio',NULL,NULL,'${now}','${now}',0,NULL);
INSERT OR REPLACE INTO read_states (id,device_id,document_id,scroll_y,created_at,updated_at,rev,deleted_at)
VALUES ('${rsid}','${deviceId}','${VIDEO_DOC_ID}',0,'${now}','${now}',0,NULL);
`
  const sqlFile = '/tmp/samizdat-test/seed.sql'
  fs.writeFileSync(sqlFile, sql)
  execSync(`sqlite3 /tmp/samizdat-test/app.db < ${sqlFile}`)
  console.log('  seeded video document', VIDEO_DOC_ID)
}

async function runSmoke() {
  // Kill any stale test server on this port, then clean test DB
  const { execSync } = await import('node:child_process')
  try {
    const pid = execSync(`ss -tlnp 2>/dev/null | grep :${TEST_PORT} | grep -oP 'pid=\\K[0-9]+'`).toString().trim()
    if (pid) { execSync(`kill ${pid}`); await sleep(600) }
  } catch { /* nothing running */ }
  execSync('rm -rf /tmp/samizdat-test && mkdir -p /tmp/samizdat-test')

  await startServer()
  const { token, deviceId } = await pairDevice()
  seedVideoDoc(deviceId)

  console.log('  launching browser...')
  browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })

  const connectionData = JSON.stringify({
    token,
    deviceId,
    serverUrls: [BASE_URL],
  })

  const errors = []

  for (const [path, label] of PAGES) {
    const page = await browser.newPage()

    // Seed localStorage before navigation
    await page.evaluateOnNewDocument((data, lastUrl) => {
      localStorage.setItem('samizdat_connection', data)
      localStorage.setItem('samizdat_last_url', lastUrl)
    }, connectionData, BASE_URL)

    // Capture console errors
    const pageErrors = []
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text()
        // Skip benign browser errors
        if (text.includes('favicon.ico')) return
        pageErrors.push(text)
      }
    })
    page.on('pageerror', err => {
      pageErrors.push(`pageerror: ${err.message}`)
    })

    // Capture failed requests
    page.on('requestfailed', req => {
      const url = req.url()
      if (url.startsWith(BASE_URL + '/api/')) {
        pageErrors.push(`request failed: ${req.method()} ${url} — ${req.failure()?.errorText}`)
      }
    })

    page.on('response', res => {
      const url = res.url()
      if (url.startsWith(BASE_URL + '/api/') && res.status() >= 400) {
        pageErrors.push(`HTTP ${res.status()}: ${res.request().method()} ${url}`)
      }
    })

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

  return errors
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
