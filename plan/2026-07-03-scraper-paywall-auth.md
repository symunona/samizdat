---
created: 2026-07-03
topic: Scraper per-domain paywall authentication (storageState + login)
excerpt: Log in once per paywalled domain, persist a Playwright storageState cookie jar, feed it into the scrape context so gated articles render full-text. CLI `sam login`, headless form login, and login/paywall success detectors.
status: in-progress
---

# Scraper paywall auth

## Goal
Scrape paywalled domains (first: `444.hu`) with the owner's subscription. Log in
once, persist the browser session, reuse it on every scrape. Detect login success
and detect a stale/expired session at scrape time.

## Investigation (done, 2026-07-03)
- 444's login is SSO on **magyarjeti.hu** (parent co). `444.hu` → click login →
  `https://magyarjeti.hu/bejelentkezes?redirect=https://444.hu`.
- Nette form, stable selectors: `input[name=username]` (email), `input[name=password]`,
  `input[name=send]` (submit).
- After submit → 302 back to `444.hu`, session cookie set. Playwright `storageState`
  captures cookies for **both** magyarjeti.hu + 444.hu → scraping 444 unlocks.
- **Login success marker:** account button text flips `JELENTKEZZ BE!` (out) →
  `FIÓK` (in).
- **Paywall/gate marker (scrape-time):** `Ezt a cikket teljes terjedelmében csak
  előfizetőink olvashatják el` / `Csatlakozz a Körhöz`. Present = still gated.
- Verified: logged-out article = 9.6k chars + gate CTA; logged-in = 32.5k chars, no
  gate, full text to footer.

## Architecture decision
Reuse the **existing per-domain seam** — `extractors/<domain>/feed.yaml`
(`extractor.ExtractorConfig`, keyed by hostname, already looked up on every scrape).
No new TOML array. Add an `auth:` block there. The cookie jar (the secret) lives at
`<cacheDir>/auth/<domain>.json`, chmod 0600, gitignored.

`feed.yaml` auth block:
```yaml
auth:
  login_url:       "https://magyarjeti.hu/bejelentkezes?redirect=https://444.hu"
  user_selector:   "input[name=username]"
  pass_selector:   "input[name=password]"
  submit_selector: "input[name=send]"
  success_text:    "FIÓK"                                        # login detector
  paywall_text:    "csak előfizetőink olvashatják"              # scrape-time stale-session detector
```

## Slices
1. **Config** — `AuthConfig` struct + `Auth *AuthConfig` on `ExtractorConfig`
   (`extractor/config.go`).
2. **Browser** — `BrowserPool.FetchHTML(url, statePath)` (empty statePath = current
   behavior; else `NewContext{StorageStatePath}`). New `BrowserPool.Login(auth, user,
   pass, statePath)` → headless form login, verify `success_text`, save storageState
   0600.
3. **Scrape wiring** — pass `extractor.Registry` into `handleScrapeURL`; resolve
   statePath from `<cacheDir>/auth/<host>.json` when the domain has `auth` + the file
   exists; after fetch, warn if `paywall_text` still present (stale session).
4. **Server endpoint** — `POST /api/v1/admin/scraper/login` (loopback-only), body
   `{domain, username, password}` → `worker.Login` → save jar. Returns `{ok, detail}`.
5. **CLI** — `sam login <domain>` (`--user`/`--pass` flags, env
   `SAM_LOGIN_USER`/`SAM_LOGIN_PASS` fallback) → POSTs the endpoint.
6. **444 config** — add the auth block to `extractors/444.hu/feed.yaml`.
7. **.gitignore** — `**/auth/*.json` cookie jars.

## E2E self-test (define before build)
1. `just build` clean.
2. `sam login 444.hu --user bboborjan+444@gmail.com --pass <pass>` → prints success,
   jar written at `<cacheDir>/auth/444.hu.json`.
3. Enqueue scrape of the known paywalled article → Document markdown length ≫ logged-out
   (assert > 20k chars, and the gate text is ABSENT from the stored markdown).
4. Negative: delete the jar, scrape again → gate text present → server logs the
   "session expired, re-run sam login" warning.

## Out of scope (follow-up)
- **Credentialed → local-LLM routing** (Rule 5). The router guard documented in
  `server/CLAUDE.md` is not implemented. Marking authed Documents credentialed and
  forcing a local provider is a separate change. Single-user server, owner's own creds
  → immediate leak risk is nil; tracked as follow-up, not this PR.
