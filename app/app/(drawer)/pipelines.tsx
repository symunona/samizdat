import { useCallback, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import {
  fetchPipelines,
  fetchPipelineDocuments,
  fetchPipelineJobs,
  patchPipeline,
} from '../../src/api'
import type { Pipeline, Document, Job } from '../../src/api'
import { useConnection } from '../../src/ConnectionContext'
import { useToast } from '../../src/ToastContext'

const STATUS_COLOR: Record<string, string> = {
  queued:  '#facc15',
  running: '#60a5fa',
  done:    '#4ade80',
  dead:    '#f87171',
}

function formatAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return iso }
}

function summarizeFilter(filterJson: string): string {
  try {
    const f = JSON.parse(filterJson) as Record<string, unknown>
    const parts: string[] = []
    if (f.feed_id) parts.push(`feed: ${String(f.feed_id).slice(0, 8)}`)
    if (f.tag) parts.push(`tag: ${f.tag}`)
    if (f.domain) parts.push(`domain: ${f.domain}`)
    if (f.url_pattern) parts.push(`url: ${f.url_pattern}`)
    return parts.length ? parts.join(', ') : 'all documents'
  } catch { return filterJson || 'all documents' }
}

function summarizeSteps(stepsJson: string): string {
  try {
    const steps = JSON.parse(stepsJson) as Array<{ kind?: string; type?: string; name?: string }>
    if (!Array.isArray(steps) || steps.length === 0) return 'no steps'
    return steps.map((s, i) => `${i + 1}. ${s.kind ?? s.type ?? s.name ?? 'step'}`).join(' → ')
  } catch { return stepsJson || 'no steps' }
}

type PipelineCardProps = {
  pipeline: Pipeline
  onToggleEnabled: (p: Pipeline) => void
  togglingId: string | null
}

type ExpandedSection = 'jobs' | 'docs' | null

