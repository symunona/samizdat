# CLAUDE.md — Samizdat

Self-hostable read → curate → cite → publish pipeline. Single-user, server-is-hub, offline-first.
`README.md` = the pitch. `ARCHITECTURE.md` = the design. **`docs/decisions.md` = why, plus the bugs that already cost a day — read it before changing anything load-bearing.**

**Always read the last 5 git commits first.**

## Layout
- `server/` — Go. REST API + worker + engine (scrape, dedup, pipeline, store, sync, TLS). One binary.
- `cli/` — Go. `sam`, every command headless.
- `app/` — Expo (RN + RN Web). Reader/curator; the web build is served by `server/`.
- `clipper/` — Chrome MV3. Capture client on the same REST API.

Each has its own `CLAUDE.md`. Component recipes are namespaced (`just server::dev`, `just app::start`) — keep that pattern.

## Non-negotiable design rules
1. **Vault markdown is truth; SQLite is a rebuildable index.** Anything in the DB must be reconstructable from `vault/` (`sam reindex`).
2. **Nothing lives only in a hosted DB.** Everything has a markdown/export path (the Omnivore lesson).
3. **Scrape one URL once.** Dedup by `canonical_url` before scraping — it is expensive and ban-prone.
4. **Phase split is sacred:** `Scraper`→`Document` (shared, opinion-free) vs `Pipeline`→`Highlight` (personal). Never personalize a Scraper; never re-fetch in a Pipeline.
5. **Credentialed/paywalled content stays per-user** — never in the shared cache, never to a cloud LLM. Route those jobs to a local provider.
6. **One binary. No Docker, no nginx, no Redis.** TLS via CertMagic in-binary. One exception to "static": the server links MuPDF via cgo, so it is dynamically linked against glibc — still one binary, no sidecars. The CLI stays pure-Go static. This puts the repo under **AGPL-3.0**.

## Domain vocabulary (exact names, no synonyms)

`Document` (scraped source, 1 per canonical URL) · `Highlight` (LLM-extracted unit; machine data, server→phone one-way) · `Annotation` (user-created selection + optional note, W3C TextQuoteSelector anchor; two-way sync) · `Note` (user-authored vault md) · `Feed` · `Subscription` · `Scraper` · `Pipeline`/`PipelineStep` · `Job` · `Schedule` · `Tag` · `UserProfile` (master prompt/persona).

PascalCase singular types, snake_case plural tables, `<singular>_id` FKs.
Banned fragments: `Content`, `Memory`, `Source`, `Parsed*`, `Cron`, `Url`.

## Locked stack
- **Server:** Go · `modernc.org/sqlite` (pure Go) · `sqlc` (portable SQL — a Postgres swap stays a driver change) · CertMagic · queue = the `jobs` table.
- **LLM:** two adapters — Anthropic native + OpenAI-compatible (OpenAI, OpenRouter, Ollama, LM Studio, llama.cpp). **One router owns every endpoint** (`server/internal/llm`); a step names a provider id, never a URL or key. Tiers: triage → local/`claude-haiku-4-5`, breakdown → `claude-sonnet-4-6`, digest → `claude-opus-4-8`. `just check-llm` probes them all.
- **App:** Expo (RN + RN Web). All state in one local SQLite behind `app/src/db/`. CodeMirror 6-in-WebView for anchored edits.
- **Clipper:** MV3; adapters ship as config/data, never remote code.
- **Auth:** no accounts. Owner passphrase (Argon2id) → device tokens (Bearer, revocable) → CLI local trust.
- **Sync:** server-authoritative. `rev` + `updated_at` + tombstone per row, client-minted UUID PKs. Machine data one-way; user-authored rows two-way LWW.

## Working rules
- Match surrounding code — comment density and naming idiomatic per component.
- **No dead code. DRY. Keep the repo clean.**
- Commits: imperative subject ≤50 chars. Branch off `main` for features.
- Never commit secrets, `*.db`, `node_modules`, `.expo`, build output.
- **Always `just build` and `just lint` before calling a job done.** Fix everything lint reports; maintain the linter.
- **If the backend changed, restart `just dev`.**
- **Commit at the end of every delivery.**
- If the specs contradict each other, raise it before implementing.

## Plans
Plan first, in `plan/YYYY-MM-DD-name.md`, front matter: `created`, `topic`, `excerpt`, `status`.
Larger feature: commit the plan to `main`, branch, small commits, ask the user to check, squash-merge back.
When shipped, `git mv` it to `plan/archive/`.
`plan/` therefore holds only work that is NOT done. Shipped design lives in `plan/archive/`.

## Testing
Write the one-time E2E self-test **before** starting — decide up front how you will know it works.

