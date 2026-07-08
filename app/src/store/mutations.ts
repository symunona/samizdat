// Local-first mutation facade. Every user action (tag / star / archive / annotate /
// read-progress) goes through here instead of calling api.ts inline: it patches the
// local store immediately (UI reacts with no network) and enqueues an outbox intent the
// pusher replays when online. Screens keep their own optimistic component state where
// they hold non-store lists (feed/document); these calls make the change durable + sync.
//
// Machine content (document markdown, highlight body) is never mutated here — only
// user-authored rows/fields, per the per-object sync-direction table in the plan.

import { useSyncStore } from './syncStore'
import type { JunctionType } from './outbox'
import type { Annotation, Tag } from '../api'

export function pinHighlight(hlId: string, pinned: boolean): void {
  useSyncStore.getState().mutSetHighlightPinned(hlId, pinned)
}

export function archiveHighlight(hlId: string, archivedAt: string | null): void {
  useSyncStore.getState().mutSetHighlightArchived(hlId, archivedAt)
}

export function deleteHighlight(hlId: string): void {
  useSyncStore.getState().mutDeleteHighlight(hlId)
}

export function addTag(type: JunctionType, parentId: string, tagId: string): void {
  useSyncStore.getState().mutAddTag(type, parentId, tagId)
}

export function removeTag(type: JunctionType, parentId: string, tagId: string): void {
  useSyncStore.getState().mutRemoveTag(type, parentId, tagId)
}

export function createTag(input: { name: string; color: string }): Tag {
  return useSyncStore.getState().mutCreateTag(input)
}

export function createAnnotation(input: {
  documentId: string | null
  highlightId?: string | null
  exact?: string; prefix?: string; suffix?: string
  posStart?: number; posEnd?: number; mediaTsMs?: number
  color: string; note: string
}): Annotation {
  return useSyncStore.getState().mutCreateAnnotation(input)
}

export function updateAnnotation(annId: string, note: string, color: string): void {
  useSyncStore.getState().mutUpdateAnnotation(annId, note, color)
}

export function deleteAnnotation(annId: string): void {
  useSyncStore.getState().mutDeleteAnnotation(annId)
}

export function saveProgress(docId: string, scrollY: number): void {
  useSyncStore.getState().mutSaveProgress(docId, scrollY)
}

export function saveMediaPos(docId: string, mediaPosMs: number): void {
  useSyncStore.getState().mutSaveMediaPos(docId, mediaPosMs)
}
