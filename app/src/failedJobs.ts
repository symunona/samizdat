import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchJobs } from './api'
import type { Job } from './api'
import type { DocumentMeta } from './db'
import { useConnection } from './ConnectionContext'

// A permanently-failed (dead) Job reduced to what the UI shows. The server keeps
// the reason in `last_error`; nothing else surfaces it, so a failed scrape or a
// failed pipeline is otherwise invisible in the reader.
export type FailedJob = {
  job: Job
  label: string // what failed, short + human ("Scrape failed")
  message: string // the server's last_error (never empty)
  url: string // scrape target, '' when the job has none
  documentId: string // owning Document, '' when the job never produced one
}

const LABELS: Record<string, string> = {
  scrape_url: 'Scrape failed',
  run_pipeline: 'Highlights failed',
  run_pipeline_step: 'Highlights failed',
  fetch_video: 'Video fetch failed',
  fetch_assets: 'Images failed',
  poll_feed: 'Feed poll failed',
}

function parseJson(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw || '{}') as Record<string, string>
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

function toFailedJob(job: Job): FailedJob {
  const payload = parseJson(job.payload)
  const result = parseJson(job.result)
  return {
    job,
    label: LABELS[job.kind] ?? 'Job failed',
    message: job.last_error.trim() || `failed after ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}`,
    url: payload.url ?? '',
    documentId: payload.document_id ?? result.document_id ?? '',
  }
}

// Compare two URLs the way the scraper's canonicalizer would see them (fragment
// and trailing slash dropped, host case-folded) — enough to tell whether a failed
// scrape already has a Document in the list.
function normalizeUrl(raw: string): string {
  const noFragment = raw.split('#')[0].trim()
  const m = /^(https?:\/\/)([^/?#]+)(.*)$/i.exec(noFragment)
  const normalized = m ? m[1].toLowerCase() + m[2].toLowerCase() + m[3] : noFragment
  return normalized.replace(/\/+$/, '')
}

// useFailedJobs polls the dead-job feed. React Query dedupes the request across
// every screen that mounts the hook, so the Documents list and the document
// viewer share one poll.
export function useFailedJobs() {
  const { activeUrl, token, status } = useConnection()
  const enabled = status === 'connected' && !!activeUrl && !!token

  const q = useQuery({
    queryKey: ['failedJobs', activeUrl],
    queryFn: () => fetchJobs(activeUrl!, token!, { status: 'dead' }),
    enabled,
    refetchInterval: 20000,
  })

  const failed = useMemo(() => (q.data ?? []).map(toFailedJob), [q.data])
  return { failed, refetch: q.refetch }
}

// failureForDocument finds the dead job that belongs to a Document. Two links,
// because no single field covers both shapes: pipeline / asset / video jobs name
// the Document in their payload (and a finished scrape in its result), while a
// re-scrape that died never recorded one — it only knows the URL. Most recent
// wins: the feed is ordered updated_at DESC.
export function failureForDocument(doc: DocumentMeta, failed: FailedJob[]): FailedJob | undefined {
  const url = normalizeUrl(doc.canonical_url)
  return failed.find(f => (f.documentId ? f.documentId === doc.id : !!f.url && normalizeUrl(f.url) === url))
}

// documentErrorText is the one line a Document shows when something went wrong —
// used by the list badge and the viewer banner so both say the same thing. The
// Document's own flag (a curated false-parse reason) wins over a dead job, which
// otherwise carries the detail. '' = healthy.
export function documentErrorText(doc: DocumentMeta | null | undefined, failed: FailedJob[]): string {
  if (!doc) return ''
  if (doc.error_reason) return `${doc.error_reason} — no summary generated`
  const f = failureForDocument(doc, failed)
  return f ? `${f.label}: ${f.message}` : ''
}

// orphanScrapeFailures are failed scrapes that produced no readable Document, so
// nothing in the list represents them — they need their own row. A failure whose
// URL did land a Document (e.g. a flagged false-parse) is dropped here: that
// Document already carries the badge.
export function orphanScrapeFailures(failed: FailedJob[], documents: DocumentMeta[]): FailedJob[] {
  const known = new Set(documents.map(d => normalizeUrl(d.canonical_url)))
  return failed.filter(f => f.job.kind === 'scrape_url' && !f.documentId && !known.has(normalizeUrl(f.url)))
}
