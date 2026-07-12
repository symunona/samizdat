---
created: 2026-07-12
topic: sam sub CLI command
excerpt: Headless subscription management (add/list/rm/poll/pause) mirroring the /api/v1/subscriptions endpoints.
status: done
---

# `sam sub` CLI command

## Why
No headless way to add a feed subscription. App-only. The server already exposes
`/api/v1/subscriptions` (create/list/patch/delete/poll) + RSS auto-detection.
CLI should mirror it (every command headless — CLAUDE.md).

## Scope
`cli/cmd/subscription.go`, cobra group `sub` (alias `subscription`, `subs`):
- `sam sub add <url> [--interval-h N]` → POST /subscriptions (auto RSS detect)
- `sam sub list` (alias `ls`)               → GET /subscriptions + GET /feeds, joined
- `sam sub rm <id>`                          → DELETE /subscriptions/{id}
- `sam sub poll <id>`                        → POST /subscriptions/{id}/poll
- `sam sub pause <id>` / `resume <id>`       → PATCH /subscriptions/{id}

## Auth
Reuse the local-trust bearer pattern from `yt.go`: cached `cfg.DeviceToken`,
`pairAndCache()` on empty/401. Factor a small `authedRequest` helper (method,
path, body) that re-pairs once on 401 — avoids copy-pasting yt.go's retry dance
per subcommand.

## Test
- `just build-cli`, then `sam sub add https://natesnewsletter.substack.com/`
- assert RSS auto-detected (Substack `/feed`), feed row + sub row created
- `sam sub list` shows it; `sam sub poll <id>` enqueues; agent-browser check the
  Subscriptions screen renders it.

## Status
- [x] command scaffold
- [x] add/list/rm/poll/pause
- [x] build + lint (0 issues)
- [x] add Nate's newsletter sub → RSS auto-detected (/feed), 20 items discovered
- [x] verified via `sam sub list`
