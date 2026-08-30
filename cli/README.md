# cli/

`sam` — the headless control surface. Runs on the server box, so it is local-trust.

- **Stack:** Go, Cobra, pure static (`CGO_ENABLED=0`).
- **Commands:** `setup` · `serve` · `connect`/`qr` (pair a device) · `sub` (subscriptions) · `yt` (ingest a video) · `login <domain>` (paywalled scrape auth) · `llm check`/`llm models` · `config`.

See `CLAUDE.md`.
