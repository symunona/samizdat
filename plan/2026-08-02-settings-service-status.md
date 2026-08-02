---
created: 2026-08-02
topic: Settings — Service Status group + LLM provider health
excerpt: Regroup Settings into Connection / Services / Preferences / Device blocks, add a per-provider LLM health card (last call ok/error, quota vs auth vs transport), and surface a drawer dot when any service is degraded.
status: planned
---

# Settings: service status group

## Why
Settings is a flat stack of 12 cards in arrival order. The four things that can be
*broken* (YouTube proxy, export mirror, browser extension, LLM providers) are scattered
between preference toggles, and the one that breaks silently — an LLM provider out of
credits — has no representation at all: the failure only shows as a dead Job.

## Scope
1. **Group + reorder Settings** into labelled sections.
2. **New LLM Services card** — one row per configured provider (primary + fallbacks)
   with last-call status, error kind, per-provider calls/cost; cumulative totals folded in.
3. **Degraded dot** on the drawer (hamburger + Settings row), same affordance as the
   existing "update available" dot.

## Server

### `internal/llm/health.go` (new)
Package-level registry — every client records its own outcome, so ad-hoc clients minted
per pipeline step (`step_llm_*.go` → `llm.New`) are covered without wiring.

```go
type ProviderHealth struct {
  Key, Provider, BaseURL string
  Calls, Errors          int64
  LastOKAt, LastErrorAt  time.Time
  LastError, LastErrorKind string   // kind: auth | quota | transport | api
}
func Record(key, provider, baseURL string, err error)
func Snapshot() []ProviderHealth
func Restore([]ProviderHealth)          // boot: rehydrate from server_settings
func SetPersist(func([]ProviderHealth)) // each Record → persist callback
```

- Key: `anthropic` / `openai_compat@<base_url>` (two Ollama boxes stay distinct).
- `classify(err)`: HTTP 401/403 → `auth`; 429 or body matching
  `credit balance|quota|insufficient` → `quota`; `errors.Is(ErrTransport)` → `transport`;
  else `api`. **This is what makes "ran out of Anthropic credits" legible** instead of a
  raw 400 blob.
- `anthropic.go` / `openai_compat.go` call `Record` on every return path of `Complete`.
- Persistence: `server_settings` key `llm_provider_health` (JSON), same pattern as
  `ytdlp_proxy_last_ok_at` — survives restart, which matters because the error that
  killed a nightly pipeline must still be visible next morning.

### `internal/api/llm_status.go` (new) — `GET /api/v1/llm/status` (bearer)
Merges three sources into one payload:
- **config** (`router.New` already receives `config.LLMSection`): primary + `Fallback[]`
  → provider, model, base_url, `has_key` (never the key itself), `role: primary|fallback`.
- **health snapshot** by key → status `ok | error | unknown`, last_ok_at, last_error(+kind).
- **usage** — new sqlc query `GetLLMUsageTotalsByProviderModel` (provider, model, sums,
  count) → per-provider calls / tokens / `llm.EstimateCost`.

A provider present in usage/health but no longer in config is still listed (`role: retired`)
— cost history must not vanish when the config changes.

### Wiring
- `router.New`: restore health from settings at boot, `llm.SetPersist(...)`, register route.
- No change to `Complete` signatures, no change to the fallback chain semantics.

## App

### `src/llmStatus.ts` (new)
`fetchLLMStatus` + types, same shape/rationale as `proxyStatus.ts` / `exportStats.ts`.

### `src/useServices.ts` (new)
React Query hooks for the three server-side service checks, replacing the hand-rolled
`useState` + `setInterval` in Settings so the drawer and Settings share one cache:
- `useProxyStatus()` (20s poll — keeps today's behaviour), `useExportStats()`, `useLLMStatus()`
- `useServiceAlert(): boolean` — true when proxy configured-but-down, export errored, or
  any configured LLM provider's last call errored.

### `app/(drawer)/settings.tsx` — regroup
Section headers (new `sectionTitle` style, no new component — it's a `<Text>`):

| Section | Cards |
|---|---|
| (top, unlabelled) | Server Connection · Server URLs · Server Info |
| **Services** | YouTube Proxy · Export Vault · Browser Extension (web) · **LLM Services** |
| **Preferences** | Background Polling · Transcript Languages · Auto Page Mode · Debug Log Streaming |
| **Device** | App Version · Connected Devices · This Device · Local Data |

**LLM Services card** (replaces the standalone "LLM API Usage" card):
- per provider: status dot · label (`anthropic` / host of base_url) · `primary`/`fallback`
  badge · model · status line (`Working — last call 4m ago` / `Out of credits — <msg>` /
  `No calls yet`) · calls + `$cost`
- footer rows: cumulative calls / input / output / est. cost (today's numbers, kept).

### `app/(drawer)/_layout.tsx`
`updateAvailable || serviceAlert` drives the hamburger dot (accent for update, `error`
colour when a service is degraded) and adds the same dot to the drawer's Settings row.

## Testing (write first, run at the end)
- **Go unit** `llm/health_test.go` — `classify` on a real Anthropic credit-exhaustion body,
  a 401, a dial error, a 500; `Record`/`Snapshot` round-trip + JSON restore.
- **e2e interaction** (`e2e/integration.js`, `just e2e-int`) — drive the real page, assert
  the VISIBLE result:
  1. Settings renders the `SERVICES` header with all four service cards under it, in order.
  2. Seed a quota failure through the API (persist a health blob), reload Settings →
     the LLM row shows the error state + the error text, not "Working".
  3. That same seeded state paints the drawer dot (hamburger badge visible).
  4. Preferences/Device sections still render their existing controls (regression on the
     reorder — the page-threshold checks at `integration.js:1050+` must stay green).
- `just e2e` smoke stays green (settings is already navigated).
- `just lint` + `just build` before done.

## Non-goals
- **No active probing of cloud providers** — a health check costs tokens and money. Status
  is derived from the last real call. (Local `openai_compat` could be pinged cheaply; not
  worth a second code path today.)
- No per-provider enable/disable UI, no key editing from the app (keys live in
  `.env`/`config.toml`, and the API must never return them).
