#!/usr/bin/env node
// Web-driver concurrency test: the wa-sqlite backend under overlapping calls.
//
// Nothing in the app awaits the DB before touching it again — the connection probe
// writes a setting on a 30s interval while the outbox pusher reads the queue on its
// own — so reads and write transactions overlap as a matter of course. wa-sqlite is
// ONE connection on ONE thread with ONE Asyncify unwind buffer: two `step()` chains
// in flight together do not interleave statements, they corrupt each other's saved
// stack and take the whole replica down with `memory access out of bounds` /
// `Aborted(RuntimeError: unreachable)`.
//
// This drives that exact shape (a burst of tx-writes and SELECTs fired with no awaits
// between them) against the real wasm in a real browser, and asserts the module
// survives and the data is right. It needs no samizdat server: a throwaway static
// server hands out the esbuild'd driver plus the .wasm from app/public/.
//
// Run via: just e2e-db

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { CHROMIUM } from './harness.js'
import puppeteer from 'puppeteer-core'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dir, '..')
const APP = join(ROOT, 'app')
const ESBUILD = join(APP, 'node_modules', '.bin', 'esbuild')
const WASM = join(APP, 'public/wasm/wa-sqlite-async.wasm')

const TMP = mkdtempSync(join(tmpdir(), 'db-web-race-'))
const BUNDLE = join(TMP, 'driver.js')
execSync(
  `"${ESBUILD}" src/db/driverImpl.web.ts --bundle --format=iife --global-name=SamDriver`
  + ` --platform=browser --log-level=error --outfile="${BUNDLE}"`,
  { cwd: APP },
)

const PAGE = '<!doctype html><meta charset="utf-8"><title>db race</title><script src="/driver.js"></script>'

const server = http.createServer((req, res) => {
  if (req.url === '/driver.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' })
    res.end(fs.readFileSync(BUNDLE))
  } else if (req.url.startsWith('/wasm/')) {
    res.writeHead(200, { 'Content-Type': 'application/wasm' })
    res.end(fs.readFileSync(WASM))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(PAGE)
  }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

let failed = 0
function ok(name, cond, detail = '') {
  if (cond) console.log(`  PASS ${name}`)
  else { console.error(`  FAIL ${name}${detail ? `\n    ${detail}` : ''}`); failed++ }
}

const browser = await puppeteer.launch({
  executablePath: CHROMIUM,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
})

try {
  const page = await browser.newPage()
  // A wasm abort surfaces as a page-level error, not as a rejected call — the module
  // is already dead by then. Collect them, because "the promise resolved" is not proof.
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  // Emscripten prints `Aborted(RuntimeError: unreachable)` to the console and then
  // poisons the module; the in-flight call may never settle at all.
  page.on('console', m => { if (m.text().includes('Aborted(')) pageErrors.push(m.text()) })
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 })

  const ROWS = 40
  // A corrupted wasm heap can leave the page's promise pending forever — the module is
  // gone, nothing will settle it — and puppeteer then reports `Promise was collected`
  // rather than a value. That is a failure, not a harness error.
  const result = await page.evaluate(async (rows) => {
    try {
      const d = await SamDriver.openDriver(`race-${Date.now()}`)
      await d.exec('CREATE TABLE race (k TEXT PRIMARY KEY, v TEXT)')

      // The production shape: a multi-statement transaction (a row + its outbox intent
      // + a dirty key) with unrelated SELECTs issued a task LATER — i.e. while it is
      // still open, which is what two independent intervals do. Issuing everything in
      // one synchronous burst would NOT reproduce it: the old driver's exemption was
      // read at call time, and at that instant no transaction had started yet.
      const tick = () => new Promise(r => setTimeout(r, 0))
      const errors = []
      const jobs = []
      const guard = (p, what) => jobs.push(p.catch(e => errors.push(`${what}: ${e}`)))
      for (let i = 0; i < rows; i++) {
        guard(d.tx(async (tx) => {
          await tx.run('INSERT INTO race (k, v) VALUES (?, ?)', [`k${i}`, `v${i}`])
          await tx.run('UPDATE race SET v = ? WHERE k = ?', [`v${i}!`, `k${i}`])
        }), 'tx')
        await tick()
        guard(d.all('SELECT k, v FROM race ORDER BY k'), 'read')
        guard(d.all('SELECT count(*) AS n FROM race'), 'read')
        await tick()
      }
      await Promise.all(jobs)
      if (errors.length) return { error: errors.slice(0, 3).join(' | ') }

      const all = await d.all('SELECT k, v FROM race ORDER BY k')
      await d.close()
      return { count: all.length, bad: all.filter(r => r.v !== `${r.k.replace('k', 'v')}!`).length }
    } catch (e) {
      return { error: String(e && e.stack || e) }
    }
  }, ROWS).catch(e => ({ error: String(e) }))

  ok('web driver: a burst of overlapping transactions and reads does not crash the wasm',
    !result.error, result.error)
  ok('web driver: no wasm abort reached the page',
    pageErrors.length === 0, pageErrors.join('\n    '))
  ok('web driver: every transaction committed exactly one row',
    result.count === ROWS, `got ${result.count}, want ${ROWS}`)
  ok('web driver: no transaction lost its second statement',
    result.bad === 0, `${result.bad} row(s) hold a pre-update value`)
} finally {
  await browser.close()
  server.close()
  fs.rmSync(TMP, { recursive: true, force: true })
}

if (failed) {
  console.error(`\n=== FAILED ===\n${failed} check(s) failed.`)
  process.exit(1)
}
console.log('\n=== PASSED ===\nweb driver concurrency checks passed.')
