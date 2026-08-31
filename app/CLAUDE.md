# CLAUDE.md — app/

Expo (React Native + RN Web) reader/curator. Offline-first.
Cross-cutting decisions + the bugs behind them: `../docs/decisions.md`.

## Stack

pnpm · React Native · TypeScript. Always run/build through `just`.

- **Styling:** `react-native-unistyles` v3 — `useUnistyles()` + `useMemo` (see below). Theme tokens in `src/theme.ts`; edit there, not inline.
- **Navigation:** Expo Router (file-based, `app/`).
- **Server state:** React Query. **UI state:** Zustand. **Storage:** SQLite behind `src/db/`.
- **Anchored edits:** CodeMirror 6 in a WebView. Casual notes: plain `TextInput`.
- No Redux, no MobX, no class components.

### Unistyles pattern

v3 injects CSS classes on web, not inline styles. Build styles from the theme in a memo:

```ts
const { theme } = useUnistyles()
const s = useMemo(() => buildStyles(theme), [theme])
// buildStyles(t) returns StyleSheet.create({ container: { backgroundColor: t.colors.background } })
```

- `DrawerContent` is the exception: **plain inline styles only** — `useUnistyles` + a stylesheet crashes it on web.
- Native theme re-render needs `react-native-unistyles/plugin` in `babel.config` — without it `setTheme` only re-renders on web.

## Offline-first

All reads come from the local SQLite replica. Sync runs in the background. Never block UI on network. Server is authoritative; broken replica → wipe + re-pull.

**Sync:** pull by cursor. Machine data (`Document`, `Highlight`) is server→phone one-way, never pushed back. User-authored rows (`Annotation`, read-state, `Tag`) are two-way LWW.

## NEVER call a mutating `api.ts` fn from a screen

Every user mutation (tag / star / archive / annotate / read-progress / delete) goes through `import * as db from '../src/db'`. A mutation (1) writes the row to SQLite and patches the memory index, so the UI reacts with **no network**, and (2) enqueues an ordered `outbox` intent that `pushEngine.drainOutbox` replays against the SAME `api.ts` endpoints when connected. That is what makes tagging/starring work offline.

