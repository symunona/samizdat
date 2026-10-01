---
created: 2026-10-01
topic: Live processing state on the Documents page
excerpt: A new resource shows only "Queued" / "Reading…" for minutes. Give every Job a `progress` JSON the worker rewrites as it moves — yt-dlp phase, egress, percent, video duration, then the LLM endpoint, try, chunk and fallback — and render it on Documents with elapsed time.
status: shipped 2026-10-01
---

# Live job progress

## Problem

A 2h46m video spent 8m46s in the audio step. The Documents row said `Reading…`
the whole time: no way to tell "downloading through pandora, 40%" from "hung".
After the scrape, the pipeline runs for minutes more and the Document card says
nothing at all until Highlights appear.

## Design

**One new column: `jobs.progress` (TEXT, JSON, `''` = none).** Jobs are queue
state, not vault truth, so nothing here needs a markdown path (design rule 1 is
about Documents/Highlights/Annotations). The last state stays on the finished
row — which egress served a download is worth keeping next to `result`.

```json
{"phase":"download","since":"2026-10-01T20:01:07Z",
 "media":"audio","proxy":"pandora","tried":["fiona"],"percent":42.5,"part":2,"parts":2,
 "duration_ms":9960000,"title":"…",
 "step":"llm_summarize","provider":"xayah…:11434","model":"qwen3-sum",
 "try":2,"tries":3,"chunk":3,"chunks":12,"fallback":true}
```

Phases: `fetch` (browser/PDF) · `probe` · `download` · `convert` (yt-dlp
post-processing: ffmpeg re-encode / merge) · `llm`. `since` resets when the
phase changes, so the app can show time-in-phase.

### Server

- `internal/progress` — a `Reporter` carried in the job's context. `Update(fn)`
  mutates the state and writes it; `Percent(p)` is throttled (2s) so a download
  does not write per line. Nil-safe: code outside a job (tests, `/llm/ask`)
  reports into nothing. No dependency on `store` — the worker hands it a sink.
- **Every progress write bumps `updated_at`.** That is a heartbeat: `stuckJobAge`
  requeues a job idle for 10 min, and a long download is exactly that — the row
  flipped to `queued` while yt-dlp was still running. A job that reports is not
  stuck.
- `worker.run` builds the reporter (seeded from the row's existing progress) and
  puts it in ctx. `handleRunPipelineStep` passes the current state into the next
  tick's `InsertJob`, so a chunked run's row never goes blank between ticks.
- **yt-dlp** (`ytdlpRun.walk`, the one invocation path): reports phase + media +
  proxy + tried before each attempt. Download runs drop `--no-progress` for
  `--newline` and stream output through a line scanner: `[download] N%` →
  `Percent`, a post-processor line → `convert`. Progress lines are not kept in
  the buffer the classifier reads. `handleYouTube` adds `duration_ms` + `title`
  right after the probe.
- **LLM**: `llm.WithAttemptHook(ctx, fn)` — the Router calls it before each
  endpoint it tries (pinned: once; chain: per entry, `Fallback` true past the
  first). `llm` stays ignorant of jobs. `pipeline.llmCall` installs the hook;
  `callWithFallback` reports `try/tries` and escalation to the big role; the
  chunk ticks report `chunk/chunks`.
- `added_at` rides the `run_pipeline` → `run_pipeline_step` payloads (the scrape
  job's `created_at`), so a Document card can show time since the resource was
  added without walking the parent chain.
- API: nothing new. `GET /api/v1/jobs` already returns the row; `progress` is
  one more field.

### App

- `src/jobProgress.ts` — pure: `parseProgress`, `progressLines(job, now)`,
  `activeJobForDocument`. Same split as `failedJobs.ts`.
- `documents.tsx`: the pending poll drops its `kind=scrape_url` filter. Scrape
  jobs keep their pinned rows (now: title once probed, a phase line, an
  elapsed line). A running/queued job naming a Document badges that Document's
  card. A queued job with `attempts > 0` reads as a retry and shows `last_error`.
  A 1s clock runs only while something is active. A scrape leaving the list
  triggers a sync so the new Document appears without waiting for the interval.

## Not doing

- Queue position, ETA.
- Progress on the document viewer / Jobs screen (the field is there; render later).
- Streaming (SSE). Polling at 3s is what the screen already does.

## Self-test (decided before starting)

1. Go: reporter (phase reset, throttle, nil-safe) · fake yt-dlp emitting
   progress lines → recorded phases/percent, classifier still sees the error ·
   Router hook fires per chain entry with `Fallback` · `callWithFallback`
   reports tries + escalation.
2. `just e2e`: seed a `running` scrape with download progress, a `queued` retry,
   and a `running` pipeline step on the seeded video Document → assert the
   VISIBLE text on `/documents` (percent, proxy, duration, provider, chunk, try,
   fallback, elapsed).
3. Real: `just build && just restart`, add a real YouTube URL through the UI in
   `just robot-browser`, screenshot each phase.
