#!/usr/bin/env node
// Rasterize the app logo (assets/samizdat.svg, repo source of truth) into the
// PNG set Expo's adaptive-icon pipeline consumes. Run by `just build-android`
// before `expo prebuild`, so a fresh SVG always flows into the APK launcher
// icon. Idempotent — safe to run any time; overwrites app/assets/*.png.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const SVG = resolve(repo, 'assets', 'samizdat.svg');
const OUT = resolve(repo, 'app', 'assets');

const BG = '#0b0b0c'; // matches app.json android.adaptiveIcon.backgroundColor

// Render the SVG mark to a transparent square PNG buffer of `px`, the mark
// scaled to `frac` of the canvas and centred (rest is transparent padding).
async function mark(px, frac) {
  const inner = Math.round(px * frac);
  const logo = await sharp(SVG, { density: 512 })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const pad = Math.round((px - inner) / 2);
  return sharp({ create: { width: px, height: px, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: logo, top: pad, left: pad }])
    .png()
    .toBuffer();
}

async function write(name, buf) {
  await sharp(buf).toFile(resolve(OUT, name));
  console.log('  wrote', name);
}

console.log('icongen: rasterizing', SVG);

// icon.png — opaque 1024², logo on brand-dark bg (iOS/legacy launchers).
const iconFg = await mark(1024, 0.8);
await write('icon.png', await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } })
  .composite([{ input: iconFg }])
  .png()
  .toBuffer());

// android-icon-foreground.png — transparent 512², mark in the 66% safe zone.
await write('android-icon-foreground.png', await mark(512, 0.66));

// android-icon-background.png — solid brand-dark 512².
await write('android-icon-background.png', await sharp({ create: { width: 512, height: 512, channels: 4, background: BG } })
  .png()
  .toBuffer());

// android-icon-monochrome.png — white silhouette (system tints it), 432²,
// same safe-zone framing; alpha taken from the rendered mark.
const monoMark = await mark(432, 0.66);
const alpha = await sharp(monoMark).extractChannel(3).toBuffer();
await write('android-icon-monochrome.png', await sharp({ create: { width: 432, height: 432, channels: 3, background: { r: 255, g: 255, b: 255 } } })
  .joinChannel(alpha)
  .png()
  .toBuffer());

console.log('icongen: done');
