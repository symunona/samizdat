
// Shared colour palette. Tags and Digests carry a colour NAME ('red', 'blue', …);
// this maps it to a hex value. Dependency-free so the WebView bundle can inline it.

// The colours a Digest picks from. The server validates against its own copy
// (digest.Colors), and its TestColorsMatchAppPalette reads THIS line — keep the
// declaration a plain one-line array literal.
export const PALETTE = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']

// A tag may also have no colour of its own.
export const TAG_COLORS = ['default', ...PALETTE]

// Text that reads on every palette fill, in both themes: the fills are all light.
export const ON_PALETTE = '#1a1a1a'

export function tagColor(color: string): string {
  switch (color) {
    case 'red': return '#f87171'
    case 'orange': return '#e8743b'
    case 'yellow': return '#facc15'
    case 'green': return '#4ade80'
    case 'blue': return '#60a5fa'
    case 'purple': return '#a78bfa'
    case 'pink': return '#f472b6'
    default: return '#9ca3af'
  }
}
