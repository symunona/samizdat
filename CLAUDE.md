# CLAUDE.md — Samizdat

Self-hostable read → curate → cite → publish pipeline. Single-user, server-is-hub, offline-first. See `README.md` for the pitch, `ARCHITECTURE.md` for the design.

Always get the last 5 git commits to gain context!

## Monorepo layout
- `server/` — Go. REST API + cron worker + engine (scrape, dedup, pipeline, store, sync, TLS). Single static binary.
- `cli/` — Go. The `sam` binary; every command headless. Shares the engine with `server/`.
- `app/` — Expo / React Native (+ RN Web). The reader/curator client; web build is served by `server/`.
- `clipper/` — Chrome/WebExtension (MV3). Capture client; posts to the same REST API.

## Branding / app icon
The app logo source of truth is `assets/samizdat.svg` (repo root). Edit that one SVG; the launcher icon set (`app/assets/icon.png` + adaptive `android-icon-foreground/background/monochrome.png`) is **auto-generated** from it by `just gen-icons`, which `just build-android` runs before `expo prebuild`. Never hand-edit the generated PNGs. The generator (`tools/icongen/`) carries its own isolated `node_modules` — the Expo app tree can't `npm i` sharp (arborist crash).

## Task runner
`just` is the entry point. Run `just` to list recipes. Prefer adding a recipe over documenting a raw command. Component recipes are namespaced (`just server::dev`, `just app::start`, etc.) — keep that pattern.

## Non-negotiable design rules
1. **Markdown vault is the source of truth; SQLite is a rebuildable index.** Anything in the DB must be reconstructable from `vault/`. `sam reindex` rebuilds it.
2. **Nothing lives only in a hosted DB** — everything has a markdown/export path (the Omnivore lesson).
3. **Scrape one URL once** — dedup by `canonical_url` before scraping; scraping is expensive and ban-prone.
4. **Phase split is sacred:** `Scraper`→`Document` (shared, opinion-free) vs `Pipeline`→`Highlight` (personal). Never personalize a Scraper; never re-fetch in a Pipeline.
5. **Credentialed/paywalled content stays per-user** — never in the shared cache, never sent to a cloud LLM by default (route those jobs to a local provider).
6. **Single static binary, no Docker, no nginx** on the happy path. TLS via CertMagic in-binary.

## Domain vocabulary (use these exact names)
`Document` (scraped source, 1 per canonical URL) · `Highlight` (**LLM-extracted** bite-sized unit from a Document; machine data, server→phone one-way) · `Annotation` (**user-created** text selection on a Document or Highlight, with optional note body + W3C TextQuoteSelector anchor; user-authored, two-way sync) · `Note` (user-authored vault md) · `Feed` (pollable source) · `Subscription` (user↔Feed + Schedule) · `Scraper` (URL→Document) · `Pipeline`/`PipelineStep` (Document→Highlights) · `Job` (queued work w/ cost metering) · `Schedule` · `Tag` · `UserProfile` (master prompt/persona). Conventions: PascalCase singular types, snake_case plural tables, `<singular>_id` FKs. Banned name fragments: `Content`, `Memory`, `Source` (ambiguous), `Parsed*`, `Cron`, `Url`.

## Stack decisions (locked)
- **Server:** Go, single static binary. SQLite via pure-Go `modernc.org/sqlite` (no CGO). Job queue = a `jobs` table (no Redis). TLS = CertMagic.
- **DB portability:** write portable SQL via `sqlc`; engine swap (SQLite→Postgres) only at a future cloud step.
- **LLM:** provider-agnostic. Two adapters — Anthropic native (Messages API) + OpenAI-compatible (covers OpenAI cloud AND local Ollama/LM Studio/llama.cpp). Tiered: triage→cheap/local or Haiku, breakdown→Sonnet, digest/draft→Opus. Model IDs: `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`.
- **App:** Expo (RN + RN Web). Editor: CodeMirror 6-in-WebView for anchored/linked edits; plain RN `TextInput` for casual notes.
- **Clipper:** fork Obsidian Web Clipper patterns; Defuddle + Turndown; adapters shipped as **config/data**, not remote code (MV3).
- **Auth:** no accounts. Owner passphrase (Argon2id) → device tokens (Bearer, revocable) → web cookie same-origin → CLI = local trust.

