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

// Median, not mean: the first build on a node pays for the gradle distribution, the
// dependency cache and the NDK, so it runs ~10× a warm build. A mean lets that one
// outlier poison the estimate for days.
const stats = (recipe) => {
  const rows = read().filter((r) => r.ok && (!recipe || r.recipe === recipe))
  if (!rows.length) return null
  const secs = rows.map((r) => r.sec).sort((a, b) => a - b)
  const mid = Math.floor(secs.length / 2)
  return {
    last: rows[rows.length - 1],
    typical: secs.length % 2 ? secs[mid] : Math.round((secs[mid - 1] + secs[mid]) / 2),
    n: rows.length,
  }
}

// `estimate <recipe>` — the one-liner printed before a build starts.
const estimate = ([recipe]) => {
  const s = stats(recipe)
  if (!s) { console.log('⏱ no timing history yet — this run establishes the baseline'); return }
  const typical = s.n >= 3 ? `, typical ${dur(s.typical)}` : ''
  console.log(`⏱ last ${dur(s.last.sec)} on ${s.last.where} (n=${s.n}${typical}) — history: just build-times`)
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
  if (l && r) console.log(`\nremote is ${(l.typical / r.typical).toFixed(1)}× faster (typical ${dur(l.typical)} local vs ${dur(r.typical)} remote)`)
}

const [cmd, ...rest] = process.argv.slice(2)
const cmds = { log, estimate, show }
if (!cmds[cmd]) { console.error('usage: build-times.mjs log <recipe> <sec> [where] [ok] | estimate [recipe] | show'); process.exit(2) }
cmds[cmd](rest)