function PipelineCard({ pipeline, onToggleEnabled, togglingId }: PipelineCardProps) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { activeUrl, token } = useConnection()

  const [expanded, setExpanded] = useState<ExpandedSection>(null)
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [docs, setDocs] = useState<Document[] | null>(null)
  const [loadingJobs, setLoadingJobs] = useState(false)
  const [loadingDocs, setLoadingDocs] = useState(false)

  async function toggleSection(section: ExpandedSection) {
    if (expanded === section) {
      setExpanded(null)
      return
    }
    setExpanded(section)
    if (!activeUrl || !token) return

    if (section === 'jobs' && jobs === null) {
      setLoadingJobs(true)
      try {
        const page = await fetchPipelineJobs(activeUrl, token, pipeline.id, { limit: 10 })
        setJobs(page.items)
      } catch { setJobs([]) }
      finally { setLoadingJobs(false) }
    }
    if (section === 'docs' && docs === null) {
      setLoadingDocs(true)
      try {
        const data = await fetchPipelineDocuments(activeUrl, token, pipeline.id)
        setDocs(data)
      } catch { setDocs([]) }
      finally { setLoadingDocs(false) }
    }
  }

  const isEnabled = pipeline.enabled === 1
  const isToggling = togglingId === pipeline.id

  return (
    <View style={s.card}>
      <View style={s.cardHeader}>
        <View style={s.cardMeta}>
          <Text style={s.pipelineName}>{pipeline.name}</Text>
          <Text style={s.triggerText}>{pipeline.trigger}</Text>
        </View>
        <Switch
          value={isEnabled}
          onValueChange={() => onToggleEnabled(pipeline)}
          disabled={isToggling}
          trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
          thumbColor={isEnabled ? theme.colors.background : theme.colors.muted}
        />
      </View>

      <Text style={s.filterText}>
        <Text style={s.filterLabel}>filter: </Text>
        {summarizeFilter(pipeline.filter)}
      </Text>
      <Text style={s.stepsText} numberOfLines={2}>
        <Text style={s.filterLabel}>steps: </Text>
        {summarizeSteps(pipeline.steps)}
      </Text>
      <Text style={s.metaText}>created {formatDate(pipeline.created_at)}</Text>

      <View style={s.sectionToggles}>
        <Pressable
          style={[s.sectionBtn, expanded === 'jobs' && s.sectionBtnActive]}
          onPress={() => toggleSection('jobs')}
        >
          <Text style={[s.sectionBtnText, expanded === 'jobs' && s.sectionBtnTextActive]}>
            {expanded === 'jobs' ? '▼' : '▶'} Recent runs
          </Text>
        </Pressable>
        <Pressable
          style={[s.sectionBtn, expanded === 'docs' && s.sectionBtnActive]}
          onPress={() => toggleSection('docs')}
        >
          <Text style={[s.sectionBtnText, expanded === 'docs' && s.sectionBtnTextActive]}>
            {expanded === 'docs' ? '▼' : '▶'} Documents
          </Text>
        </Pressable>
        <Pressable
          style={s.sectionBtn}
          onPress={() => router.push(`/documents?pipeline_id=${pipeline.id}`)}
        >
          <Text style={s.sectionBtnText}>All docs →</Text>
        </Pressable>
      </View>

      {/* Jobs section */}
      {expanded === 'jobs' && (
        <View style={s.sectionBody}>
          {loadingJobs
            ? <ActivityIndicator color={theme.colors.accent} size="small" style={{ padding: 8 }} />
            : jobs?.length === 0
              ? <Text style={s.emptySection}>No runs yet.</Text>
              : jobs?.map(job => {
                  const p = (() => { try { return JSON.parse(job.payload) as Record<string, string> } catch { return {} } })()
                  const r = (() => { try { return JSON.parse(job.result) as Record<string, string> } catch { return {} } })()
                  const docId = p.document_id ?? r.document_id ?? ''
                  const docTitle = p.document_title ?? ''
                  const statusColor = STATUS_COLOR[job.status] ?? '#9ca3af'
                  return (
                    <Pressable
                      key={job.id}
                      style={s.jobRow}
                      onPress={() => docId ? router.push(`/document/${docId}`) : undefined}
                      disabled={!docId}
                    >
                      <View style={[s.jobDot, { backgroundColor: statusColor }]} />
                      <Text style={s.jobAge}>{formatAge(job.updated_at)}</Text>
                      <Text style={[s.jobDocTitle, !!docId && s.jobDocLink]} numberOfLines={1}>
                        {docTitle || (docId ? `doc ${docId.slice(0, 8)}` : job.kind)}
                        {!!docId ? ' →' : ''}
                      </Text>
                    </Pressable>
                  )
                })
          }
        </View>
      )}

      {/* Docs section */}
      {expanded === 'docs' && (
        <View style={s.sectionBody}>
          {loadingDocs
            ? <ActivityIndicator color={theme.colors.accent} size="small" style={{ padding: 8 }} />
            : docs?.length === 0
              ? <Text style={s.emptySection}>No documents processed yet.</Text>
              : docs?.map(doc => (
                  <Pressable
                    key={doc.id}
                    style={s.docRow}
                    onPress={() => router.push(`/document/${doc.id}`)}
                  >
                    <Text style={s.docTitle} numberOfLines={2}>
                      {doc.title?.trim() || doc.canonical_url} →
                    </Text>
                    <Text style={s.docUrl} numberOfLines={1}>{doc.canonical_url}</Text>
                  </Pressable>
                ))
          }
        </View>
      )}
    </View>
  )
}