## Sync (server-authoritative)
Rows carry `rev` (server monotonic seq) + `updated_at` + tombstone. Phone pulls by `since_rev` cursor; pushes user-authored rows with LWW. UUID PKs (client-minted) → no insert collisions. Machine data (Document/Highlight) is server→phone one-way; only user-authored rows (Annotation, read-state, tags) are two-way.

## Conventions
- Match surrounding code; keep comment density and naming idiomatic per component.
- Commits: imperative subject ≤50 chars; branch off `main` for features.
- Don't commit secrets, `*.db`, `node_modules`, `.expo`, build output (see `.gitignore`).
- Tests/lint live behind `just` recipes; run them before claiming done.

## Commit Rules
Do commit at the end of every delivery!

## Prefer subagents for dev tasks
Always make a plan first in the plan/[yyyy-mm-dd]-plan-name.md
Use front matter: create date, topic, excerpt, status of where we are.
When done, move to plans/archive folder.
When feature is larger commit plan to main, then branch off, do smaller commits, at the end, ask the user to check. When done, squash merge back to main.

## Testing
Craft one time E2E self-tests before starting - how you will make sure the feature works when the work is done!
ALWAYS TEST YOURSELF VIA agent-browser!
**Never pair a fresh device for UI tests** — it spams the dev DB. Run `just robot-browser`
(or `just test-device`) which mints/reuses the single `robot-automated-ui-tester` device via
the idempotent `POST /api/v1/admin/test-device` endpoint and preloads its token into the
browser state. One row, reused forever.
If there are inconsistencies in the specs, raise it to the user, before starting to implement.
Always run linter before you finish a job and fix anything that comes up..
Maintain the global linter.
If backend changed, always restart `just dev`!

## Data destruction
If you're doing BULK deletes or updates that are non-recoverable, always ask for confirmation.

## Subsidiarity
Keep sub-project specifix notes in the CLAUDE.mds. Before each merge, run the `diff_review` tool to see if we need to append the respective CLAUDE.md with new info.

## Building
No dead code. Only functional code.
Keep repo CLEAN code.
Try always everything DRY.
Always run `just build` before you call a job done.

## Design source of truth
Detailed research + decisions live in the planning vault (outside this repo):
`~/dropx/org/50-59 pet projects and hobbies/54 samizdat/` — see `plan/003 Plan Decisions.md`, `plan/004 Onboarding Plan.md`, `plan/005 Samizdat Expo App UX.md`, `options/`, and `research/tech/` (009 naming, 019 SQLite, 020 sync/queue/API). When a decision here is ambiguous, that vault is canonical.


## Smoke test (e2e)

Run before every major feature or refactor that touches the app frontend:

```bash
just e2e
```

What it does: builds the server binary, starts it on port **8766** with a clean `/tmp/samizdat-test/` DB, pairs a device programmatically, navigates Documents / Tags / Jobs / Subscriptions in headless Chromium, and fails on any JS error or HTTP 4xx/5xx from the API.

**Maintain the smoke test** — if you add a screen, add it to `e2e/smoke.js` `PAGES`. If you rename a route, update it there. The test config lives at `config/config-test.toml` (never edit for dev work — it always points to `/tmp`).

**Never** claim a frontend feature done without a green `just e2e`.

## tmp/ — scratch, screenshots, browser sessions

`tmp/` at the repo root is gitignored. Use it for:
- **Screenshots** from browser automation / agent-browser runs
- **Browser session files** (cookies, localStorage exports) so headless Chrome can resume authenticated sessions across runs — store as `tmp/sessions/<name>.json`
- **Temporary debug data**, API response dumps, one-off scripts

To run the web app in a browser with a persisted session, use `just browser-session <name>` — it launches headless Chrome loading `tmp/sessions/<name>.json` if it exists, and saves the session back on exit. Create `tmp/` with `mkdir -p tmp/sessions`.

## agent-browser cleanup (mandatory)

After **every** agent-browser task, verify no zombie processes remain:

```bash
pgrep -a -f "agent-browser|chrome-linux64/chrome" | grep -v grep
```

If any linger, kill them:

```bash
pkill -f "agent-browser-linux-x64" 2>/dev/null || true
pkill -f "chrome-linux64/chrome" 2>/dev/null || true
```

**Never leave an agent-browser session open after a task is done.** Chrome + renderer processes each consume 50–200 MB and do not self-terminate when the parent task ends.
