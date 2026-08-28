import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ContextMenuItem, ContextMenuPrefs } from './api'
import type { PendingSelection } from './AnnotationPanel'
import type { TemplateVars } from './contextMenu'
import {
  DEFAULT_SEARCH_TEMPLATE,
  defaultContextMenu,
  enabledItems,
  loadContextMenu,
  renderTemplate,
  renderUrlTemplate,
} from './contextMenu'
import SelectionMenuSheet from './SelectionMenuSheet'
import AiPopout from './AiPopout'
import type { AiRequest } from './AiPopout'
import { copyToClipboard } from './clipboard'
import { openExternal } from './openExternal'
import { useConnection } from './ConnectionContext'
import { useToast } from './ToastContext'

interface Props {
  /** The selection the "···" was pressed on. Null = nothing open. */
  selection: PendingSelection | null
  documentTitle: string
  /** Feeds {{article_summary}} — the document's summary Highlight, or its head. */
  articleSummary: string
  /** Called with the AI answer when the user keeps it; the host anchors it. */
  onSaveNote: (selection: PendingSelection, answer: string) => void
  onClose: () => void
}

// Everything behind the "···" next to Annotate: the sheet of configured actions
// and the AI popout the two LLM-backed ones open. Kept out of the document screen
// because it is one self-contained interaction with its own config, and the video
// screen will want the same one.
export default function SelectionActions({ selection, documentTitle, articleSummary, onSaveNote, onClose }: Props) {
  const { activeUrl, token } = useConnection()
  const { toast } = useToast()

  const [menu, setMenu] = useState<ContextMenuPrefs | null>(null)
  const [request, setRequest] = useState<AiRequest | null>(null)
  // The selection the popout's answer belongs to: the sheet closes when the popout
  // opens, and the answer must anchor to what was selected, not to nothing.
  const [target, setTarget] = useState<PendingSelection | null>(null)

  // Re-read on every open: the config is server-held, so another device (or the
  // Settings screen) may have changed it since the last selection.
  useEffect(() => {
    if (!selection) return
    let cancelled = false
    loadContextMenu(activeUrl, token)
      .then(m => { if (!cancelled) setMenu(m) })
      .catch(() => { if (!cancelled) setMenu(defaultContextMenu()) })
    return () => { cancelled = true }
  }, [selection, activeUrl, token])

  const vars = useMemo<TemplateVars>(() => ({
    selection: selection?.exact ?? '',
    selection_wider_context: selection
      ? `${selection.wide_prefix ?? selection.prefix}${selection.exact}${selection.wide_suffix ?? selection.suffix}`
      : '',
    article_title: documentTitle,
    article_summary: articleSummary,
  }), [selection, documentTitle, articleSummary])

  const handlePick = useCallback(async (item: ContextMenuItem) => {
    const sel = selection
    if (!sel) return
    switch (item.kind) {
      case 'copy': {
        onClose()
        const ok = await copyToClipboard(sel.exact)
        toast(ok ? 'Copied' : 'Copy failed', ok ? 'success' : 'error')
        return
      }
      case 'web_search':
        onClose()
        openExternal(renderUrlTemplate(item.template || DEFAULT_SEARCH_TEMPLATE, vars))
        return
      case 'translate':
        setTarget(sel)
        onClose()
        setRequest({
          title: item.title, kind: 'translate', text: sel.exact,
          lang: item.lang || 'en', engine: item.engine ?? 'llm',
          system: menu?.master_prompt, provider: item.provider, model: item.model,
        })
        return
      case 'ask': {
        const prompt = renderTemplate(item.template ?? '', vars).trim()
        if (!prompt) {
          toast('That action has no prompt — add one in Settings', 'error')
          return
        }
        setTarget(sel)
        onClose()
        setRequest({
          title: item.title, kind: 'ask', text: prompt,
          system: menu?.master_prompt, provider: item.provider, model: item.model,
        })
        return
      }
    }
  }, [selection, vars, menu, onClose, toast])

  const handleSave = useCallback((answer: string) => {
    const sel = target
    setRequest(null)
    setTarget(null)
    if (sel) onSaveNote(sel, answer)
  }, [target, onSaveNote])

  return (
    <>
      <SelectionMenuSheet
        visible={selection !== null}
        selection={selection?.exact ?? ''}
        items={menu ? enabledItems(menu) : []}
        loading={menu === null}
        onPick={handlePick}
        onClose={onClose}
      />
      <AiPopout
        request={request}
        onSave={handleSave}
        onClose={() => { setRequest(null); setTarget(null) }}
      />
    </>
  )
}
