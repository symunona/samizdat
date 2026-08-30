# app/

The reader/curator client — Android, iOS, and web from one Expo codebase.

- **Stack:** Expo / React Native (+ RN Web). Web build is exported and served by `server/`.
- **Offline-first:** everything reads from a local SQLite replica (`src/db/`); mutations write locally + queue an outbox intent.
- **Screens:** Feed (`Highlight` cards, swipe-triage) · Documents · document viewer (WebView, anchored annotations) · video/podcast player · Settings.

Dev: `just app::start`. Android: `just build-android`. See `CLAUDE.md`.