- `src/store/outbox.ts` — PURE reducers + dirty-tracking + dirty-aware pull-merge. No zustand, network or clock here. Unit-tested by `e2e/outbox-unit.mjs`.
- `src/db/repo.ts` — the mutations (row + intent + dirty key in ONE transaction, then the index) and a **dirty-aware `applySync`**: a locally-dirty row is not clobbered by an older server pull until its intent is pushed. `base_rev` per dirty row is the note-conflict seam.
- `src/store/pushEngine.ts` — FIFO drain (a create lands before edits referencing it). Transient failure (offline/5xx/401) stops the drain + backoff; a 4xx is dropped so it cannot wedge the queue.
- `src/store/useOutboxPush.ts` — mounted in `_layout`'s `SyncEffects`; drains on new intent, reconnect, foreground, interval. The outbox is a table → survives restart in order.
- **Creates are client-minted UUIDs** (`src/store/uuid.ts` — crypto when present, else `Math.random`; the `uuid` package's v4 crashes on bare Hermes). Server create endpoints honor an optional `id` idempotently, so a replayed offline create cannot duplicate. Never enqueue machine content (doc markdown, highlight body).
- **Mutations are async** — real I/O. `createTag`/`createAnnotation` return the new row; `await` if you need the id.

## A failed local write must be LOUD (`src/store/persistHealth.ts`)

The blob-replica era failed in total silence — see `../docs/decisions.md`. SQLite removed the cause, but a write can still fail (full disk, corrupt file), so the visibility stays. **Do not re-introduce a silent write path.**

- `repo.ts`'s write gate reports **once per write**: `null` = landed, the error = didn't. A failed write leaves the memory index untouched, so the UI cannot show a change that was not saved; the mutation swallows the error after reporting (re-throwing restores the unhandled rejection). `applySync` is the exception — it rethrows, because the sync engine owns the retry and must not advance its cursor.
- `isStorageFullError(e)` picks the wording only (`SQLiteFull` / `disk is full` / `QuotaExceeded`); any write error raises the alert.
- `persistHealth.ts` — non-persisted zustand store (persisting "writes are broken" through the broken writer would be absurd). Logs once per outage at `error` level → `logger.ts` → `debugLog.ts` → `tmp/device-logs/<device>.ndjson`, flushed immediately. A later success clears it.
- A replica that cannot even OPEN reports here too and marks the index hydrated anyway — otherwise every screen sits on a skeleton with nothing saying why.
- `useServiceAlert()` ORs it in: same red dot as a broken server service. Settings shows a **Device Storage** card only while broken.
- `src/offlineSim.ts` hosts the web-only e2e simulators: `samizdat_force_offline` (every fetch rejects — except the SQLite `.wasm`, which is runtime) and `samizdat_force_storage_full`.

Covered by `just e2e-int` (`runPersistFailure`). `runPersistFailure` and `runDbLayer` must stay **before** `runSettingsServices`, which permanently seeds a broken LLM provider and would keep the drawer dot lit for every later check.

## DB layer is the only storage (`src/db/`)

Screens, the sync engine and the pusher import `src/db` and nothing else — no driver, no query, no memory index.

### Three rules, enforced by `just lint` (`tooling/check-db-layer.mjs`)
1. Only `src/db/**` may import a SQLite engine (`expo-sqlite` / `wa-sqlite` / `node:sqlite`).
2. Only `src/db/queries.ts` may contain SQL text — DDL included, so the schema has one place to change. (`BEGIN`/`COMMIT`/`PRAGMA` are exempt: per-engine transaction control.)
3. Only `src/db/**` and `src/storage.ts` may import AsyncStorage. **`storage.ts` keeps the connection record ALONE** — it must survive an unopenable database, because it is the only way back to the server. Every other preference is a `settings` row reached through `src/prefs.ts`.

### One engine per runtime (`driver.ts` is the contract)
| target | driver | why |
|---|---|---|
| native | `expo-sqlite` | first-party, system SQLite, no cap |
| web | `@journeyapps/wa-sqlite` | real SQL with **no COOP/COEP** |
| node (tests) | `node:sqlite` | built in, drives `e2e/db-unit.mjs` |

Metro resolves `driverImpl.web.ts`; nothing outside the folder names a backend. **Do NOT use expo-sqlite's web target** — it needs SharedArrayBuffer → cross-origin isolation, and COEP is recursive: it would break the YouTube embed in `YtPlayer.web.tsx`. The `.wasm` is served from `app/public/wasm/` by `just sync-wasm`.

### Reactivity contract
- SQLite is the truth. `src/db/memoryIndex.ts` is a **body-less** read cache (plain zustand, deliberately NOT persisted — persisting it recreates the bug this layer replaced). `open()` warms it with one SELECT per table.
- **SQLite first, then the index.** A failed write leaves the index untouched.
- **Writes are serialized** (`repo.ts`'s queue). One connection means two overlapping transactions are not two transactions — the second `BEGIN` lands inside the first and is rejected. Merges and queue reads happen INSIDE the write, so a delta is never computed against a snapshot a concurrent mutation moved past.
- **On web, READS are serialized too, and a tx body must use the handle `tx()` hands it.** wa-sqlite is one connection, one thread, ONE Asyncify unwind buffer: two `step()` chains in flight corrupt each other's saved stack (`memory access out of bounds`, replica dead until reload). Reentrancy is expressed as an OBJECT, never an `inTransaction` flag — a flag cannot tell an inner call from an unrelated one, so it exempted every concurrent read and ran it into an open transaction. Covered by `just e2e-db` (`e2e/db-web-race.mjs`, real wa-sqlite in Chromium).
- Bodies (`markdown`, `transcript`) never enter the index — `useDocuments()` returns `DocumentMeta`. Read a body with `useDocument(id)` / `db.getDocument(id)`, never from a list.
- A screen needing a *stable* callback must read the hook value through a ref, or every local write re-triggers a fetch.
- `db.open()` retires the pre-SQLite era once (`src/db/legacy.ts`): deletes the `samizdat_sync_store*` blob **and all its chunk keys**, carries loose preference / offline-audio keys into `settings` / `media_files`.

Tests: `just e2e-db` · `just e2e-offline` · `just e2e-int` (`runDbLayer`, `runLargeReplica`).

### Store selectors: never map to fresh objects inside `useShallow`

`arr.map(x => ({...x, extra}))` mints new refs every call → shallow equality never holds → **infinite render loop / white crash (React #185)**. Empty arrays compare equal, so it passes smoke tests and only dies with real rows. Select the **raw store slices** (stable refs) and derive in a `useMemo`. See `useAnnotations`/`useTagsWithCounts` in `src/db/hooks.ts`.

## Connection state — NEVER bypass `ConnectionProvider`

`src/ConnectionContext.tsx` is the single owner: probes on mount and every 30s, picks the fastest reachable URL.

**Every screen reads `useConnection()`.** Never import `loadConnection` / `saveConnection` / `findReachable` in a screen — `findReachable` with no `lastSuccessfulUrl` hint tries ALL stored URLs sequentially with no timeout (localhost, docker bridges, Tailscale), so a remote client stalls indefinitely.

```ts
const { activeUrl, token, status } = useConnection()
useEffect(() => {
  if (status === 'connected') load()
  else if (status === 'disconnected') { setError('Not connected'); setLoading(false) }
}, [status, load])
```

Writing connection data (e.g. after pairing): call `reload()` from `useConnection()` — it re-reads storage and re-probes. Do not `saveConnection` and forget.

**Re-pairing the browser after session loss:** `just sam connect`, then open a printed `…/connect?code=…` link. It reads `?code=`, uses the page origin as the server URL, auto-pairs. The `?c=<base64>` param is the paste/QR flow.

## UI conventions

- PascalCase filename, one component per file. Look for an existing component before making a new one.
- **Always use styled icons** — never raw emoji/glyphs as tappable controls. `<IconButton name="…">` (`src/IconButton.tsx`, Ionicons + non-touch hover) for delete (`trash-outline`), tags (`pricetags-outline`), any new icon button. `<NoteEditButton>` (`create-outline`) wherever a note/annotate action appears. `✏` is display only (annotation badges, note previews), never a control.
- Any control that fires an API call: show loading, disable the button, toast + mark the button on error. Make it a component, reuse it.

## "Web vs mobile" = touch vs non-touch, not `Platform.OS`

`Platform.OS === 'web'` is true for desktop Chrome AND mobile Safari. Never use it to mean "desktop" — branch on `window.matchMedia('(pointer: coarse)').matches` (`isTouchDevice()`). Mobile web and native must behave identically.

## Native-only platform traps (not testable headless — verify on a device)

- **`autoFocus` inside an animated `<Modal>` does not raise the soft keyboard.** It fires while the Modal window is still animating in, before it is the active input window, so `showSoftInput` never runs. Fix: focus via a `ref` from `onShow`, then again in a `setTimeout(…, 250)`. (`InteractionManager.runAfterInteractions` can fire before the window is IME-ready.) Keep `autoFocus` for web. Enforced by `just lint`'s `check-modal-focus`.
- **`KeyboardAvoidingView` is a no-op inside an Android `<Modal>`** — the Modal is a separate window that doesn't resize for the IME. Track the height with `Keyboard.addListener` (`keyboardDidShow/Hide` on Android, `keyboardWillShow/Hide` on iOS) and lift by `marginBottom`. See `AnnotationPanel.tsx`.
- **Native `Image` cannot load a relative URL** — it silently reports 1×1 while web renders fine. Absolutize against `activeUrl`.
- **Android share-sheet ingest** and **page-mode swipe** ride native behavior no synthetic event exercises.

## Highlight card lives in TWO renderers — keep them in parity

- `src/HighlightCard.tsx` — React Native (the feed; native + RN-Web).
- `src/webview/document-viewer.ts` → `renderHighlightCard()` — raw DOM inside the WebView (the document body). No React: `createElement` + event delegation → `postMessage`.

They must show the **same actions (pin · tags · annotate · delete), same icons, same layout**. A change to either MUST be mirrored.

**Why no shared component:** native RN has no DOM; the WebView has no RN renderer. `dangerouslySetInnerHTML` is web-only, kills React's event wiring, and per-row HTML in a FlatList is a perf anti-pattern. **Share the spec, not the pixels.**

- **Icons:** same Ionicons glyph both sides — RN via `IconButton`, the WebView inlines that glyph's SVG path. Form differs; glyph/size/meaning must match.
- **Actions:** the WebView posts `hl_pin` / `hl_delete` / `hl_tags` / `hl_annotate`; `app/(drawer)/document/[id].tsx` maps them to the same callbacks the feed wires directly.
- **Annotated cards are marked whole** both sides: dotted 2px accent border + accent pencil (`cardNoted`/`hasNote` in RN; `.hl-card.hl-noted` / `.hl-icon-btn.hl-noted-btn` in the WebView). **Pinned applies after noted and is SOLID accent** — the two must stay tellable apart. The flag is `db.useAnnotatedHighlightIds()` (a Set read once per screen — a per-row hook in a FlatList is the anti-pattern), fed as `HlData.hasNote`. The host pushes a fresh `setHighlights` when that Set changes: `setAnnotations` only moves marks, and the border lives in the highlight payload.
- **The WebView card has NO swipe gesture.** Removed: both actions are unconditional footer buttons, and the drag only bought accidental deletes plus a swallowed horizontal pan (and a `touch-action` fight with page mode). The RN feed's `ReanimatedSwipeable` triage is a different thing and stays. Do not reintroduce a drag here.

**Enforced:** `just lint` runs `spec parity` — if one file changed vs main and the other didn't, it flags it. See `tooling/CLAUDE.md`.

## The feed's date is the SORT KEY (`src/DateStamp.tsx`)

The feed is ordered by **`highlights.created_at DESC`** (ingest) on both paths (`queries.sql` `ListHighlights`; replica `db/hooks.ts` `selectHighlights`). The card used to print `document_published_at`, so the list was ordered by one date and labelled with another and read as unsorted. **Whatever the list sorts by is what the card must show.**

`DateStamp` shows the ingest date and keeps the publication date one reveal away: `title` tooltip on a fine pointer, long-press → toast on a coarse one (`isTouchDevice()`, never `Platform.OS`). RNW drops an unknown `title` prop, so it is written onto the host node from a ref.

Replica schema is versioned: `SCHEMA_SQL` is the v1 baseline and is **never edited**; a new column is an appended entry in `MIGRATIONS` (e.g. `MIGRATE_2_DOC_PUBLISHED_AT`), or a fresh install runs `CREATE`-then-duplicate-`ALTER`.

## Error state comes from the JOB, not the Document (`src/failedJobs.ts`)

`documents.error_reason` is only set by the server's false-parse gate — one failure out of many. A 404 scrape, a dead LLM, a failed video fetch never touch the Document row (a hard scrape failure produces no Document at all). The reason lives in the dead **Job** (`last_error`), surfaced only by `GET /api/v1/jobs?status=dead`.

`useFailedJobs()` polls it once (React Query dedupes across screens); pure helpers derive the UI:
- `documentErrorText(doc, failed)` — the one line for a Document. Its own `error_reason` wins; else the dead job naming it or scraping its URL. Used by the Documents badge, the article banner and `VideoDocument` — **keep all three on this one function**.
- `orphanScrapeFailures(failed, documents)` — dead scrapes that produced no Document. They get a pinned row on Documents (Retry / dismiss). Failures stay in `jobs`; do NOT invent stub Documents.

Covered by `just e2e` (`runErrorStateUiCheck` + `seedDeadJob`).

## Pipeline step editor (`app/(drawer)/pipelines.tsx`)

A step is `{kind, config}` free-form JSON; `GET /api/v1/pipeline-steps` describes each kind's keys. The editor renders the union of *catalog fields* and *config keys*, so an undescribed key stays visible and editable. Save serializes through `putPipelineSteps` (steps go as a JSON **string** — that is the column).

- **The filter summary mirrors Go exactly.** `PipelineFilter` in `src/api.ts` = the four keys of `pipeline.PipelineFilter`; anything else prints verbatim as `key: value`. The old code checked `feed_id`/`tag`/`domain`/`url_pattern` — none of which exist — so every pipeline read "all documents".
- **`max_tokens` is not a credential**, even though `SECRET_KEY` matches "token" — `NOT_SECRET_KEY` carves it back out. The server strips the same name on read; the two exemptions must stay in step.
- **A credential must never enter the DOM.** No step kind declares one, the server strips every credential-named key, and the screen ALSO drops anything matching `SECRET_KEY` — including in the raw-JSON view, which is rebuilt from the parsed steps rather than echoing the stored string.

### `model` is a picker, not a text box (`src/ModelPicker.tsx`)

A model name belongs to exactly ONE provider: a Claude id sent to an Ollama box is a 404 → 4xx → no fallback → the pipeline dies hard. The catalog gives `model` `type: "model"` and the editor renders a searchable modal: results grouped under provider headers, search matching model ids AND provider names, plus an explicit *Provider default* row (clearing the model hands the choice back to the endpoint's `default_model`).

- Selecting writes **both** `model` and `provider` in one `setModelChoice`. Two `setFieldValue` calls would each start from the pre-update drafts and the second would drop the first — producing exactly the mismatch this feature prevents.
- `src/llmModels.ts` — `fetchLLMModels` + `probeLLMProviders`. Sibling of `llmStatus.ts`: that one reads passive health, these ACTIVELY ask.
- Follows the native Modal focus rule above.

Covered by `just e2e-int` (`runPipelineStepsUi`, with a stub OpenAI-compatible box — real rows, no network, no spend).

## Selection context menu + AI popout

A selection in the document viewer raises **Annotate** + **···** (copy · web search · translate · AI question). Config is **server-held** (`ctxmenu.Prefs` → `/api/v1/settings` `context_menu`), so a template authored on the desktop is what the phone offers. `src/contextMenu.ts` caches the last good copy in the replica, so the sheet opens offline (copy and search work; the LLM kinds report that they cannot).

- **The anchor fields are frozen.** `SelectionData.prefix/suffix` (64 chars) and `pos_start/pos_end` ARE the TextQuoteSelector — every stored annotation re-anchors off them. `{{selection_wider_context}}` rides on ADDITIVE `wide_prefix`/`wide_suffix` (600 chars). Never widen the anchor fields to feed a prompt.
- **The menu is RN, not DOM.** Its actions need the clipboard shim, the network and a model config — none of which exist inside the WebView. `document-viewer.ts` only posts `selection_menu` with the same payload as `selection`; the host renders `SelectionMenuSheet`. A sheet (not a popover) is the same affordance on both platforms with no iframe→RN coordinate math. The row (`#sel-actions`) is what gets positioned, never the two buttons separately.
- `src/SelectionActions.tsx` owns the interaction; `src/AiPopout.tsx` is the single popout for both LLM kinds. Nothing persists unless **Save** is pressed: that hands the answer to `AnnotationPanel` (`initialNote`) with the ORIGINAL selection, so it lands through the normal `db.createAnnotation` path.
- `renderTemplate` expands `{{selection}}` / `{{selection_wider_context}}` / `{{article_title}}` / `{{article_summary}}` in **one pass**, mirroring the server's `pipeline/prompt.go`. Web-search URLs use `renderUrlTemplate` (percent-encoded).
- **Translate has two engines.** `browser` uses Chrome's built-in `Translator` when present (web only), else falls back to the LLM — absence is normal, not an error. `src/translate.ts` is the only place that feature-detects.
- Settings → **Context Menu** (`src/ContextMenuEditor.tsx`) edits the master prompt + items. Text fields commit on **blur**; a model choice writes `model` AND `provider` in one update.
- Covered by `just e2e-int` (`runSelectionContextMenu`, `runContextMenuSettings`). The first must run **after** `runSettingsServices`: it makes a real completion through the stub box, which lands in the provider-health registry where in-memory rows beat seeded ones.

## Document body images — ONE lightbox, two callers (`src/ImageViewer.tsx`)

`ImageLightbox` (named export) is the controlled full-screen zoomable overlay. Do not write a second one.
- `ImageViewer` (default) = thumb + `ImageLightbox`, used by `MarkdownBody`.
- The **document body** is raw DOM in the WebView, so its `<img>` has no RN component: `document-viewer.ts`'s click delegate posts `image_tap {src, alt}` and `document/[id].tsx` renders `ImageLightbox`. The `img` check runs **before** the `a[href]` check — a figure wrapped in a link must zoom, not navigate.
- Keep `src` as the raw `getAttribute('src')`: on web the body is an `iframe srcDoc` (base `about:srcdoc`) where `img.src` resolves to nonsense. `ImageLightbox` absolutizes a leading `/` against `activeUrl`.

## Page mode (document viewer)

A reading preference, **strictly additive**: every rule is scoped to `html.pg` and **no DOM node is added or moved**, so with it off the reader is unchanged and body-text offsets (hence every annotation anchor) are identical in both modes.

**Three-way preference `flow | auto | page` (default `auto`).** `src/store/readingModeStore.ts` is the ONE source of truth (zustand + AsyncStorage), **global, never per-document**. Two writers: the meta panel's segmented control and Settings → Auto Page Mode (the switch *is* `mode === 'auto'`). Settings also owns `pageThreshold` (default **20**, digits-only, committed on blur, clamped 1–999). `loadReadingPrefs()` migrates the old boolean `samizdat_page_mode` once, then deletes it.

- **`auto` resolves inside the WebView**, because only it can measure. `estimatePages()` = `ceil(body.scrollHeight / innerHeight)` — a page IS one column of the body at the same width cut to the viewport. **Always measured the same way**: if currently paginated, `html.pg` comes off for the read and goes straight back in the same task (no paint, `scrollLeft` restored). Using the real `_pageCount` while paginated and the estimate while not would flip a threshold-straddling document on every resize. Re-resolved on `init`, `window.load` (images have no height before that), each throttled `resize`, and every host push.
- The host owns the preference and sends `setReadingMode {mode, threshold}`; the viewer reports back `readingMode {mode, paginated, pages}`, the only source for the meta panel's summary line.
- **Mechanism:** the *body* becomes a horizontal multi-column scroller (`column-width:var(--pgw)` + `column-fill:auto` on a `100vh` box; `html{overflow:hidden}` so the body really is the scroll container). Geometry comes from JS (`layoutPages`) — `column-width` takes no percentages.
- **No `scroll-snap`** — column boxes are anonymous, so nothing can carry `scroll-snap-align`. Snapping is a 140ms scroll-idle settle, which also means touch needs no drag handler: the body's own pan IS the page turn.
- **Scroll containers never fragment**, so anything taller than a page spills. Cap each to the page box and let it scroll inside: `pre`, `img`, `table`, `details`, `.hl-card`. When nesting, cap the OUTER one only (`html.pg details>pre{max-height:none}`) or you get two scrollbars.
- **Resize** is throttled 150ms, but capture the anchor when the scroll SETTLES, not in the handler — `resize` fires after the browser reflowed, so reading it there loses the reader's place.
- One `reportFraction` for both modes (scroll position, or `pageIdx/(pageCount-1)`). `revealElement` is the single way to bring anything into view.

## PDF figures in the viewer

A figure is framed like a blockquote (border + inset background + padding) so a crop reads as one object. The text the scraper lifted out of a figure box arrives as a raw `<details><summary>…</summary><pre>` block, rows separated by `<br>` — collapsed, subordinate to the picture, still searchable. `table`/`th`/`td` are styled too (under the `*{margin:0;padding:0}` reset a GFM table rendered borderless).

**Test gotcha:** `innerText` reads **empty** inside a collapsed `<details>` (no layout) — assert on `textContent` or the check fails on working code.

## Video / podcast Documents (`media_type === 'video'`)

`document/[id].tsx` early-returns `<VideoDocument>` before building article HTML.

### Layout — nothing scrolls the whole page
Header · **pinned player** (thumbnail → inline YouTube player, 16:9 bounded to ≤32% viewport height) · "Audio only" button · **pinned tab bar** (Transcript · Details · Excerpt · Notes) · tab content (`flex:1`, scrolls internally; the transcript pane stays mounted so it keeps auto-following) · find bar · **floating resume button** (top-right, only while the playing segment has drifted off-screen; driven by `activeSegVisible`, taps post `scrollToActive`) · seeker bar (play/pause, time, scrub, speed lever, add-note, offline-sync) · `AnnotationPanel` sheet.

### Keyboard shortcuts (desktop web)
`handleHotkey`: **←/→** ±1s · **↑/↓** ±10s · **[** / **]** ∓0.1× · **=** reset to 1× · **n**/**a** add note.
Two entry points, both web-only: a `window` keydown listener, and the transcript iframe forwarding the raw key as a `hotkey` message (its document otherwise swallows the keydown). Mutually exclusive — a key event never crosses the frame boundary, so no double-fire. Ignored while a text field is focused; the iframe only forwards for transcript docs.

### ONE shared timeline — `useMediaTimeline`
The video is an alternate VIEW of one timeline, **not** a second player. Two backends behind the existing `AudioControl` shape, so the seeker/transcript/rate code never branches on which is playing:

```ts
const { playing, positionMs, durationMs, rate, play, pause, seek, setRate,
        videoActive, ytRef, onYtStatus } = useMediaTimeline({ audioUrl, ytId, showVideo })
```

- **audio** — `useAudio` (platform-split). Audio-only mode + offline files.
- **youtube** — `YtPlayer` (platform-split), driven via `ytRef`, reporting via `onYtStatus`. Active when `videoActive = showVideo && !!ytId`.
- **Rate is owned by the timeline** and fanned out to both, so speed survives a switch.
- **Handoff (no double audio):** entering the video pauses the audio element; collapsing seeks audio to the video position and resumes if it was playing. The two never sound at once.
- **Lock-screen handoff:** the WebView is suspended when the phone locks, so a playing video hands off to `expo-audio` (which holds the OS media session) and restores the video view on unlock. Full state machine: `../docs/media-playback-lockscreen.md`.

### Platform-split backends
- `src/useAudio.ts` (native, `expo-audio`) / `src/useAudio.web.ts` (HTML5 `<audio>`). **Never import `expo-audio` in a component** — go through `useAudio` or `useMediaTimeline`. Metro resolves `.web.ts`; the web file is knip-ignored.
- `src/YtPlayer.web.tsx` (injects `youtube.com/iframe_api`, `new YT.Player`, `onStateChange` + 250ms poll) / `src/YtPlayer.tsx` (native WebView hosting the same IFrame API; commands via `injectJavaScript`, status via `postMessage`) / `src/YtPlayer.types.ts` (the shared contract). A plain `?src=` iframe is opaque — no `currentTime`, no control — so it could not share the timeline.
- **Offline audio sync (native only):** `expo-file-system` (`legacy`) downloads to `documentDirectory`; the URI is persisted under `video_audio_<docId>` and restored on mount. Hidden on web.

### Transcript rendering
`buildTranscriptHtml()` renders `TranscriptSegment[]` as one **`.seg` span per sentence** (`data-start-ms`/`data-end-ms`), grouped into `.para` blocks on the server's `new_para` flag. **A block per segment is wrong** — see `server/CLAUDE.md` → video Documents. The hover timestamp chip hangs off the **paragraph**: an absolute `::after` on an inline span lands per line-box, i.e. mid-sentence.

Everything keys off `.seg[data-start-ms]` and is indifferent to the tag. WebView messages:
`mediaTime` (in) → highlight active `.seg` + auto-scroll (suppressed 2.5s after user scroll, entirely while a selection is up) · `activeSegVisible` (out) · `scrollToActive` (in) · `hotkey` (out) · `selection_start` / `play_from` (out) · `findTranscript` (in) / `findResult` (out) · `requestSegmentWindow` / `segmentWindow`.

### Transcript interaction contract
Reading a transcript means touching it constantly, so touch must be cheap and playback must never move under the finger.

- **A tap NEVER seeks.** The `.seg` click handler posts only `tap_annotation`. Seeking lives on the selection row's **▶** (`#sel-play-btn`) → `play_from {ms}` → host `userSeek` + `play`. Shown via `#sel-actions.has-time`, i.e. only when the range sits in a `.seg` — an article selection never offers it.
- **A live selection pauses playback and freezes auto-follow.** `handleSelection` posts `selection_start` once per selection (transcript only); there is no auto-resume. It ALSO bumps `_lastUserScroll`, and `setActiveSeg` skips its `scrollIntoView` while `_pendingSel` is set. Without both, the next `mediaTime` tick scrolls the playing line back to center mid-selection — the "it jumps to the top" bug. `wheel`/`touchmove` do not cover it: neither a mouse drag nor Android's handle drag emits them.
- **A jump leaves a way back.** `jumpFromMs` (the amber scrub flag) also renders a **Back to m:ss** pill. It routes through `userSeek`, so using it re-drops the flag where we were — the pill toggles between the two spots.
- **Find is per SEGMENT and rewrites no DOM.** `findTranscript {q, step}` toggles `.find-hit`/`.find-current` on whole `.seg`s and replies `findResult {count, index}`. A fresh query lands on the first hit at or after the playing line. Wrapping matches in new nodes is the obvious implementation and the wrong one: the seg IS the unit the reader navigates, and a class toggle cannot move an annotation's char offset.

Covered by `just e2e-int` (`runTranscriptPlayback`) — asserting on the messages the iframe actually posts, since a dropped handler is a silent no-op.

### Transcript helpers + languages
`Document.transcript` is a lang-keyed map (legacy rows may be a bare array). Always use the `src/api.ts` helpers, never inline `JSON.parse`:
`parseTranscripts(doc)` · `transcriptLangs(doc)` (server's primary-first order) · `parseTranscript(doc, lang?)` · `parseMediaMetadata(doc)`.

`VideoDocument` shows a language pill selector (`·orig` marks `orig_lang`) when >1 track exists; default = the primary. Ingest policy is one `preserved_langs` list in Settings → Transcript Languages; everything else → English. `src/langNames.ts` maps names↔codes.

**Time-anchored annotations:** `media_ts_ms` is captured when the user taps "add note"; tapping an existing annotation seeks to its timestamp.

## Settings: Services group + the drawer's degraded dot (`src/useServices.ts`)

Settings leads with one **Version** card (installed build + APK download + server version — they answer one question), then **Connection → Services → Preferences → Device**. Services holds the four things that can be *broken*: YouTube Proxies, Export Vault, Browser Extension, LLM Services.

All server-side checks go through ONE React Query cache (`useProxyStatus` / `useExportStats` / `useLLMStatus`) — never a screen-local `useState` + `setInterval`, because the drawer reads the same data. `useServiceAlert()` (proxy configured-but-down · export errored · a non-retired LLM provider whose last call failed · a broken local write) paints the red dot on the hamburger and the drawer's Settings row.

**The long cards are accordions** (`src/Accordion.tsx`): Server Connection (the URL list lives INSIDE it — the list answers "why am I connected there"), Connected Devices, YouTube Proxies, Context Menu, LLM Services. Collapsed on every render, open state screen-local. A collapsed card shows a one-line summary INSTEAD of its body, so collapsing never hides the fact worth a glance. The header's action button (Test / Refresh / Probe) renders only while open, so it is never tapped blind. **e2e reads must open the card first** (`openSettingsCard(page, 'youtube-proxies')`, `settingsText(page, { open: ['llm-services'] })`).

- `src/proxyStatus.ts` — `[ytdlp].proxies` is a LIST, so the response carries `proxies[]`, each with its own dot, exit IP and error. The flat top-level fields describe the **active** entry and predate the pool; they stay because installed APKs parse that shape, and `fetchYtdlpProxyStatus` synthesizes a one-entry list from them against a pre-pool server. The headline number is **distinct exit IPs**, not entry count — duplicates are tagged `SHARED IP`, or the card reads "7 proxies" for five addresses. `ytdlp` on the same response is the BINARY's version: a stale one 403s on every egress IP, so it renders as its own warning above the node list while the dots stay green.
- `src/exportStats.ts` — `GET /api/v1/export/stats` (which also triggers a server-side re-export). The card renders only when the endpoint returns.
- `src/llmStatus.ts` — `GET /api/v1/llm/status` plus the label helpers `llmErrorLabel` and `llmProviderLabel`. Nothing probes on a render, so a provider with lifetime spend but no recorded outcome reads "No status yet — last call …", not "No calls yet". The list is sorted **troubled-first**. **The Check button is the one active check.** It is deep: a real 1-token completion per provider, which is the ONLY thing that can clear a status dot — health is the outcome of the last real call and no render path may move it. Spending a token on a *tap* is what makes that honest, so the handler must stay tap-only and must `refetch()` the status query afterwards or the dot keeps the colour the check just disproved. Its per-row `Checked: …` results are screen state on purpose, so a re-navigation clears them (an e2e check that re-navigates will see nothing — read in place).
- **Spend is never shown on an `available` row.** `llm_usages` records the provider NAME only, so every `openai_compat` row matches the same total — a discovered box nothing routed to would claim another endpoint's calls. Such a row reads "No calls yet".
- **The drawer dot follows the ROUTING CHAIN.** Only `primary`/`fallback` failures count: `retired` is history, `available` is an offer. Neither can break a pipeline.

Covered by `just e2e-int` (`runSettingsServices`).

## Android share-sheet URL ingest (`ShareIntentBridge`)

Sharing a link to Samizdat (`ACTION_SEND` `text/*`) opens Documents with "Add URL" **prefilled** — the user taps Add. Prefill, not auto-submit: it gives a confirm step and works before the connection probe finishes. The `expo-share-intent` config plugin registers the intent-filter at `expo prebuild`; the native tree is gitignored and regenerated every build, so **never hand-edit `AndroidManifest.xml`**.

- `src/ShareIntentBridge.tsx` — `useShareIntent()` → extract URL → `useShareStore.getState().setPendingUrl(url)` → `router.push('/documents')`.
- `src/store/shareStore.ts` — one-shot Zustand channel (`pendingUrl` + `consume()`). **Do NOT pass the URL as an expo-router param**: `router.setParams` in the consuming effect re-render-loops the screen to a white crash.
- `app/(drawer)/documents.tsx` reads `pendingUrl`, `consume()`s it, fills + focuses the field.
- `src/ShareIntentBridge.web.tsx` returns null (Metro resolves `.web`, so web/e2e never imports the native module; knip-ignored).

## Device debug-log channel (live logs off a physical device)

The only window into native-only failures (e.g. the WebView YouTube player, which has no reachable console).

`logger.ts` forwards every log/warn/error to a sink; `src/debugLog.ts` buffers and POSTs NDJSON to `POST /api/v1/debug/logs` — flush ~1s, immediate on `error`, `keepalive: true` so a batch survives navigation. The server appends to `tmp/device-logs/<device>.ndjson`. Watch with `just device-logs`.

- `src/logger.ts` — `setLogSink()` (a setter, to avoid an import cycle).
- `src/debugLog.ts` — the shipper. **NEVER call the app logger from here** (it loops back through the sink); use `console` for its own diagnostics.
- `app/_layout.tsx` `DebugLogBridge` — supplies the target from `useConnection()` and pipes uncaught JS errors.
- `src/store/debugLogStore.ts` — toggle shared by the bridge + the Settings switch (**default ON** — this is a debug build).
- `src/YtPlayer.tsx` (native) — the WebView also posts `window.onerror`/unhandledrejection + iframe error detail; the RN side logs `onError`/`onHttpError`/`onRenderProcessGone`.

**Standard YT IFrame error codes are 2/5/100/101/150/153** — anything else points *outside* the API (YouTube's overlay, or the native WebView/net layer).

The beacon is fire-and-forget: `e2e/smoke.js` ignores its `requestfailed` events, so a debug side-channel can never gate the frontend.

## Debugging with agent-browser

**Never pair a fresh device** — it spams the dev DB. Use `just robot-browser` (or `just test-device`), which mints/reuses the single `robot-automated-ui-tester` device via the idempotent admin endpoint and preloads its token.

`just debug-session` opens with the persisted state at `tmp/debug-session/state.json` (gitignored: cookies + localStorage, so the app starts connected). After any pairing action in a test, `just save-debug-session`. Screenshots go to `tmp/screenshots/`.

**Always kill agent-browser + Chrome when done** (`just kill`) — they do not self-terminate and cost 50–200 MB each.
