---
created: 2026-07-03
topic: Fix broken select→annotate→highlight in document viewer webview + real integration tests
excerpt: Multi-node selections never render a <mark>; e2e only checked "no errors" and created annotations via API, never drove the actual interaction. Fix the webview highlighter, add proper per-page integration tests, add a CLAUDE.md rule.
status: done
---

# Webview annotation: multi-node highlight fix + integration tests

## Reproduced root cause (live, agent-browser, web/iframe path)

Doc `4832dc7d` (Go). Two selections saved to server:
- single text node ("New built-in", pos 1864–1876) → `<mark>` renders. ✓
- selection crossing a `<a>` link ("Today the Go team … download page", pos 2723–2821) → **saved server-side, 0 marks in DOM.** ✗

`highlightTextNode` (document-viewer.ts) only wraps a range contained in ONE text node:
`if (start + exact.length > len) { offset += len; continue }` — any selection spanning
inline elements (`<a>`,`<b>`,`<em>`,`<code>`) silently produces no mark. No error, HTTP 200.
Real prose is full of inline elements → "totally broken".

Secondary:
- Anchoring ignores captured `prefix`/`suffix` (TextQuoteSelector) — only `pos_start`+`indexOf`.
- `exact` captured with `.trim()` but `pos_start` not adjusted for trimmed leading ws.
- Article viewer (unlike VideoDocument) has no effect to re-send annotations after async load → blank on slow client.

## Why testing kept missing it
- `just e2e` (smoke.js): navigates pages, checks JS/HTTP errors, creates annotation **via API**.
  Never opens a doc, never selects text, never asserts a `<mark>`. Silent failure passes an error-check.
- No integration test drives the real webview interaction.

## Plan
1. [ ] Fix `highlightTextNode` → wrap every text-node slice a range covers (multi-node). Same annId → multiple `<mark>` (removeMark already handles N).
2. [ ] `applyMark` locate: pos_start → prefix+exact+suffix probe → indexOf(exact).
3. [ ] `handleSelection` capture: align pos_start with trimmed exact.
4. [ ] `document/[id].tsx`: add `useEffect` re-sending `setAnnotations` after async load (parity w/ VideoDocument).
5. [ ] `just webview-build`; re-verify multi-node highlight renders + persists (agent-browser).
6. [ ] Extract `e2e/harness.js` (server/pair/browser/seed) shared by smoke + integration.
7. [ ] `e2e/integration.js`: proper integration test.
   - seed a TEXT document with inline elements.
   - per page (documents/tags/jobs/subscriptions/pipelines/starred/archived/document): real interaction assertion, not just no-errors.
   - selection lifecycle (the hard case): select across `<a>` → annotate → Save → assert `mark[data-ann-id]` text → reload persists → tap edits → delete removes.
   - `just e2e-int` recipe; run in CI-ish before done.
8. [ ] CLAUDE.md rule (as user worded): test interaction (agent-browser) not JUST api; start with API then always test interaction; compose hard case. Write tests to each page.
9. [ ] lint + `just build` + `just e2e` + `just e2e-int` green.
10. [ ] squash-merge to main, `just build`, `just build-android` (APK).

## Note
Native react-native-webview is a separate untested runtime; agent-browser/puppeteer only
cover web/iframe. The bug was present on web too (RN Web shares document-viewer.ts), so the
web integration test genuinely guards the shared highlighter.
