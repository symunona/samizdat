---
created: 2026-06-29
topic: Browser extension — "Save to Sam" (MV3)
excerpt: Minimal MV3 extension. Toolbar button saves current tab to Sam via scrape_url job; checks dedup on page load and flips icon to a checkmark; click on saved page opens the Sam document in a new tab.
status: done 2026-06-29 — server + extension + app settings shipped on branch feat/clipper-save-to-sam. Mint endpoint corrected to Bearer auth (no cookie sessions exist); zip served from disk. Server contract curl-verified; app card/auto-pair verified via agent-browser. Extension runtime not browser-tested (headless --load-extension unreliable) — verified by code review + endpoint tests.
---

# Browser extension — "Save to Sam" (minimal)

Lives in `clipper/` (already scaffolded: CLAUDE.md + README, no code yet).
Scope: **just the save-button + saved-state indicator.** No Defuddle/Turndown/highlight/offline-queue yet — those are later phases per `clipper/README.md`.

## Goal (user words)
1. Toolbar button "Save to Sam".
2. Extension knows if current page already saved (queries local Sam store).
3. If saved → icon shows a checkmark.
4. If saved → clicking the icon opens the Sam document in a new tab (no re-save).

## Decisions (locked 2026-06-29)
- **Pairing:** auto via settings page — owner-authed page mints a device token, `postMessage`s it to the extension. One click, no code copy.
- **Browser v1:** Chrome only, "load unpacked" zip served from settings page. Firefox `.xpi` + Web Store later.
- **Single account / single instance** for now.

## Server: bare save flow needs ZERO changes
Existing, verified:
- **Dedup check:** `GET /api/v1/documents/by-url?url=<url>` → `200` Document JSON (`{id, canonical_url, title, ...}`) or `404`. (`documents.go:106`)
- **Save:** `POST /api/v1/jobs` `{"kind":"scrape_url","url":"<url>"}` → `202 {"job_id":"..."}`. (`jobs.go:21`)
- **Auth:** `Authorization: Bearer <token>`.
- **CORS:** `Access-Control-Allow-Origin: *`, allows `Authorization, Content-Type`, OPTIONS. Cross-origin fetch works. (`middleware.go:34`)

## Server: 3 small additions for auto-detect + auto-pair + distribution
1. **App marker on health** — `GET /api/v1/health` returns `{"app":"samizdat", ...}` so the content script can recognize a Sam origin no matter the domain. (Currently health exists; add the `app` field.)
2. **Mint-extension-token endpoint** — cookie/same-origin-authed (owner web session): `POST /api/v1/devices/extension-token` → `{device_token, device_id}`. Creates a device named e.g. "Chrome extension". Reuses existing device/token insert (`pair.go` logic), just authed by the web cookie instead of a pair code. Used by the settings page during auto-pair.
3. **Serve the extension bundle** — embed zip in the binary, `GET /extension/sam-chrome.zip`. Settings page links it + load-unpacked instructions.

## Open-document web route
Document deep-link = `<serverBase>/document/<id>` (from `app/app/(drawer)/document/[id].tsx`).
TODO confirm exact web path before build (plain `/document/<id>` vs hash route). One agent-browser check.

## Auto-detect + detection bridge (content script on Sam origin)
A content script runs on **all_urls** but only acts where the origin is Sam.
- On load, `GET <origin>/api/v1/health`; if `app==="samizdat"` → this origin is a Sam instance.
  - Save `serverBase=origin` to `chrome.storage.local` (if not already set).
  - Inject detection marker into the page: `document.documentElement.dataset.samExt = "<version>:<paired|unpaired>"`.
