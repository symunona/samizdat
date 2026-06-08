# CLAUDE.md — clipper/

Chrome extension (MV3). Capture client. POSTs to Samizdat server REST API.

## MV3 hard constraints
- **No remote code execution** — all logic must ship in the extension bundle
- **No eval, no dynamic import from remote URLs**
- Background script = service worker (`background.js`), not a persistent page
- Site adapters are JSON config data shipped in the bundle, not remote JS

## Extraction pipeline (client-side only)
1. Defuddle — main content extraction (fork Obsidian Web Clipper patterns)
2. Turndown — HTML → Markdown conversion
3. Result POSTed to server as markdown; server never receives raw HTML

## Offline queue
IndexedDB queue for failed POSTs. Drain on next successful connection.
Never lose a clip due to network failure.

## API
- `POST /api/v1/documents` — `{url, markdown, title, captured_at}`
- Bearer token stored in `chrome.storage.local` — **never** `chrome.storage.sync` (token is a secret)

## Conventions
- No frameworks in content scripts (plain DOM APIs)
- Popup and options page may use a lightweight framework if needed (decide before first UI component)
- Vite for bundling
- Adapters = JSON files in `src/adapters/` — one per site domain pattern

## Stack (locked — do not add without discussion)
- MV3 APIs
- Defuddle (content extraction)
- Turndown (HTML→MD)
- Vite (build)
- IndexedDB (offline queue)
