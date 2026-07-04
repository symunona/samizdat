---
created: 2026-07-04
topic: Scraper credential store + unattended session auto-refresh
excerpt: Persist per-domain login creds in a 0600 credentials.toml (not bashrc), and auto-relogin from it when the scraper detects an expired session.
status: done — verified E2E: delete jar (keep creds) → scrape auto-relogins, regenerates jar, returns full 32.9k text
---

# Scraper credential store + auto-refresh

Follow-up to `2026-07-03-scraper-paywall-auth`. Answers "where do the creds
live" (not bashrc) and makes session expiry self-healing.

## Decisions
- **Store:** `<data_dir>/credentials.toml`, 0600, gitignored, per-domain
  `["<domain>"] {username, password}`. Server-managed (`internal/credstore`),
  separate from the hand-edited config.toml. NOT shell rc / env files (leaky, flat
  namespace, wrong lifetime).
- **Split by secrecy:** login *flow* (selectors) stays in git-tracked feed.yaml;
  *secrets* go in credentials.toml.
- **Auto-refresh:** on scrape, if the authed page still shows `paywall_text`,
  `refreshSession` re-logins once from credentials.toml, rewrites the jar, re-fetches.
  Warn only if still gated after (no creds / login fail / lapsed sub). At most once
  per scrape — no loop.

## Surface
- `internal/credstore`: `New(dataDir)`, `Get(domain)`, `Set(domain, Creds)` (atomic
  temp+rename, 0600).
- `dataDir` plumbed `main → api.New → worker.New`; worker holds `*credstore.Store`.
- Login endpoint body gains `save` (default true) → stores creds on success; returns
  `saved`. CLI `sam login` gains `--no-save`.
- `handleScrapeURL`: `isGated()` + `refreshSession()`.

## E2E (verified)
1. `sam login 444.hu` (default save) → jar + credentials.toml (0600) written.
2. Scrape → 32.9k full text.
3. Delete jar, keep creds → scrape → log `session expired → re-logging in → session
   refreshed`, jar regenerated, 32.9k full text (no gate). ✅

## Still out of scope
Credentialed → local-LLM routing (Rule 5) — unchanged from prior plan.
