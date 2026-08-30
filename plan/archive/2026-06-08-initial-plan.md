# Samizdat — Initial Plan (2026-06-08)

> Dense north-star: what we're building, why, and the path. Canonical detail: `ARCHITECTURE.md`, `CLAUDE.md`, `docs/`, and the planning vault (`~/dropx/.../54 samizdat/`). Lists ≤10.

## What
A self-hostable **read → curate → cite → publish** pipeline. Ingest newsletters + news portals, break them into bite-sized **units** with your own per-source rules, read them in your own fast offline app, curate with one swipe (links first-class), and publish your own digest with citations auto-attached.

## Why / goal
Stop the copy-paste. Output = **your own Thorsten-style newsletter, effortless, from units of info.** Anti-slop, own-your-data, one-command self-host. OSS-first (reputation engine); hosted tier optional/later. Beachhead user = you, dogfooding daily.

## Shape
Single-user. **Server = hub** (scrapers, cron, canonical store, markdown vault). **Devices pair in** (phone/web app, browser clipper, CLI). Phone holds an offline replica.

## Core idea — two phases, one seam
- **`Scraper` → `Document`** — shared, deduped, opinion-free; one per `canonical_url`; LVL0 summary as a field; every link becomes a child `Document`.
- **`Document`** — the seam (the firewall).
- **`Pipeline` → `Highlight`** — personal; your editable per-source prompt emits bite-sized units + `Tag`s.
- Rule: *the Scraper makes the Document; the Pipeline reads it.*

## Components
- **`server/`** Go — REST API + cron worker + engine; single static binary; SQLite (rebuildable index) + md vault (truth); CertMagic TLS.
- **`cli/`** Go `sam` — every command headless; local-trust.
- **`app/`** Expo — offline reader/curator (iOS/Android/web); web build served by the server.
- **`clipper/`** MV3 — capture + manual add; same API.

## Stack (locked)
Go · pure-Go SQLite (`modernc`) · `sqlc` · CertMagic · Expo/RN (+Web) · CM6-in-WebView editor · Defuddle+Turndown clipper · provider-agnostic LLM (Anthropic native + OpenAI-compatible/local Ollama·LM Studio·llama.cpp), tiers Haiku/local → Sonnet → Opus (`claude-haiku-4-5`/`claude-sonnet-4-6`/`claude-opus-4-8`).

## Scope now — L0′
Newsletter / news-portal ingest → unit breakdown → own reader → digest. **Parked (forward-compatible):** podcast/transcript, voice notes, visual pipeline editor, embeddings, multiuser/billing.

## Milestones
1. **M1 — Online** — public connection + install service + QR pair + health "we're online". → `plan/milestone-1-online.md`, build spec `docs/server-auth-pairing.md`.
2. **M2 — Ingest** — one `Feed` → `Document` → `Highlight` → app feed.
3. **M3 — Curate** — swipe/tag/save + resume + links + sync.
4. **M4 — Publish** — digest build + citations + publish.
5. **M5 — Clipper** — capture + authed scraping.

## Non-negotiables
md = truth / DB = rebuildable · nothing only-in-DB · scrape-once · phase split sacred · paywalled stays local · single binary, no Docker/nginx.
