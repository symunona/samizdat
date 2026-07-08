// Shared tag colour palette. Tags carry a colour NAME ('red', 'blue', 'default', …);
// this maps it to a hex value. Dependency-free so the WebView bundle can inline it.

export const TAG_COLORS = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']

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
