---
created: 2026-06-28
topic: YouTube / podcast video Documents — audio download, transcript, time-anchored player
excerpt: Ingest a YouTube URL into a media Document (audio via yt-dlp + transcript), with a native audio player, on-demand YouTube iframe video, time-anchored autoscroll transcript, and timestamped annotations.
status: planning
---

# YouTube Video Documents

Unparks ARCHITECTURE §9: "podcast/YouTube transcripts (a transcript = a `Document` with
time-anchored `Highlight`s)". Reuses the existing `scrape_url` → `Document` → `Pipeline`
→ `Highlight` path; the Document just grows a `media_type` and a structured transcript.

## Confirmed decisions (user, 2026-06-28)

1. **Download scope**: audio-only (`yt-dlp bestaudio`, m4a) + thumbnail. Cheap on the 4GB box.
   No video file is ever stored server-side.
2. **No transcript**: try yt-dlp manual subs → auto-subs (VTT). If genuinely none, still create
   the Document with `transcript_status='none'` (no blocking, no whisper for now).
3. **Player = hybrid**:
   - Default playback is **native audio**. App has a manual **"Sync to device"** button that
     downloads the audio file into the app's data dir (expo-file-system); plays locally, works
     locked/in background. Before sync, audio streams from the server.
   - Tapping the **video** area loads the **YouTube IFrame** on demand (online only) and seeks it
     (via the YT JS API) to the current audio position. Used only when the user actively wants video.
4. Highlights come from the existing pipeline running over the transcript text (no time-anchoring
   of Highlights in phase 1). Annotations get a timestamp.

## Domain fit

- `Document` stays the unit. `canonical_url` = `https://www.youtube.com/watch?v=<id>` (dedup rule 3).
- Audio file = a `media_assets` row, `kind='audio'` (precedent: `hero`/`content`).
- Transcript = structured segments stored on the Document, **and** flattened into
  `documents.markdown` so Pipeline/Highlight/Annotation machinery works unchanged.
- YouTube is public → shared cache is fine (no privacy-rule conflict).
- Reuse `scrape_url` job kind (no new kind). Branch by host inside `handleScrapeURL`.

## Schema changes (`schema.sql` + `open.go` additiveMigrations + `UpsertDocument` + `sqlc generate`)

`documents` — additive columns:
- `media_type TEXT NOT NULL DEFAULT 'article'`  — `'article' | 'video'`
- `media_metadata TEXT NOT NULL DEFAULT ''`     — JSON: `{provider, external_id, duration_ms, transcript_status}`
- `transcript TEXT NOT NULL DEFAULT ''`         — JSON: `[{start_ms, end_ms, text}]` (empty for articles)

`annotations` — additive column:
- `media_ts_ms INTEGER NOT NULL DEFAULT 0`      — playback timestamp for video annotations (0 = none)

