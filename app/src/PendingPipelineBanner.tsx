import { useMemo } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { useQuery } from '@tanstack/react-query'
import { useUnistyles } from 'react-native-unistyles'
import { fetchDocumentPipelineRuns, fetchJobs, fetchPipelines } from './api'
import { useConnection } from './ConnectionContext'

// Pipeline work that hasn't produced Highlights yet, for one Document.
type Pending = { name: string; status: 'queued' | 'running' | 'paused' }

function parsePayload(payload: string): Record<string, string> {
  try { return JSON.parse(payload) as Record<string, string> } catch { return {} }
}

// A pipeline is "pending" for a Document when its Highlights aren't ready yet.
// Two signals, because a pipeline_run row only exists once the run_pipeline job
// starts executing (running); before that (queued/paused) only the Job exists:
//   1. pipeline_runs with status queued/running  → run already executing
//   2. run_pipeline jobs (queued/running/paused) for this doc → still to run
// Merged + de-duped by pipeline name, preferring the more-active status.
function useDocPendingPipelines(docId: string): Pending[] {
  const { activeUrl, token, status } = useConnection()
  const enabled = status === 'connected' && !!activeUrl && !!token && !!docId

  // Pipeline names change rarely — cache and reuse for pipeline_id → name lookup.
  const pipelinesQ = useQuery({
    queryKey: ['pipelines', activeUrl],
    queryFn: () => fetchPipelines(activeUrl!, token!),
    enabled,
    staleTime: 5 * 60 * 1000,
  })

  const dataQ = useQuery({
    queryKey: ['docPendingPipelines', activeUrl, docId],
    queryFn: async () => {
      const [runs, jobs] = await Promise.all([
        fetchDocumentPipelineRuns(activeUrl!, token!, docId),
        fetchJobs(activeUrl!, token!, { kind: 'run_pipeline' }),
      ])
      return { runs, jobs }
    },
    enabled,
    // Mirror jobs.tsx: poll every 3s while something is pending, otherwise stop.
    refetchInterval: (query) => {
      const d = query.state.data
      if (!d) return 3000
      const runsPending = d.runs.some(r => r.status === 'queued' || r.status === 'running')
      const jobsPending = d.jobs.some(j =>
        j.kind === 'run_pipeline' && !j.deleted_at &&
        (j.status === 'queued' || j.status === 'running' || j.status === 'paused') &&
        parsePayload(j.payload).document_id === docId)
      return runsPending || jobsPending ? 3000 : false
    },
  })

  return useMemo(() => {
    const data = dataQ.data
    if (!data) return []
    const nameById = new Map<string, string>()
    for (const p of pipelinesQ.data ?? []) nameById.set(p.id, p.name)

    // Precedence so a de-duped pipeline shows its most-active status.
    const rank: Record<Pending['status'], number> = { running: 0, queued: 1, paused: 2 }
    const byName = new Map<string, Pending>()
    const add = (name: string, st: Pending['status']) => {
      const prev = byName.get(name)
      if (!prev || rank[st] < rank[prev.status]) byName.set(name, { name, status: st })
    }

    for (const r of data.runs) {
      if (r.status === 'queued' || r.status === 'running') {
        add(nameById.get(r.pipeline_id) ?? 'Pipeline', r.status)
      }
    }
    for (const j of data.jobs) {
      if (j.kind !== 'run_pipeline' || j.deleted_at) continue
      if (j.status !== 'queued' && j.status !== 'running' && j.status !== 'paused') continue
      const p = parsePayload(j.payload)
      if (p.document_id !== docId) continue
      add(p.pipeline_name || nameById.get(p.pipeline_id) || 'Pipeline', j.status)
    }
    return [...byName.values()]
  }, [dataQ.data, pipelinesQ.data, docId])
}

// Info block shown above a Document's content while a Pipeline is still producing
// its Highlights. Disappears once no pipeline is pending (query stops polling).
export default function PendingPipelineBanner({ docId, isVideo }: { docId: string; isVideo?: boolean }) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const pending = useDocPendingPipelines(docId)

  if (pending.length === 0) return null

  const running = pending.some(p => p.status === 'running')
  const names = pending.map(p => p.name).join(', ')
  const statusLabel = running ? 'Running' : pending.some(p => p.status === 'queued') ? 'Queued' : 'Paused'
  const kind = isVideo ? 'video' : 'article'
  const why = running
    ? `Extracting key highlights from this ${kind} — they'll appear here when it finishes.`
    : `Highlights for this ${kind} are queued — they'll appear here once the pipeline runs.`

  return (
    <View style={s.card}>
      <ActivityIndicator size="small" color={theme.colors.accent} style={s.spinner} />
      <View style={s.body}>
        <View style={s.titleRow}>
          <Text style={s.title} numberOfLines={1}>{names}</Text>
          <View style={s.badge}><Text style={s.badgeText}>{statusLabel}</Text></View>
        </View>
        <Text style={s.why}>{why}</Text>
      </View>
    </View>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.md,
      paddingVertical: t.spacing.sm,
      paddingHorizontal: t.spacing.md,
      backgroundColor: t.colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: t.colors.border,
      borderLeftWidth: 3,
      borderLeftColor: t.colors.accent,
    },
    spinner: { flexShrink: 0 },
    body: { flex: 1, gap: 2 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    title: { flexShrink: 1, color: t.colors.text, fontSize: 13, fontWeight: '700' },
    badge: {
      flexShrink: 0,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: t.radius.sm,
      backgroundColor: t.colors.accent + '22',
    },
    badgeText: { color: t.colors.accent, fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
    why: { color: t.colors.muted, fontSize: 12, lineHeight: 16 },
  })
}
