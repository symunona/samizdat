---
created: 2026-08-13
topic: Selection context menu + AI popout
excerpt: A customizable "…" menu next to the Annotate button (copy · web search · translate · AI question), its editor in Settings, and a new AI popout module that composes a templated prompt, runs it through the LLM Router, and can save the answer as an Annotation.
status: planned — not started
---

# Selection context menu + AI popout

## What exists today

- A text selection in the document WebView surfaces ONE button: `#ann-btn`
  ("Annotate"), positioned next to the selection (`positionAnnButton`,
  `app/src/webview/document-viewer.ts`). Clicking it posts
  `{type:'selection', data: SelectionData}`; the host opens `AnnotationPanel`.
- `SelectionData` = `{exact, prefix, suffix, pos_start, pos_end, media_ts_ms?}`,
  where prefix/suffix are **64 chars** (`getContext(start, len, 64)`) — the W3C
  TextQuoteSelector anchor. **These fields are the anchor; nothing here may change
  their values** or every stored annotation re-anchors.
- The LLM Router (`server/internal/llm`) owns every endpoint, but there is **no
  ad-hoc completion endpoint** — only pipeline steps call it. Routes today:
  `GET /api/v1/llm/status|models`, `POST /api/v1/llm/probe`.
- Server settings are `server_settings` rows served by `GET/PUT /api/v1/settings`
  (`settingsHandler`), with `langpref` as the precedent for a structured
  JSON-in-one-row preference.
- `ModelPicker` (provider+model, written together) already exists for pipeline steps.

## Decisions (asked, answered)

1. **Config lives on the server** — a `context_menu` blob in `server_settings`,
   served/patched by `/api/v1/settings`, so templates authored on desktop appear on
   the phone. The app caches the last-good copy in the replica so the menu still
   opens offline.
2. **An AI answer is ephemeral, saved on demand, as an Annotation** — the popout's
   Save hands the answer to `AnnotationPanel` prefilled (note body = answer,
   anchor = the ORIGINAL selection), so saving goes through the normal local-first
   `db.createAnnotation` path and exports/syncs like any other note.

## Scope

### 1. Server — context-menu preference (`server/internal/ctxmenu/`)

New package modelled on `langpref` (Parse / Defaults / SettingKey), so the shape has
one owner and a junk row degrades to defaults instead of 500ing.

```go
type Prefs struct {
    MasterPrompt string `json:"master_prompt"`
    Items        []Item `json:"items"`
}
type Item struct {
    ID       string  `json:"id"`                 // client-minted uuid
    Kind     string  `json:"kind"`               // copy | web_search | translate | ask
    Title    string  `json:"title"`
    Enabled  bool    `json:"enabled"`
    Template string  `json:"template,omitempty"` // ask: prompt; web_search: URL template
    Lang     string  `json:"lang,omitempty"`     // translate: target language code
    Engine   string  `json:"engine,omitempty"`   // translate: llm | browser
    Model    string  `json:"model,omitempty"`    // ask/translate(llm)
    Provider string  `json:"provider,omitempty"` // written together with Model
}
```

- `Defaults()` = copy (on) + web search (on) + translate (off) + one example ask
  item, so a fresh install has a menu without an editor visit.
- `settingsPayload` gains `context_menu`; `put` merges it like `language_prefs`
  (absent = untouched — the app sends partial patches).
- **No credential ever enters this blob** — routing is `provider` + `model`, same
  rule as pipeline steps.

### 2. Server — ad-hoc completion (`POST /api/v1/llm/ask`, `api/llm_ask.go`)

The one path from a UI to the Router. Bearer-authed.

```
POST /api/v1/llm/ask
{ "prompt": "...", "system": "...", "provider": "", "model": "", "max_tokens": 0, "temperature": null }
→ { "reply": "...", "model": "...", "provider": "...", "tokens_in": 0, "tokens_out": 0 }
```

- `router.CompleteRoute(ctx, llm.Route{Provider, Params}, msgs)` — a named provider
  is **pinned** (no fallback), empty = the configured chain. Same semantics as a step.
