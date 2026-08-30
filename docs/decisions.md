# Decisions + Traps

Why things are the way they are. One line each. Detail lives in the component
`CLAUDE.md`s; shipped design lives in `plan/archive/`.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Vault markdown = truth. SQLite = rebuildable index (`sam reindex`). | Omnivore died and took its DB with it. Nothing lives only in a hosted DB. |
| 2 | Scrape one URL once. Dedup on `canonical_url` before scraping. | Scraping is slow, expensive, ban-prone. |
| 3 | Phase seam is sacred: `Scraper`→`Document` (shared, opinion-free) vs `Pipeline`→`Highlight` (personal). | Scraper output is shareable/community-maintainable. Pipeline never re-fetches. |
| 4 | Paywalled/credentialed content routes to a LOCAL provider, never cloud. | Owner's subscription, owner's box. Enforced in the Router. |
| 5 | One binary. No Docker, no nginx, no Redis. Queue = a `jobs` table. | Self-host must be one command. |
| 6 | Server links MuPDF via cgo → dynamically linked, repo is **AGPL-3.0**. CLI stays pure-Go static. | Most academic figures are vector draw ops; nothing to "extract" — they must be rendered. |
| 7 | Pure-Go SQLite (`modernc.org/sqlite`) + `sqlc` for all SQL. | No cgo on the DB path; portable SQL for a future Postgres swap. |
| 8 | UUID PKs, client-minted. Every row: `id/created_at/updated_at/rev/deleted_at`. | Offline creates can never collide; tombstones sync. |
| 9 | Sync is server-authoritative: pull by cursor, push user-authored rows LWW. Machine data (`Document`,`Highlight`) is server→phone one-way. | Conflict surface shrinks to rows the user actually writes. |
| 10 | No accounts. Owner passphrase (Argon2id) → device tokens (Bearer, revocable) → CLI = local trust. | Single user. Accounts are a hosted-SaaS tax. |
| 11 | ONE LLM Router owns every endpoint. A step names a `provider` id + `model`, never a URL or a key. | Four steps each carrying `base_url`+`api_key` = four routers and a credential in a DB row. |
| 12 | Pinning is pinning: `Route{Provider}` never falls back. | A step aimed at the local box must fail loud, not quietly spend cloud money. |
| 13 | Step catalog + default prompts are config/DB values, not Go consts. | Tuning a prompt is a DB edit, not a redeploy. App renders the editor from `GET /api/v1/pipeline-steps`. |
| 14 | Long docs chunk with **`partition`** (run the step's own prompt per chunk, union results). `map→reduce` only for lossy steps (`llm_summarize`). | The fold never sees the source, so an extraction step invents quotes. Real incident — see Traps. |
| 15 | App: one Expo codebase (native + RN Web). All state in ONE local SQLite behind `app/src/db/`. | A zustand-persist blob replica hit Android's 6MB cap and froze silently. |
| 16 | Every user mutation goes through `db.*` (row + outbox intent in one tx), never `api.ts` from a screen. | That is what makes tag/star/annotate work offline. |
| 17 | Clipper is MV3: adapters ship as config/data, never remote code. | MV3 bans remote execution. |
| 18 | Prod = per-instance user systemd service (`samizdat-<dir>`, linger). Dev = `just dev` nohup takeover. | Service auto-restarts on crash+boot; dev needs live rebuild + tailable logs. |
| 19 | Anything dev and prod both need lives in `config.toml`, never in a `just dev` flag. | A flag the systemd unit omits is silently OFF in prod. |
| 20 | APK `versionCode` = `max(old+1, minutesSince2024-01-01)`. | Plain +1 regresses across machines/uncommitted bumps → Android refuses install-over, updater goes blind. |
| 21 | APK builds on a remote node over `git push`; this box is the fallback. | 4GB here = ~35 min throttled build. Node needs no GitHub creds. |
| 22 | Concrete paired checks, not a generic registry (`spec parity`). | Abstract before the second case exists and you get a framework with one user. |
| 23 | yt-dlp egress = ordered proxy pool, sticky active entry. | One home node blinking used to kill every video ingest. |
| 24 | Name a self-hosted box by MagicDNS, never by IP. | A `providerID` is `host:port` — the identity every pipeline step pins. Rebuilding a box moves the IP. |

## Traps — bugs that already cost a day

Each one bit. Each one has a guard now. Do not remove the guard.

### Deploy / process
- **Rebuild ≠ restart.** Old code serves until the process dies. `just status` compares live `/api/v1/health` commit vs `git HEAD` → FRESH/STALE. A service that cannot bind still reports `active`.
- **`just dev` STOPS the prod service.** Dev nohup has no auto-restart. Session dies → prod stays down. **Always end with `just restart`.**
- **Playwright `azureedge` CDN is decommissioned** → 404 → worker `[FATAL] browser init failed` → server exits on boot. Use `github.com/mxschmitt/playwright-go` v0.6100.0 (not `playwright-community`), both in Go imports and the `just` install recipe.
- **`cli`'s `config.Save` re-serializes the WHOLE file** from the CLI struct → wiped every server-only key (`[llm]`, `[ytdlp]`, `[export]`) once. Never `Save` a config the CLI did not write; use single-value setters like `SaveDeviceToken`.

### Silent data loss
- **Sync cursor: sample `server_time` BEFORE the DB reads.** After = a concurrent write lands in the read gap below the returned cursor and the client skips it forever.
- **A failed local write must be LOUD.** zustand `persist` never awaited `setItem`; past Android's 6MB whole-DB cap every write rejected unhandled and the replica froze for **6 days** while the phone re-pulled a growing delta. → `persistHealth.ts` + drawer dot.
- **`diff-review` rewrites the whole CLAUDE.md.** `max_tokens` 4096 truncated the reply and deleted 67 lines. Guards: `claude.ErrTruncated` + `shrinksTooMuch` (15%). Never discard either.
- **Idle export sweep must touch NOTHING on disk.** Cursor sits AT the newest `updated_at` (never rolled back), and byte-identical files are skipped — else Syncthing/Obsidian see a change event every 15s forever.

### LLM
- **map→reduce fabricated real quotes.** The fold sees chunk summaries, not the source, so a "verbatim" step invented a Dolly Parton quote and misattributed a Steve Jobs line — written to Highlights that synced and exported. `chunkStrategyFor` defaults to `partition`; only `llm_summarize` opts out.
- **Ollama's default `num_ctx` is 4096 and truncates silently.** Bake the context into a model variant (`ollama create`), then tell the server the same number in `ctx_tokens`. An oversized prompt comes back as a confident answer about whatever survived. (0.32.7+ errors instead — but only on a sized model.)
- **`EstimateTokens` (runes/3) is not always safe** — link-heavy markdown tokenizes ~1.7 runes/token. `CompactForLLM` strips link targets first (76% of one real newsletter was tracking URLs). Fix the estimator before "correcting" `ctx_tokens`.
- **`max_tokens` contains "token"** → the credential-name stripper ate it, the field never rendered and the next save dropped it. Two exemptions (`notCredentialRe` server, `NOT_SECRET_KEY` app) must stay in step.

### Scraping / ingest
- **Never route a PDF through the browser.** Chromium answers a PDF nav with `playwright: Download is starting` and no page → every PDF scrape dead. Branch on `isPDFURL` before the fetch.
- **Trafilatura does NOT rewrite relative `<img src>`.** A site-relative src survives into the markdown → no asset row → no export rewrite → dead image both ends. Absolutize at HTML level AND markdown level.
- **A stale `yt-dlp` looks exactly like an IP ban** (403 on every proxy). It cost an afternoon of swapping healthy nodes. It is a separate failure class, checked BEFORE the bot-block test, and it never rotates the pool.
- **YouTube auto-captions emit every line ~3×** (paint-on + settle + carry-over). Un-deduped, every video body was 3× its real text and every LLM step paid 3× tokens. A transcript segment is a SENTENCE, never a caption cue.

### App / RN
- **`useShallow` selector that maps to fresh objects → React #185 white crash.** Empty arrays compare equal, so it passes smoke tests and only dies with real data. Select raw slices, derive in `useMemo`.
- **Go nil slice marshals to JSON `null`** → RN expects an array → blank screen, no console error. Normalize to `[]` at the API boundary.
- **`Platform.OS === 'web'` is TRUE on mobile Safari.** It never means "desktop". Branch on `(pointer: coarse)`.
- **Native RN `Image` silently reports 1×1 for a relative URL.** Renders fine on web. Absolutize against `activeUrl`.
- **Native `<Modal>`: `autoFocus` won't raise the soft keyboard** (focus from `onShow` + `setTimeout`), and **`KeyboardAvoidingView` is a no-op inside an Android Modal** (track `Keyboard` height, lift by margin). Neither is testable headless — verify on a device.
- **wa-sqlite is one Asyncify stack**: two `step()` chains in flight corrupt the heap → `memory access out of bounds`, replica dead. Serialize READS too, and express reentrancy as the handle `tx()` hands the body — never an `inTransaction` flag.
