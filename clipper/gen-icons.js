#!/usr/bin/env node
// Generates the extension's toolbar icons as PNGs — no external deps.
// Three states × four sizes. Vector shapes are sampled with 4× supersampling
// for crisp edges, then encoded to PNG with Node's built-in zlib.
//
//   sam        — brand card, document lines  (authed, page not saved)
//   sam-check  — same card + green check badge (authed, page saved)
//   sam-off    — greyscale card              (not configured / not paired)

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'src', 'icons')
const SIZES = [16, 32, 48, 128]
const SS = 4 // supersampling factor

const BRAND = [0xd6, 0x45, 0x41] // samizdat red
const GREY = [0x9a, 0xa0, 0xa6]
const WHITE = [0xff, 0xff, 0xff]
const GREEN = [0x2e, 0xcc, 0x71]

// ── geometry helpers (normalized 0..1 space) ────────────────────────────────
function insideRoundRect(u, v, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(u, x0 + r), x1 - r)
  const cy = Math.min(Math.max(v, y0 + r), y1 - r)
  if (u >= x0 + r && u <= x1 - r) return v >= y0 && v <= y1
  if (v >= y0 + r && v <= y1 - r) return u >= x0 && u <= x1
  const dx = u - cx
  const dy = v - cy
  return dx * dx + dy * dy <= r * r
}
function distSeg(u, v, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1e-9
  let t = ((u - ax) * dx + (v - ay) * dy) / len2
  t = Math.min(1, Math.max(0, t))
  const px = ax + t * dx
  const py = ay + t * dy
  return Math.hypot(u - px, v - py)
}

// Returns [r,g,b,a] for a normalized point, given the state.
function sample(u, v, state) {
  const card = state === 'off' ? GREY : BRAND
  if (!insideRoundRect(u, v, 0.07, 0.07, 0.93, 0.93, 0.2)) return [0, 0, 0, 0]
  let col = card

  // document "text" lines (upper-left area)
  const bars = [
    [0.22, 0.78, 0.30],
    [0.22, 0.78, 0.46],
    [0.22, 0.58, 0.62],
  ]
  for (const [x0, x1, y] of bars) {
    if (u >= x0 && u <= x1 && Math.abs(v - y) <= 0.045) col = WHITE
  }

  if (state === 'check') {
    // green badge, bottom-right
    const bc = Math.hypot(u - 0.72, v - 0.72)
    if (bc <= 0.28) col = card // ring gap (card colour) so badge reads separate
    if (bc <= 0.25) col = GREEN
    // white checkmark
    const d = Math.min(
      distSeg(u, v, 0.60, 0.73, 0.68, 0.81),
      distSeg(u, v, 0.68, 0.81, 0.85, 0.63),
    )
    if (bc <= 0.25 && d <= 0.035) col = WHITE
  }
  return [col[0], col[1], col[2], 255]
}

function render(size, state) {
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size
          const v = (y + (sy + 0.5) / SS) / size
          const [pr, pg, pb, pa] = sample(u, v, state)
          const af = pa / 255
          r += pr * af
          g += pg * af
          b += pb * af
          a += pa
        }
      }
      const n = SS * SS
      const av = a / n
      const i = (y * size + x) * 4
      // un-premultiply averaged colour
      const cov = av > 0 ? (a / 255) / n : 0
      buf[i] = cov > 0 ? Math.round(r / (n * cov)) : 0
      buf[i + 1] = cov > 0 ? Math.round(g / (n * cov)) : 0
      buf[i + 2] = cov > 0 ? Math.round(b / (n * cov)) : 0
      buf[i + 3] = Math.round(av)
    }
  }
  return buf
}

// ── PNG encoding ────────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  // filter type 0 per scanline
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT, { recursive: true })
const states = { sam: 'normal', 'sam-check': 'check', 'sam-off': 'off' }
for (const [name, state] of Object.entries(states)) {
  for (const size of SIZES) {
    const png = encodePNG(size, render(size, state))
    writeFileSync(join(OUT, `${name}-${size}.png`), png)
  }
}
console.log(`icons written to ${OUT}`)
