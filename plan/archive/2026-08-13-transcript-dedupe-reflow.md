---
created: 2026-08-13
topic: YouTube transcript roll-up de-duplication + sentence reflow
excerpt: Auto-caption VTT is a roll-up stream — every spoken line lands three times (paint-on cue, 10ms settle cue, carry-over line of the next cue). ParseVTT joins whole cues and only drops exactly-equal ones, so nothing was dropped and every video body is ~3x its real text. Fix the parser, then reflow 35-char display stubs into sentences/paragraphs while keeping per-segment scroll-follow.
status: done — parser + reflow + renderer + backfill shipped; all 10 video Documents repaired on this instance (ddc03351 346983 → 115311 chars), verified by a real mouse click in agent-browser
---

# Transcript de-dup + sentence reflow

## Root cause

`--write-auto-subs` gets YouTube's **roll-up** WebVTT:

```
00:00:00.160 --> 00:00:01.990
 
How<00:00:00.400><c> do</c>...<c> something?</c>      ← paint-on cue (inline word timings)

00:00:01.990 --> 00:00:02.000
How do I know when to quit something?               ← 10ms settle cue
 

00:00:02.000 --> 00:00:04.390
How do I know when to quit something?               ← carry-over of the previous line
&gt;&gt; It's<00:00:02.240><c> okay.</c>...          ← new paint-on line
```

Each spoken line therefore appears **3×**. `transcript.ParseVTT` joins *all* lines of a
cue into one string and drops only cues that are **exactly equal to the previous one**.
The real sequence is `A`, `A`, `A B`, `B`, `B C` … — never exactly equal after the join,
so nothing is dropped.

Measured on `ddc03351` (`g7AxxkywiFI`): stored markdown 346 983 chars, real content
112 582 chars → **3.08×**. Every LLM step over a video paid 3× tokens.

Not our generation — it is what YouTube ships. Manual subtitle tracks are unaffected
(no inline timing tags, no roll-up).

## Fix 1 — roll-up de-duplication (no LLM)

Roll-up detection: the file contains inline timestamp tags `<HH:MM:SS.mmm>`.

In roll-up mode, emit **per line**, not per cue, and drop a line equal to the last
emitted one:

- settle cue → equals last → dropped
- carry-over first line of the next cue → equals last → dropped
- new paint-on line → kept, timed at cue start

Window of 1 on purpose: the only false-drop is a line genuinely repeated back-to-back
verbatim. Rejected alternative — keep only lines containing `<c>` tags: loses 113 legit
lines on the sample file (lines whose words all precede the first inline tag).

Non-roll-up files keep today's per-cue path plus the existing exact-dup drop.

## Fix 2 — sentence reflow (display + anchors)

Post-dedupe the segments are still YouTube's ~35-char display wraps, cut mid-sentence
(`this morning, there was the Michael` / `Jordan quote.`). One `<p class="seg">` per
wrap = 3 185 stubs.

Split the roles: **cue = timing atom, sentence = display + scroll atom.**

`transcript.Reflow(cues) []Segment`:

1. Join deduped cue texts with a space, keeping a `charOffset → cue` index.
2. Pre-pass: split a cue at ` >> ` (YouTube's speaker-change marker), interpolating the
   start time by char fraction; strip the marker, flag a speaker break.
3. Cut at sentence boundaries: `[.?!…]["')\]]*` + whitespace + uppercase/digit, unless
   the preceding token is a known abbreviation (`Mr.`, `e.g.`, `U.S.`, decimals).
4. Force a cut at every speaker break.
5. Timing: segment start/end interpolated from the cue index at its first/last char.
6. Guards: sentence > 350 chars or > 20 s → split at the nearest `,` / ` and ` / ` but `
   past the midpoint (punctuation-free ASR run-ons); sentence < 40 chars → glue to the
   next one unless a speaker break intervenes.
7. Paragraph break (`Segment.NewPara`) on speaker change, on a silence gap > 2.5 s, or
   when the running paragraph exceeds ~700 chars.

Server-side, in `server/internal/transcript`, **not** in the app:

- `Document.markdown` becomes real prose. It is currently fragment-per-line, so
  TextQuoteSelector anchors break across the line breaks and Highlight extraction sees
  shredded input.
- One implementation for app + web + LLM + vault export.

`FlattenText` joins sentences inside a paragraph with a space and paragraphs with a
blank line.

## Rendering

`buildTranscriptHtml` emits `<p class="para" data-ts>` per paragraph, with one
`<span class="seg" data-start-ms data-end-ms>` per sentence inside it. The viewer's
follow/seek/annotation machinery keys off `.seg[data-start-ms]` and needs no logic
change; CSS moves the hover timestamp chip from the seg to the paragraph (an
absolutely-positioned `::after` on an inline span lands per line-box).

Scroll granularity goes from ~1.5 s stubs to ~2–6 s sentences — what podcast transcript
readers do.

## Backfill

10 video Documents; the 12 cached `.vtt` cover 6 of them → offline re-parse, no yt-dlp,
no bot wall. Boot-time, self-guarded by a `settings` key, next to the existing
`pipeline.BackfillStepPrompts` precedent: re-parse each video Document's cached VTT →
rewrite `transcript` + `markdown` + `content_hash`, bump `rev` so phones re-pull.

The other 4 predate per-language ingest: no `transcript_langs`, no cached `.vtt`, and a
bare-array transcript. `transcript.DedupRollup` repairs those from the stored segments —
the pre-fix parser stored A, "A B", B, "B C" …, so each line comes back by stripping the
leading copy of the one before it. Result on this instance:

| doc | before | after |
|---|---|---|
| ddc03351 | 346 983 | 115 311 |
| 9b5badaf | 300 943 | 99 669 |
| 957847bd | 201 532 | 70 753 |
| 7c39db6f | 173 306 | 57 376 |
| ee382465 | 143 793 | 47 944 |
| 3d4fd892 | 115 982 | 38 747 |
| 568379f5 | 58 205 | 19 465 |
| ce0c1ed3 | 47 801 | 15 973 |
| ae46a98a | 49 136 | 49 140 |

`ae46a98a` has **manual** subtitles — no roll-up, so only the reflow applied and the
length is unchanged. That is the control case.

Known consequence: character offsets of existing annotations on these 10 docs move (the
body loses 2/3 of its length). Time-anchored transcript annotations re-anchor by
`media_ts_ms` and survive; text-anchored ones fall back to the TextQuoteSelector
`prefix+exact+suffix` search. Highlights extracted from the 3× text stay as they are —
re-run the pipeline per document if they read badly.

## Tests

- `vtt_test.go`: roll-up fixture (paint-on / settle / carry-over) → asserts one segment
  per spoken line; existing manual-subs + entity + timestamp tests stay green.
- `reflow_test.go`: mid-sentence wrap joins into one sentence; speaker change splits and
  starts a paragraph; run-on splits at the comma; short sentence glues forward; timings
  monotonic and inside the source cue range.
- `just e2e` + agent-browser on `/document/ddc03351-…`: assert the visible transcript has
  no tripled line, renders as paragraphs, and that clicking a sentence seeks.

## Steps

1. `plan/` commit on main, branch `feat/transcript-dedupe-reflow`.
2. `transcript`: roll-up dedupe in `ParseVTT` + tests.
3. `transcript`: `Reflow` + `Segment.NewPara` + `FlattenText` + tests.
4. `worker`: `readLangVTT` composes ParseVTT→Reflow (single call site for ingest + backfill).
5. `worker`: guarded boot backfill over cached VTT.
6. `app`: `buildTranscriptHtml` paragraphs + viewer CSS + `just webview-build`.
7. `just build`, `just lint`, `just e2e`, agent-browser check, hand back for review.
