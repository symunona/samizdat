---
created: 2026-07-03
topic: Android share-sheet URL ingest
excerpt: Share a webpage/YouTube link from any Android app → Samizdat scrapes it as a Document.
status: implementing
---

# Android share URL → ingest

## Goal
Press **Share** on a webpage / YouTube link in any Android app, pick **Samizdat** →
the URL is queued as a scrape job (same path as the Documents "Add URL" box), the
app opens on the Documents screen, and the in-flight scrape card shows progress →
tap-to-open when done.

## Mechanism
Android `ACTION_SEND` with `text/plain` (the standard "share a link" intent). Expo's
managed workflow can't read `ACTION_SEND` extras via `expo-linking` (that's for
`VIEW`/URL-scheme deep links only), so use **`expo-share-intent`**:
- Config plugin → registers the `ACTION_SEND` intent-filter in the generated
  `AndroidManifest.xml` at `expo prebuild` (native tree is gitignored + regenerated
  every `just build-android`, so no hand-editing).
- `useShareIntent()` hook → reads the shared URL/text, both cold-start and warm.

## Central ingest path (reuse, don't reinvent)
`useScrapeQueue().startScrape(url)` (src/ScrapeQueueContext.tsx) already:
submits `submitScrapeJob`, dedups by URL, shows the floating overlay card
("Reading as document…" → "Ready — tap to open"), polls the job, resolves docId.
The share bridge just calls `startScrape(url)` + navigates to `/documents`.

## Files
1. `app/package.json` — add `expo-share-intent`, `expo-linking`, `expo-constants`
   (peer deps) via `npx expo install` (SDK-pinned, pnpm).
2. `app/app.json` — add `expo-share-intent` plugin with `androidIntentFilters: ["text/*"]`.
3. `app/src/ShareIntentBridge.tsx` — native: `useShareIntent()` → extract URL →
   hold until `status==='connected'` → `startScrape(url)` + `router.push('/documents')`
   + `resetShareIntent()`. Toast if the shared payload has no URL.
4. `app/src/ShareIntentBridge.web.tsx` — `return null` (no expo-share-intent import;
   Metro resolves `.web` for web/e2e builds). knip-ignore it.
5. `app/app/_layout.tsx` — mount `<ShareIntentBridge/>` inside `ScrapeQueueProvider`
   (needs useConnection + useScrapeQueue + useRouter).
6. `app/knip.json` — ignore `src/ShareIntentBridge.web.tsx`.

## URL extraction
`shareIntent.webUrl ?? firstUrlIn(shareIntent.text)`. YouTube/browsers send the bare
URL as text/plain; some apps prepend a title ("Look at this https://…") → regex the
first http(s) URL out of `.text`.

## Edge cases
- Not connected yet (cold start): hold the pending URL in a ref, fire `startScrape`
  the moment `status` flips to `connected`.
- No URL in payload → toast "No link found in shared content", reset.
- Web/e2e build → `.web.tsx` no-op, `just e2e` stays green.

## Testing
- `just typecheck` + `just lint` (parity/knip) green.
- `just e2e` green (web build must not import the native module).
- Native ACTION_SEND flow is device-only (headless browser can't fire a share
  intent) — verify on a real phone after `just build-android`: share a page from
  Chrome + a video from the YouTube app; confirm both land as Documents.
