# CLAUDE.md — app/

Expo (React Native + RN Web) reader/curator client. Offline-first.

## Stack
pnpm, React Native, TypeScript. Running & building: always map them to just.

- **Styling**: `react-native-unistyles` v3 (`createStyleSheet` + `useStyles`). Never use `StyleSheet.create`. Theme defined in `src/theme.ts`.
- **Navigation**: Expo Router (file-based routes in `app/` dir)
- **Server state**: React Query
- **UI state**: Zustand
- **Rich/anchored edits**: CodeMirror 6 in a WebView
- **No Redux, no MobX, no class components**

## Unistyles pattern

Unistyles v3 uses CSS class injection on web, not inline styles. For RNW (web builds), use `useUnistyles()` + `useMemo` to build styles from the theme:

```ts
import { useUnistyles } from 'react-native-unistyles'
import { StyleSheet, useMemo } from 'react-native'

function MyComponent() {
  const { theme } = useUnistyles()
  const s = useMemo(() => buildStyles(theme), [theme])
  return <View style={s.container} />
}

type Theme = ReturnType<typeof useUnistyles>['theme']
function buildStyles(t: Theme) {
  return StyleSheet.create({
    container: { backgroundColor: t.colors.background },
  })
}
```

Theme tokens live in `src/theme.ts` — edit there, not inline.
On native builds, `StyleSheet.create` from unistyles can be used directly.

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
- Co-locate styles with component via `createStyleSheet` at bottom of file
- No `StyleSheet.create` anywhere

## Editor
- Rich/anchored edits: CodeMirror 6 in a WebView
- Casual notes: plain `TextInput`
- Never use RN's built-in `TextInput` for anchored highlight editing

## UI guidelines
Always look for existing components before making a new one.
Interactions: when user clicks on something that does an API call - indicate loading, disable button. On error, toast, indicate error on button. Make this a component, reuse wherever.
