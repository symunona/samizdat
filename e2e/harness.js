// Shared e2e harness: server lifecycle, device pairing, browser launch, DB seed.
// Used by both smoke.js (page-load errors) and integration.js (real interactions).

import puppeteer from 'puppeteer-core'
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(__dir, '..')

export const CHROMIUM = process.env.CHROMIUM_PATH ||
  '/home/symunona/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome'
export const SERVER_BIN = join(ROOT, 'server/bin/samizdat')
export const TEST_CONFIG = join(ROOT, 'config/config-test.toml')
export const TEST_PORT = 8766
export const BASE_URL = `http://localhost:${TEST_PORT}`
export const TEST_DB = '/tmp/samizdat-test/app.db'

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

export async function waitForHealth(maxWaitMs = 8000) {
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

// Kill a stale server holding TEST_PORT, wipe the test DB dir for a clean run.
export function resetTestEnv() {
  try {
    const pid = execSync(`ss -tlnp 2>/dev/null | grep :${TEST_PORT} | grep -oP 'pid=\\K[0-9]+'`).toString().trim()
    if (pid) { execSync(`kill ${pid}`); execSync('sleep 0.6') }
  } catch { /* nothing running */ }
  execSync('rm -rf /tmp/samizdat-test && mkdir -p /tmp/samizdat-test')
}

export async function startServer() {
  console.log('  starting test server on port', TEST_PORT, '...')
  const serverProc = spawn(SERVER_BIN, ['--config', TEST_CONFIG], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group — cleanup kills the whole tree
  })
  serverProc.stdout.on('data', d => process.stdout.write(`  [server] ${d}`))
  serverProc.stderr.on('data', d => process.stdout.write(`  [server] ${d}`))
  serverProc.on('exit', code => {
    if (code !== null && code !== 0) console.error(`  [server] exited with code ${code}`)
  })
  const up = await waitForHealth()
  if (!up) throw new Error('server did not become healthy within 8s')
  console.log('  server ready')
  return serverProc
}

