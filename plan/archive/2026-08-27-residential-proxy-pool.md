---
created: 2026-08-27
topic: Multiple residential proxies for yt-dlp (pool + failover + UI list)
excerpt: >-
  [ytdlp].proxy is single-valued, so when the one home node goes down every
  YouTube ingest fails with the bot-block error. Replace it with an ordered
  pool that health-checks every entry, picks the active one stickily, rotates
  past a bot-blocked IP mid-job, and renders the whole list in Settings.
status: shipped — squash-merged to main 2026-08-28 (a79e9a4)
---

# Residential proxy pool

## Why

`[ytdlp].proxy = "socks5h://meet-2-cam…:1080"` is one string. `meet-2-cam` is a
Pi Zero at 95.2% uptime under load 2.4 — when it blinks, every ingest dies. The
tailnet already has six working microsocks egresses across **five distinct
residential IPs** (probed 2026-08-27, all clear the YouTube bot wall):

| node                    | exit IP          | site        | ISP             |
|-------------------------|------------------|-------------|-----------------|
| `rath-pince-inside-cam` | 145.236.177.21   | Rath        | Magyar Telekom  |
| `piri`                  | 77.74.81.30      | Dietikon CH | Init7           |
| `papi`                  | 89.133.207.170   | Balatonfüred| One Hungary     |
| `fured-1-cam`           | 89.133.207.170   | Balatonfüred| One Hungary     |
| `meet-2-cam`            | 178.48.93.10     | Meetlab     | UPC             |
| `meet-4-cam`            | 178.48.93.10     | Meetlab     | UPC             |
| `mama-1-cam`            | 89.134.23.230    | Mama        | One Hungary     |

(`rue`, `fiona`, `xayah`, `pandora` have no reachable :1080 — `rue`'s
`thermal-socks` is bound elsewhere and it is browning out anyway.)

Note `papi`/`fured-1-cam` and `meet-2-cam`/`meet-4-cam` **share** an exit IP —
so the UI must show the exit IP, not just the host, or a "failover" hops to the
same blocked address.

## Shape

### 1. `server/internal/proxypool` (new)

One owner of the list + its health, shared by the API card and the worker — the
two consumers that today each read `cfg.Proxy` independently.

- `New(list []string, p Persist) *Pool`
- `Configured() bool`, `Current() string`, `Attempts() []string`
- `MarkFailed(proxy, reason string)` — worker demotes a bot-blocked IP
- `Statuses() []Status` — per-entry `{proxy,label,ok,exit_ip,error,checked_at,last_ok_at,active}`
- `Check(ctx)` probes every entry **concurrently** via api.ipify.org; `Run(ctx)` loops 60s.
- **Sticky active**: keep the current entry while it is OK; else first OK in list
  order. Prevents flapping between two healthy nodes on every probe.
- `Persist` is a 2-method interface (`Get`/`Set`) so the package stays store-free;
  api adapts `store.Queries`. `last_ok_at` moves from the scalar
  `ytdlp_proxy_last_ok_at` key to one JSON blob `ytdlp_proxy_last_ok`
  (`{proxy: rfc3339}`), seeded from the old key for the legacy `proxy` value so
  "last online" survives the upgrade.

### 2. Config

```toml
[ytdlp]
proxies = [
  "socks5h://rath-pince-inside-cam.tail7f475e.ts.net:1080",  # 145.236.177.21 Rath
  "socks5h://piri.tail7f475e.ts.net:1080",                   # 77.74.81.30  CH
  ...
]
```

`YTDLPSection` gains `Proxies []string`; `Proxy string` stays for back-compat.
`ProxyList()` = dedup(Proxies ++ [Proxy]), trimmed, empties dropped — so an
existing single-valued config keeps working untouched.

### 3. Worker

The three yt-dlp call sites (`probeYTInfo` `-J`, audio download, video download)
each hand-roll `--proxy`/`--cookies`/exec/classify. Collapse into one
`runYTDLP(ctx, bin, pool, cookies, args, url)` that walks `pool.Attempts()`:
bot-block → `MarkFailed` + next proxy; any other error → return immediately.
Empty pool → one direct run. `classifyYTDLPError` reports which proxies were
tried, not a single `%q`.

### 4. API

`GET /api/v1/ytdlp/status` keeps every existing top-level field (mirroring the
**active** entry — APKs in the wild parse that shape) and adds `proxies: []`.

### 5. App

`proxyStatus.ts` adds `proxies?: YtdlpProxyEntry[]`; Settings' "YouTube Proxy"
card keeps the headline (active proxy + exit IP) and lists every entry below
with dot / label / exit IP / error. Falls back to synthesizing a one-entry list
from the flat fields when talking to an older server.

## Tests

- `proxypool` unit test: sticky selection, rotation past a failed entry, dedup,
  empty list.
- `just e2e` smoke stays green.
- **agent-browser interaction test**: open Settings, assert the card lists >1
  proxy row with distinct exit IPs, hit Recheck, assert the rows re-render.
- Live check against the real tailnet: kill the active node's reachability
  (point an entry at a dead host) and assert `Current()` moves on.

## Built (2026-08-27)

All of the above, plus one thing the investigation turned up: **the reported
breakage was not the proxy at all.** All seven nodes probed healthy and cleared
the YouTube bot wall; the failure was a `yt-dlp` binary 2.5 months behind
(`2026.06.09` vs `2026.08.19`), which 403s on the media fetch through *every*
proxy. Updated the binary, and added detection so it can never be misread again:

- `server/internal/ytdlp` — `Checker` reports installed vs latest release
  (cached 6h, age fallback when offline), served as `ytdlp` on
  `GET /api/v1/ytdlp/status`.
- `isStaleBinaryFailure` is its own error class, checked **before** the bot-block
  branch, and it does **not** rotate — verified: a stubbed stale binary failed the
  job in 541ms (one proxy) instead of walking all seven.
- Settings renders it as a separate warning above the node list; proxy dots stay
  green, because the proxies are green.

Verified live: 7 proxies / 5 distinct exit IPs listed with `SHARED IP` tags,
Recheck re-probes, a dead head entry (`rue`) goes red while the active pointer
moves on, and a real ingest logs `yt-dlp probe … (proxy=rath-pince-inside-cam)`.

## Out of scope

Per-proxy weighting/round-robin for load spreading, and auto-discovery of
tailnet peers from `status.tmpx.space`. Ordered failover first.
