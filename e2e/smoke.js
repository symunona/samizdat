#!/usr/bin/env node
// Smoke test: starts test server, pairs a device, navigates all main pages,
// captures JS errors and HTTP failures. Run via: just e2e
//
// Requires: server binary at server/bin/samizdat, web build at app/dist/

import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
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

// Pages to visit: [path, description]
const PAGES = [
  ['/', 'root / connect'],
  ['/documents', 'documents'],
  ['/tags', 'tags'],
  ['/jobs', 'jobs'],
  ['/subscriptions', 'subscriptions'],
]

let serverProc = null
let browser = null
let failed = false

function fail(msg) {
  console.error(`\n  FAIL: ${msg}`)
  failed = true
}

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

  return errors
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
    if (browser) await browser.close().catch(() => {})
    if (serverProc) {
      serverProc.kill('SIGTERM')
      await sleep(500)
    }
  }
}

main()
