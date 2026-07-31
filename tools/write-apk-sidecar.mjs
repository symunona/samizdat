// Write dist/samizdat.apk.json — the version manifest the server hands to the in-app
// updater. Shared by the local and remote Android build paths so they cannot drift.
//
// built_at MUST derive from expo.extra.buildEpoch, never `new Date()`: at equal
// versionCode `isUpdateAvailable` (app/src/appVersion.ts) compares
// built_at > APP_BUILD_EPOCH, and buildEpoch is stamped at build *start* while this
// file is written minutes later at build *end* — a fresh timestamp is always later,
// so the app would perpetually report an update against its own build.
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const apk = process.argv[2] ?? resolve(repo, 'dist/samizdat.apk')
const out = process.argv[3] ?? `${apk}.json`

const { expo } = JSON.parse(readFileSync(resolve(repo, 'app/app.json'), 'utf8'))
const epoch = expo.extra?.buildEpoch
if (!epoch) throw new Error('app.json has no expo.extra.buildEpoch — run tools/bump-version.mjs')

writeFileSync(out, `${JSON.stringify({
  version: expo.version,
  version_code: expo.android.versionCode,
  size: statSync(apk).size,
  built_at: new Date(epoch).toISOString(),
})}\n`)
console.log(`sidecar → ${out} (${expo.version} / code ${expo.android.versionCode})`)
