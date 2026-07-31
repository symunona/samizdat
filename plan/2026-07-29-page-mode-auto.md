---
created: 2026-07-29
topic: Document viewer — three-way reading mode (flow / auto / page) + page threshold
excerpt: The page-mode boolean becomes a three-way reading preference. `auto` paginates only documents longer than a user-settable page threshold (default 20); the viewer resolves it from the continuous-flow page estimate and reports the resolution back for the meta-panel info line.
status: done
---

# Reading mode: flow / auto / page

Extends the page mode shipped in `plan/2026-07-29-doc-viewer-images-and-page-mode.md`.

## Requirement (verbatim)

> For long articles that span for over 20 pages, let's default to page mode! Have this
> as a toggle under settings. Default to true. show single line info on side menu about
> the setting. 3 way toggle there: flow/auto/page -> limit is settable under settings.

## The preference

`ReadingMode = 'flow' | 'auto' | 'page'`, default **`auto`**; `pageThreshold` (int),
default **20**.

- `flow` — always continuous scroll (yesterday's page-mode-off).
- `page` — always paginated (yesterday's page-mode-on).
- `auto` — paginate only when the document would run to MORE than `pageThreshold` pages.

**One source of truth**, `src/store/readingModeStore.ts` (zustand, hydrated from
AsyncStorage, same shape as `debugLogStore`). Both the meta panel's 3-way control and the
Settings card read/write that store — the Settings "Auto page mode" switch is not a
separate flag, it is `mode === 'auto'` (on → `auto`, off → `flow`), and when the mode is
`page` the switch reads off with a subtitle that says so. Two prefs that could disagree
would be the bug; there is only one.

**Migration.** The old key `samizdat_page_mode` ('1'/'0') is read once when the new key
`samizdat_reading_mode` is absent: `'1' → page`, `'0' → flow`, nothing → `auto`. The old
key is then deleted. A user who deliberately turned page mode OFF lands on `flow`, not on
the new `auto` default.

## How `auto` gets a page count (the interesting decision)

The count only exists once the document is paginated, and paginating to find out — then
undoing it — is exactly the flicker we must not ship. So `auto` resolves from an
**estimate taken with pagination OFF**: `ceil(body.scrollHeight / innerHeight)`. In page
mode a "page" is one column of the body laid out at the same width and cut to the viewport
height, so continuous height ÷ viewport height IS the page count, to within the slack that
break-avoidance and the page-mode caps (`img`/`pre`/`.hl-card`) introduce (±1–2 on a long
doc). A threshold in whole pages does not need better than that.

The important part is that **one metric decides in both directions**. Deciding "should I
paginate?" with the flow estimate but "should I stop?" with the real `_pageCount` is what
would oscillate: the two disagree by a page or two around the boundary, so a document
sitting on the threshold would flip on every resize. So `estimatePages()` always measures
the same way — if the viewer is currently paginated it removes `html.pg`, reads
`scrollHeight`, and puts it back within the same task (no paint in between, body
`scrollLeft` saved/restored). That costs one extra reflow, only on the resize path, which
already repaginates.

Re-evaluated: on `init` (after the highlight cards are in the DOM), on `window.load`
(images change the height), on each throttled `resize`, and whenever the host pushes a new
mode/threshold.

## Protocol (one concept, not two)

- `setPageMode {on}` → **`setReadingMode {mode, threshold}`**; `init.pageMode` →
  `init.readingMode` + `init.pageThreshold`. The host owns the preference, the viewer owns
  the resolution — nobody else can measure.
- New outbound `readingMode {mode, paginated, pages}`: the resolution the viewer arrived
  at. It feeds the meta panel's single info line, which is otherwise guesswork on the host
  side.

## UI

- **Meta panel (⋮)** — the `Switch` becomes a 3-segment control `Flow · Auto · Page`
  (pill styling borrowed from `VideoDocument`'s language pills), plus one info line:
  `Auto: ~34 pages → paginated (limit 20)` / `… → continuous (limit 20)` for `auto`,
  `Paginated — 34 pages` / `Continuous scrolling` for the explicit modes.
- **Settings → Reading Mode** — the auto switch (default ON) + a numeric threshold field
  ("Paginate documents longer than [20] pages"). Input is digits-only while typing and
  clamped to 1–999 on commit; empty/junk reverts to the stored value, so the reader can
  never be wedged.

## Constraints kept

Strictly additive page mode (every rule still scoped to `html.pg`, no DOM node added or
moved → annotation anchors identical). No per-document override: the preference stays
global.

## Tests

`e2e/integration.js`: the 7 existing page-mode checks are rewritten against the segmented
control (they drove the old `Switch`), plus new ones — short doc stays flow under `auto`,
long doc paginates under `auto`, `flow`/`page` override regardless of length, a threshold
change in Settings flips the resolution for the same document, and the preference survives
a reload. New seeded `SHORT_DOC` / `LONG_DOC` (the existing `TEXT_DOC` sits between them).

## Status log

- 2026-07-29 — plan written.
- 2026-07-29 — implemented: `readingModeStore` + storage migration, viewer
  `setReadingMode`/`readingMode` protocol + `estimatePages`, meta-panel segmented control
  + info line, Settings "Reading Mode" card.
- 2026-07-29 — **DONE**. `just lint` clean (spec parity OK — `document-viewer.ts` changed
  but no card change, checker satisfied), `just build`, `just webview-build`, `just e2e`
  green, `just e2e-int` **56/56** (was 43/43; 7 page-mode checks updated, 13 added).
  Driven live in agent-browser against the real prod DB: an 88k-char arXiv paper opens
  paginated by itself (`~95 pages here, limit 20 → paginated`, indicator `12 / 95`, and it
  restored the reading position); `Flow` un-paginates it, `Page` re-paginates it; raising
  the Settings threshold to 200 makes the SAME document open continuous and lowering it
  back to 20 paginates it again; a 2.4k-char newsletter reads `~3 pages here, limit 20 →
  continuous`. Screenshots `tmp/screenshots/pagemode-auto-*.png`.
  Found + fixed live: RN-Web re-runs `selectTextOnFocus` on every re-render of a
  controlled field, so each keystroke in the threshold box replaced the previous one.
  Not verifiable headless (unchanged from the previous plan): a real finger swipe on
  Android rides the WebView's native horizontal overflow scroll.
