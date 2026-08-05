import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useUnistyles } from 'react-native-unistyles'
import { useConnection } from './ConnectionContext'
import { fetchLLMModels } from './llmModels'
import type { LLMModel, LLMModelGroup } from './llmModels'

// A model name belongs to exactly ONE provider: a Claude id sent to an Ollama box
// is a 404, which is a 4xx, which never falls back — the pipeline just dies. So
// the picker groups by provider and reports BOTH halves of the choice; the caller
// writes `model` and `provider` together and they can never disagree.
export type ModelChoice = { model: string; provider: string }

type Props = {
  visible: boolean
  value: string           // the currently configured model id ('' = provider default)
  provider: string        // the currently configured provider id ('' = the chain)
  onSelect: (choice: ModelChoice) => void
  onClose: () => void
}

type Section = { title: string; providerId: string; note: string; data: LLMModel[] }

export default function ModelPicker({ visible, value, provider, onSelect, onClose }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const { activeUrl, token } = useConnection()
  const searchRef = useRef<TextInput>(null)

  const [groups, setGroups] = useState<LLMModelGroup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!visible) return
    setQuery('')
    if (!activeUrl || !token) { setError('Not connected'); return }
    let cancelled = false
    setError(null)
    fetchLLMModels(activeUrl, token)
      .then(g => { if (!cancelled) setGroups(g) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load models') })
    return () => { cancelled = true }
  }, [visible, activeUrl, token])

  // The soft keyboard does not rise from autoFocus inside an animated Modal on
  // native (see app/CLAUDE.md) — focus from onShow, deferred.
  function handleShow() {
    if (Platform.OS === 'web') return
    searchRef.current?.focus()
    setTimeout(() => searchRef.current?.focus(), 250)
  }

  // Matching on the provider label too is what makes "ollama" or "anthropic" a
  // usable query when you know the box but not the model id.
  const sections: Section[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (groups ?? []).map(g => {
      const providerHit = g.provider_label.toLowerCase().includes(q) || g.provider_id.toLowerCase().includes(q)
      const models = !q || providerHit
        ? g.models
        : g.models.filter(m => `${m.id} ${m.label ?? ''}`.toLowerCase().includes(q))
      return {
        title: g.provider_label,
        providerId: g.provider_id,
        note: g.error ? g.error : `${g.role} · ${g.models.length}`,
        data: models,
      }
    }).filter(sec => sec.data.length > 0 || !q)
  }, [groups, query])

  const total = sections.reduce((n, sec) => n + sec.data.length, 0)

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} onShow={handleShow}>
      <View style={s.overlay}>
        <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="close model picker" />
        <View style={s.panel}>
          <View style={s.header}>
            <Text style={s.title}>Model</Text>
            <Pressable onPress={onClose} style={s.xBtn} hitSlop={10} accessibilityLabel="close">
              <Text style={s.xBtnText}>✕</Text>
            </Pressable>
          </View>

          <TextInput
            ref={searchRef}
            style={s.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Search models or providers…"
            placeholderTextColor={theme.colors.placeholder}
            accessibilityLabel="model search"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={Platform.OS === 'web'}
          />

          {/* Clearing the model is a real choice: it hands the decision back to the
              provider's default_model, which is what a fallback chain needs. */}
          <Pressable
            style={[s.row, s.defaultRow, !value && s.rowSelected]}
            onPress={() => onSelect({ model: '', provider })}
            accessibilityLabel="use provider default model"
          >
            <Text style={[s.modelId, !value && s.modelIdSelected]}>Provider default</Text>
            {!value ? <Text style={s.check}>✓</Text> : null}
          </Pressable>

          {error ? (
            <Text style={s.errorText}>{error}</Text>
          ) : groups === null ? (
            <ActivityIndicator size="small" color={theme.colors.accent} style={s.loading} />
          ) : total === 0 ? (
            <Text style={s.emptyText}>
              {query ? `No model matches "${query}"` : 'No models — run `just check-llm` to see why'}
            </Text>
          ) : (
            <SectionList
              sections={sections}
              keyExtractor={(item, i) => `${item.id}-${i}`}
              style={s.list}
              stickySectionHeadersEnabled={false}
              keyboardShouldPersistTaps="handled"
              renderSectionHeader={({ section }) => (
                <View style={s.sectionHead}>
                  <Text style={s.sectionTitle}>{section.title}</Text>
                  <Text style={s.sectionNote} numberOfLines={1}>{section.note}</Text>
                </View>
              )}
              renderItem={({ item, section }) => {
                const selected = item.id === value && section.providerId === provider
                return (
                  <Pressable
                    style={[s.row, selected && s.rowSelected]}
                    onPress={() => onSelect({ model: item.id, provider: section.providerId })}
                    accessibilityLabel={`model ${item.id}`}
                  >
                    <View style={s.rowText}>
                      <Text style={[s.modelId, selected && s.modelIdSelected]} numberOfLines={1}>{item.id}</Text>
                      {item.context_length ? (
                        <Text style={s.modelMeta}>{Math.round(item.context_length / 1000)}k ctx</Text>
                      ) : null}
                    </View>
                    {selected ? <Text style={s.check}>✓</Text> : null}
                  </Pressable>
                )
              }}
            />
          )}
        </View>
      </View>
    </Modal>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    overlay: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)' },
    panel: {
      backgroundColor: t.colors.surface,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingHorizontal: t.spacing.lg,
      paddingBottom: 40,
      maxHeight: '85%' as unknown as number,
    },
    header: { flexDirection: 'row', alignItems: 'center', paddingTop: t.spacing.lg, paddingBottom: t.spacing.sm },
    title: { flex: 1, fontSize: 17, fontWeight: '700', color: t.colors.text },
    xBtn: { padding: 4 },
    xBtnText: { fontSize: 16, color: t.colors.muted },
    search: {
      borderWidth: 1,
      borderColor: t.colors.border,
      borderRadius: 8,
      paddingHorizontal: t.spacing.md,
      paddingVertical: 8,
      color: t.colors.text,
      backgroundColor: t.colors.background,
      marginBottom: t.spacing.sm,
    },
    list: { marginTop: t.spacing.xs },
    sectionHead: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: t.spacing.sm,
      paddingTop: t.spacing.md,
      paddingBottom: 4,
    },
    sectionTitle: { fontSize: 12, fontWeight: '700', color: t.colors.text, textTransform: 'uppercase', letterSpacing: 0.5 },
    sectionNote: { flex: 1, fontSize: 11, color: t.colors.muted },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.spacing.sm,
      paddingVertical: 9,
      paddingHorizontal: t.spacing.sm,
      borderRadius: 6,
    },
    defaultRow: { borderWidth: 1, borderColor: t.colors.border, marginBottom: t.spacing.xs },
    rowSelected: { backgroundColor: t.colors.background },
    rowText: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: t.spacing.sm },
    modelId: { flex: 1, fontSize: 13, color: t.colors.text },
    modelIdSelected: { fontWeight: '700', color: t.colors.accent },
    modelMeta: { fontSize: 11, color: t.colors.muted },
    check: { fontSize: 13, color: t.colors.accent, fontWeight: '700' },
    loading: { alignSelf: 'flex-start', marginVertical: t.spacing.md },
    emptyText: { fontSize: 13, color: t.colors.muted, paddingVertical: t.spacing.md },
    errorText: { fontSize: 13, color: t.colors.error, paddingVertical: t.spacing.md },
  })
}
