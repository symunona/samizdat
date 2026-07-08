import { useSyncStore } from './syncStore'
import type { Highlight, HighlightWithDoc, Tag } from '../api'

// Build a highlight list straight from the persisted replica so the feed / starred /
// archived screens render OFFLINE (every highlight is already synced locally). Mirrors
// the server's HighlightWithDoc shape: created_at DESC, document title/url + tags joined
// from the store. `keep` selects the per-screen subset (e.g. archived vs. pinned);
// deleted rows are always excluded.
export function highlightsFromStore(keep: (h: Highlight) => boolean): HighlightWithDoc[] {
  const st = useSyncStore.getState()
  const tagsFrom = (ids?: string[]): Tag[] =>
    (ids ?? []).map(tid => st.tags[tid]).filter((t): t is Tag => !!t)
  return Object.values(st.highlights)
    .filter(h => !h.deleted_at && keep(h))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map(h => {
      const d = st.documents[h.document_id]
      return {
        ...h,
        document_title: d?.title ?? '',
        document_url: d?.canonical_url ?? '',
        tags: tagsFrom(st.highlightTags[h.id]),
      } as HighlightWithDoc
    })
}
