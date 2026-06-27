// Shared icon-button geometry — the SINGLE source of truth for the flat,
// borderless icon button rendered in BOTH runtimes:
//   - RN:      src/IconButton.tsx          (feed card; native + RN-Web)
//   - WebView: src/webview/document-viewer.ts  (document-body highlight card)
//
// Dependency-free on purpose: the WebView bundle must NOT pull in
// react-native-unistyles, so it imports these raw values directly while the RN
// side surfaces them through the theme (theme.ts → theme.iconButton). Geometry
// is theme-independent, so it lives here, not per-theme. "Share the spec, not
// the pixels" — see app/CLAUDE.md.
export const iconButtonSpec = {
  size: 16, // glyph px
  padX: 8,
  padY: 5,
  radius: 6,
  hoverScale: 1.18,
} as const
