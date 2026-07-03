#!/usr/bin/env node
// Bump app/app.json version + android.versionCode. Default level is `patch`;
// pass `minor` or `major` for the bigger bumps.
//
//   node tools/bump-version.mjs            # patch: 0.2.2 -> 0.2.3
//   node tools/bump-version.mjs minor      #        0.2.2 -> 0.3.0
//   node tools/bump-version.mjs major      #        0.2.2 -> 1.0.0
//
// versionCode is MONOTONIC BY WALL-CLOCK: max(oldCode+1, minutesSince2024). It is
// NOT a simple +1, because +1 reads the git-tracked app.json — which regresses when
// a build's bump isn't committed (or across machines/sessions), so a rebuild would
// reuse the SAME code. Android then refuses the install-over AND the in-app updater
// (`served_code > installed_code`) never offers it → "the new build isn't picked up".
// Wall-clock minutes always advance, so every build gets a strictly-greater, unique
// revision number regardless of app.json state. built_at (ms) is also stamped into
// expo.extra so the checker can offer a rebuild even at an equal code (belt & braces).
//
// `just build-android` runs this first, before prebuild stamps the native manifest
// — see justfile and CLAUDE.md.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const level = (process.argv[2] || 'patch').toLowerCase()
if (!['patch', 'minor', 'major'].includes(level)) {
  console.error(`bump-version: unknown level "${level}" (use patch|minor|major)`)
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const path = join(root, 'app', 'app.json')
const json = JSON.parse(readFileSync(path, 'utf8'))
const expo = json.expo

const parts = String(expo.version).split('.').map((n) => Number.parseInt(n, 10))
while (parts.length < 3) parts.push(0)
let [major, minor, patch] = parts
if (level === 'major') { major += 1; minor = 0; patch = 0 }
else if (level === 'minor') { minor += 1; patch = 0 }
else { patch += 1 }

// Minutes since 2024-01-01 UTC: a monotonic floor. ~0.8M today, +1/min, tops out
// far below Android's 2.1e9 versionCode ceiling (good for ~2800 years).
const EPOCH_2024 = Date.UTC(2024, 0, 1)
const now = Date.now()
const wallClockCode = Math.floor((now - EPOCH_2024) / 60000)

const oldVersion = expo.version
const oldCode = expo.android.versionCode
expo.version = `${major}.${minor}.${patch}`
expo.android.versionCode = Math.max(oldCode + 1, wallClockCode)
expo.extra = { ...(expo.extra ?? {}), buildEpoch: now }

writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
console.log(`version ${oldVersion} -> ${expo.version}  (${level}), versionCode ${oldCode} -> ${expo.android.versionCode}`)
