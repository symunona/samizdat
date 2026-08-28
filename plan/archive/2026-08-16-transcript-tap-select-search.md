---
created: 2026-08-16
topic: Video document viewer — selection, tap semantics, jump-back, transcript search
excerpt: Selection no longer yanks the transcript or fights playback; tapping a line stops seeking (play-from moves into the long-tap row); a jump leaves a way back; the transcript gets a find bar.
status: shipped — squash-merged to main 2026-08-28 (522e015)
---

# Transcript: selection, tap semantics, jump-back, search

Five reports on `VideoDocument` + the shared viewer bundle. All app-side; no server change.

## 1. Selecting jumps the transcript back (to the active line)

**Cause.** `setActiveSeg()` (fired by every `mediaTime` push) auto-scrolls the active
`.seg` to center unless a *user scroll* happened in the last 2.5s — and "user scroll"
is only `wheel` / `touchmove` (`_lastUserScroll`). A mouse-drag or a native long-press
selection emits neither, so while the reader selects text further down, the next
playback tick scrolls the view back to the playing line. If playback is early in the
document that reads as "jumps back to top".

**Fix (viewer).** A live selection is user activity:
- `handleSelection()` bumps `_lastUserScroll` whenever the selection is non-collapsed.
- `setActiveSeg()` never auto-scrolls while `_pendingSel` is set (the row is up).

## 2. Starting a selection stops playback

The viewer posts `selection_start` the first time a selection becomes live (transcript
docs only — gated on the range sitting in a `.seg`). The host pauses if playing. No
auto-resume: the ▶ in the footer (or the new play-from button) is the way back.

## 3. Tap must not seek; long-tap → row → "play from here"

- Seg click handler drops `sendMsg({type:'seek'})`. A line carrying a time-anchored
  annotation still reopens that note (that is not a seek).
- The selection action row (`#sel-actions`) gains a leading **▶** button
  (`#sel-play-btn`), rendered only when the pending selection carries `media_ts_ms`
  (i.e. it is inside a transcript segment). Click → `play_from {ms}` → the host
  `userSeek(ms)` + `play()`. Order: ▶ · Annotate · ···

## 4. A jump leaves a way back

`jumpFromMs` already exists (the amber scrub flag) but nothing acts on it. Add a
floating pill above the footer while it is set: **↩ Back to m:ss**. Tap → `userSeek()`
back, which itself re-drops the flag at the position we left — so the pill toggles
between the two spots, which is what "continue from where we were" needs after a
mis-jump.

## 5. Transcript search

A find bar in the transcript tab (RN, so web + native): input · `n/m` · ↑ ↓ · ✕.
- Host posts `findTranscript {q, step}` — an empty `q` is the clear (✕ / emptied box),
  so there is one message, not two that can disagree.
- The viewer matches on `.seg` textContent (case-insensitive), marks hits with
  `.find-hit` and the current one with `.find-current`, reveals it (`revealElement`,
  so page mode works too) and suppresses auto-follow while searching. It replies
  `findResult {count, index}`.
- **No DOM is rewritten.** Wrapping matches in new elements would move nothing (text
  nodes split, offsets survive) but the segment IS the unit here and a sentence-level
  hit is what the reader wants — so a class toggle is both cheaper and anchor-safe.

## Touched files
- `app/src/webview/document-viewer.ts` — selection/auto-follow interlock, seg click,
  play-from button, find engine.
- `app/src/markdownToHtml.ts` — the ▶ button in the `#sel-actions` markup.
- `app/src/VideoDocument.tsx` — `selection_start` / `play_from` handling, back-pill,
  find bar UI + messaging.
- `app/CLAUDE.md` — transcript interaction contract.
- `e2e/integration.js` — new `runTranscriptPlayback` interaction check.

## E2E (write first, run at the end)
`just e2e-int` → `runTranscriptPlayback`, driving the real UI and asserting on the
messages the iframe actually posts (a `window.addEventListener('message')` collector
in the page, so a silent UI no-op cannot pass):
1. Click a `.seg` → **no** `seek` message, and the time label does not move.
2. Select text inside a `.seg` → a `selection_start` message arrives; the row shows ▶.
3. Click ▶ → `play_from` with that segment's `data-start-ms`.
4. Press `+10s` → the **Back to 0:00** pill appears; click it → the pill retargets.
5. Type a word only the second seeded line contains → 1 hit, `.find-current` is that
   seg; a word in all three lines → 3 hits and ↓ advances the current index.

Plus `just e2e` (smoke) + `just lint` + `just build`.
