---
created: 2026-06-09
topic: Playwright headless scraper
excerpt: Replace plain http.Client scraper with playwright-go for full JS rendering
status: done
---

## Goal
Rewrite `handleScrapeURL` to use playwright-go (Chromium) instead of plain HTTP.
All sites, including JS-rendered ones (Telex, etc.), scraped correctly.

## Changes

### server/
- `internal/worker/browser.go` — NEW: BrowserPool (init, FetchHTML, Close)
- `internal/worker/scraper.go` — replace `http.Client` fetch with `BrowserPool.FetchHTML`
- `internal/worker/worker.go` — add browser field, init on startup, stop on ctx done

### justfile
- `setup-server` recipe: add playwright browser install step

## Auto-install strategy
`playwright.Install()` called at Worker startup — downloads Chromium to
`~/.cache/ms-playwright` if not already present. Silent on re-runs.
Also wired into `just setup-server` so it runs during dev setup.

## Key decisions
- Single shared `playwright.Browser` instance, per-scrape `BrowserContext` + `Page`
- Wait strategy: `load` state (faster than `networkidle`, enough for SSR content)
- User-agent: realistic Chrome UA
- 30s page timeout
- Keep trafilatura + figure-image extraction unchanged (they work on the rendered HTML)
