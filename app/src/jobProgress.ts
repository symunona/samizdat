import { useEffect, useState } from 'react'
import type { Job } from './api'

// What a running Job says about itself — the server's `progress.State`, written
// to `jobs.progress` as the worker moves. Every field is optional: an older
// server sends none, and each phase fills only what it knows.
export type JobProgress = {
  phase?: 'fetch' | 'probe' | 'download' | 'convert' | 'llm'
  since?: string // when the phase began
  media?: string // audio | video
  proxy?: string // egress label, "direct" when none
  tried?: string[] // egresses that failed before `proxy`
  percent?: number // of the current part
  part?: number // a video arrives as separate streams, each its own 0–100%
  parts?: number
  duration_ms?: number // media length, known once probed
  title?: string
  step?: string // pipeline step kind
  provider?: string // LLM endpoint being asked
  model?: string
  try?: number
  tries?: number
  chunk?: number
  chunks?: number
  fallback?: boolean // not the endpoint first asked
}

// The three lines a job shows: what it is doing, with what, and for how long.
export type JobActivity = { headline: string; detail: string; timing: string }

type Payload = { url?: string; document_id?: string; added_at?: string }

function parse<T>(raw: string | undefined): Partial<T> {
  try {
    const v = JSON.parse(raw || '{}') as Partial<T>
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export function parseProgress(job: Job): JobProgress {
  return parse<JobProgress>(job.progress)
}

// formatSpan renders a length of time the way a stopwatch would be read aloud:
// "42s", "3m 12s", "2h 46m". Never negative — a phone clock behind the server's
// must not print "-3s".
export function formatSpan(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

function since(iso: string | undefined, now: number): number | null {
  const t = iso ? new Date(iso).getTime() : NaN
  return Number.isNaN(t) ? null : now - t
}

// What a job is doing when it has not said: the kind is all there is to go on.
const KIND_LABELS: Record<string, string> = {
  scrape_url: 'Reading',
  fetch_assets: 'Fetching images',
  fetch_video: 'Fetching video',
  run_pipeline: 'Starting pipeline',
  run_pipeline_step: 'Running pipeline',
}

function phaseHeadline(p: JobProgress, kind: string): string {
  switch (p.phase) {
    case 'fetch':
      return 'Fetching page'
    case 'probe':
      return 'Reading video info'
    case 'download': {
      const pct = p.percent && p.percent > 0 ? ` ${Math.floor(p.percent)}%` : ''
      const part = p.part && p.parts && p.parts > 1 ? ` · part ${p.part}/${p.parts}` : ''
      return `Downloading ${p.media || 'media'}${pct}${part}`
    }
    case 'convert':
      return `Converting ${p.media || 'media'}`
    case 'llm': {
      const verb = p.step === 'llm_summarize' ? 'Summarizing' : 'Extracting highlights'
      return p.chunks ? `${verb} · chunk ${p.chunk ?? 1}/${p.chunks}` : verb
    }
    default:
      return KIND_LABELS[kind] ?? 'Working'
  }
}

function phaseDetail(p: JobProgress): string {
  const parts: string[] = []
  if (p.phase === 'llm') {
    if (p.provider) parts.push(p.model ? `${p.provider} / ${p.model}` : p.provider)
    if (p.try && p.tries && p.try > 1) parts.push(`try ${p.try}/${p.tries}`)
    if (p.fallback) parts.push('fallback')
  } else if (p.proxy) {
    const failed = p.tried?.length ? ` (${p.tried.join(', ')} failed)` : ''
    parts.push((p.proxy === 'direct' ? 'direct connection' : `via ${p.proxy}`) + failed)
  }
  if (p.duration_ms) parts.push(`${formatSpan(p.duration_ms)} long`)
  return parts.join(' · ')
}

// jobAddedAt is when the RESOURCE entered the queue, not when this job row was
// minted: a pipeline tick is a fresh row every chunk, so its payload carries
// the original scrape's time.
export function jobAddedAt(job: Job): string {
  return parse<Payload>(job.payload).added_at || job.created_at
}

// describeJob turns one active Job into its three lines. `now` is passed in so
// the caller owns the clock (and a list re-renders off one tick, not one each).
export function describeJob(job: Job, now: number): JobActivity {
  const p = parseProgress(job)
  const added = since(jobAddedAt(job), now)
  const addedText = added === null ? '' : `added ${formatSpan(added)} ago`

  // Back in the queue after a failed attempt: say so, and say why.
  if (job.status === 'queued' && job.attempts > 0) {
    const wait = since(job.run_after, now)
    const when = wait !== null && wait < 0 ? ` in ${formatSpan(-wait)}` : ''
    return {
      headline: `Retrying${when} · attempt ${job.attempts + 1}`,
      detail: job.last_error.trim(),
      timing: addedText,
    }
  }
  // A queued row that already carries a phase is the next tick of a chunked
  // run, not a job waiting its turn.
  if (job.status === 'queued' && !p.phase) {
    return { headline: 'Queued', detail: '', timing: addedText }
  }

  const inPhase = since(p.since, now)
  const attempt = job.attempts > 1 ? ` · attempt ${job.attempts}` : ''
  return {
    headline: phaseHeadline(p, job.kind) + attempt,
    detail: phaseDetail(p),
    timing: [inPhase === null ? '' : `${formatSpan(inPhase)} in this step`, addedText].filter(Boolean).join(' · '),
  }
}

export function jobDocumentId(job: Job): string {
  return parse<Payload>(job.payload).document_id ?? ''
}

// activeJobForDocument picks the job a Document's card should show. A running
// one wins — that is the thing happening now; a queued one only says more is
// coming.
export function activeJobForDocument(documentId: string, jobs: Job[]): Job | undefined {
  const mine = jobs.filter(j => jobDocumentId(j) === documentId)
  return mine.find(j => j.status === 'running') ?? mine[0]
}

// useNow ticks once a second while `active`, and not at all otherwise: an idle
// list must not re-render every second to update clocks nobody is showing.
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}
