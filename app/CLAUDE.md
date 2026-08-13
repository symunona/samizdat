# CLAUDE.md — app/

Expo (React Native + RN Web) reader/curator client. Offline-first.

## Stack
pnpm, React Native, TypeScript. Running & building: always map them to just.

- **Styling**: `react-native-unistyles` v3 (`createStyleSheet` + `useStyles`). Never use `StyleSheet.create`. Theme defined in `src/theme.ts`.
- **Navigation**: Expo Router (file-based routes in `app/` dir)
- **Server state**: React Query
- **UI state**: Zustand
- **Rich/anchored edits**: CodeMirror 6 in a WebView
- **No Redux, no MobX, no class components**

## Unistyles pattern

Unistyles v3 uses CSS class injection on web, not inline styles. For RNW (web builds), use `useUnistyles()` + `useMemo` to build styles from the theme:

```ts
import { useUnistyles } from 'react-native-unistyles'
import { StyleSheet, useMemo } from 'react-native'

function MyComponent() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  return <View style={s.container} />
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    container: { backgroundColor: t.colors.background },
  })
}
```

Theme tokens live in `src/theme.ts` — edit there, not inline.
On native builds, `StyleSheet.create` from unistyles can be used directly.

## Offline-first rule
All reads come from local SQLite replica. Network sync runs in background.
Never block UI on network. Server is authoritative; broken replica → wipe + re-pull.

## Sync model
- Pull: send `since_rev` cursor, receive rows with `rev > since_rev`
- Machine data (`Document`, `Highlight`): server→phone one-way, never push back
- User-authored rows (`Annotation`, read-state, `Tag`): two-way LWW push

