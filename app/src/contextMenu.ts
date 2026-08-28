// The reader's selection context menu: the "···" next to Annotate.
//
// The config is SERVER-held (`ctxmenu.Prefs`, a server_settings row served by
// /api/v1/settings), so a template written on the desktop is the one the phone
// offers. The last good copy is cached in the replica's settings table, so the
// sheet still opens offline — the two device-local actions (copy, web search)
// keep working there; the two that need the LLM say so.
import type { ContextMenuItem, ContextMenuPrefs } from './api'
import { fetchSettings } from './api'
import { getSetting, setSetting } from './db'

const CACHE_KEY = 'samizdat_context_menu_cache'

export const DEFAULT_SEARCH_TEMPLATE = 'https://www.google.com/search?q={{selection}}'

// Mirrors ctxmenu.Default() on the server — what a device shows before it has
// ever reached one.
export function defaultContextMenu(): ContextMenuPrefs {
  return {
    master_prompt: '',
    items: [
      { id: 'copy', kind: 'copy', title: 'Copy to clipboard', enabled: true },
      { id: 'web_search', kind: 'web_search', title: 'Web search', enabled: true, template: DEFAULT_SEARCH_TEMPLATE },
      { id: 'translate', kind: 'translate', title: 'Translate', enabled: false, lang: 'en', engine: 'llm' },
      {
        id: 'explain', kind: 'ask', title: 'Explain simply', enabled: false,
        template: "Context: {{selection_wider_context}}\n\nIn layman's terms, explain the following part, super brief: {{selection}}",
      },
    ],
  }
}

// The variables a template may name. Kept small on purpose: every one of them has
// to be derivable from what the WebView reports plus the open Document.
export type TemplateVars = {
  selection: string
  selection_wider_context: string
  article_title: string
  article_summary: string
}

export const TEMPLATE_TOKENS: (keyof TemplateVars)[] = [
  'selection', 'selection_wider_context', 'article_title', 'article_summary',
]

// renderTemplate expands {{token}} in ONE pass — mirroring the server's
// pipeline/prompt.go. A selection that itself contains "{{selection}}" must never
// be re-expanded, which a naive chain of replaces would do.
export function renderTemplate(tmpl: string, vars: TemplateVars): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in vars ? String(vars[name as keyof TemplateVars] ?? '') : whole)
}

// The search URL is the same template machinery with the values percent-encoded —
// a selection with an "&" in it must not turn into two query parameters.
export function renderUrlTemplate(tmpl: string, vars: TemplateVars): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in vars ? encodeURIComponent(String(vars[name as keyof TemplateVars] ?? '')) : whole)
}

// Normalizes what came off the wire: Go emits an empty slice as null (see the
// nil-slice rule), and an unknown kind would render a row that does nothing.
export function normalizeContextMenu(p: ContextMenuPrefs | null | undefined): ContextMenuPrefs {
  if (!p) return defaultContextMenu()
  const items = (p.items ?? []).filter(it => it && it.id && isKnownKind(it.kind))
  return { master_prompt: p.master_prompt ?? '', items }
}

function isKnownKind(k: string): boolean {
  return k === 'copy' || k === 'web_search' || k === 'translate' || k === 'ask'
}

export function enabledItems(p: ContextMenuPrefs): ContextMenuItem[] {
  return p.items.filter(it => it.enabled)
}

// loadContextMenu prefers the server (the authority) and falls back to the cached
// copy. Every successful fetch rewrites the cache, so going offline keeps the menu
// the user last saw rather than the built-in defaults.
export async function loadContextMenu(
  serverUrl: string | null, token: string | null,
): Promise<ContextMenuPrefs> {
  if (serverUrl && token) {
    try {
      const settings = await fetchSettings(serverUrl, token)
      const menu = normalizeContextMenu(settings.context_menu)
      await setSetting(CACHE_KEY, JSON.stringify(menu))
      return menu
    } catch { /* fall through to the cache — offline is not an error here */ }
  }
  const raw = await getSetting(CACHE_KEY)
  if (!raw) return defaultContextMenu()
  try {
    return normalizeContextMenu(JSON.parse(raw) as ContextMenuPrefs)
  } catch {
    return defaultContextMenu()
  }
}

// cacheContextMenu keeps the offline copy in step after the Settings editor saves.
export async function cacheContextMenu(menu: ContextMenuPrefs): Promise<void> {
  await setSetting(CACHE_KEY, JSON.stringify(normalizeContextMenu(menu)))
}
