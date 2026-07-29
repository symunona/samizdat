// Build-duration log: `log` appends one record, `show` prints history + estimates.
// Consumed by just build-android* (estimate before a build), just build-times, just status.
// Lives in config/build-times.json (gitignored — machine-local timing, not source).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const file = resolve(repo, 'config/build-times.json')
const KEEP = 40

const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return [] } }
const dur = (s) => (s < 90 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`)

// `log <recipe> <seconds> [where] [ok]`
const log = ([recipe, sec, where = 'local', ok = 'true']) => {
  const rows = read()
  rows.push({ at: new Date().toISOString(), recipe, where, sec: Number(sec), ok: ok !== 'false' })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(rows.slice(-KEEP), null, 1)}\n`)
}

const stats = (recipe) => {
  const rows = read().filter((r) => r.ok && (!recipe || r.recipe === recipe))
  if (!rows.length) return null
  const last = rows[rows.length - 1]
  const avg = Math.round(rows.reduce((a, r) => a + r.sec, 0) / rows.length)
  return { last, avg, n: rows.length }
}

// `estimate <recipe>` — the one-liner printed before a build starts.
const estimate = ([recipe]) => {
  const s = stats(recipe)
  if (!s) { console.log('⏱ no timing history yet — this run establishes the baseline'); return }
  console.log(`⏱ last ${dur(s.last.sec)} on ${s.last.where} (n=${s.n}, avg ${dur(s.avg)}) — history: just build-times`)
}

// `show` — full table plus the local-vs-remote speedup, the number that justifies the node.
const show = () => {
  const rows = read()
  if (!rows.length) { console.log('no builds recorded yet'); return }
  console.log('when                  recipe                  where      elapsed')
  for (const r of rows) {
    console.log(
      `${r.at.replace('T', ' ').slice(0, 19)}   ${r.recipe.padEnd(22)}  ${String(r.where).padEnd(9)}  ${dur(r.sec).padStart(7)}${r.ok ? '' : '  (failed)'}`,
    )
  }
  const l = stats('build-android-local')
  const r = stats('build-android-remote')
  if (l && r) console.log(`\nremote is ${(l.avg / r.avg).toFixed(1)}× faster (avg ${dur(l.avg)} local vs ${dur(r.avg)} remote)`)
}

const [cmd, ...rest] = process.argv.slice(2)
const cmds = { log, estimate, show }
if (!cmds[cmd]) { console.error('usage: build-times.mjs log <recipe> <sec> [where] [ok] | estimate [recipe] | show'); process.exit(2) }
cmds[cmd](rest)