## Local-first writes (outbox) — NEVER call a mutating api.ts fn from a screen
Every user mutation (tag / star / archive / annotate / read-progress / delete) MUST go
through the DB layer (`import * as db from '../src/db'`), never the inline `api.ts`
client. A mutation (1) writes the row to SQLite and patches the memory index, so the UI
reacts with **no network**, and (2) enqueues an ordered `outbox` intent that
`pushEngine.drainOutbox` replays against the SAME `api.ts` endpoints when connected.
This is why tagging/starring work offline. Wiring:
- `src/store/outbox.ts` — PURE reducers + dirty-tracking + dirty-aware pull-merge (unit-tested by `e2e/outbox-unit.mjs`; run via `just e2e-offline`). No zustand/network/clock here.
- `src/db/repo.ts` — the mutations (row + intent + dirty key in ONE transaction, then the index) and a **dirty-aware `applySync`**: a locally-dirty row is NOT clobbered by an older server pull until its intent is pushed. `base_rev` is tracked per dirty row (Phase 2 note-conflict seam).
- `src/store/pushEngine.ts` — drains the outbox in FIFO order (dependencies hold: a create lands before edits that reference it); a transient failure (offline/5xx/401) stops the drain + retries with backoff, a 4xx is dropped so it can't wedge the queue.
- `src/store/useOutboxPush.ts` — mounted in `_layout` `SyncEffects`; drains on new intent, reconnect, foreground, interval. The outbox is a table → survives restart in FIFO order.
- **Creates are client-minted UUIDs** (`src/store/uuid.ts` — crypto when present, else Math.random; the `uuid` pkg's v4 crashes on bare Hermes). The server create endpoints (annotation, note, tag) honor an optional `id` idempotently, so a replayed offline create can't collide or duplicate. Never enqueue machine content (doc markdown, highlight body).
- **Mutations are async** — they are real I/O. `createTag`/`createAnnotation` return a Promise of the new row; `await` them if you need the id.
- `TagSelectorModal` is fully replica-driven (`db.useTags()` + `db.useTagLinks()`, mutates via `db.*`) → works offline, no fetch. Follow the useShallow rule: raw slices + `useMemo`.

## A failed local write must be LOUD (`src/store/persistHealth.ts`)

The blob-replica era failed in total silence: zustand's `persist` called
`storage.setItem()` on **every** `set()` and never awaited the promise, so once a device's
storage filled up every write rejected as an unhandled promise rejection — nothing thrown,
nothing logged, no UI change. The replica froze at one snapshot for **six days** while
hydration kept handing that snapshot back; `lastSyncedAt` never advanced, so the phone
re-pulled an ever-growing delta on every launch. Do not re-introduce a silent write path.

SQLite removed the cause (rows have no 6MB whole-DB cap), but a write can still fail — a
genuinely full disk, a corrupt file — so the visibility stays. Wiring:
- `repo.ts`'s write gate reports **once per write**: `null` = it landed, the error = it
  didn't. A failed write leaves the memory index untouched, so the UI cannot show a change
  that was not saved, and the mutation swallows the error after reporting (re-throwing
  would only restore the unhandled rejection). `applySync` is the exception: it rethrows,
  because the sync engine owns the retry and must not advance its cursor.
- `isStorageFullError(e)` — pure discriminator (`SQLiteFull` / `disk is full` /
  `QuotaExceeded`). It only picks the wording; any write error still raises the alert.
- `persistHealth.ts` — non-persisted zustand store (persisting "writes are broken" through
  the broken writer would be absurd). Logs **once per outage** at `error` level, so it
  rides `logger.ts` → `debugLog.ts` → `tmp/device-logs/<device>.ndjson` with an immediate
  flush. A later successful write clears it — the state is recoverable, not sticky.
- A replica that cannot even OPEN reports here too, and marks the index hydrated anyway —
  otherwise every screen sits on a skeleton forever with nothing saying why.
- `useServiceAlert()` ORs it in: same red dot on the hamburger + drawer Settings row as a
  broken server-side service. Settings shows a **Device Storage** card in the Services
  group *only while broken*.
- `src/offlineSim.ts` hosts both web-only e2e simulators: `samizdat_force_offline` (every
  fetch rejects — except the SQLite `.wasm`, which is runtime, not server) and
  `samizdat_force_storage_full` (every SQL write rejects with `SQLITE_FULL`).

Covered by `just e2e-int` (`runPersistFailure` — the visible card + drawer dot, the NDJSON
line, and the recovery). `runPersistFailure` and `runDbLayer` must stay **before**
`runSettingsServices`, which permanently seeds a broken LLM provider and would keep the
drawer dot lit for every later check.

## Screen structure (plan/005)
Bottom tabs: **Feed · Digest · Settings**. Add FAB center-bottom. Side drawers for filters.
Feed: `Highlight` cards, swipe-triage (read/save/skip). Document viewer: gutter-anchored highlights.
Digest: assembled citations, LLM draft, export.

## Component conventions
- PascalCase filename, one component per file
- Co-locate styles with component via `createStyleSheet` at bottom of file
- No `StyleSheet.create` anywhere

## Editor
- Rich/anchored edits: CodeMirror 6 in a WebView
- Casual notes: plain `TextInput`
- Never use RN's built-in `TextInput` for anchored highlight editing

## UI guidelines
Always look for existing components before making a new one.

**Always use styled icons** — never raw emoji/glyphs (`🗑`, `#`, `★`) as tappable controls. Use `@expo/vector-icons` (Ionicons) via a styled component so every icon gets consistent color, sizing, and desktop hover.
- Tappable icons: `<IconButton name="…" onPress={…} />` (`src/IconButton.tsx`) — Ionicons wrapper with non-touch hover (scale + color shift). Use for delete (`trash-outline`), tags (`pricetags-outline`), and any new icon button.
- Note action buttons: `<NoteEditButton onPress={…} />` (`src/NoteEditButton.tsx`) — wraps `IconButton` with `create-outline` (tilted pencil). Use everywhere a note/annotate action button appears.
- Notes / annotations inline display: `✏` (pencil emoji) — annotation badges, note preview text only (display, not a control)
Interactions: when user clicks on something that does an API call - indicate loading, disable button. On error, toast, indicate error on button. Make this a component, reuse wherever.

## Highlight card lives in TWO renderers — keep them in parity

The Highlight card is rendered in two places that **cannot share a rendered component** (different runtimes):
- `src/HighlightCard.tsx` — **React Native** (the feed list; native + RN-Web).
- `src/webview/document-viewer.ts` → `renderHighlightCard()` — **raw DOM inside a WebView** (the document body). React does not run here; it's `document.createElement` + event-delegation → `postMessage` back to RN.

They must show the **same actions (pin · tags · annotate · delete), same icons, same layout**. A change to the action set / an icon / a label / the layout in one MUST be mirrored in the other.

**Why no shared component:** native RN has no DOM/`innerHTML`; the WebView has no RN renderer. `dangerouslySetInnerHTML` does NOT bridge this — it's web-only and kills React's event wiring (you'd hand-roll delegation anyway), and per-row HTML in a FlatList is a perf anti-pattern. So: **share the spec, not the pixels.**
- **Icons:** same Ionicons glyph both sides — RN uses the `@expo/vector-icons` component (`IconButton`); the WebView inlines the *same glyph's* SVG path data (vector-icons can't run in the WebView). Form differs, glyph/size/meaning must match.
- **Action protocol:** the WebView posts `hl_pin` / `hl_delete` / `hl_tags` / `hl_annotate`; the RN host (`app/(drawer)/document/[id].tsx`) maps them to the same callbacks the feed wires directly.
- **Annotated cards are marked whole**, both sides: dotted 2px accent border + the note
  pencil in accent (`cardNoted` / `hasNote` in RN; `.hl-card.hl-noted` /
  `.hl-icon-btn.hl-noted-btn` in the WebView). **Pinned is applied after noted and is
  SOLID accent** — the two states must stay tellable apart. The flag is
  `db.useAnnotatedHighlightIds()` (a Set, read once per screen — a per-row hook in a
  FlatList is the anti-pattern), fed to the WebView on `HlData.hasNote`. The host pushes
  a fresh `setHighlights` when that Set changes: `setAnnotations` only moves marks, and
  the border lives in the highlight payload.
- **The WebView card has NO swipe gesture.** It used to drag left/right for star/delete;
  removed, because both actions are unconditional footer buttons and the gesture only
  bought accidental deletes plus a swallowed horizontal pan (it also forced a
  `touch-action` dance against page mode). The RN feed's `ReanimatedSwipeable` triage is
  a different thing and stays. Do not reintroduce a drag here.

**Enforced:** `just lint` runs `spec parity` — if one of the two files changed vs main and the other didn't (or they diverged), it flags it and asks Claude whether the change needs mirroring. See `tooling/CLAUDE.md`.

## The feed's date is the SORT KEY (`src/DateStamp.tsx`)

The feed is ordered by **`highlights.created_at DESC`** — when the pipeline produced the
Highlight, i.e. ingest — on both paths (`queries.sql` `ListHighlights`; replica
`db/hooks.ts` `selectHighlights`). The card used to print `document_published_at`
instead, so the list was ordered by one date and labelled with another and read as
unsorted. **Whatever the list sorts by is what the card must show.**

`DateStamp` shows the ingest date and keeps the article's own publication date one
reveal away: `title` attribute for a hover tooltip on a fine pointer, long-press → toast
on a coarse one (`isTouchDevice()`, never `Platform.OS` — see below). RNW drops an
unknown `title` prop, so it is written onto the host node from a ref.

`documents.published_at` was always on the wire (`store.Document`) but the replica
dropped it, so offline there was no second date to reveal — hence replica schema **v2**
(`MIGRATE_2_DOC_PUBLISHED_AT`). `SCHEMA_SQL` is the v1 baseline and is never edited; a
new column is an appended entry in `MIGRATIONS`, or a fresh install would run
`CREATE`-then-duplicate-`ALTER`.

## Error state comes from the JOB, not the Document (`src/failedJobs.ts`)

`documents.error_reason` is only ever set by the server's false-parse gate, so it
covers one failure out of many: a scrape that 404s, a pipeline whose LLM is down,
a video fetch that dies — none of them touch the Document row (a hard scrape
failure produces no Document at all). The reason lives in the dead **Job**
(`last_error`), and `GET /api/v1/jobs?status=dead` is the only place it surfaces.

`useFailedJobs()` polls that feed once (React Query dedupes it across screens) and
the pure helpers derive the UI:
- `documentErrorText(doc, failed)` — the one line shown for a Document. Its own
  `error_reason` wins; otherwise the dead job that names it (`payload.document_id`
  / `result.document_id`) or scraped its URL. Used by the Documents list badge,
  the article viewer banner and `VideoDocument` — **keep all three on this one
  function** so they can never disagree.
- `orphanScrapeFailures(failed, documents)` — dead scrapes that produced no
  Document. They get their own pinned row on Documents (Retry / dismiss), because
  nothing in the list represents them. Failures stay in `jobs`; do NOT invent stub
  Documents for them.

Covered by `just e2e` (`runErrorStateUiCheck` + `seedDeadJob` in the harness).

## Pipeline step editor (`app/(drawer)/pipelines.tsx`)

A step is `{kind, config}` free-form JSON; `GET /api/v1/pipeline-steps` (`fetchStepCatalog`)
describes the keys each kind knows — label, type (`string|text|int|float|bool`), default, help.
The editor renders the union of *catalog fields* and *config keys*, so a key the catalog
doesn't describe is still visible and editable; a `text` field (the prompt) opens at ~4
lines with an expand toggle. Save serializes the drafts through `putPipelineSteps` (steps
go as a JSON **string** — that's the column).

- **The filter summary mirrors Go exactly.** `PipelineFilter` in `src/api.ts` = the four
  keys of `pipeline.PipelineFilter`; anything else is printed verbatim as `key: value`. The
  old code checked `feed_id`/`tag`/`domain`/`url_pattern` — none of which exist — so every
  pipeline read "all documents", the maximally wrong answer for a feed-scoped pipeline.
- **`max_tokens` is not a credential**, even though `SECRET_KEY` matches "token" —
  `NOT_SECRET_KEY` carves it back out. Without the exemption the field never rendered and
  the next save dropped it (the server strips the same name on read; the two exceptions
  must stay in step).
- **A credential must never enter the DOM.** No step kind declares one any more (the LLM
  Router owns endpoints and keys) and the server strips every credential-*named* key from
  each read path, but the screen ALSO drops anything matching `SECRET_KEY` — including in
  the raw-JSON view, which is rebuilt from the parsed steps rather than echoing the stored
  string. A legacy `api_key` therefore never renders, and the next save drops it for good.

### The `model` field is a picker, not a text box (`src/ModelPicker.tsx`)

A model name belongs to exactly ONE provider: a Claude id sent to an Ollama box is a 404 →
a 4xx → no fallback → the pipeline dies hard. Typing one was the easiest way to break a
pipeline, so the catalog gives the `model` field `type: "model"` and the editor renders a
searchable modal instead: results **grouped under provider headers**, the search matching
model ids AND provider names, plus an explicit *Provider default* row (clearing the model
hands the choice back to the endpoint's `default_model` — what a fallback chain needs).

- Selecting writes **both** `model` and `provider` through one `setModelChoice` update.
  Two `setFieldValue` calls would each start from the pre-update drafts and the second
  would drop the first's write — and a model naming a different endpoint than its provider
  is exactly the 404 this feature exists to prevent.
- `src/llmModels.ts` — `fetchLLMModels` (`GET /api/v1/llm/models`, grouped + cached
  server-side) and `probeLLMProviders` (`POST /api/v1/llm/probe`). Sibling of
  `llmStatus.ts`; that one reads the passive health registry, these ACTIVELY ask.
- The picker follows the native Modal focus rule below (focus from `onShow`, deferred).

Covered by `just e2e-int` (`runPipelineStepsUi` + `seedPipeline`/`startStubLLM` in the
harness — a stub OpenAI-compatible box gives the catalog real rows with no network and no
spend).

## Connection state — NEVER bypass ConnectionProvider

`ConnectionProvider` (in `src/ConnectionContext.tsx`) is the single owner of connection state. It probes the server on mount and every 30s, and picks the fastest reachable URL automatically.

**Rule:** Every screen reads connection via `useConnection()`. Never import `loadConnection`, `saveConnection`, or `findReachable` directly in a screen.

```ts
// ✅ correct
const { activeUrl, token, status } = useConnection()

// ❌ wrong — bypasses provider, re-probes every render, hangs on slow/dead URLs
const saved = await loadConnection()
const found = await findReachable(saved.serverUrls, saved.token)
```

**Why it matters:** `findReachable` without a `lastSuccessfulUrl` hint tries ALL stored URLs sequentially — localhost, docker bridges, Tailscale — with no timeout. For a remote client (Tailscale, LAN), unreachable IPs stall the fetch indefinitely. `ConnectionProvider` already did this work; use its result.

**Pattern for screens that fetch on mount:**
```ts
const { activeUrl, token, status } = useConnection()

useEffect(() => {
  if (status === 'connected') load()
  else if (status === 'disconnected') { setError('Not connected'); setLoading(false) }
}, [status, load])
```

**Writing connection data** (e.g. after pairing): call `reload()` from `useConnection()` — do not call `saveConnection` and forget. `reload()` re-reads storage and triggers a fresh probe, keeping the provider in sync.

## Re-connecting after session expiry (local testing)

If the browser loses its session (cleared storage, expired token, fresh state):

```bash
just sam connect
```

Copy any of the printed links, e.g. `http://localhost:8765/connect?code=ABCD-EFGH`, and open it in the browser. The connect page reads `?code=`, uses the page's own origin as the server URL, and auto-pairs immediately — no manual form filling needed.

The `?c=<base64>` param is for the paste-string / QR-scan flow (mobile, no terminal).

## Debugging with agent-browser

**Always reuse the persisted debug session** — never start fresh from an unpaired state.

State lives at `tmp/debug-session/state.json` (gitignored). It holds cookies + localStorage so the app starts already connected to the server.

### Setup (one-time, or after wiping state)

```bash
# 1. Open a fresh browser, go through the pairing flow manually
agent-browser open http://localhost:8765
# ... pair device in the UI ...
# 2. Save state for future runs
just save-debug-session
```

### Every debug / e2e run

```bash
# Opens with saved state — app starts already paired/authenticated
just debug-session
# or directly (note: --no-sandbox required on this Linux host):
AGENT_BROWSER_ARGS="--no-sandbox" agent-browser --state tmp/debug-session/state.json open http://localhost:8765
```

### Rules

- **Never** start a debug agent-browser session without `--state tmp/debug-session/state.json` (or via `just debug-session`).
- After any pairing action in tests, call `just save-debug-session` to persist the new token.
- Screenshots go to `tmp/screenshots/`, not `tmp/` root.
- State file is gitignored — recreate from the pairing flow if missing.

## Device debug-log channel (live logs off a physical device)

A paired device streams its logs to the server so you can watch a real phone from
the dev machine — the only window into native-only failures (e.g. the WebView
YouTube player, which has no reachable console).

**Flow:** `logger.ts` forwards every log/warn/error to a sink; `src/debugLog.ts`
buffers them and POSTs NDJSON to `POST /api/v1/debug/logs` (bearer auth) — flush
every ~1s, immediate on `error`, `keepalive: true` so a batch survives page
navigation. The server appends to `tmp/device-logs/<device>.ndjson`.

**Watch it:** `just device-logs` (tails `tmp/device-logs/*.ndjson`).

**Wiring:**
- `src/logger.ts` — `setLogSink()` (kept as a setter to avoid an import cycle).
- `src/debugLog.ts` — the shipper. NEVER call the app logger from here (it loops
  back through the sink); use `console` directly for its own diagnostics.
- `app/_layout.tsx` `DebugLogBridge` — supplies the connection target from
  `useConnection()` and pipes uncaught JS errors (ErrorUtils / window error events).
- `src/store/debugLogStore.ts` — toggle shared by the bridge + Settings switch
  ("Debug Log Streaming", **default ON** — this is a debug build; persisted via
  `storage.ts`). Turn it off to silence a device.
- `src/YtPlayer.tsx` (native) — the WebView also posts `window.onerror` /
  unhandledrejection + richer iframe error detail, and the RN side logs
  `onError`/`onHttpError`/`onRenderProcessGone`. All of it flows to the channel.

**Standard YT IFrame error codes are 2/5/100/101/150/153** — anything else points
*outside* the API (YouTube's own overlay, or the native WebView/net layer).

The `/api/v1/debug/logs` beacon is fire-and-forget: `e2e/smoke.js` ignores its
`requestfailed` events (a full-page nav legitimately aborts a send) so a debug
side-channel can never gate the frontend.

## UX RN Platform specifics

### Soft keyboard won't rise on autoFocus inside an animated Modal (native)
A `TextInput` with bare `autoFocus` inside `<Modal animationType="slide">` focuses on
native (cursor blinks) but the OS **does not raise the soft keyboard** — a second tap is
needed. The `autoFocus` fires while the Modal window is still animating in, before it's
the active input window, so `showSoftInput` never runs. Web has no native Modal/IME
handshake, so `autoFocus` alone works there (the overlay just shifts above the browser
keyboard). Known RN issue: react-native-modal #516, react-native-screens #89 / #472.

**Fix:** don't rely on `autoFocus` for native. Focus via a `ref` from the Modal's
`onShow` (fires after the entrance animation), deferred with a `setTimeout` so focus lands
only once the Modal window is the active input window. (An earlier version used
`InteractionManager.runAfterInteractions`; that reportedly did NOT raise the IME on some
devices — it can fire before the window is IME-ready — so a fixed timeout is more
deterministic. The `check-modal-focus` lint accepts either.) Keep `autoFocus` for web.

```tsx
const inputRef = useRef<TextInput>(null)
function handleShow() {
  if (Platform.OS === 'web') return
  inputRef.current?.focus()
  setTimeout(() => inputRef.current?.focus(), 250)
}
<Modal animationType="slide" onShow={handleShow} …>
  <TextInput ref={inputRef} autoFocus={Platform.OS === 'web'} … />
```

### The sheet hides behind the keyboard (native Modal)
`KeyboardAvoidingView` is a **no-op inside an Android `<Modal>`** — the Modal is a separate
window that doesn't resize for the IME, and `behavior={undefined}` (the common Android
default) does nothing regardless. A bottom sheet with a `TextInput` therefore stays put and
the keyboard covers it. **Fix:** track the keyboard height with `Keyboard.addListener`
(`keyboardDidShow`/`Hide` on Android, `keyboardWillShow`/`Hide` on iOS) and lift the sheet
by it (`marginBottom: kbHeight`) — do NOT use `KeyboardAvoidingView`. See `AnnotationPanel.tsx`.

Both are **native-only** — headless web e2e can't exercise the soft keyboard, and there is no
emulator/adb in this repo's build env, so these can only be verified on a physical device
after `just build-android`. Do not claim them working from web tests.

## "Web vs mobile" = touch vs non-touch, not Platform.OS

`Platform.OS === 'web'` is true for ALL browsers — desktop Chrome and mobile Safari alike. Never use it to mean "desktop". To branch on touch capability use `window.matchMedia('(pointer: coarse').matches`. Mobile web and native app must behave identically; `Platform.OS === 'web'` silently breaks one of them.

## Document body images — ONE lightbox, two callers (`src/ImageViewer.tsx`)

`ImageLightbox` (named export) is the controlled full-screen zoomable overlay: visible
while mounted, gone when the caller stops rendering it. Do not write a second one.
- `ImageViewer` (default export) = thumb + `ImageLightbox`, used by `MarkdownBody`
  (highlight bodies, RN markdown).
- The **document body** is raw DOM inside the WebView/iframe, so its `<img>` has no RN
  component. `document-viewer.ts`'s click delegate posts `image_tap {src, alt}` and
  `document/[id].tsx` renders `ImageLightbox` from that. The `img` check runs **before**
  the `a[href]` check — a figure wrapped in a link must zoom, not navigate.
- Keep `src` as the raw `getAttribute('src')`: on web the body is an `iframe srcDoc`
  (base `about:srcdoc`), where `img.src` resolves to nonsense. `ImageLightbox`
  absolutizes a leading `/` against `activeUrl` — native RN `Image` cannot load a
  relative URL (it silently reports a 1×1).

## Page mode (document viewer)

A reading preference — **strictly additive**. Every rule is scoped to
`html.pg` and **no DOM node is added or moved**, so with it off the reader is unchanged
and body-text offsets (hence every annotation anchor) are identical in both modes.

### The preference is three-way: `flow` | `auto` | `page` (default `auto`)

`src/store/readingModeStore.ts` is the ONE source of truth (zustand + AsyncStorage via
`storage.ts`), **global, never per-document**. Both writers use it: the meta panel's
`Flow · Auto · Page` segmented control, and Settings → **Auto Page Mode** (whose switch
*is* `mode === 'auto'` — on writes `auto`, off writes `flow`; when the mode is `page` it
reads off and says so). Settings also owns the **threshold** (`pageThreshold`, default
**20**, digits-only, committed on blur, clamped 1–999 — junk restores the last good
value). `loadReadingPrefs()` migrates the old boolean key `samizdat_page_mode`
('1'→`page`, '0'→`flow`, absent→`auto`) once, then deletes it.

- `flow` — always continuous. `page` — always paginated. `auto` — paginate only past the
  threshold.
- **`auto` resolves inside the WebView**, because only it can measure. `estimatePages()`
  = `ceil(body.scrollHeight / innerHeight)` — a page IS one column of the body laid out at
  the same width and cut to the viewport, so the two are the same quantity (±1–2 pages of
  break-avoidance slack, irrelevant to a whole-page threshold). **Always measured the same
  way**: if the viewer is currently paginated, `html.pg` comes off for the read and goes
  straight back in the same task (no paint, `scrollLeft` restored). Using the real
  `_pageCount` while paginated and the estimate while not would let a document sitting on
  the threshold flip on every resize. Re-resolved on `init`, on `window.load` (images have
  no height before that), on each throttled `resize`, and on every host push.
- **Lives in the WebView** (`document-viewer.ts`) — only it knows real laid-out box
  heights. The host owns the preference, the `setReadingMode {mode, threshold}` message
  and the `readingMode`/`pageThreshold` fields on `init`; the viewer reports the
  resolution back as `readingMode {mode, paginated, pages}`, which is the only source for
  the meta panel's one-line summary (`~95 pages here, limit 20 → paginated`).
- **Mechanism:** the *body* becomes a horizontal multi-column scroller
  (`column-width:var(--pgw)` + `column-fill:auto` on a `100vh` box; `html{overflow:hidden}`
  so the body really is the scroll container). Geometry comes from JS (`layoutPages`)
  because `column-width` takes no percentages.
- **No `scroll-snap`** — column boxes are anonymous, so nothing can carry
  `scroll-snap-align`. Snapping is a 140ms scroll-idle settle instead, which also means
  touch needs no bespoke drag handler: the body's own pan IS the page turn.
- **Scroll containers never fragment**, so anything taller than a page spills past it.
  Cap each to the page box and let it scroll inside: `pre`, `img`, `table`, `details`,
  `.hl-card` (one highlight/summary card per page — content may be cut there, accepted).
  When nesting, cap the OUTER one only (`html.pg details>pre{max-height:none}`) or you
  get two scrollbars.
- **Resize** is throttled 150ms, but capture the anchor when the scroll SETTLES, not in
  the handler — `resize` fires after the browser has already reflowed, so reading it
  there loses the reader's place.
- Reading progress: one `reportFraction` for both modes — scroll position when scrolling,
  `pageIdx/(pageCount-1)` when paginated. `revealElement` (page jump vs `scrollIntoView`)
  is the single way to bring anything into view.
- **Not verifiable headless:** a real finger swipe on Android rides the WebView's native
  horizontal overflow scroll, which no synthetic event exercises. Test on a device.

## PDF figures in the viewer

A figure is framed like a blockquote (border + inset background + padding) so a crop
reads as one object. The text the scraper lifts out of a figure box (server-side
`interiorBlock`) arrives as a raw `<details><summary>…</summary><pre>` block, rows
separated by `<br>` — it renders collapsed, subordinate to the picture, and stays
searchable. `table`/`th`/`td` are styled too (there was **no** table CSS at all: under
the `*{margin:0;padding:0}` reset a GFM table rendered borderless).
Test gotcha: `innerText` reads **empty** inside a collapsed `<details>` (no layout) —
assert on `textContent`, or the check fails on working code.

## Video / podcast Documents (`media_type === 'video'`)

Documents with `media_type === 'video'` get a dedicated player screen (`src/VideoDocument.tsx`) instead of the article WebView. The document viewer (`app/(drawer)/document/[id].tsx`) early-returns `<VideoDocument doc={doc} from={from} />` before building article HTML.

### VideoDocument layout
The screen is a flex column with **nothing scrolling the whole page** — the player and
tab bar are pinned so you never scroll the video away to get back to it:
- Header with back button
- **Pinned player** (top): thumbnail (tappable → expands inline YouTube player) OR video box.
  Sized to a compact 16:9 box bounded to ≤32% of the viewport height (`playerH`/`playerW`
  computed in the component) so the transcript stays maximized on phone and desktop.
- "Audio only" button below the video box → collapses to audio, keeps playing
- **Pinned tab bar** (Transcript · Details · Excerpt · Notes)
- **Tab content** (`flex:1`) fills the space between the tab bar and footer and scrolls
  **internally**. The transcript pane (WebView / iframe) stays mounted (hidden on other tabs)
  so it keeps auto-following playback.
- **Floating resume button** — a top-right down-arrow shown only while the transcript is up
  and the currently-playing segment has drifted off-screen. Tap → scrolls to the active line
  and resumes auto-follow. Driven by the webview's `activeSegVisible` message; the tap posts
  `scrollToActive` back (see the transcript-rendering notes below).
- Seeker bar: play/pause, time, scrub track, speed lever, add-note, offline-sync (native only)
- AnnotationPanel sheet for creating/editing time-anchored notes

### Keyboard shortcuts (desktop web)
`handleHotkey` in `VideoDocument` maps keys to the same actions as the buttons:
- **←/→** seek ±1s, **↑/↓** seek ±10s (up = forward)
- **[** / **]** slow down / speed up by 0.1× (VLC-style), **=** reset to 1×
- **n** / **a** add a note (same as the footer note button)

Two entry points, both web-only: a `window` keydown listener (focus in the app shell)
and the transcript iframe forwarding the raw key as a `hotkey` message (focus in the
transcript, whose document otherwise swallows the keydown). They're mutually exclusive
— a key event never crosses the frame boundary — so no double-fire. Keys are ignored
while a text field is focused. The iframe forwards only for transcript docs, so article
arrow-scroll is untouched.

### ONE shared timeline — `useMediaTimeline` (video = alternate view, not a separate player)
The bottom seeker + transcript are driven by **one** playback timeline that reads from
whichever backend is active. The video is just an alternate VIEW of that same timeline —
**not** a second, mutually-exclusive player. `src/useMediaTimeline.ts` merges two backends
behind the existing `AudioControl` shape so the seeker/transcript/rate code is written once
and never branches on which is playing:

```ts
const { playing, positionMs, durationMs, rate, play, pause, seek, setRate,
        videoActive, ytRef, onYtStatus } = useMediaTimeline({ audioUrl, ytId, showVideo })
```

- **audio backend** — the platform-split `useAudio` hook (below). Audio-only mode + offline files.
- **youtube backend** — the platform-split `YtPlayer` component (below), driven imperatively via
  `ytRef` and reporting progress via `onYtStatus`. Active when `videoActive`.
- `videoActive = showVideo && !!ytId` selects the backend the timeline exposes.
- **Rate is owned by the timeline** and fanned out to BOTH backends, so speed stays synced across
  a switch. The speed lever/± buttons just call `setRate`.
- **Handoff (no double audio):** entering the video pauses the `<audio>` element (YouTube provides
  the sound); collapsing to audio-only seeks the audio element to the video's position and resumes
  if it was playing. The two never sound at once.

### Audio backend — `useAudio` hook (platform-split)
Audio is abstracted behind a single hook with a **platform-split implementation**:
- `src/useAudio.ts` — **native** backend using `expo-audio` (`useAudioPlayer` + `useAudioPlayerStatus`)
- `src/useAudio.web.ts` — **web** backend using a plain HTML5 `<audio>` element

Metro resolves `.web.ts` for web builds automatically. **Never import `expo-audio` directly in components** — always go through `useAudio` (or `useMediaTimeline`, which wraps it). The web file is knip-ignored because Metro handles the resolution.

```ts
const { playing, positionMs, durationMs, rate, play, pause, seek, setRate } = useAudio(url)
```

`url` can be a local file URI (offline-synced) or a remote streaming URL. If both exist, prefer the local URI.

### YouTube backend — `YtPlayer` component (platform-split)
A plain `?src=` iframe is opaque (no `currentTime`, no control), so the video could not share the
timeline. `YtPlayer` drives the **YouTube IFrame Player API** instead — same imperative contract
(`YtPlayerHandle`: `play`/`pause`/`seek`/`setRate`) + progress (`YtStatus`) on both platforms:
- `src/YtPlayer.web.tsx` — **web**: injects `youtube.com/iframe_api`, `new YT.Player` into a host
  div, `onStateChange` + a 250ms `getCurrentTime` poll → `onStatus`. (knip-ignored; Metro resolves it.)
- `src/YtPlayer.tsx` — **native**: a WebView hosting the same IFrame API; commands in via
  `injectJavaScript(window.__cmd)`, status out via `ReactNativeWebView.postMessage`.
- `src/YtPlayer.types.ts` — the shared `YtPlayerHandle` / `YtStatus` / `YtPlayerProps` contract.

Because `positionMs` now advances from the YouTube player while the video plays, the transcript
auto-scroll (`mediaTime` message) keeps following with **no** change to the transcript plumbing.

### Offline audio sync (native only)
`expo-file-system` (`legacy` import) downloads the audio asset to `FileSystem.documentDirectory`. The local URI is persisted in AsyncStorage under key `video_audio_<docId>` and restored on mount. The sync button is hidden on web (no `expo-file-system` on web).

### Transcript rendering
`buildTranscriptHtml()` in `src/markdownToHtml.ts` renders `TranscriptSegment[]` as one
**`.seg` span per sentence** carrying `data-start-ms`/`data-end-ms`, grouped into `.para`
paragraph blocks on the server's `new_para` flag. **A block per segment is wrong** — the
server sends sentences, but before that it sent YouTube's ~35-char display wraps, and one
`<p>` each meant thousands of mid-sentence stubs (see `server/CLAUDE.md` → video Documents
for why the segment is a sentence). The hover timestamp chip hangs off the **paragraph**:
an absolutely-positioned `::after` on an inline span lands per line-box, i.e. mid-sentence.

Everything below keys off `.seg[data-start-ms]` and is indifferent to the tag, so the
follow/seek/annotation machinery needed no change. The document-viewer WebView bundle handles:
- `mediaTime` message → highlights the active `.seg` and auto-scrolls (suppressed for 2.5s after user scroll)
- `activeSegVisible` message (outbound) → reports whether the `.seg.active` is on-screen; the host shows/hides the floating resume button
- `scrollToActive` message → scrolls the active `.seg` to center and resets the user-scroll timer so auto-follow resumes
- `hotkey` message (outbound) → forwards a keyboard shortcut key (arrows / `[` `]` `=` / `n` `a`) to the host when the transcript frame has focus (see keyboard shortcuts above)
- `seek` message (outbound) → tapping a `.seg` seeks audio to that timestamp
- `requestSegmentWindow` / `segmentWindow` messages → builds a text-anchor around the active segment for time-stamped annotations

### Time-anchored annotations
`Annotation` now has a `media_ts_ms` field. When creating an annotation on a video document, `positionMs` is captured at the time the user taps "add note" and sent as `media_ts_ms`. Tapping an existing annotation seeks audio to its timestamp.

### Transcript helpers + language selector
`Document.transcript` is a **lang-keyed map** `{lang: [segments]}` (legacy rows may be a bare array). `src/api.ts` helpers, always used — never `JSON.parse` inline:
- `parseTranscripts(doc)` → `Record<lang, TranscriptSegment[]>` (accepts both map and legacy array).
- `transcriptLangs(doc)` → languages present, in the server's **primary-first** order (`media_metadata.transcript_langs`).
- `parseTranscript(doc, lang?)` → one track: requested `lang`, else the primary (`transcriptLangs[0]`).
- `parseMediaMetadata(doc)` → `{provider, external_id, duration_ms, transcript_status, orig_lang, transcript_langs, description}`. `orig_lang` = the true original (marks the `·orig` pill); `transcript_langs[0]` = the default/primary track.

`VideoDocument` shows a **language pill selector** (codes; `·orig` marks `orig_lang`) above the transcript when >1 track exists; default = the primary track (original for a preserved language, English for a translated one). Ingest policy: one `preserved_langs` list in Settings → Transcript Languages (`AppSettings.language_prefs`) — languages kept original, everything else → English. `src/langNames.ts` (`displayLang`/`parseLangInput`) maps names↔codes for that editor.

### YouTube video ID
`meta.external_id` from `parseMediaMetadata` is the YouTube video ID, fed to `YtPlayer` (see
"YouTube backend" above). The video and the bottom audio bar share ONE timeline — opening the
video is just a view switch, not a separate player; the handoff in `useMediaTimeline` guarantees
only one of the two sounds at a time (audio pauses while the video plays, and vice-versa).

### `proxyStatus.ts` — yt-dlp proxy health
`src/proxyStatus.ts` exposes `fetchYtdlpProxyStatus` and `YtdlpProxyStatus`. Kept separate from `api.ts` to avoid merge conflicts. Polled every 20s via `useProxyStatus()` (below) so the card flips back to green on its own when the proxy host returns.

### `exportStats.ts` — auto-export vault status
`src/exportStats.ts` exposes `fetchExportStats` and `ExportStats`, hitting `GET /api/v1/export/stats` (which also triggers a server-side re-export). Kept separate from `api.ts` like `proxyStatus.ts`. The Settings "Export Vault" card shows doc/annotation counts, last-export time, dir, and any error; its Refresh button re-fetches (forcing a fresh mirror). The card renders only when the endpoint returns (i.e. when export is configured).

### `useServices.ts` — the Services group and the drawer's degraded dot
Settings leads with one **Version** card — installed app build, the APK download and the
**server's** version together (they answer one question: what am I running) — then is
grouped **Connection → Services → Preferences → Device**. The Services
group holds the four things that can be *broken*: YouTube Proxy, Export Vault, Browser
Extension, **LLM Services**. All three server-side checks go through ONE React Query
cache (`useProxyStatus` / `useExportStats` / `useLLMStatus` in `src/useServices.ts`) —
never a screen-local `useState` + `setInterval`, because the drawer reads the same data:
`useServiceAlert()` (proxy configured-but-down · export errored · a non-retired LLM
provider whose last call failed) paints the red dot on the hamburger + the drawer's
Settings row, the same affordance as "update available" (a broken service outranks it).

**Three long cards are accordions** (`src/Accordion.tsx`): Server Connection (the
server-URL list lives INSIDE it — the list is the answer to "why am I connected there"),
Connected Devices, LLM Services — collapsed on every render, open state screen-local. A collapsed
card shows a one-line summary INSTEAD of its body, so collapsing never hides the fact
worth a glance (connected host · device count · which LLM endpoint jobs go to). The LLM
list is sorted **troubled-first** — a `primary`/`fallback` provider whose last call failed
leads the list AND is what the summary says; otherwise the primary leads. The header's
action button (Test / Refresh / Probe) renders only while open, so it is never tapped
blind. e2e reads must open the card first (`settingsText(page, { open: ['llm-services'] })`).

`src/llmStatus.ts` hits `GET /api/v1/llm/status` and owns the two label helpers:
`llmErrorLabel` (kind → "Out of credits / rate limited", "Bad or missing API key",
"Unreachable") and `llmProviderLabel` (the Router's own `label`, falling back to the host
for a retired row). Nothing probes on a render — a row's status is the last real call's
outcome (see `server/CLAUDE.md` → LLM provider health), so a provider with lifetime spend
but no recorded outcome reads "No status yet — last call …", not "No calls yet".

**The card's Probe button is the one active check.** It calls
`probeLLMProviders(url, token)` (shallow — a screen never spends tokens) and adds a
`Probed: …` line per row: reachable, bad key, out of credits, or the model count. The
results are screen state on purpose, so a re-navigation clears them (an e2e check that
re-navigates to read the text will therefore see nothing — read in place).

**Spend is never shown on an `available` row.** `llm_usages` records the provider NAME
only, so every `openai_compat` row matches the same usage total — a discovered box nothing
ever routed to would claim another endpoint's calls and its "last call" time. The lookup is
therefore skipped for `role === 'available'`; such a row reads "No calls yet".

**The drawer dot follows the ROUTING CHAIN.** `useServiceAlert` flags only a
`primary`/`fallback` provider whose last call failed. `retired` is history, and
`available` (discovered from an env key — nothing routes through it) is an offer, not a
dependency; neither can break a pipeline, so neither raises the dot.

Covered by `just e2e-int` (`runSettingsServices`): group order, a staged quota failure
rendering as *out of credits*, a retired provider keeping its history without alarming,
and the drawer dot appearing only for a **configured** provider's failure.

## Android share-sheet URL ingest (`ShareIntentBridge`)

Sharing a webpage/YouTube link to Samizdat (Android `ACTION_SEND` `text/*`) opens the
Documents screen with the "Add URL" box **prefilled** — the user confirms (taps Add)
and watches it land in the scrape queue. Prefill (not auto-submit) is deliberate: it
gives a confirm step and works before the connection probe finishes. `expo-share-intent`
config plugin (in `app.json` plugins) registers the intent-filter at `expo prebuild` —
the native tree is gitignored + regenerated every `just build-android`, so never
hand-edit `AndroidManifest.xml`.

- `src/ShareIntentBridge.tsx` — native: `useShareIntent()` → extract URL (`webUrl` or
  first http(s) in `text`) → `useShareStore.getState().setPendingUrl(url)` → `router.push('/documents')`.
- `src/store/shareStore.ts` — one-shot Zustand channel (`pendingUrl` + `consume()`).
  **Do NOT** pass the URL as an expo-router param: `router.setParams` in the consuming
  effect re-render-loops the screen to a white crash. A store carries it cleanly, leaves
  no stale param in the URL, and re-fires on a fresh share.
- `app/(drawer)/documents.tsx` — reads `pendingUrl`, `consume()`s it (clears the store),
  fills + focuses the Add-URL field.
- `src/ShareIntentBridge.web.tsx` — `return null` (Metro resolves `.web` so the web/e2e
  build never imports the native module; knip-ignored).
- Mounted in `app/_layout.tsx` inside `ScrapeQueueProvider`.

## Store selectors: never map to fresh objects inside a `useShallow` selector
A zustand selector wrapped in `useShallow` that returns `arr.map(x => ({...x, extra}))`
mints new element references every call, so shallow-equality never holds → the hook
returns a "changed" value on every render → **infinite render loop / white crash
(React #185)** the moment there's any data (empty arrays compare equal, so it passes
smoke tests and only breaks with real rows). `useDocuments` is safe because it only
`.filter().sort()`s raw store refs. For derived shapes (counts, joined tags), select
the **raw store slices** (`s => s.tags`, `s => s.annotationTags`, … — stable refs) and
build the derived array in a `useMemo`. See `useAnnotations`/`useTagsWithCounts` in
`src/db/hooks.ts`.

Native-only — the share flow can't be exercised headless; test on a device after build.

## DB layer is the only storage

All app state lives in ONE local SQLite database, behind `app/src/db/`. Screens, the sync
engine and the pusher import `src/db` and nothing else — no driver, no query, no memory
index. The layer replaced a zustand-persist replica that serialized the WHOLE library into
a single AsyncStorage value on every `set()`; past Android's 6MB whole-DB cap every write
threw, silently, and the replica froze for six days.

### The three rules — enforced by `just lint` (`tooling/check-db-layer.mjs`)
1. Only `app/src/db/**` may import a SQLite engine (`expo-sqlite` / `wa-sqlite` / `node:sqlite`).
2. Only `app/src/db/queries.ts` may contain SQL text — DDL included, so the schema has one
   place to change. (`BEGIN`/`COMMIT`/`PRAGMA` are exempt: they are per-engine transaction
   and connection control and belong to the driver that wraps them.)
3. Only `app/src/db/**` and `app/src/storage.ts` may import AsyncStorage. **`storage.ts`
   keeps the connection record ALONE** — it must survive a corrupt or unopenable database,
   because it is the only way back to the server. Every other preference is a row in the
   `settings` table, reached through `src/prefs.ts`.

### One engine per runtime (`driver.ts` is the contract, `driverImpl*.ts` the backends)
| target | driver | why |
|---|---|---|
| native | `expo-sqlite` | first-party, system SQLite, no cap |
| web | `@journeyapps/wa-sqlite` | real SQL with **no COOP/COEP** |
| node (tests) | `node:sqlite` | built in, zero dep, drives `e2e/db-unit.mjs` |

Metro resolves `driverImpl.web.ts` on its own; nothing outside the folder names a backend.
**Do NOT use expo-sqlite's web target**: it needs SharedArrayBuffer, hence cross-origin
isolation, and COEP is recursive — it would break the YouTube embed in `YtPlayer.web.tsx`.
Every wa-sqlite VFS works without those headers, which is the whole reason for two drivers.
The `.wasm` is served from `app/public/wasm/` by `just sync-wasm` (Metro does not bundle
`.wasm`, and asking it to would buy nothing — the file is fetched by URL either way).

### Reactivity contract
- SQLite is the truth. `src/db/memoryIndex.ts` is a **body-less** read cache (a plain
  zustand store, deliberately NOT persisted — persisting it would recreate the exact bug
  this layer replaced). `open()` warms it with one SELECT per table.
- **SQLite first, then the index.** A failed write leaves the index untouched, so the UI
  can never show a change that did not persist.
- **Writes are serialized** (`repo.ts`'s queue). One connection means two overlapping
  transactions are not two transactions — the second `BEGIN` lands inside the first and
  the engine rejects it. Merges and queue reads happen INSIDE the write, so a delta can
  never be computed against a snapshot that a concurrent mutation has already moved past.
- **On web, READS are serialized too, and a tx body must use the handle `tx()` hands it.**
  wa-sqlite is one connection on one thread with ONE Asyncify unwind buffer: two `step()`
  chains in flight together corrupt each other's saved stack — `memory access out of
  bounds` / `Aborted(RuntimeError: unreachable)`, replica dead until reload. The driver
  therefore queues every public call, and reentrancy is expressed as an OBJECT (the
  in-transaction handle passed to the body), never as an `inTransaction` flag: a flag
  cannot tell an inner call from an unrelated one, so it exempted every concurrent read
  (`listOutbox` on the pusher's interval vs `setSetting` on the connection probe's) and
  ran it straight into an open transaction. Covered by `just e2e-db`
  (`e2e/db-web-race.mjs` — real wa-sqlite in Chromium, no server).
- Bodies (`markdown`, `transcript`) never enter the index — `useDocuments()` returns
  `DocumentMeta`. Read a body with `useDocument(id)` / `db.getDocument(id)`, never from a list.
- Hooks feed screens; a screen that needs a *stable* callback (`loadFromStore` feeding a
  network `load`) must read the hook value through a ref, or every local write re-triggers
  a fetch.
- `db.open()` also retires the pre-SQLite era once (`src/db/legacy.ts`): it deletes the
  `samizdat_sync_store*` blob **and all its chunk keys**, and carries the loose preference /
  offline-audio keys into `settings` / `media_files`.

Tests: `just e2e-db` (the layer on `node:sqlite`, no server, no browser) · `just e2e-offline`
(the offline walkthrough now asserts a **real** reload-from-SQLite restart) · `just e2e-int`
(`runDbLayer`, `runLargeReplica`).
