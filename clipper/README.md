# clipper/

Browser capture — clip pages, highlight, manually add sources — posting to the same REST API as the app.

- **Stack:** Chrome/WebExtension (MV3), cross-browser.
- **Capture:** extract client-side with **Defuddle + Turndown** → clean markdown → `POST /documents` (server dedups by `canonical_url`, enqueues a `Pipeline`). In-page highlight → W3C selectors → `POST /highlights`.
- **Manual add:** forms over the same endpoints — add-by-URL (`scrape_url` job), paste markdown (`Document`), quick `Note`.
- **Offline:** queue clips in IndexedDB, drain to the API when online.
- **Site adapters:** shipped as **config/data** (selector JSON), never remote code (MV3 policy). Community-contributable via PR.

Auth: pairs with the server like any device (QR/token → Bearer). Not initialized yet. See `../ARCHITECTURE.md` and `../CLAUDE.md`.
