#!/usr/bin/env node
// Bump app/app.json version + android.versionCode. Default level is `patch`;
// pass `minor` or `major` for the bigger bumps. versionCode always +1 (Android
// requires a strictly increasing integer for the in-app updater to offer it).
//
//   node tools/bump-version.mjs            # patch: 0.2.2 -> 0.2.3
//   node tools/bump-version.mjs minor      #        0.2.2 -> 0.3.0
//   node tools/bump-version.mjs major      #        0.2.2 -> 1.0.0
//
// `just build-android` runs this first, before prebuild stamps the native
// manifest — see justfile and CLAUDE.md.
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

const oldVersion = expo.version
const oldCode = expo.android.versionCode
expo.version = `${major}.${minor}.${patch}`
expo.android.versionCode = oldCode + 1

writeFileSync(path, JSON.stringify(json, null, 2) + '\n')
console.log(`version ${oldVersion} -> ${expo.version}  (${level}), versionCode ${oldCode} -> ${expo.android.versionCode}`)
