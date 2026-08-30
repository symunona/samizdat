# clipper/

Browser capture (Chrome MV3) — "Save to Sam". Posts to the same REST API as the app.

- **Shipped:** multi-instance popup dropdown, saved-state indicator, on-page toast, auto-pair from the web Settings page.
- **Not yet:** client-side capture (Defuddle + Turndown), in-page highlights, IndexedDB offline queue.
- Adapters ship as config data, never remote code (MV3 policy).

Build: `just build-clipper` → `dist/unpacked/` + `dist/sam-chrome.zip`. See `CLAUDE.md`.
