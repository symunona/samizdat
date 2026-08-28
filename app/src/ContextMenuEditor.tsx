import { useCallback, useMemo, useState } from 'react'
import { Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useUnistyles } from 'react-native-unistyles'
import type { ContextMenuItem, ContextMenuPrefs } from './api'
import { DEFAULT_SEARCH_TEMPLATE, TEMPLATE_TOKENS } from './contextMenu'
import { displayLang, parseLangInput } from './langNames'
import { hasBrowserTranslator } from './translate'
import ModelPicker from './ModelPicker'
import type { ModelChoice } from './ModelPicker'
import IconButton from './IconButton'
import { uuidv4 } from './store/uuid'

interface Props {
  menu: ContextMenuPrefs
  /** Persists the whole menu — the server merges by key, so it is one PUT. */
  onChange: (next: ContextMenuPrefs) => void
}

const TOKEN_HINT = TEMPLATE_TOKENS.map(t => `{{${t}}}`).join(' · ')

// The editor for the reader's selection "···" menu. Every edit writes the WHOLE
// menu back (it is one settings blob, not per-item rows), so the caller can save
// with a single patch and the offline cache stays a copy of exactly what is stored.
export default function ContextMenuEditor({ menu, onChange }: Props) {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  const [picking, setPicking] = useState<string | null>(null)
  // Text fields are edited locally and committed on blur — a PUT per keystroke
  // would be a request per character and would fight the controlled value.
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const draft = (key: string, stored: string) => drafts[key] ?? stored
  const setDraft = (key: string, v: string) => setDrafts(d => ({ ...d, [key]: v }))
  const clearDraft = (key: string) => setDrafts(d => { const n = { ...d }; delete n[key]; return n })

  const patchItem = useCallback((id: string, patch: Partial<ContextMenuItem>) => {
    onChange({ ...menu, items: menu.items.map(it => (it.id === id ? { ...it, ...patch } : it)) })
  }, [menu, onChange])

  const removeItem = useCallback((id: string) => {
    onChange({ ...menu, items: menu.items.filter(it => it.id !== id) })
  }, [menu, onChange])

  const addAsk = useCallback(() => {
    const item: ContextMenuItem = {
      id: uuidv4(), kind: 'ask', title: 'New question', enabled: true,
      template: 'Context: {{selection_wider_context}}\n\nAbout this part: {{selection}}',
    }
    onChange({ ...menu, items: [...menu.items, item] })
  }, [menu, onChange])

  const commitField = (item: ContextMenuItem, field: 'title' | 'template' | 'lang', key: string) => () => {
    const value = drafts[key]
    clearDraft(key)
    if (value === undefined) return
    if (field === 'lang') {
      const code = parseLangInput(value)
      if (code && code !== item.lang) patchItem(item.id, { lang: code })
      return
    }
    if (value !== (item[field] ?? '')) patchItem(item.id, { [field]: value })
  }

  const renderModelRow = (item: ContextMenuItem) => (
    <>
      <Pressable style={s.picker} onPress={() => setPicking(item.id)} testID={`ctxmenu-model-${item.id}`}>
        <Text style={s.pickerText} numberOfLines={1}>
          {item.model || 'Provider default'}
          {item.provider ? ` · ${item.provider}` : ''}
        </Text>
        <Ionicons name="chevron-down" size={14} color={theme.colors.muted} />
      </Pressable>
      <ModelPicker
        visible={picking === item.id}
        value={item.model ?? ''}
        provider={item.provider ?? ''}
        // model AND provider in ONE update: a model naming a different endpoint
        // than its provider is a 404 with no fallback (see ModelPicker).
        onSelect={(choice: ModelChoice) => {
          patchItem(item.id, { model: choice.model, provider: choice.provider })
          setPicking(null)
        }}
        onClose={() => setPicking(null)}
      />
    </>
  )

  const renderItem = (item: ContextMenuItem) => {
    const titleKey = `${item.id}:title`
    const tmplKey = `${item.id}:template`
    const langKey = `${item.id}:lang`
    return (
      <View key={item.id} style={s.item} testID={`ctxmenu-item-${item.id}`}>
        <View style={s.itemHeader}>
          {item.kind === 'ask' ? (
            <TextInput
              style={s.titleInput}
              value={draft(titleKey, item.title)}
              onChangeText={v => setDraft(titleKey, v)}
              onBlur={commitField(item, 'title', titleKey)}
              placeholder="Action name"
              placeholderTextColor={theme.colors.placeholder}
              accessibilityLabel="Action name"
            />
          ) : (
            <Text style={s.itemTitle}>{item.title}</Text>
          )}
          <Switch
            value={item.enabled}
            onValueChange={enabled => patchItem(item.id, { enabled })}
            accessibilityLabel={`${item.title} enabled`}
            trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
            thumbColor={theme.colors.background}
          />
          {item.kind === 'ask' && (
            <IconButton name="trash-outline" onPress={() => removeItem(item.id)} />
          )}
        </View>

        {item.kind === 'web_search' && (
          <TextInput
            style={s.input}
            value={draft(tmplKey, item.template ?? DEFAULT_SEARCH_TEMPLATE)}
            onChangeText={v => setDraft(tmplKey, v)}
            onBlur={commitField(item, 'template', tmplKey)}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Search URL"
          />
        )}

        {item.kind === 'translate' && (
          <>
            <View style={s.row}>
              <Text style={s.label}>Into</Text>
              <TextInput
                style={s.langInput}
                value={draft(langKey, displayLang(item.lang ?? 'en'))}
                onChangeText={v => setDraft(langKey, v)}
                onBlur={commitField(item, 'lang', langKey)}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Target language"
              />
            </View>
            <View style={s.row}>
              {(['llm', 'browser'] as const).map(engine => (
                <Pressable
                  key={engine}
                  style={[s.segment, (item.engine ?? 'llm') === engine && s.segmentOn]}
                  onPress={() => patchItem(item.id, { engine })}
                >
                  <Text style={[s.segmentText, (item.engine ?? 'llm') === engine && s.segmentTextOn]}>
                    {engine === 'llm' ? 'LLM' : 'Browser built-in'}
                  </Text>
                </Pressable>
              ))}
            </View>
            {item.engine === 'browser' && !hasBrowserTranslator() && (
              <Text style={s.hint}>
                {Platform.OS === 'web'
                  ? 'This browser has no built-in translator — those requests fall back to the LLM.'
                  : 'No built-in translator on the app — those requests fall back to the LLM.'}
              </Text>
            )}
            {(item.engine ?? 'llm') === 'llm' && renderModelRow(item)}
          </>
        )}

        {item.kind === 'ask' && (
          <>
            <TextInput
              style={[s.input, s.templateInput]}
              value={draft(tmplKey, item.template ?? '')}
              onChangeText={v => setDraft(tmplKey, v)}
              onBlur={commitField(item, 'template', tmplKey)}
              multiline
              placeholder="Prompt…"
              placeholderTextColor={theme.colors.placeholder}
              accessibilityLabel="Prompt template"
            />
            <Text style={s.hint}>{TOKEN_HINT}</Text>
            {renderModelRow(item)}
          </>
        )}
      </View>
    )
  }

  const masterKey = 'master_prompt'
  return (
    <View style={s.wrap}>
      <Text style={s.label}>Master prompt</Text>
      <TextInput
        style={[s.input, s.templateInput]}
        value={draft(masterKey, menu.master_prompt)}
        onChangeText={v => setDraft(masterKey, v)}
        onBlur={() => {
          const v = drafts[masterKey]
          clearDraft(masterKey)
          if (v !== undefined && v !== menu.master_prompt) onChange({ ...menu, master_prompt: v })
        }}
        multiline
        placeholder="Persona sent with every AI action…"
        placeholderTextColor={theme.colors.placeholder}
        accessibilityLabel="Master prompt"
      />

      {menu.items.map(renderItem)}

      <Pressable style={s.addBtn} onPress={addAsk} testID="ctxmenu-add">
        <Ionicons name="add" size={16} color={theme.colors.accent} />
        <Text style={s.addText}>Add AI question</Text>
      </Pressable>
    </View>
  )
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    wrap: { gap: t.spacing.sm },
    item: {
      borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radius.sm,
      padding: t.spacing.sm, gap: t.spacing.sm,
    },
    itemHeader: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    itemTitle: { flex: 1, color: t.colors.text, fontSize: 14, fontWeight: '600' },
    titleInput: {
      flex: 1, color: t.colors.text, fontSize: 14, fontWeight: '600',
      borderBottomWidth: 1, borderBottomColor: t.colors.border, paddingVertical: 2,
    },
    input: {
      backgroundColor: t.colors.background, color: t.colors.text,
      borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.sm, fontSize: 13,
    },
    templateInput: { minHeight: 72, textAlignVertical: 'top' },
    row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
    label: { color: t.colors.muted, fontSize: 12 },
    langInput: {
      flex: 1, backgroundColor: t.colors.background, color: t.colors.text,
      borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.sm, fontSize: 13,
    },
    segment: {
      paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm - 2,
      borderRadius: t.radius.sm, borderWidth: 1, borderColor: t.colors.border,
    },
    segmentOn: { borderColor: t.colors.accent, backgroundColor: t.colors.background },
    segmentText: { color: t.colors.muted, fontSize: 12, fontWeight: '600' },
    segmentTextOn: { color: t.colors.accent },
    hint: { color: t.colors.muted, fontSize: 11 },
    picker: {
      flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm,
      borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radius.sm,
      paddingHorizontal: t.spacing.sm, paddingVertical: t.spacing.sm,
    },
    pickerText: { flex: 1, color: t.colors.text, fontSize: 13 },
    addBtn: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs, paddingVertical: t.spacing.sm },
    addText: { color: t.colors.accent, fontSize: 13, fontWeight: '600' },
  })
}
