---
created: 2026-06-30
topic: Clipper multi-instance + popup dropdown + toast
excerpt: Rework the "Save to Sam" extension from single first-origin-wins to multiple connected Sam instances keyed by hostname, with an action popup dropdown, on-page save toast, Sam-origin extra items, and auto-detect/connect of new instances.
status: planning
---

# Clipper multi-instance + popup

## Goal
Turn the v1 single-instance "Save to Sam" extension into a multi-instance client.

User spec (resolved with user):
1. Click toolbar icon → **popup dropdown** with "Save as document to Samizdat".
2. After save → **toast "URL added to stream"** injected on the current page.
3. On a **Sam instance page** (host page) → popup shows **extra items** (Open dashboard, Manage instances, Disconnect).
4. **Detect new environments**: visiting an unconnected Sam origin → popup offers **Connect**.
5. **Multiple sams**, keyed by **hostname**; connect to many.
6. Multiple connected → **count badge** on icon.
7. Multiple connected → **separate "Save to <domain>"** item per instance.

## Server impact
Pairing is already per-origin (web Settings page mints a device token via
`POST /api/v1/devices/extension-token` and postMessages it to `content.js`).
Each Sam origin pairs independently → multi-instance is a pure client change.

**New: extension version endpoint (for update check).**
`GET /api/v1/extension/version` → `{version}` read live from the served
`sam-chrome.zip` manifest (`archive/zip` in-memory read of `manifest.json`),
so whatever zip is served reports its own version — no build/version coupling.
Returns 404 when `--extension-zip` unset / file missing. health already carries
server `version`; this reports the *extension* version available for download.
Popup compares to `chrome.runtime.getManifest().version`; if server > local →
add **"Download new version"** menu item → `<origin>/extension/sam-chrome.zip`.
Update check runs per active-instance origin (the one you're paired to).

## Storage migration
v1: `{ serverBase: string, deviceToken: string }` (singular).
v2: `{ instances: [{ hostname, origin, token }], activeOrigin? }`.
- `hostname` = `new URL(origin).host` (host = hostname:port → dev `localhost:8765`
  and prod `sam.tmpx.space` stay distinct, satisfies "IDd by hostname").
- One-time migration in `background.js` on startup + on storage read: if legacy
  `serverBase`+`deviceToken` present and `instances` absent → fold into `instances`,
  delete legacy keys.

## Files & changes

### manifest.json
- Add `"default_popup": "popup.html"` to `action`. Removing the bare
  `onClicked` handler (popup replaces it).
- Keep `permissions`/`host_permissions`. No new perms (no contextMenus —
  user chose Sam-instance extra items, not page context menu).

### src/popup.html + src/popup.js (NEW)
The dropdown. On open, query active tab, read instances, render list:
- Per connected instance: row "Save to `<hostname>`" (single instance →
  label "Save as document to Samizdat"). Click → send `save` message to
  background with `{ origin, tabUrl, tabId }`.
- If active tab is a known Sam origin → extra section: **Open dashboard**,
  **Manage instances** (→ options page), **Disconnect this instance**.
- If active tab is an *unconnected* Sam origin (health probe says samizdat) →
  **Connect** row (opens that origin so its Settings page can pair, or triggers
  pair flow).
- Saved-state: if active URL already a Document on an instance → that row shows
  ✓ "Open in `<hostname>`" instead of Save.
- **Update check**: GET `<origin>/api/v1/extension/version`; if newer than
  manifest version → "Download new version (vX.Y.Z)" row → opens the zip URL.
- Plain DOM, no framework (matches content-script convention).

### src/background.js (REWRITE state layer)
- Replace singular `getConfig()` with `getInstances()` returning the array +
  migration.
- `checkTab` now probes the active URL against **each** connected instance;
  caches per-tab a map `origin → {state, docId}`.
- Icon/badge logic:
  - 0 instances → off icon, no badge.
  - ≥1 instance + URL saved on any → check icon.
  - Multiple instances connected → **badge = instance count** (text colour
    neutral) per spec "show number on the icon". Saved/saving states still use
    ✓/… transient badges (precedence: transient > count).
- `save(origin, tabId, url)` → POST `/jobs scrape_url` to that instance's
  origin/token, poll by-url, then message the tab's content script to show the
  **toast**.
- Message router (`chrome.runtime.onMessage`) for popup→bg: `getPopupState`,
  `save`, `disconnect`, `connect`.

### src/content.js (EXTEND)
- Keep health probe + auto-pair postMessage handshake, but **append** the paired
  origin into `instances` (not overwrite `serverBase`). Dedup by origin.
- Add a `showToast(text)` message handler: inject a minimal shadow-DOM toast
  ("URL added to stream"), auto-dismiss ~2.5s. No page CSS bleed.
- `data-sam-ext` marker unchanged (per-origin paired/unpaired).

### src/options.js + options.html (EXTEND → "Manage instances")
- Render the list of connected instances (hostname, connected/rejected status,
  Disconnect button each).
- Keep manual "add by URL" as fallback (adds to `instances`).

### build.js
- Add `popup.html`, `popup.js` to the copy list.

## E2E / verification
MV3 load is unreliable headless (per clipper/CLAUDE.md) — so:
- Unit-ish: load `background.js`/`popup.js` logic by hand-review + a node harness
  for the migration + instance-dedup pure functions if extractable.
- Server contract via curl: pair two origins (dev + a second port via
  multi-instance install), confirm both mint tokens, both `by-url`/`jobs` work.
- In-browser (agent-browser): open dev Sam Settings, run the pair handshake,
  assert `data-sam-ext` flips to paired; verify toast injection by calling the
  content-script handler.
- `just build-clipper` green; `node build.js` produces popup in dist.

## Open / deferred
- Origin-trust hardening (malicious site faking `/api/v1/health`) still deferred;
  multi-instance makes first-origin-wins moot but a fake origin could still offer
  a Connect row — connecting still requires the real Settings page to mint a
  token, so no token leaks. Note in CLAUDE.md.

## Steps
1. Commit this plan to main, branch `feat/clipper-multi-instance`.
2. Storage model + migration in background.js (pure fns first).
3. popup.html/popup.js dropdown.
4. background.js multi-instance state + badge + message router.
5. content.js toast + multi-pair append.
6. options.js manage-instances list.
7. build.js + manifest.json.
8. Build, curl contract test, agent-browser pair test, screenshots in tmp/.
9. Update clipper/CLAUDE.md (diff_review). Ask user to check. Squash merge.
