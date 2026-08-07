// Shared e2e harness: server lifecycle, device pairing, browser launch, DB seed.
// Used by both smoke.js (page-load errors) and integration.js (real interactions).

import puppeteer from 'puppeteer-core'
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(__dir, '..')

// Resolve the installed Playwright Chromium dynamically — the version dir
// (chromium-<rev>) changes whenever playwright-go is bumped, so a hardcoded
// path silently breaks every e2e after an upgrade. Pick the newest chromium-*.
function resolveChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const base = join(process.env.HOME || '/home/symunona', '.cache/ms-playwright')
  let best = null
  try {
    for (const d of fs.readdirSync(base)) {
      const m = /^chromium-(\d+)$/.exec(d)
      if (!m) continue
      const exe = join(base, d, 'chrome-linux64/chrome')
      if (fs.existsSync(exe) && (!best || Number(m[1]) > best.rev)) best = { rev: Number(m[1]), exe }
    }
  } catch { /* fall through to error below */ }
  if (!best) throw new Error(`no Playwright Chromium found under ${base} (run: just setup-server)`)
  return best.exe
}
export const CHROMIUM = resolveChromium()
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
    // The LLM Router discovers providers from the environment, so a real key on
    // this box would make the suite probe the live internet AND would un-retire
    // the retired-provider fixture. Strip them: the test server sees config only.
    env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', OPENROUTER_API_KEY: '' },
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

// The port config-test.toml's llm fallback points at. A stub box here gives the
// model catalog (and the picker) real rows with no network and no spend; when it
// is NOT running (the smoke suite), that provider simply probes as unreachable.
export const STUB_LLM_PORT = 8767

export const STUB_LLM_MODELS = ['stub-large', 'stub-small']