export default function PipelinesScreen() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { status, activeUrl, token } = useConnection()
  const { toast } = useToast()

  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const load = useCallback(async (isRefresh = false) => {
    if (!activeUrl || !token) return
    isRefresh ? setRefreshing(true) : setLoading(true)
    setError(null)
    try {
      const data = await fetchPipelines(activeUrl, token)
      setPipelines(data ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [activeUrl, token])

  useFocusEffect(
    useCallback(() => {
      if (status === 'connected') void load()
    }, [status, load])
  )

  async function handleToggleEnabled(pipeline: Pipeline) {
    if (!activeUrl || !token || togglingId) return
    setTogglingId(pipeline.id)
    try {
      const updated = await patchPipeline(activeUrl, token, pipeline.id, { enabled: pipeline.enabled === 0 })
      setPipelines(prev => prev.map(p => p.id === pipeline.id ? updated : p))
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to update', 'error')
    } finally {
      setTogglingId(null)
    }
  }

  return (
    <SafeAreaView style={s.screen}>
      {loading && !refreshing
        ? <View style={s.centered}><ActivityIndicator color={theme.colors.accent} size="large" /></View>
        : error
          ? <View style={s.centered}>
              <Text style={s.errText}>{error}</Text>
              <Pressable onPress={() => load()} style={s.retryBtn}>
                <Text style={s.retryText}>Retry</Text>
              </Pressable>
            </View>
          : <FlatList
              data={pipelines}
              keyExtractor={item => item.id}
              renderItem={({ item }) => (
                <PipelineCard
                  pipeline={item}
                  onToggleEnabled={handleToggleEnabled}
                  togglingId={togglingId}
                />
              )}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => load(true)}
                  tintColor={theme.colors.accent}
                />
              }
              contentContainerStyle={pipelines.length === 0 ? s.emptyContainer : s.list}
              ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
              ListEmptyComponent={
                <View style={s.emptyContainer}>
                  <Text style={s.emptyText}>No pipelines configured.</Text>
                  <Text style={s.emptyHint}>Pipelines are defined in YAML config files on the server.</Text>
                </View>
              }
            />
      }
    </SafeAreaView>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.colors.background },
    list: { padding: t.spacing.sm, maxWidth: 800, alignSelf: 'center', width: '100%' },
    card: {
      backgroundColor: t.colors.surface,
      borderRadius: t.radius.md,
      padding: t.spacing.md,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: t.spacing.sm, gap: t.spacing.sm },
    cardMeta: { flex: 1 },
    pipelineName: { color: t.colors.text, fontSize: 16, fontWeight: '700', marginBottom: 2 },
    triggerText: { color: t.colors.accent, fontSize: 11, fontFamily: 'monospace' },
    filterLabel: { color: t.colors.placeholder, fontWeight: '600' },
    filterText: { color: t.colors.muted, fontSize: 12, fontFamily: 'monospace', marginBottom: 2 },
    stepsText: { color: t.colors.muted, fontSize: 12, fontFamily: 'monospace', marginBottom: 2 },
    metaText: { color: t.colors.placeholder, fontSize: 11, marginBottom: t.spacing.sm },
    sectionToggles: { flexDirection: 'row', gap: t.spacing.sm, flexWrap: 'wrap', marginTop: t.spacing.xs },
    sectionBtn: {
      paddingHorizontal: t.spacing.sm,
      paddingVertical: 4,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
    },
    sectionBtnActive: { backgroundColor: t.colors.accent + '22', borderColor: t.colors.accent },
    sectionBtnText: { color: t.colors.muted, fontSize: 12, fontFamily: 'monospace' },
    sectionBtnTextActive: { color: t.colors.accent, fontWeight: '700' },
    sectionBody: { marginTop: t.spacing.sm, borderTopWidth: 1, borderTopColor: t.colors.border, paddingTop: t.spacing.sm },
    emptySection: { color: t.colors.placeholder, fontSize: 12, fontStyle: 'italic', paddingVertical: 4 },
    jobRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, paddingVertical: 5 },
    jobDot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
    jobAge: { color: t.colors.placeholder, fontSize: 11, width: 56, flexShrink: 0 },
    jobDocTitle: { flex: 1, color: t.colors.muted, fontSize: 12, fontFamily: 'monospace' },
    jobDocLink: { color: t.colors.accent, fontWeight: '600' },
    docRow: { paddingVertical: t.spacing.sm, borderBottomWidth: 1, borderBottomColor: t.colors.border + '55' },
    docTitle: { color: t.colors.accent, fontSize: 13, fontWeight: '600', marginBottom: 2 },
    docUrl: { color: t.colors.placeholder, fontSize: 11, fontFamily: 'monospace' },
    centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl },
    errText: { color: t.colors.error, fontSize: 15, textAlign: 'center', marginBottom: t.spacing.md },
    retryBtn: { paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
    retryText: { color: t.colors.accent, fontSize: 15, fontWeight: '600' },
    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: t.spacing.xl, maxWidth: 800, alignSelf: 'center', width: '100%' },
    emptyText: { color: t.colors.muted, fontSize: 16, fontWeight: '600', marginBottom: t.spacing.sm },
    emptyHint: { color: t.colors.placeholder, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  })
}
