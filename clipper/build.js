#!/usr/bin/env node
// Assemble the unpacked extension into dist/unpacked and zip it to
// dist/sam-chrome.zip (served by the server at /extension/sam-chrome.zip).
// No bundler: v1 has zero npm dependencies, so build = generate icons + copy + zip.

import { execSync } from 'node:child_process'
import { rmSync, mkdirSync, copyFileSync, cpSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const DIST = join(ROOT, 'dist')
const UNPACKED = join(DIST, 'unpacked')

execSync('node gen-icons.js', { cwd: ROOT, stdio: 'inherit' })

rmSync(DIST, { recursive: true, force: true })
mkdirSync(UNPACKED, { recursive: true })

copyFileSync(join(ROOT, 'manifest.json'), join(UNPACKED, 'manifest.json'))
for (const f of [
  'background.js', 'content.js', 'instances.js',
  'popup.html', 'popup.js', 'options.html', 'options.js',
]) {
  copyFileSync(join(ROOT, 'src', f), join(UNPACKED, f))
}
cpSync(join(ROOT, 'src', 'icons'), join(UNPACKED, 'icons'), { recursive: true })

execSync('zip -qr -X ../sam-chrome.zip .', { cwd: UNPACKED, stdio: 'inherit' })

console.log('built clipper/dist/unpacked + clipper/dist/sam-chrome.zip')