**Test the interaction, not just the API.** Set state up through the API, then drive the real interaction (agent-browser) and assert the VISIBLE result. A `POST` proving a row exists is NOT proof: a silent UI failure returns 200 and throws nothing, so "no errors" passes on broken code. Compose the HARD case (a selection crossing inline `<a>`/`<b>`/`<code>`, not the first easy word). One interaction test per page.

- `just e2e` — smoke: builds, starts on :8766 with a clean `/tmp/samizdat-test/` DB, pairs a device, navigates every page, fails on any JS error or 4xx/5xx. **Add every new screen to `e2e/smoke.js` `PAGES`.** Config: `config/config-test.toml` (never edit for dev work).
- `just e2e-int` — the deep interaction net (`e2e/integration.js`).
- `just e2e-db` / `just e2e-offline` — replica layer and offline walkthrough.
- **Never claim a frontend feature done without a green `just e2e`.**
- **Never pair a fresh device** — it spams the dev DB. `just robot-browser` / `just test-device` mints/reuses the single `robot-automated-ui-tester` device. One row, reused forever.
- Native-only behavior (soft keyboard, share sheet, page-mode swipe, install-over) cannot be verified headless. Say so instead of claiming it works.

**After every agent-browser task, kill the zombies** — Chrome + renderers cost 50–200 MB each and do not self-terminate:
```bash
pgrep -a -f "agent-browser|chrome-linux64/chrome" | grep -v grep   # then: just kill
```

## tmp/ — scratch (gitignored)
Screenshots (`tmp/screenshots/`), browser sessions (`tmp/sessions/<name>.json`, `tmp/debug-session/state.json`), device logs, API dumps, one-off scripts.

## Data destruction
Bulk deletes or non-recoverable updates: **ask first.**

## Subsidiarity
Component-specific notes live in that component's `CLAUDE.md`; cross-cutting decisions and traps in `docs/decisions.md`. Before a merge, run `spec diff-review` to see whether a `CLAUDE.md` needs the new fact.

## Deploy: prod = systemd service, dev = nohup takeover

Prod runs as a **per-instance user systemd service** (`samizdat-<dir>`, e.g. `samizdat-sam`), installed once by `just install`, `enabled` + `linger=yes` → auto-restarts on crash AND boot. That is the recovery mechanism. **Dev is NOT a service** — `just dev` builds live and runs a nohup, so you can rebuild/restart/tail freely.

The handoff is one-directional per command:
- `just dev` → stops the systemd service and takes the port as a nohup.
- `just restart` → hands the port back to the service. It kills a dev nohup still holding the port, then asserts the service's MainPID is the process actually listening. Both halves matter: a service that cannot bind still reports `active`, so without the assert `just restart` prints success while the OLD dev binary serves every request — visible only in `/health`'s commit stamp.
- `just status` → which mode holds the port, plus build staleness. `just service-logs` → the service journal.

**Dev and the service must be configured by the SAME file, never by a flag one of them passes.** Anything a `just dev` flag turns on and the unit omits is silently off in prod — that is how the APK download stayed dead under systemd.

**The gap to remember:** while you are in `just dev`, prod is STOPPED, and a dev nohup has no auto-restart. If it dies and you forget to hand back, prod stays down. **Always end a dev session with `just restart`.** For a quick prod change prefer `just build && just restart`. Do NOT turn dev into a service — you would lose live rebuild + tailable logs and gain nothing.

## Branding / app icon
Source of truth: `assets/samizdat.svg` (repo root). The launcher set (`app/assets/icon.png` + adaptive fg/bg/monochrome) is **auto-generated** by `just gen-icons`, which `just build-android` runs before `expo prebuild`. Never hand-edit the generated PNGs. The generator (`tools/icongen/`) keeps its own isolated `node_modules` — the Expo tree cannot `npm i sharp` (arborist crash).

## Playwright driver / CDN
The scraper uses headless Chromium via **`github.com/mxschmitt/playwright-go` v0.6100.0**, not `playwright-community` — the latter hardcodes the decommissioned `playwright.azureedge.net`, which 404s → `[FATAL] browser init failed` → the server exits on boot. That tag mis-declares its module path, so the import path is `mxschmitt/...`; keep both the Go import and the `just` playwright-install recipe on it. `StorageState` takes `BrowserContextStorageStateOptions{Path:...}`, not a bare string.

## Android APK

`just build-android` builds on the machine named in `config/build-node.env` (gitignored, written by `just setup-build-node <ssh-dest> [workspace]`) — this box has 4GB and a throttled local build takes ~35 min vs a few minutes on a real machine. `just build-android-local` is the offline fallback; an unreachable node **fails loud** rather than silently costing 35 min. `just build-times` shows history; `just status` reports node reachability. Both paths share `_apk-gradle` and `_apk-collect`, so flags and paths cannot drift.