export async function pairDevice(name = 'e2e-device') {
  const mintRes = await fetch(`${BASE_URL}/api/v1/admin/pair/new`, { method: 'POST' })
  if (!mintRes.ok) throw new Error(`admin/pair/new failed: ${mintRes.status}`)
  const { code } = await mintRes.json()
  const pairRes = await fetch(`${BASE_URL}/api/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name }),
  })
  if (!pairRes.ok) throw new Error(`pair failed: ${pairRes.status}`)
  const { device_token: token, device_id: deviceId } = await pairRes.json()
  console.log(`  paired device ${deviceId}`)
  return { token, deviceId }
}

export async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
}

// A page pre-seeded with the connection so the app boots already paired. Attaches
// error capture; the returned `errors` array collects JS/HTTP failures for the page.
export async function newConnectedPage(browser, token, deviceId) {
  const page = await browser.newPage()
  const conn = JSON.stringify({ token, deviceId, serverUrls: [BASE_URL] })
  await page.evaluateOnNewDocument((data, lastUrl) => {
    localStorage.setItem('samizdat_connection', data)
    localStorage.setItem('samizdat_last_url', lastUrl)
  }, conn, BASE_URL)

  const errors = []
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text()
      if (text.includes('favicon.ico')) return
      errors.push(text)
    }
  })
  page.on('pageerror', err => errors.push(`pageerror: ${err.message}`))
  page.on('requestfailed', req => {
    const url = req.url()
    const errText = req.failure()?.errorText || ''
    // net::ERR_ABORTED is a client-side CANCELLATION (page nav/close/unmount races,
    // e.g. the debug-logs beacon or a delete request still in flight at teardown),
    // never a server or contract failure — don't gate the frontend on it.
    if (errText.includes('ERR_ABORTED')) return
    if (url.startsWith(BASE_URL + '/api/')) {
      errors.push(`request failed: ${req.method()} ${url} — ${errText}`)
    }
  })
  page.on('response', res => {
    const url = res.url()
    if (url.startsWith(BASE_URL + '/api/') && res.status() >= 400) {
      errors.push(`HTTP ${res.status()}: ${res.request().method()} ${url}`)
    }
  })
  return { page, errors }
}

// Insert a text (article) Document straight into the test DB. There's no ingest in
// the harness (scraping needs network), so we write the row the engine would.
export function seedTextDoc({ id, title, markdown, canonicalUrl }) {
  const now = new Date().toISOString()
  const q = s => s.replace(/'/g, "''")
  const sql = `
INSERT OR REPLACE INTO documents (id,canonical_url,title,markdown,fetched_at,excerpt,hero_image_url,author,published_at,source_feed_id,content_hash,media_type,media_metadata,transcript,created_at,updated_at,rev,deleted_at)
VALUES ('${q(id)}','${q(canonicalUrl)}','${q(title)}','${q(markdown)}','${now}','','','Test',NULL,NULL,'${q(id)}hash','article',NULL,NULL,'${now}','${now}',1,NULL);
`
  const sqlFile = '/tmp/samizdat-test/seed-text.sql'
  fs.writeFileSync(sqlFile, sql)
  execSync(`sqlite3 ${TEST_DB} < ${sqlFile}`)
  console.log('  seeded text document', id)
}

// Seed a false-parse Document (a bot-protection / login-wall scrape that the
// engine flagged) so the Documents-list error badge is exercised by the smoke
// test. error_reason is the visible flag; no highlights are created.
export function seedFalseParseDoc({ id, reason, canonicalUrl }) {
  const now = new Date().toISOString()
  const q = s => s.replace(/'/g, "''")
  const sql = `
INSERT OR REPLACE INTO documents (id,canonical_url,title,markdown,fetched_at,excerpt,hero_image_url,author,published_at,source_feed_id,content_hash,media_type,media_metadata,transcript,error_reason,created_at,updated_at,rev,deleted_at)
VALUES ('${q(id)}','${q(canonicalUrl)}','Checking your browser','Checking your browser before accessing.','${now}','','','',NULL,NULL,'${q(id)}hash','article','','','${q(reason)}','${now}','${now}',1,NULL);
`
  const sqlFile = '/tmp/samizdat-test/seed-falseparse.sql'
  fs.writeFileSync(sqlFile, sql)
  execSync(`sqlite3 ${TEST_DB} < ${sqlFile}`)
  console.log('  seeded false-parse document', id, `(${reason})`)
}

// Seed the video Document used by the smoke test's player + export checks.
export function seedVideoDoc(deviceId, videoDocId) {
  const aid = 'eeeeeeee-0000-4000-8000-0000000000a1'
  const vid = 'eeeeeeee-0000-4000-8000-0000000000c1'
  const rsid = 'eeeeeeee-0000-4000-8000-0000000000b1'
  const mediaDir = '/tmp/samizdat-test/cache/media'
  fs.mkdirSync(mediaDir, { recursive: true })
  // Placeholder files: make GET /documents/:id/{audio,video} return 200 (no 4xx);
  // the headless run never plays them.
  fs.writeFileSync(join(mediaDir, `${aid}.m4a`), Buffer.alloc(2048))
  fs.writeFileSync(join(mediaDir, `${vid}.mp4`), Buffer.alloc(4096))
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
VALUES ('${videoDocId}','${cu}','Smoke Video','${markdown}','${now}','','','Smoke',NULL,NULL,'smokehash','video','${meta}','${transcript}','${now}','${now}',1,NULL);
INSERT OR REPLACE INTO media_assets (id,document_id,original_url,local_path,kind,width,height,created_at,updated_at,rev,deleted_at)
VALUES ('${aid}','${videoDocId}','${cu}#audio','media/${aid}.m4a','audio',NULL,NULL,'${now}','${now}',0,NULL);
INSERT OR REPLACE INTO media_assets (id,document_id,original_url,local_path,kind,width,height,created_at,updated_at,rev,deleted_at)
VALUES ('${vid}','${videoDocId}','${cu}#video','media/${vid}.mp4','video',NULL,NULL,'${now}','${now}',0,NULL);
INSERT OR REPLACE INTO read_states (id,device_id,document_id,scroll_y,created_at,updated_at,rev,deleted_at)
VALUES ('${rsid}','${deviceId}','${videoDocId}',0,'${now}','${now}',0,NULL);
`
  const sqlFile = '/tmp/samizdat-test/seed-video.sql'
  fs.writeFileSync(sqlFile, sql)
  execSync(`sqlite3 ${TEST_DB} < ${sqlFile}`)
  console.log('  seeded video document', videoDocId)
}

// Kill server process group + close browser. Safe to call more than once.
export function makeCleanup(getState) {
  let done = false
  return async function cleanup() {
    if (done) return
    done = true
    const { browser, serverProc } = getState()
    if (browser) { try { await browser.close() } catch {} }
    if (serverProc) {
      try { process.kill(-serverProc.pid, 'SIGTERM') } catch {}
      await sleep(600)
      try { process.kill(-serverProc.pid, 'SIGKILL') } catch {}
    }
  }
}
