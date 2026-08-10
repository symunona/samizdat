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
  TextInput,
  View,
} from 'react-native'
import { useRouter, useFocusEffect } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import {
  fetchPipelines,
  fetchPipelineDocuments,
  fetchPipelineJobs,
  fetchStepCatalog,
  parseSteps,
  patchPipeline,
  putPipelineSteps,
} from '../../src/api'
import type {
  Pipeline, Document, Job, PipelineFilter, PipelineStep, StepFieldSpec, StepKindSpec,
} from '../../src/api'
import { useConnection } from '../../src/ConnectionContext'
import IconButton from '../../src/IconButton'
import ModelPicker from '../../src/ModelPicker'
import type { ModelChoice } from '../../src/ModelPicker'
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

// The only keys the server matches on — pipeline.PipelineFilter, mirrored by
// PipelineFilter in api.ts. Anything else is rendered verbatim as `key: value`
// so a filter key added on the Go side can never silently read "all documents".
const FILTER_LABELS: Record<keyof PipelineFilter, string> = {
  feed_url_contains: 'feed url contains',
  source_feed_id: 'feed',
  exclude_feed_url_contains: 'excluding feed url',
  exclude_source_feed_ids: 'excluding feed',
}

function filterValueText(v: unknown): string {
  return Array.isArray(v) ? v.map(String).join(', ') : String(v)
}

