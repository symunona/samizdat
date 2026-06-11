// Converts a markdown string to an HTML string for WebView injection.
// Handles only the subset that highlights actually produce.
// Not a replacement for MarkdownBody (which targets native RN component trees).
export function mdToHtml(raw: string): string {
  let s = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  // links before bold/italic so [**bold**](url) doesn't mis-parse
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')

  // Convert consecutive bullet lines to <ul>/<li> before replacing \n with <br>
  s = s.replace(/((?:(?:^|\n)[-*] [^\n]+))+/g, (match) => {
    const items = match.trim().split('\n').map(l => `<li>${l.replace(/^[-*]\s+/, '')}</li>`).join('')
    return `<ul style="margin:0.5em 0;padding-left:1.4em;list-style:disc">${items}</ul>`
  })
  s = s.replace(/\n/g, '<br>')

  return s
}