- Writes the `llm_usages` ledger row (`JobID: nil, PipelineRunID: nil` — both are
  `*string`), so an ad-hoc ask is metered exactly like a pipeline call and shows up
  in the Settings spend summary.
- Caps: prompt length ceiling (reject > ~40k runes with 413) and a request timeout;
  an unbounded paste must not become an unbounded bill.
- `ErrNoProvider` → 503 with a plain reason; a 4xx from the provider → 502 + message
  (never a stack trace).
- Unit test: routes to a stub provider, records exactly one usage row, honors the pin.

### 3. WebView — the "…" button next to Annotate

`document-viewer.ts` + `markdownToHtml.ts`:

- Wrap the existing button in `#sel-actions` holding `#ann-btn` + a new
  `#sel-more-btn` ("…"). `positionAnnButton` → `positionSelActions` positions the
  **container** (same flip-above / clamp logic, now measuring the row).
- `#sel-more-btn` posts `{type:'selection_menu', data: SelectionData}`.
- `SelectionData` gains **`wide_prefix` / `wide_suffix`** (~600 chars, from the same
  `getContext` with a bigger radius) used ONLY for `{{selection_wider_context}}`.
  The 64-char `prefix`/`suffix` stay byte-identical — they are the anchor.
- The menu itself is **RN, not DOM**: it needs the clipboard shim, the network, model
  config and a modal. The WebView reports; the host renders a bottom sheet (same
  affordance on native and web — no iframe→RN coordinate math).
- **Card parity:** this touches the *selection* affordance, not the highlight card's
  action set, so `HighlightCard.tsx` needs no mirror. `just lint`'s `spec parity`
  check will still flag the one-sided change — answer it explicitly rather than
  silently editing the other file.

### 4. App — menu config module (`src/contextMenu.ts`)

- Types mirroring the Go `Prefs`/`Item`, `DEFAULT_ITEMS`, and
  `renderTemplate(tmpl, vars)` — **single pass**, mirroring
  `server/internal/pipeline/prompt.go` (selection text containing `{{…}}` is never
  re-expanded).
- Tokens: `{{selection}}`, `{{selection_wider_context}}` (wide prefix + exact +
  wide suffix), `{{article_title}}`, `{{article_summary}}` (the doc's `summary`
  Highlight if present, else the head of `documents.markdown`, clamped).
- `loadContextMenu()` — server settings when connected, else the replica cache
  (`db.getSetting('context_menu_cache')`); every successful fetch rewrites the cache.
- `webSearchUrl(item, vars)` — the `template` is a URL with the same tokens,
  default `https://www.google.com/search?q={{selection}}`, opened via `openExternal`.

### 5. App — the sheet (`src/SelectionMenuSheet.tsx`)

One modal listing the **enabled** items with icons (Ionicons, per the icon rule):
copy → `copy-outline`, web search → `search-outline`, translate → `language-outline`,
ask → `sparkles-outline`. Each row shows a loading/disabled state while its action
runs and toasts on failure (the shared interaction rule). Copy and web search resolve
in place; translate and ask open the AI popout.

### 6. App — new module `src/AiPopout.tsx`

A single popout, sibling of `AnnotationPanel` (same sheet chrome, same keyboard-lift
and native focus rules).

- Props: `visible`, `title`, `system` (master prompt), `prompt` (already rendered),
  `route {provider, model}`, `selection`, `onSave`, `onClose`.
- States: **loading** (spinner + the composed title), **answer** (markdown via
  `MarkdownBody`), **error** (message + Retry).
- Actions: Copy · Retry · **Save** → closes the popout and opens `AnnotationPanel` in
  `create` mode with `note` prefilled to the answer and the ORIGINAL selection as the
  anchor, so saving is the existing local-first `db.createAnnotation` path (offline
  safe, syncs, exports, renders a `<mark>`).
- Calls `askLLM(activeUrl, token, …)` in a new `src/llmAsk.ts` (sibling of
  `llmModels.ts` / `llmStatus.ts`), aborting on close.