`media_assets.kind` — add `'audio'` value (no schema change, it's a free-text column).

Migration mechanics per `server/CLAUDE.md`: edit BOTH `schema.sql` and the `const schema` in
`open.go`, append idempotent `ALTER TABLE … ADD COLUMN` to `additiveMigrations`, update the
`UpsertDocument` column list, then `just server::gen`.

## Phase 0 — infra & deps

- **yt-dlp**: install the standalone binary on the VPS (`/usr/local/bin/yt-dlp`). Add a
  `just setup-ytdlp` recipe (download latest release) + a runtime check; config key
  `ytdlp_path` (default: `yt-dlp` on PATH). ffmpeg already present (needed for audio extract).
- App deps: `expo-audio`, `expo-file-system`. (`expo-video` NOT needed — video is the YT iframe
  in the existing WebView.)

## Phase 1 — server ingest

1. **YouTube detection + canonicalization** (`worker/scraper.go`):
   - `youtubeID(raw) (id string, ok bool)` — handle `youtube.com/watch?v=`, `youtu.be/`,
     `/shorts/`, `/embed/`; strip `t`, `list`, etc.
   - In `canonicalize`, if it's a YT URL, return `https://www.youtube.com/watch?v=<id>` so dedup holds.
2. **Branch in `handleScrapeURL`**: if host is YouTube → `handleYouTube(...)` instead of the
   trafilatura path; both end at the same `UpsertDocument`.
3. **`handleYouTube`** (new `worker/youtube.go`):
   - Run `yt-dlp -J <url>` (JSON dump, no download) → title, uploader→`author`,
     upload_date→`published_at`, duration→`duration_ms`, thumbnail→`hero_image_url`.
   - Download audio: `yt-dlp -f bestaudio -x --audio-format m4a -o <cacheDir>/media/<assetID>.m4a`.
     Upsert `media_assets` row kind=`audio`, `local_path`.
   - Subtitles: `yt-dlp --write-subs --write-auto-subs --sub-format vtt --sub-langs en.* --skip-download`
     → parse VTT to `[]segment{start_ms,end_ms,text}` (new `internal/transcript/vtt.go`).
     `transcript_status` = `subs` | `auto` | `none`.
   - `markdown` = segments' text joined by `\n` (or the video description if no transcript).
   - `UpsertDocument` with `media_type='video'`, `media_metadata`, `transcript`.
   - Existing `triggerPipelines` then fires on the new Document → text Highlights, for free.
4. **API**:
   - Serve audio with HTTP range support: `GET /api/v1/media/{id}` already serves files —
     verify/extend it to honor `Range` (needed for streaming + device download). Add a
     convenience `GET /api/v1/documents/{id}/audio` that 302s to the audio media asset, or returns it.
   - Expose `media_type`, `media_metadata`, `transcript` on the Document responses
     (`GET /documents/:id`, sync payload).
5. **Sync**: Document is server→phone one-way; new fields ride along. Annotation gains `media_ts_ms`
   in create/update payloads + sync (two-way).

## Phase 2 — app player screen

In `app/(drawer)/document/[id].tsx`, branch on `doc.media_type === 'video'` → render a
`VideoDocument` layout (new `src/VideoDocument.tsx`); article path unchanged.

Layout (top → bottom):
- **Player header**: thumbnail (hero). Tap → expand a YouTube IFrame (in a small WebView /
  `react-native-youtube-iframe`); on load, seek it to current audio ms via YT JS API. Collapse
  returns to audio-only.
- **Transcript**: the existing document WebView, but built from `transcript` segments — each
  segment a `<span data-start-ms=…>`; concatenated text equals `markdown` so annotation char
  offsets stay valid. Reuses all existing annotation marks + gutter.
- **Bottom seeker bar** (native, full width): play/pause + scrubber bound to the audio player,
  plus **Add Note** + **Sync to device** buttons.

Behavior:
- `expo-audio` player; source = local file uri if synced, else `…/documents/:id/audio`.
- On audio time tick → RN posts `{type:'mediaTime', ms}` to WebView → highlight active segment +
  autoscroll to it (skip autoscroll while the user is manually scrolling).
- Tap a transcript segment → WebView posts `{type:'seek', ms}` → RN seeks audio.
- **Add Note** → RN reads current ms + asks WebView for the active segment ±2–3 sentences →
  opens `AnnotationPanel` in create mode with `exact/prefix/suffix` from that window and
  `media_ts_ms` = current ms.
- Tapping an existing video annotation → seek audio to its `media_ts_ms`.
- "Sync to device" → `expo-file-system` download audio to app data dir; persist local uri in the
  sync store; button reflects synced/again state.

API/types (`src/api.ts`): add `media_type`, `media_metadata`, `transcript` to `Document`;
`media_ts_ms` to `Annotation` + `createAnnotation` payload.

## Phase 3 — highlights/pipeline

No change needed — pipelines run on `markdown` (the flattened transcript) and produce text
Highlights. Time-anchored Highlights deferred (would map highlight text → nearest segment).

## Tests (write FIRST — e2e self-test)

Success = with the test video `https://www.youtube.com/watch?v=PqtggjVAi8M`:
1. **VTT parser unit test** (`internal/transcript/vtt_test.go`) — sample cue block → segments.
2. **Server ingest test**: enqueue `scrape_url` for the test video → assert a Document with
   `media_type='video'`, non-empty `transcript`, an `audio` media_asset on disk, `duration_ms>0`.
   (Gated on yt-dlp present; skip with a clear message if absent in CI.)
3. **`just e2e`**: add the video Document to `e2e/smoke.js` PAGES — page loads, no JS error, no 4xx/5xx.
4. **agent-browser manual**: open the video doc, press play, confirm transcript autoscrolls,
   tap a segment seeks, Add Note captures a timestamped annotation, tap video loads the iframe
   seeked to position. Screenshots to `tmp/`.

## Open risks

- VTT auto-subs are noisy (overlapping/duplicated cues) — parser must dedup/merge.
- Audio streaming range support must work for both `<audio>` (web) and expo-audio (native).
- yt-dlp gets blocked/needs updates periodically — keep `just setup-ytdlp` and surface job errors.
- Disk: audio is small (~1MB/min) but add it to any future retention policy.

## Build order / git

Commit this plan to `main`, branch `feat/youtube-video-docs`, small commits per phase, run
`just build` + `just e2e` + linter before done, then ask user to check → squash merge.
