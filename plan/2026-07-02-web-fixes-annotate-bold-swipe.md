---
created: 2026-07-02
topic: Three web/document-viewer bug fixes
excerpt: Annotate button appears only on scroll; bold/link jammed against words in scraped MD; highlight swipe (star/delete) missing in the WebView.
status: implemented + verified (browser + Go test); awaiting user sign-off → squash-merge
---

# Web fixes: annotate button · bold spacing · highlight swipe

Three bugs reported by user while reading a document on the web app
(https://sam.tmpx.space/document/a4250ac3-…).

## Bug 1 — Annotate button only appears on scroll
- **Where:** `app/src/webview/document-viewer.ts` — `handleSelection()` (~L742) sets
  `#ann-btn` `display:block`. CSS (`BASE_CSS` L93) positions it
  `position:fixed;bottom:80px;right:24px` — a far-corner button, NOT anchored to the
  selection. User selects text and sees nothing near it.
- **Fix:** anchor the button to the selection. In `handleSelection`, compute
  `range.getBoundingClientRect()` and place the button just below/after the selection
  (viewport coords, `position:fixed` so it survives the iframe/webview scroll model).
  Clamp to viewport. Hide on empty selection (already done).
- **Confirm mechanism first via browser** (desktop web iframe path) before finalizing.

## Bug 2 — Bold/link jammed against neighbouring words (CONFIRMED + fix verified)
- **Symptom (stored .md):** `to**remove yourself…**`, `mixed.[htihle](url)reported`.
  Space is missing in the vault markdown itself → server serializer bug, not renderer.
- **Root cause:** `github.com/markusmobius/go-trafilatura` **strips boundary whitespace**
  when it rebuilds the content tree from real pages (text wrapped in `<span>`s, e.g.
  latent.space/Substack: `…have to </span><strong>…`). Reproduced: trafilatura's own
  `ContentNode` HTML already reads `have to<strong>remove…`. The `html-to-markdown`
  converter and trafilatura are both correct when the source has plain text-node spaces;
  the loss is trafilatura's span/text trimming on complex pages.
- **Fix (verified on the real page):** in `scraper.go`, after `renderNode` and before
  `conv.ConvertString`, re-insert a space between a word char and an adjacent
  inline-formatting tag:
  - `(\w)(<(?:strong|b|em|i|a|mark|u|code)\b)` → `$1 $2`
  - `(</(?:strong|b|em|i|a|mark|u|code)>)(\w)` → `$1 $2`
  Extracted-article code lives in `<pre>/<code>` as **escaped entities**, not real
  `<strong>/<a>` tags, so the tag-targeted regex never edits code. After fix the generic
  `\w\*\*\w` / `)\w` jam scan on the real page is empty.
- **Regression test:** `internal/worker/…_test.go` running the fix on a fixture.

## Bug 3 — Highlight swipe (star/delete) missing in the WebView
- **Where:** highlights render in TWO places (parity rule, app/CLAUDE.md):
  - `app/src/HighlightCard.tsx` (RN feed) — has `ReanimatedSwipeable` (right=delete, left=pin).
  - `app/src/webview/document-viewer.ts` `renderHighlightCard()` (document body, raw DOM)
    — has click buttons (pin/tags/annotate/delete) but **no swipe**.
- User was reading a Document → the WebView cards. Wants swipe there ("run it in WebView").
- **Fix:** add pointer-based horizontal drag on `.hl-card` in the WebView JS:
  Pointer Events (covers touch + desktop mouse-drag). Threshold to distinguish from text
  selection / vertical scroll. Right → `hl_pin` (star), left → `hl_delete` — mirror the
  feed's direction. Visual: translate the card + reveal an action hint; snap back on release.
  Emit the existing `hl_pin`/`hl_delete` messages (already handled in `[id].tsx`).
- **Parity:** action set/icons unchanged, so spec parity holds; gesture is renderer-specific.
  Run `just lint-parity` to confirm no false flag.

## Test plan (E2E self-tests)
1. **Bug 2:** Go test — fixture HTML through scraper pipeline → assert no `\w**\w` / `)\w` jams. ✅ built.
2. **Bug 1:** robot-browser — open a document, select text → annotate button appears next to
   the selection immediately (no scroll). Screenshot.
3. **Bug 3:** robot-browser — drag a WebView highlight card right → star toggles; left → delete.
4. `just webview-build` (rebuild bundle), `just lint`, `just e2e`, `just build`.

## Order
Bug 2 (server, isolated) → rebuild → Bug 1 + Bug 3 (both in document-viewer.ts) → bundle → test → commit.
