import { marked } from 'marked'

marked.use({ breaks: true })

// Converts a markdown string to an HTML string for WebView injection.
// Not a replacement for MarkdownBody (which targets native RN component trees).
export function mdToHtml(raw: string): string {
  return marked.parse(raw) as string
}
