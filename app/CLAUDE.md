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

**Enforced:** `just lint` runs `spec parity` — if one of the two files changed vs main and the other didn't (or they diverged), it flags it and asks Claude whether the change needs mirroring. See `tooling/CLAUDE.md`.

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

## "Web vs mobile" = touch vs non-touch, not Platform.OS

`Platform.OS === 'web'` is true for ALL browsers — desktop Chrome and mobile Safari alike. Never use it to mean "desktop". To branch on touch capability use `window.matchMedia('(pointer: coarse').matches`. Mobile web and native app must behave identically; `Platform.OS === 'web'` silently breaks one of them.

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
`buildTranscriptHtml()` in `src/markdownToHtml.ts` renders `TranscriptSegment[]` as `.seg` paragraphs with `data-start-ms` attributes. The document-viewer WebView bundle handles:
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
- `transcriptLangs(doc)` → languages present, **original first** (from `media_metadata.orig_lang`).
- `parseTranscript(doc, lang?)` → one track: requested `lang`, else original, else first.
- `parseMediaMetadata(doc)` → `{provider, external_id, duration_ms, transcript_status, orig_lang, transcript_langs, description}`.

`VideoDocument` shows a **language pill selector** above the transcript when >1 track exists; default = original (so a machine translation is never surfaced unasked). Ingest policy is set server-side in Settings → Transcript Languages (`AppSettings.language_prefs`).

### YouTube video ID
`meta.external_id` from `parseMediaMetadata` is the YouTube video ID, fed to `YtPlayer` (see
"YouTube backend" above). The video and the bottom audio bar share ONE timeline — opening the
video is just a view switch, not a separate player; the handoff in `useMediaTimeline` guarantees
only one of the two sounds at a time (audio pauses while the video plays, and vice-versa).

### `proxyStatus.ts` — yt-dlp proxy health
`src/proxyStatus.ts` exposes `fetchYtdlpProxyStatus` and `YtdlpProxyStatus`. Kept separate from `api.ts` to avoid merge conflicts. The Settings screen polls this every 20s when connected and displays online/offline status with exit IP and last-ok timestamp.

### `exportStats.ts` — auto-export vault status
`src/exportStats.ts` exposes `fetchExportStats` and `ExportStats`, hitting `GET /api/v1/export/stats` (which also triggers a server-side re-export). Kept separate from `api.ts` like `proxyStatus.ts`. The Settings "Export Vault" card shows doc/annotation counts, last-export time, dir, and any error; its Refresh button re-fetches (forcing a fresh mirror). The card renders only when the endpoint returns (i.e. when export is configured).

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

Native-only — the share flow can't be exercised headless; test on a device after build.
