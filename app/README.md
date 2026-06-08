# app/

The reader/curator client — iOS, Android, and web from one codebase.

- **Stack:** Expo / React Native (+ RN Web). The web build is exported and served by `server/`.
- **Offline-first:** local SQLite replica; syncs to the server via the change-cursor protocol.
- **Editor:** CodeMirror 6-in-WebView for anchored/linked edits; plain RN `TextInput` for casual `Annotation`s.

UX (see `plan/005 Samizdat Expo App UX.md` in the design vault): bottom tabs **Feed · Digest · Settings** + Add FAB + side drawers. Feed of `Highlight`s with per-filter resume + swipe-triage; Document viewer with gutter-anchored highlights; one-tap LLM chat; digest assembly with auto-citation.

Not initialized yet. Bootstrap: `npx create-expo-app .`. See `../ARCHITECTURE.md` and `../CLAUDE.md`.