- **Translate** reuses the same popout: engine `llm` composes a fixed translate
  prompt; engine `browser` uses the Chrome built-in `Translator` API when
  `'Translator' in self` (web only), and falls back to the LLM engine with a toast
  when absent. Wrapped in `src/translate.ts` so the popout never feature-detects.

### 7. App — Settings → **Context Menu** accordion (Preferences group)

`Accordion` (collapsed by default, one-line summary = "N actions" + master-prompt
presence), inside the existing **Preferences** section:

- **Master prompt** — multiline input, committed on blur.
- **Copy to clipboard** / **Web search** — switches (web search also exposes its URL
  template behind an expand).
- **Translate** — switch + target-language input (`langNames.ts`
  `parseLangInput`/`displayLang`) + engine choice (LLM via `ModelPicker` | Chrome
  built-in).
- **AI questions** — a list; each row = Title, template editor (~4 lines + expand,
  like the pipeline prompt field), `ModelPicker` (writes `model`+`provider` in ONE
  update — never two `set…` calls), delete. "Add question" appends a blank item.
- Saves via `updateSettings(url, token, { context_menu })`, debounced, with the
  standard loading/error affordance.

### 8. Docs

`app/CLAUDE.md` — the popout module, the sheet, where the config lives, the
anchor-fields-are-frozen rule. `server/CLAUDE.md` — `/api/v1/llm/ask` + the
`ctxmenu` preference. Run `diff_review` before merge.

## Test plan (write these BEFORE the feature is called done)

`just e2e-int` — two new checks in `e2e/integration.js`, seeded through the API and
driven through the real UI (a POST proving a row exists is not proof):

1. **`runSelectionContextMenu`** — seed `context_menu` via `PUT /api/v1/settings`
   with an `ask` item pinned to the harness `startStubLLM` box. Open the text doc,
   compose the HARD selection (crossing the inline `<a>`, reusing
   `runSelectionLifecycle`'s range trick), assert:
   - `#sel-more-btn` is visible next to `#ann-btn` and positioned in-viewport;
   - clicking it opens the sheet with exactly the enabled items;
   - the ask item opens the popout, shows a loading state, then renders
     `stub reply`;
   - Save → `AnnotationPanel` prefilled with the answer → Save → a `<mark>` renders
     over the ORIGINAL selection and survives a reload (anchor unchanged);
   - copy-to-clipboard writes the exact selection (read back via
     `navigator.clipboard.readText` with clipboard permission granted);
   - `GET /api/v1/settings` `llm_usage.total_calls` incremented by exactly 1.
2. **`runContextMenuSettings`** — open Settings, expand the accordion, add an AI
   question, type a title + template, pick a model, reload the page, assert it
   persisted and that the sheet on the document now offers it. Must run **before**
   `runSettingsServices` (that one seeds a broken LLM provider permanently).

Plus: `just e2e` stays green (Settings is already in `PAGES`), `just e2e-db` and
`just e2e-offline` unaffected but re-run, `just lint` (incl. the parity prompt) and
`just build` before calling it done. Server changed → `just dev` restart; end the
session with `just restart`.

## Risks / notes

- **Anchor drift** is the one way this feature can corrupt data: the wide-context
  fields must be additive and `prefix`/`suffix`/`pos_*` must stay byte-identical.
  The reload assertion in check 1 is what proves it.
- **Spend**: every ask is real money unless pinned to the local box. The popout shows
  which model answered; the ledger row makes it visible in Settings.
- Chrome's built-in `Translator` is web-Chrome-only and gated on a model download —
  treat absence as normal and fall back, never as an error.
- Native-only paths (soft keyboard in the popout, WebView selection on Android) can
  only be confirmed on a device after `just build-android`; do not claim them from a
  headless web run.

## Commit plan

1. This plan on `main`.
2. Branch `feat/selection-context-menu`, small commits: server prefs → `/llm/ask` →
   webview button → contextMenu module → sheet → AiPopout → Settings editor → e2e →
   docs.
3. Ask the user to check, then squash-merge to `main`.