- **Page → extension (auto-pair):** when settings page has minted a token, it `window.postMessage`s it; content script (isolated world) receives → stores `deviceToken`.
- **Page reads marker** → shows: **not installed** / **installed, not paired** / **installed + connected**.
This one script ties together: instance detection (#domain), seamless pairing, and installed/connected status.

## Extension shape (MV3, Vite — per clipper/CLAUDE.md stack)
```
clipper/
  manifest.json          # MV3, action, background SW, content script, storage, host_permissions
  src/
    background.js        # service worker: lifecycle + per-tab state machine
    content.js           # runs on all_urls: detect Sam origin, inject marker, receive token postMessage
    options.html/.js     # fallback config: manual server URL entry
    icons/
      sam-16/32/48/128.png         # authed, not-saved
      sam-check-16/32/48/128.png   # authed, saved (checkmark)
      sam-off-16/32/48/128.png     # not configured / not paired (grey)
  vite.config.js
  package.json
```

### State stored (`chrome.storage.local` — secret, never `.sync`)
- `serverBase` — set automatically by content script when you open your Sam; manual entry in options as fallback.
- `deviceToken` (Bearer, secret) — set automatically via settings-page auto-pair (`postMessage`).

### background.js logic
Per-tab state: `unknown | not_saved | saved | saving`.
Plus global auth state: `no_server | unpaired | authed`.

- **On tab activate / URL change (`tabs.onUpdated` status=complete, `tabs.onActivated`):**
  - skip non-http(s) URLs.
  - `GET /documents/by-url?url=<tabUrl>` with Bearer.
    - `200` → state=saved, cache `docId`, set checkmark icon (`action.setIcon` per-tabId), title "Open in Sam".
    - `404` → state=not_saved, default icon, title "Save to Sam".
    - error/no-token → default icon, title "Configure Sam…".
- **On action click (`action.onClicked`):**
  - authed + saved → `chrome.tabs.create({url: serverBase + '/document/' + docId})`.
  - authed + not_saved → saving icon+badge "…", `POST /jobs {kind:scrape_url,url}`. On 202 poll `by-url` a few times (async scrape) until 200 → checkmark. Badge "✓"/"!".
  - **unpaired** (serverBase known, no token) → open `serverBase` (settings page) in a tab → user clicks "Connect extension" → auto-pair.
  - **no_server** → open options page (manual URL entry) + hint "open your Sam to auto-connect".

### Three icon states (per #3)
- `sam-off` grey → `no_server` or `unpaired`.
- `sam` normal → authed, page not saved.
- `sam-check` → authed, page saved.

### Icon swap
`chrome.action.setIcon({tabId, path:{...}})` — per-tab so each tab reflects its own state. Badge text for transient feedback (saving/error).

## Dedup caveat (flag, decide before build)
`by-url` matches **exact `canonical_url`**. Server may canonicalize stored URLs (strip tracking params, trailing slash) differently than the raw tab URL → false "not saved".
- **Minimal v1:** send raw tab URL, accept occasional misses. Ship, observe.
- **Later:** mirror server canonicalization client-side, or add `?url=` normalization server-side in the lookup. Don't over-engineer now.

## Settings page (app) — extension section
Add to app settings screen:
- **Install link** → `GET /extension/sam-chrome.zip` + "load unpacked" steps (Chrome v1).
- **Status** (read `document.documentElement.dataset.samExt`): not installed / installed-not-paired / connected.
- **"Connect extension"** button (shown when installed-not-paired): calls `POST /api/v1/devices/extension-token` (cookie-authed) → `postMessage` token to extension → status flips to connected.

## Permissions (manifest)
- `storage`
- `tabs` (read active tab URL for onUpdated/onActivated).
- `scripting` (inject marker) — or static `content_scripts`.
- `host_permissions: <all_urls>` — required because the Sam domain is unknown ahead of time (any self-hosted origin). Content script must run everywhere to probe `/api/v1/health`. Document this in the install note (justified by auto-detect).

## Distribution (per #4, decided: Chrome load-unpacked v1)
- Build zip, embed in server binary, serve `GET /extension/sam-chrome.zip`.
- Self-hosted Chrome `.crx` is blocked → load-unpacked only for v1.
- Later: Firefox AMO-signed `.xpi` (self-hostable), Chrome Web Store listing.

## Out of scope (later phases)
Defuddle/Turndown content capture, POST /documents markdown, highlights, IndexedDB offline queue, site adapters, Firefox/Web-Store packaging, multi-instance/multi-account.

## Test (E2E, do at end)
- Pair extension against `just dev` server via a minted code.
- Visit fresh URL → icon default → click → job enqueued → after scrape, icon flips to checkmark.
- Revisit same URL in new tab → checkmark immediately.
- Click checkmarked icon → opens `/document/<id>` tab.
- Verify via agent-browser; clean up chrome processes after (per CLAUDE.md).

## Build/verify checklist
- `just build` green.
- Add a clipper build recipe to `justfile` (`just clipper::build`) — keep namespaced pattern.
- agent-browser smoke of the flow above.
```
