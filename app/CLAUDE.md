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

**Icon conventions** — use these consistently everywhere:
- Note action buttons: `<NoteEditButton onPress={…} />` (`src/NoteEditButton.tsx`) — Ionicons `create-outline` tilted pencil, accent bg, no text. Use everywhere a note/annotate action button appears.
- Notes / annotations inline display: `✏` (pencil emoji) — annotation badges, note preview text only
Interactions: when user clicks on something that does an API call - indicate loading, disable button. On error, toast, indicate error on button. Make this a component, reuse wherever.

## Connection state — NEVER bypass ConnectionProvider

`ConnectionProvider` (in `src/ConnectionContext.tsx`) is the single owner of connection state. It probes the server on mount and every 30s, and picks the fastest reachable URL automatically.

**Rule:** Every screen reads connection via `useConnection()`. Never import `loadConnection`, `saveConnection`, or `findReachable` directly in a screen.

```ts
// ✅ correct
const { activeUrl, token, status } = useConnection()

// ❌ wrong — bypasses provider, re-probes every render, hangs on slow/dead URLs
const saved = await loadConnection()
const found = await findReachable(saved.serverUrls, saved.token)
```

**Why it matters:** `findReachable` without a `lastSuccessfulUrl` hint tries ALL stored URLs sequentially — localhost, docker bridges, Tailscale — with no timeout. For a remote client (Tailscale, LAN), unreachable IPs stall the fetch indefinitely. `ConnectionProvider` already did this work; use its result.

**Pattern for screens that fetch on mount:**
```ts
const { activeUrl, token, status } = useConnection()

useEffect(() => {
  if (status === 'connected') load()
  else if (status === 'disconnected') { setError('Not connected'); setLoading(false) }
}, [status, load])
```

**Writing connection data** (e.g. after pairing): call `reload()` from `useConnection()` — do not call `saveConnection` and forget. `reload()` re-reads storage and triggers a fresh probe, keeping the provider in sync.

## Re-connecting after session expiry (local testing)

If the browser loses its session (cleared storage, expired token, fresh state):

```bash
just sam connect
```

Copy any of the printed links, e.g. `http://localhost:8765/connect?code=ABCD-EFGH`, and open it in the browser. The connect page reads `?code=`, uses the page's own origin as the server URL, and auto-pairs immediately — no manual form filling needed.

The `?c=<base64>` param is for the paste-string / QR-scan flow (mobile, no terminal).

## Debugging with agent-browser

**Always reuse the persisted debug session** — never start fresh from an unpaired state.

State lives at `tmp/debug-session/state.json` (gitignored). It holds cookies + localStorage so the app starts already connected to the server.

### Setup (one-time, or after wiping state)

```bash
# 1. Open a fresh browser, go through the pairing flow manually
agent-browser open http://localhost:8765
# ... pair device in the UI ...
# 2. Save state for future runs
just save-debug-session
```

### Every debug / e2e run

```bash
# Opens with saved state — app starts already paired/authenticated
just debug-session
# or directly (note: --no-sandbox required on this Linux host):
AGENT_BROWSER_ARGS="--no-sandbox" agent-browser --state tmp/debug-session/state.json open http://localhost:8765
```

### Rules

- **Never** start a debug agent-browser session without `--state tmp/debug-session/state.json` (or via `just debug-session`).
- After any pairing action in tests, call `just save-debug-session` to persist the new token.
- Screenshots go to `tmp/screenshots/`, not `tmp/` root.
- State file is gitignored — recreate from the pairing flow if missing.
