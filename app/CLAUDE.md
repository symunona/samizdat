# CLAUDE.md — app/

Expo (React Native + RN Web) reader/curator client. Offline-first.

## Stack
pnpm, React Native, TypeScript. Running & building: always map them to just.

## Offline-first rule
All reads come from local SQLite replica. Network sync runs in background.
Never block UI on network. Server is authoritative; broken replica → wipe + re-pull.

## Sync model
- Pull: send `since_rev` cursor, receive rows with `rev > since_rev`
- Machine data (`Document`, `Highlight`): server→phone one-way, never push back
- User-authored rows (`Annotation`, read-state, `Tag`): two-way LWW push

## Screen structure (plan/005)
Bottom tabs: **Feed · Digest · Settings**. Add FAB center-bottom. Side drawers for filters.
Feed: `Highlight` cards, swipe-triage (read/save/skip). Document viewer: gutter-anchored highlights.
Digest: assembled citations, LLM draft, export.

## Component conventions
- PascalCase filename, one component per file
- Co-locate styles with component (StyleSheet.create at bottom of file)
- Navigation: Expo Router (file-based routes in `app/` dir)
- No Redux. Server state: React Query. UI state: Zustand (decide adapter before first component)

## Editor
- Rich/anchored edits: CodeMirror 6 in a WebView
- Casual notes: plain `TextInput`
- Never use RN's built-in `TextInput` for anchored highlight editing

## Stack (locked — do not add without discussion)
- Expo SDK (latest stable at init time)
- React Native
- Expo Router
- React Query (server state)
- Zustand (UI state)
- CodeMirror 6 (WebView, for anchored edits)
- No Redux, no MobX, no class components
