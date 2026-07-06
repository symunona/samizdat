---
created: 2026-07-06
topic: YouTube transcript language preferences + in-app lang selector
excerpt: Stop auto-translating non-English videos. Detect original language, keep native per user prefs, translate to English only when asked. Store transcripts lang-keyed; add a Settings language section and a per-video transcript language selector.
status: DONE 2026-07-06 — implemented on feat/transcript-lang-prefs; server two-pass + lang-keyed map, Settings language section, video lang selector; unit + e2e + agent-browser interaction tests green. Found+fixed a null-slice crash (server now emits [] not null). Awaiting user review before squash-merge.
---

# Transcript Language Preferences

## Problem

`server/internal/worker/youtube.go:123` hardcodes `--sub-langs "en.*,en,en-orig"` with
`--write-auto-subs`. For a non-English video (e.g. Hungarian "Borizü hang"), YouTube's
`en` track is a **machine-translation** of the Hungarian ASR. So we stored the English
translation and threw away the original — the user never wanted that.

## Goal

1. Detect the video's **original** language and keep it by default.
2. Translate to English only per user preference (not blindly).
3. Store transcripts **lang-keyed** so multiple languages coexist.
4. Feed the **original** language to the Pipeline (highlight/LLM extraction).
5. Settings → **Language Preferences** section, seeded from the browser/device locale.
6. Per-video **transcript language selector** in the video screen.

## User-chosen decisions (from Q&A 2026-07-06)

- Policy lives under **Settings → Language Preferences**, default-seeded from browser API
  (`navigator.languages` on web, device locale on native).
- Behavior: **keep native** language when the video's original lang is in the user's list;
  otherwise **translate to English** by default; a list of languages to **always store →
  English**.
- Storage: **lang-keyed map**.
- Pipeline consumes the **original** language.
- Build the in-app **language selector** in this scope.

## Proposed settings schema

`server_settings` new key `language_prefs`, value = JSON:

```json
{
  "native_langs": ["hu", "en"],       // orig lang in here → keep native, no translation
  "translate_to_english": true,        // non-native orig → also fetch en (auto-translated)
  "always_store_langs": []             // always also fetch these tracks, regardless
}
```

**Semantics to confirm with user** (my interpretation of the sketch):
- `native_langs`: if `orig_lang ∈ native_langs` → download original track only.
- else if `translate_to_english` → download original **+** English (auto-translated).
- `always_store_langs`: union'd into the requested set every time (each as its own track).
- English is never dropped when it's the original.

App seeds `native_langs` from `navigator.languages` (deduped to base codes) on first load
if the setting is empty; user edits thereafter.

## Data model changes

### Transcript: array → lang-keyed map

Today: `Document.transcript = "[{start_ms,end_ms,text}, ...]"`.
New: `Document.transcript = "{\"hu\":[...],\"en\":[...]}"`.

**Backward compat:** parsers accept BOTH. A bare `[...]` = legacy single track; treat its
lang as `orig_lang` from metadata (or `"unknown"`).

### MediaMetadata gains

```go
OrigLang        string   `json:"orig_lang,omitempty"`        // e.g. "hu"
TranscriptLangs []string `json:"transcript_langs,omitempty"` // ["hu","en"]
// transcript_status stays; consider per-lang later, not v1.
```

## Server changes

**`server/internal/worker/youtube.go`**
1. **Two-pass:** first `yt-dlp -J --skip-download <url>` to read `language` + available
   `subtitles`/`automatic_captions` keys (cheap metadata probe, no media download).
2. Load `language_prefs` from `server_settings`; compute the requested sub-lang set from
   `orig_lang` + prefs (function `wantedSubLangs(origLang, prefs, available)`).
3. Real download pass with computed `--sub-langs` (keep audio/`--write-info-json`).
4. `loadTranscript` → `loadTranscripts` returning `map[string][]Segment` (per-lang manual>auto
   preference preserved). Set `OrigLang`, `TranscriptLangs`.
5. `Markdown` (pipeline input) built from the **original** lang segments.

**`server/internal/api/settings.go` + `store/queries.sql`**
- Extend GET/PUT `/api/v1/settings` to include `language_prefs` (read/patch the JSON blob).

**Vault rebuildability (design rule 1) — DECIDED:** persist per-lang `.vtt` files in the
media cache dir alongside the audio; `sam reindex` reconstructs the lang-keyed map from
them (no network on reindex). Naming: yt-dlp already writes `<base>.<lang>.vtt` — keep those
files instead of discarding after parse.

## App changes

**`app/src/api.ts`**
- `MediaMetadata` gains `orig_lang`, `transcript_langs`.
- `AppSettings` gains `language_prefs: LanguagePrefs`.
- `parseTranscript` → `parseTranscripts(doc): Record<string, TranscriptSegment[]>` handling
  legacy array; helper `transcriptLangs(doc)` and `origLang(doc)`.

**`app/src/VideoDocument.tsx`**
- Language selector (pill row / dropdown) above the Transcript tab content; state
  `selectedLang` defaults to `orig_lang`; `buildTranscriptHtml(map[selectedLang], …)`.
- Hide selector when only one lang present.

**`app/app/(drawer)/settings.tsx`**
- New "Language Preferences" section: chip editor for `native_langs`, toggle
  `translate_to_english`, chip editor for `always_store_langs`. Seed from
  `navigator.languages` on first empty load. Persist via `updateSettings`.

## CLI

- `sam yt` unchanged (uses server prefs). Optional later: `--lang` override flag.

## E2E self-test (write FIRST, per CLAUDE.md)

1. Set `language_prefs = {native_langs:["hu"], translate_to_english:true}` via API.
2. Ingest a known **Hungarian** YouTube video (short) through the worker.
3. Assert Document.transcript is a **map**, contains `hu` (original, not English), and
   `orig_lang == "hu"`; assert Markdown (pipeline input) is Hungarian text.
4. Set `native_langs=[]`; re-ingest a different HU video → assert map has BOTH `hu` and `en`.
5. **agent-browser** (`just robot-browser`): open the video doc, assert the language selector
   is visible, switch `hu`↔`en`, assert the visible transcript text actually changes.
6. Settings screen: assert Language Preferences section renders + a saved change persists.
7. Add the settings section + video lang selector to `e2e/smoke.js` PAGES coverage.

## Commit plan (branch `feat/transcript-lang-prefs`)

1. Write E2E test scaffolding + Hungarian fixture.
2. Server: settings schema (`language_prefs`) + API.
3. Server: youtube.go two-pass + lang-keyed transcripts + orig-lang markdown.
4. App: types + parseTranscripts + VideoDocument selector.
5. App: Settings language section + locale seeding.
6. Run `just build`, `just e2e`, `just e2e-int`, linter. Squash-merge to main after user check.

## Resolved

- Reindex: **persist per-lang VTTs in cache**, rebuild map from them.
- **Two-pass probe** (`yt-dlp -J`) confirmed acceptable.
- `always_store_langs`: proceeding with "union these lang tracks into the requested set on
  every ingest" (my sketch reading; flag to user if it feels wrong at review).