// startStubLLM serves the OpenAI-compatible surface the Router probes and lists:
// GET /v1/models and POST /v1/chat/completions.
export function startStubLLM() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url.startsWith('/v1/models')) {
      res.end(JSON.stringify({ data: STUB_LLM_MODELS.map(id => ({ id })) }))
      return
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      res.end(JSON.stringify({
        choices: [{ message: { content: 'stub reply' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  server.listen(STUB_LLM_PORT, '127.0.0.1')
  console.log('  stub LLM box on port', STUB_LLM_PORT)
  return server
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
    // Runs on EVERY document, including the initial about:blank — and an
    // about:blank re-created by an emulation change (page.emulate with
    // isMobile/hasTouch reloads) has an opaque origin where touching
    // localStorage throws SecurityError. Swallow it: the real page load runs
    // this again on the server's origin, where it matters.
    try {
      localStorage.setItem('samizdat_connection', data)
      localStorage.setItem('samizdat_last_url', lastUrl)
    } catch { /* opaque-origin document — nothing to seed */ }
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

// Seed the persisted LLM provider-health snapshot — the shape llm.Record leaves
// behind after a real call. The server re-reads this setting on every
// GET /api/v1/llm/status, so a seed lands without a restart. Use it to stage a
// failure (e.g. Anthropic out of credits) the UI must surface.
export function seedLLMHealth(rows) {
  const q = s => s.replace(/'/g, "''")
  const sql = `INSERT OR REPLACE INTO server_settings (key,value)
VALUES ('llm_provider_health','${q(JSON.stringify(rows))}');`
  const f = '/tmp/samizdat-test/seed-llm-health.sql'
  fs.writeFileSync(f, sql)
  execSync(`sqlite3 ${TEST_DB} < ${f}`)
  console.log('  seeded llm health', rows.map(r => `${r.key}:${r.last_error_kind || 'ok'}`).join(', '))
}

// Seed a Tag row (offline-test fixture — an existing tag the app can apply offline).
export function seedTag({ id, name, color = 'default' }) {
  const now = new Date().toISOString()
  const q = s => s.replace(/'/g, "''")
  const sql = `INSERT OR REPLACE INTO tags (id,name,color,created_at,updated_at,rev,deleted_at)
VALUES ('${q(id)}','${q(name)}','${q(color)}','${now}','${now}',1,NULL);`
  const f = '/tmp/samizdat-test/seed-tag.sql'
  fs.writeFileSync(f, sql)
  execSync(`sqlite3 ${TEST_DB} < ${f}`)
  console.log('  seeded tag', name)
}

// Seed a Highlight (with the pipeline → pipeline_run parents its FK needs) on a
// Document, as the pipeline would. Used by the offline walkthrough to exercise
// star / delete / tag on real machine-data rows.
export function seedHighlight({ id, documentId, title, body, pinned = 0 }) {
  const now = new Date().toISOString()
  const q = s => s.replace(/'/g, "''")
  const pipeId = `pipe-${id}`
  const runId = `run-${id}`
  const sql = `
INSERT OR IGNORE INTO pipelines (id,name,enabled,trigger,filter,steps,created_at,updated_at,rev,deleted_at)
VALUES ('${q(pipeId)}','seed',1,'on_new_document','{}','[]','${now}','${now}',1,NULL);
INSERT OR IGNORE INTO pipeline_runs (id,pipeline_id,document_id,job_id,document_content_hash,status,step_index,state,superseded_at,created_at,updated_at,rev,deleted_at)
VALUES ('${q(runId)}','${q(pipeId)}','${q(documentId)}',NULL,'','done',0,'{}',NULL,'${now}','${now}',1,NULL);
INSERT OR REPLACE INTO highlights (id,document_id,pipeline_run_id,kind,title,body,metadata,pinned,archived_at,created_at,updated_at,rev,deleted_at)
VALUES ('${q(id)}','${q(documentId)}','${q(runId)}','item','${q(title)}','${q(body)}','{}',${pinned ? 1 : 0},NULL,'${now}','${now}',1,NULL);
`
  const f = '/tmp/samizdat-test/seed-highlight.sql'
  fs.writeFileSync(f, sql)
  execSync(`sqlite3 ${TEST_DB} < ${f}`)
  console.log('  seeded highlight', id)
}

// Seed a Pipeline row — the shape the API creates. `filter` and `steps` are
// objects/arrays here and stored as the JSON strings the column holds, so a test
// can stage a scoped filter or a step config (including a secret the UI must
// never render) without going through the create endpoint.
export function seedPipeline({ id, name, filter, steps, trigger = 'on_new_document', enabled = 1 }) {
  const now = new Date().toISOString()
  const q = s => s.replace(/'/g, "''")
  const sql = `
INSERT OR REPLACE INTO pipelines (id,name,enabled,trigger,filter,steps,created_at,updated_at,rev,deleted_at)
VALUES ('${q(id)}','${q(name)}',${enabled},'${q(trigger)}','${q(JSON.stringify(filter))}','${q(JSON.stringify(steps))}','${now}','${now}',1,NULL);
`
  const f = '/tmp/samizdat-test/seed-pipeline.sql'
  fs.writeFileSync(f, sql)
  execSync(`sqlite3 ${TEST_DB} < ${f}`)
  console.log('  seeded pipeline', name)
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

// Seed a permanently-failed (dead) Job — the shape the worker leaves behind when
// a scrape or a pipeline gives up. The Documents screen reads these to show the
// error state; `payload` is the job's JSON payload (url / document_id).
export function seedDeadJob({ id, kind, payload, lastError, attempts = 3 }) {
  const now = new Date().toISOString()
  const q = s => s.replace(/'/g, "''")
  const sql = `
INSERT OR REPLACE INTO jobs (id,kind,payload,status,attempts,run_after,last_error,result,duration_ms,created_at,updated_at,rev,deleted_at,parent_job_id)
VALUES ('${q(id)}','${q(kind)}','${q(JSON.stringify(payload))}','dead',${attempts},'${now}','${q(lastError)}','',120,'${now}','${now}',1,NULL,NULL);
`
  const sqlFile = '/tmp/samizdat-test/seed-dead-job.sql'
  fs.writeFileSync(sqlFile, sql)
  execSync(`sqlite3 ${TEST_DB} < ${sqlFile}`)
  console.log('  seeded dead job', id, `(${kind})`)
}

// Seed a finished Job — the row the worker leaves behind on success. `result` is
// the job's JSON result (a scrape_url records `{document_id}`), `parentJobId` the
// job that enqueued it. Together they carry a Document's provenance: a scrape whose
// parent is a run_pipeline_step was pulled in by a pipeline, one without is a manual
// add by the device in its payload.
export function seedJob({ id, kind, payload, result = {}, parentJobId = null }) {
  const now = new Date().toISOString()
  const q = s => s.replace(/'/g, "''")
  const parent = parentJobId ? `'${q(parentJobId)}'` : 'NULL'
  const sql = `
INSERT OR REPLACE INTO jobs (id,kind,payload,status,attempts,run_after,last_error,result,duration_ms,created_at,updated_at,rev,deleted_at,parent_job_id)
VALUES ('${q(id)}','${q(kind)}','${q(JSON.stringify(payload))}','done',1,'${now}','','${q(JSON.stringify(result))}',120,'${now}','${now}',1,NULL,${parent});
`
  const f = '/tmp/samizdat-test/seed-job.sql'
  fs.writeFileSync(f, sql)
  execSync(`sqlite3 ${TEST_DB} < ${f}`)
  console.log('  seeded job', id, `(${kind})`)
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
    const { browser, serverProc, stubLLM } = getState()
    if (browser) { try { await browser.close() } catch {} }
    if (stubLLM) { try { stubLLM.close() } catch {} }
    if (serverProc) {
      try { process.kill(-serverProc.pid, 'SIGTERM') } catch {}
      await sleep(600)
      try { process.kill(-serverProc.pid, 'SIGKILL') } catch {}
    }
  }
}