function summarizeFilter(filterJson: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(filterJson || '{}') } catch { return filterJson || 'all documents' }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return filterJson || 'all documents'
  const parts = Object.entries(parsed as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${FILTER_LABELS[k as keyof PipelineFilter] ?? k}: ${filterValueText(v)}`)
  return parts.length ? parts.join(', ') : 'all documents'
}

function summarizeSteps(stepsJson: string): string {
  try {
    const steps = JSON.parse(stepsJson) as Array<{ kind?: string; type?: string; name?: string }>
    if (!Array.isArray(steps) || steps.length === 0) return 'no steps'
    return steps.map((s, i) => `${i + 1}. ${s.kind ?? s.type ?? s.name ?? 'step'}`).join(' → ')
  } catch { return stepsJson || 'no steps' }
}

// ── Step config editor ───────────────────────────────────────────────────────
// A step's config is free-form JSON; the catalog (GET /api/v1/pipeline-steps)
// describes the keys a kind knows about. Keys the catalog does not describe are
// still editable — a pipeline row can carry anything.

type FieldType = 'string' | 'text' | 'int' | 'float' | 'bool' | 'json' | 'model'

type StepFieldRow = {
  key: string
  label: string
  help: string
  type: FieldType
  placeholder: string
  value: string | boolean
  present: boolean  // the key exists in the stored config (an absent+blank one is not written back)
}

type StepDraft = { kind: string; label: string; description: string; rows: StepFieldRow[] }

// Credentials never reach a client (design rule 5): they belong to the LLM Router
// (config.toml + env), no step kind declares one, and the server strips any
// credential-named key from every read path. This mirrors that same key-name test
// as the second lock — a leaked credential must not become a rendered, re-savable
// input, and the raw-JSON view is rebuilt through it too.
const SECRET_KEY = /api[_-]?key|secret|token|password|passphrase/i
// `max_tokens` is a completion cap that happens to contain "token" — without this
// exception the field never renders and the next save drops it. Mirrors
// `notCredentialRe` in the server's steps_json.go; keep the two in step.
const NOT_SECRET_KEY = /^max_tokens$/i
function isSecretField(key: string): boolean {
  return SECRET_KEY.test(key) && !NOT_SECRET_KEY.test(key)
}

// The key is always shown, so a label that is only the key re-cased ("base_url" →
// "Base URL") is noise in a two-column table. Show it only when it says something new.
function addsMeaning(label: string, key: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[_\-\s]/g, '')
  return norm(label) !== norm(key)
}

const SPEC_TYPES: FieldType[] = ['text', 'int', 'float', 'bool', 'string', 'model']

function fieldType(spec: StepFieldSpec | undefined, value: unknown): FieldType {
  if (spec && (SPEC_TYPES as string[]).includes(spec.type)) {
    return spec.type as FieldType
  }
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float'
  if (value !== null && typeof value === 'object') return 'json'
  return typeof value === 'string' && value.length > 80 ? 'text' : 'string'
}

function toDraftValue(v: unknown, type: FieldType): string | boolean {
  if (type === 'bool') return v === true || v === 'true'
  if (v === undefined || v === null) return ''
  if (type === 'json') return JSON.stringify(v, null, 2)
  return String(v)
}

// Throws with a human-readable reason — the Save handler surfaces it as the row's
// error, so junk in an int/JSON field never reaches the server.
function fromDraftValue(row: StepFieldRow): unknown {
  if (row.type === 'bool') return row.value === true
  const text = String(row.value)
  if (row.type === 'int' || row.type === 'float') {
    const n = Number(text)
    if (!Number.isFinite(n)) throw new Error(`${row.label}: "${text}" is not a number`)
    return row.type === 'int' ? Math.trunc(n) : n
  }
  if (row.type === 'json') {
    try { return JSON.parse(text) } catch { throw new Error(`${row.label}: invalid JSON`) }
  }
  return text
}

function buildDrafts(pipeline: Pipeline, catalog: StepKindSpec[]): StepDraft[] {
  return parseSteps(pipeline).map(step => {
    const spec = catalog.find(k => k.kind === step.kind)
    const fields = spec?.fields ?? []
    const extraKeys = Object.keys(step.config).filter(k => !fields.some(f => f.key === k))
    const rows: StepFieldRow[] = [...fields.map(f => f.key), ...extraKeys]
      .filter(key => !isSecretField(key))
      .map(key => {
        const fs = fields.find(f => f.key === key)
        const raw = step.config[key]
        const type = fieldType(fs, raw)
        return {
          key,
          label: fs?.label || key,
          help: fs?.help ?? '',
          type,
          placeholder: fs?.default === undefined || fs.default === null ? '' : String(toDraftValue(fs.default, type)),
          value: toDraftValue(raw, type),
          present: key in step.config,
        }
      })
    return {
      kind: step.kind,
      label: spec?.label || step.kind || 'step',
      description: spec?.description ?? '',
      rows,
    }
  })
}

function draftsToSteps(drafts: StepDraft[]): PipelineStep[] {
  return drafts.map(d => {
    const config: Record<string, unknown> = {}
    for (const row of d.rows) {
      if (!row.present && (row.value === '' || row.value === false)) continue
      config[row.key] = fromDraftValue(row)
    }
    return { kind: d.kind, config }
  })
}

// Rebuilt from the parsed steps rather than echoing the stored string, so the raw
// view cannot become the one place a credential shows up.
function prettySteps(pipeline: Pipeline): string {
  const steps = parseSteps(pipeline).map(step => {
    return {
      kind: step.kind,
      config: Object.fromEntries(
        Object.entries(step.config).filter(([k]) => !isSecretField(k)),
      ),
    }
  })
  return JSON.stringify(steps, null, 2)
}

// A prompt is long enough to swallow the card, so a text field opens at ~4 lines
// and expands on demand. RN-Web maps numberOfLines to <textarea rows>; native
// Android honours it only with an explicit height, hence both.
const FIELD_LINE_H = 18
const FIELD_LINES = 4
const FIELD_LINES_EXPANDED = 16

function StepFieldEditor({ step, row, onChange, onPickModel }: {
  step: StepDraft
  row: StepFieldRow
  onChange: (value: string | boolean) => void
  // A model choice writes model AND provider (see ModelPicker) — one callback for
  // both, so the two can never end up naming different endpoints.
  onPickModel: (choice: ModelChoice) => void
}) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const [expanded, setExpanded] = useState(false)
  const [picking, setPicking] = useState(false)
  const multiline = row.type === 'text' || row.type === 'json'
  const lines = expanded ? FIELD_LINES_EXPANDED : FIELD_LINES
  const label = `${step.kind} ${row.key}`
  const providerValue = String(step.rows.find(r => r.key === 'provider')?.value ?? '')

  return (
    <View style={s.fieldRow}>
      <View style={s.fieldHead}>
        <Text style={s.fieldKey}>{row.key}</Text>
        {addsMeaning(row.label, row.key) ? <Text style={s.fieldLabel}>{row.label}</Text> : null}
        {multiline
          ? <IconButton
              name={expanded ? 'contract-outline' : 'expand-outline'}
              size={14}
              onPress={() => setExpanded(v => !v)}
            />
          : null}
      </View>
      {row.help ? <Text style={s.fieldHelp}>{row.help}</Text> : null}
      {row.type === 'model' ? (
        <>
          <Pressable style={s.fieldPicker} onPress={() => setPicking(true)} accessibilityLabel={label}>
            <Text style={[s.fieldPickerText, !row.value && s.fieldPickerPlaceholder]} numberOfLines={1}>
              {row.value ? String(row.value) : 'Provider default'}
            </Text>
            <Text style={s.fieldPickerCaret}>▾</Text>
          </Pressable>
          <ModelPicker
            visible={picking}
            value={String(row.value)}
            provider={providerValue}
            onSelect={choice => { onPickModel(choice); setPicking(false) }}
            onClose={() => setPicking(false)}
          />
        </>
      ) : row.type === 'bool'
        ? <Switch
            value={row.value === true}
            onValueChange={onChange}
            accessibilityLabel={label}
            trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
            thumbColor={theme.colors.background}
          />
        : <TextInput
            style={[s.fieldInput, multiline && s.fieldInputMultiline, multiline && { minHeight: lines * FIELD_LINE_H }]}
            value={String(row.value)}
            onChangeText={onChange}
            accessibilityLabel={label}
            placeholder={row.placeholder}
            placeholderTextColor={theme.colors.placeholder}
            multiline={multiline}
            numberOfLines={multiline ? lines : 1}
            inputMode={row.type === 'int' ? 'numeric' : row.type === 'float' ? 'decimal' : 'text'}
            autoCapitalize="none"
            autoCorrect={false}
          />
      }
    </View>
  )
}

type PipelineCardProps = {
  pipeline: Pipeline
  catalog: StepKindSpec[]
  onToggleEnabled: (p: Pipeline) => void
  onPipelineSaved: (p: Pipeline) => void
  togglingId: string | null
}

type ExpandedSection = 'jobs' | 'docs' | 'steps' | null

function PipelineCard({ pipeline, catalog, onToggleEnabled, onPipelineSaved, togglingId }: PipelineCardProps) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const router = useRouter()
  const { activeUrl, token } = useConnection()
  const { toast } = useToast()

  const [expanded, setExpanded] = useState<ExpandedSection>(null)
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [docs, setDocs] = useState<Document[] | null>(null)
  const [loadingJobs, setLoadingJobs] = useState(false)
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [drafts, setDrafts] = useState<StepDraft[] | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function toggleSection(section: ExpandedSection) {
    if (expanded === section) {
      setExpanded(null)
      return
    }
    setExpanded(section)
    if (section === 'steps' && drafts === null) setDrafts(buildDrafts(pipeline, catalog))
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

  function setFieldValue(stepIdx: number, key: string, value: string | boolean) {
    setDrafts(prev => prev?.map((d, i) => i !== stepIdx
      ? d
      : { ...d, rows: d.rows.map(r => r.key === key ? { ...r, value, present: true } : r) }) ?? null)
  }

  // Both keys in ONE update: two setFieldValue calls would each start from the
  // pre-update drafts, so the second would drop the first's write.
  function setModelChoice(stepIdx: number, choice: ModelChoice) {
    setDrafts(prev => prev?.map((d, i) => i !== stepIdx
      ? d
      : {
          ...d,
          rows: d.rows.map(r => {
            if (r.key === 'model') return { ...r, value: choice.model, present: true }
            if (r.key === 'provider') return { ...r, value: choice.provider, present: true }
            return r
          }),
        }) ?? null)
  }

  async function saveSteps() {
    if (!activeUrl || !token || !drafts || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const updated = await putPipelineSteps(activeUrl, token, pipeline.id, draftsToSteps(drafts))
      onPipelineSaved(updated)
      setDrafts(buildDrafts(updated, catalog))
      toast('Steps saved', 'success')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save steps'
      setSaveError(msg)
      toast(msg, 'error')
    } finally {
      setSaving(false)
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
          style={[s.sectionBtn, expanded === 'steps' && s.sectionBtnActive]}
          onPress={() => toggleSection('steps')}
        >
          <Text style={[s.sectionBtnText, expanded === 'steps' && s.sectionBtnTextActive]}>
            {expanded === 'steps' ? '▼' : '▶'} Steps
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

      {/* Steps section — the step config the server actually runs, editable. */}
      {expanded === 'steps' && (
        <View style={s.sectionBody}>
          <View style={s.stepsBar}>
            <Pressable style={s.sectionBtn} onPress={() => setShowRaw(v => !v)}>
              <Text style={[s.sectionBtnText, showRaw && s.sectionBtnTextActive]}>
                {showRaw ? 'hide raw JSON' : 'raw JSON'}
              </Text>
            </Pressable>
            <Pressable
              style={[s.saveBtn, saving && s.saveBtnBusy, !!saveError && s.saveBtnError]}
              onPress={saveSteps}
              disabled={saving || drafts === null}
              accessibilityLabel={`Save steps ${pipeline.name}`}
            >
              {saving
                ? <ActivityIndicator size="small" color={theme.colors.accent} />
                : <Text style={[s.saveBtnText, !!saveError && s.saveBtnTextError]}>Save</Text>}
            </Pressable>
          </View>
          {saveError ? <Text style={s.saveErrorText}>{saveError}</Text> : null}
          {showRaw
            ? <Text style={s.rawJson} selectable>{prettySteps(pipeline)}</Text>
            : null}
          {drafts === null || drafts.length === 0
            ? <Text style={s.emptySection}>No steps configured.</Text>
            : drafts.map((step, i) => (
                <View key={`${step.kind}-${i}`} style={s.stepBlock}>
                  <Text style={s.stepLabel}>{i + 1}. {step.label}</Text>
                  {step.description ? <Text style={s.stepDescription}>{step.description}</Text> : null}
                  {step.rows.length === 0
                    ? <Text style={s.emptySection}>No configuration.</Text>
                    : step.rows.map(row => (
                        <StepFieldEditor
                          key={row.key}
                          step={step}
                          row={row}
                          onChange={v => setFieldValue(i, row.key, v)}
                          onPickModel={choice => setModelChoice(i, choice)}
                        />
                      ))}
                </View>
              ))}
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
  const [catalog, setCatalog] = useState<StepKindSpec[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const load = useCallback(async (isRefresh = false) => {
    if (!activeUrl || !token) return
    isRefresh ? setRefreshing(true) : setLoading(true)
    setError(null)
    try {
      // The catalog only labels + types the step editor: an older server without
      // the endpoint still lists pipelines, its config keys just render verbatim.
      const [data, kinds] = await Promise.all([
        fetchPipelines(activeUrl, token),
        fetchStepCatalog(activeUrl, token).catch(() => [] as StepKindSpec[]),
      ])
      setPipelines(data ?? [])
      setCatalog(kinds ?? [])
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
                  catalog={catalog}
                  onToggleEnabled={handleToggleEnabled}
                  onPipelineSaved={updated => setPipelines(prev => prev.map(p => p.id === updated.id ? updated : p))}
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
                  <Text style={s.emptyHint}>
                    A pipeline turns scraped Documents into Highlights. They are rows in the server database,
                    created through the API (POST /api/v1/pipelines) — once one exists, tune its steps here.
                  </Text>
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
    stepsBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.sm },
    saveBtn: {
      minWidth: 72,
      alignItems: 'center',
      paddingHorizontal: t.spacing.md,
      paddingVertical: 5,
      borderRadius: t.radius.sm,
      borderWidth: 1,
      borderColor: t.colors.accent,
      backgroundColor: t.colors.accent + '22',
    },
    saveBtnBusy: { opacity: 0.6 },
    saveBtnError: { borderColor: t.colors.error, backgroundColor: t.colors.error + '18' },
    saveBtnText: { color: t.colors.accent, fontSize: 13, fontWeight: '700' },
    saveBtnTextError: { color: t.colors.error },
    saveErrorText: { color: t.colors.error, fontSize: 12, marginTop: t.spacing.xs },
    rawJson: {
      color: t.colors.muted,
      fontSize: 11,
      fontFamily: 'monospace',
      backgroundColor: t.colors.background,
      borderRadius: t.radius.sm,
      padding: t.spacing.sm,
      marginTop: t.spacing.sm,
    },
    stepBlock: { marginTop: t.spacing.md },
    stepLabel: { color: t.colors.text, fontSize: 13, fontWeight: '700' },
    stepDescription: { color: t.colors.placeholder, fontSize: 11, marginTop: 2 },
    fieldRow: { marginTop: t.spacing.sm },
    fieldHead: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
    fieldKey: { color: t.colors.muted, fontSize: 11, fontFamily: 'monospace' },
    fieldLabel: { color: t.colors.placeholder, fontSize: 11, flex: 1 },
    fieldHelp: { color: t.colors.placeholder, fontSize: 10, marginTop: 1 },
    fieldInput: {
      color: t.colors.text,
      fontSize: 12,
      fontFamily: 'monospace',
      backgroundColor: t.colors.background,
      borderWidth: 1,
      borderColor: t.colors.border,
      borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: 6,
      marginTop: 3,
    },
    fieldPicker: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      borderWidth: 1,
      borderColor: t.colors.border,
      borderRadius: 6,
      paddingHorizontal: t.spacing.sm,
      paddingVertical: 7,
      backgroundColor: t.colors.background,
    },
    fieldPickerText: { flex: 1, fontSize: 12, color: t.colors.text },
    fieldPickerPlaceholder: { color: t.colors.placeholder },
    fieldPickerCaret: { fontSize: 11, color: t.colors.muted },
    fieldInputMultiline: { textAlignVertical: 'top' },
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
