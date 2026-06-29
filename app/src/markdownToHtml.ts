import { marked } from 'marked'
import { DOCUMENT_VIEWER_JS } from './webview/document-viewer-bundle'

marked.use({ breaks: true })

export function mdToHtml(raw: string): string {
  return marked.parse(raw) as string
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function markDocumentLinks(html: string, docsByUrl: Record<string, string>): string {
  return html.replace(/<a href="(https?:\/\/[^"]+)"/g, (_match, url: string) => {
    const docId = docsByUrl[url]
    if (!docId) return `<a href="${url}"`
    return `<a class="has-doc" data-doc-id="${docId}" href="${url}"`
  })
}

export function buildDocumentHtml(
  markdown: string,
  title: string,
  docsByUrl: Record<string, string>,
): string {
  const bodyHtml = markDocumentLinks(mdToHtml(markdown), docsByUrl)
  return wrapViewerHtml(title, bodyHtml)
}

// buildTranscriptHtml renders a video Document's time-anchored transcript: each
// segment is a `.seg` paragraph carrying its `data-start-ms`, so the WebView can
// highlight/seek by playback time while reusing the same annotation machinery.
export function buildTranscriptHtml(
  segments: { start_ms: number; text: string }[],
  title: string,
): string {
  const body = segments
    .map(s => `<p class="seg" data-start-ms="${s.start_ms}">${escapeHtmlText(s.text)}</p>`)
    .join('\n')
  return wrapViewerHtml(title, body)
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function wrapViewerHtml(title: string, bodyHtml: string): string {
  const escapedTitle = escapeHtmlAttr(title || '')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapedTitle}</title>
<script>${DOCUMENT_VIEWER_JS}</script>
</head>
<body>
<div id="sam-article">${bodyHtml}</div>
<div id="ann-gutter"></div>
<button id="ann-btn">Annotate</button>
</body>
</html>`
}