This box keeps only a partial SDK (`build-tools/36.0.0`, `platforms`, `cmdline-tools`, `licenses`, `~/.jdks/jdk-17`). The NDK, `cmake`, `platform-tools` and `app/android/` were reclaimed; AGP re-downloads the NDK on a first local build, so the fallback costs a couple of GB before it costs 35 minutes.

- **The APK's location has exactly ONE source: `config.toml` `[server] apk_path`.** Optional — unset means `dist/samizdat.apk`; a relative value resolves against the **config file's own directory** (a systemd unit has no cwd guarantee). The server always registers `GET /download/samizdat.apk` + `GET /api/v1/app/android/version` and serves from that path (plain 404 before a build exists). **There is no `--apk` flag** — a flag only `just dev` passed, with the unit omitting it, left prod registering neither route: the version request fell through to the SPA catch-all and returned *HTML*, so the APK was undownloadable and the in-app updater blind for as long as the service ran. The build side asks the binary for the same value (`just _apk-path` → `samizdat config apk-path`). Nothing else may spell out `dist/samizdat.apk`.
- **Transport is `git push` over ssh** (`build-node` remote) — the node needs no GitHub credentials. Consequence: **the node builds `HEAD`, so the tree must be committed**; the version bump is committed automatically for that reason.
- The node's checkout stays on `main` while builds push to `build`, so the pushed ref is never the checked-out branch (no `receive.denyCurrentBranch`).
- Remote reset uses **`git clean -fd`, never `-fdx`**: ignored paths (`node_modules`, `app/android/`, `secrets/`) must survive or every build pays a reinstall + cold gradle cache. The pnpm lock stamp lives in `GRADLE_USER_HOME`, outside the repo.
- The node gets its own `GRADLE_USER_HOME` (cache **and** memory tuning sized from its cores/RAM), so it never inherits this box's small-JVM survival config. **Metro's heap is sized the same way** and carried in `build-node.env` as `BUILD_NODE_METRO_MB` — it runs concurrently with the gradle + kotlin daemons, so one fixed number swaps a small node for the whole bundle task.
- **`setup-build-node` installs the whole toolchain into the node's `$HOME`** — node, pnpm, `just`, JDK 17, SDK cmdline-tools — with **no sudo and no package manager**, so one recipe provisions any distro and cannot disturb the node's own toolchain. It only requires `git curl unzip rsync tar` to be there already. An existing node ≥ 22 is reused; anything older or absent gets the pinned tarball symlinked into `~/.local/bin`.
- **`secrets/debug.keystore` is the APK's install-over identity.** `app/android` is gitignored, so the keystore never travels with the source; if a host lets `expo prebuild` mint its own, the APK installs on a clean phone but Android **silently refuses** to install it over a build signed by the other key. Setup ships it, every build re-syncs it, `tools/verify-apk.sh` compares signer certs against `dist/samizdat.apk.prev`. **Back that file up outside the repo** — it is gitignored and lives nowhere else.
- Version metadata never comes back from the node: the bump, `extra.buildEpoch` and the sidecar are produced here.
- `tools/verify-apk.sh` gates every build (signer identity, versionCode monotonic, bundled `assets/app.config` freshness, single arm64 ABI, sidecar↔buildEpoch, served version). No arguments = verify the configured APK.
- `app/src/webview/document-viewer-bundle.ts` is generated + gitignored, so `_apk-gradle` runs `just webview-build` every build — otherwise a build host has none and this box ships whatever stale copy was on disk.

### Versioning
`just build-android` auto-bumps every build — default **patch**; pass `minor` / `major` when the release warrants it. Bump only: `just bump [level]`. It runs *before* prebuild so the native manifest is stamped.

**`versionCode` is monotonic by wall-clock**: `max(oldCode+1, minutesSince2024-01-01)`, NOT a plain +1. Plain +1 reads the git-tracked `app.json` and regresses when a bump isn't committed (or across machines) → a rebuild reuses the SAME code → Android refuses the install-over and the updater never offers it. Wall-clock minutes always advance.

`bump-version.mjs` also stamps `expo.extra.buildEpoch` (ms). **The sidecar's `built_at` MUST derive from `extra.buildEpoch`, never `new Date()`** — `isUpdateAvailable` compares `built_at > APP_BUILD_EPOCH` at equal versionCode, and buildEpoch is stamped at build *start* while the sidecar is written at build *end*; a `new Date()` value is always greater, so the app perpetually reports an update against its own build.

## Design source of truth
Detailed research + decisions live in the planning vault outside this repo:
`~/dropx/org/50-59 pet projects and hobbies/54 samizdat/` — `plan/003 Plan Decisions.md`, `plan/004 Onboarding Plan.md`, `plan/005 Samizdat Expo App UX.md`, `options/`, `research/tech/`. When something here is ambiguous, that vault is canonical.
