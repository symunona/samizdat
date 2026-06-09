package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	ghtml "github.com/yuin/goldmark/renderer/html"
	"github.com/symunona/samizdat/server/internal/store"
)

type htmlHandler struct{ q *store.Queries }

func (h *htmlHandler) render(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	doc, err := h.q.GetDocumentByID(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	anns, err := h.q.ListAnnotationsByDocument(r.Context(), id)
	if err != nil {
		anns = []store.Annotation{}
	}
	if anns == nil {
		anns = []store.Annotation{}
	}

	md := goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithParserOptions(parser.WithAutoHeadingID()),
		goldmark.WithRendererOptions(ghtml.WithHardWraps(), ghtml.WithUnsafe()),
	)
	var bodyBuf bytes.Buffer
	if err := md.Convert([]byte(doc.Markdown), &bodyBuf); err != nil {
		writeErr(w, http.StatusInternalServerError, "render error")
		return
	}

	annsJSON, _ := json.Marshal(anns)

	title := doc.Title
	if title == "" {
		title = doc.CanonicalUrl
	}

	page := fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>%s</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b0b0c;color:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.7;padding:16px 20px 80px;max-width:720px;margin:0 auto}
h1,h2,h3,h4{color:#f4f1ea;margin:1.4em 0 0.5em;line-height:1.3}
h1{font-size:1.6em}h2{font-size:1.35em}h3{font-size:1.15em}
p{margin-bottom:1em}
a{color:#e8743b;text-decoration:none}a:hover{text-decoration:underline}
code{background:#161618;border-radius:4px;padding:2px 5px;font-family:monospace;font-size:0.9em;color:#e8743b}
pre{background:#161618;border-radius:6px;padding:14px;overflow-x:auto;margin-bottom:1em}
pre code{background:none;padding:0;color:#f4f1ea}
blockquote{border-left:3px solid #e8743b;padding-left:14px;color:#9ca3af;margin-bottom:1em}
img{max-width:100%%;border-radius:6px;margin-bottom:1em}
ul,ol{padding-left:1.5em;margin-bottom:1em}
li{margin-bottom:0.3em}
hr{border:none;border-top:1px solid #26262a;margin:1.5em 0}
mark{background-color:rgba(232,116,59,0.35);color:#f4f1ea;border-radius:3px;padding:1px 0;cursor:pointer}
mark.color-yellow{background-color:rgba(250,204,21,0.3)}
mark.color-green{background-color:rgba(74,222,128,0.3)}
mark.color-blue{background-color:rgba(96,165,250,0.3)}
mark.color-pink{background-color:rgba(244,114,182,0.3)}
#ann-btn{position:fixed;bottom:80px;right:16px;background:#e8743b;color:#0b0b0c;border:none;border-radius:20px;padding:8px 16px;font-weight:700;font-size:14px;cursor:pointer;display:none;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,0.4)}
</style>
</head>
<body>
<script>window.__annotations=%s;</script>
%s
<button id="ann-btn">Annotate</button>
<script>
(function(){
var anns = window.__annotations || [];
var pendingSel = null;

function applyMark(a) {
  var body = document.body;
  var text = body.innerText;
  var idx = -1;
  if (a.pos_start > 0 && a.pos_end > a.pos_start) {
    var candidate = text.substring(a.pos_start, a.pos_end);
    if (candidate === a.exact) idx = a.pos_start;
  }
  if (idx < 0) idx = text.indexOf(a.exact);
  if (idx < 0) return;
  highlightTextNode(a.exact, idx, a.id, a.color || 'yellow');
}

function highlightTextNode(exact, charIdx, annId, color) {
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var offset = 0;
  while (walker.nextNode()) {
    var node = walker.currentNode;
    var len = node.nodeValue.length;
    if (offset + len > charIdx) {
      var start = charIdx - offset;
      if (start + exact.length > len) { offset += len; continue; }
      var range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + exact.length);
      var mark = document.createElement('mark');
      mark.className = 'color-' + color;
      mark.dataset.annId = annId;
      range.surroundContents(mark);
      return;
    }
    offset += len;
  }
}

function getCharOffset(range) {
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var offset = 0;
  while (walker.nextNode()) {
    var node = walker.currentNode;
    if (node === range.startContainer) return offset + range.startOffset;
    offset += node.nodeValue.length;
  }
  return 0;
}

function getContext(range, n) {
  var body = document.body.innerText;
  var start = getCharOffset(range);
  return {
    prefix: body.substring(Math.max(0, start - n), start),
    suffix: body.substring(start + range.toString().length, start + range.toString().length + n)
  };
}

anns.forEach(applyMark);

document.addEventListener('touchend', function() {
  setTimeout(function() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      document.getElementById('ann-btn').style.display = 'none';
      pendingSel = null;
      return;
    }
    var exact = sel.toString().trim();
    var range = sel.getRangeAt(0);
    var start = getCharOffset(range);
    var ctx = getContext(range, 64);
    pendingSel = { exact: exact, prefix: ctx.prefix, suffix: ctx.suffix, pos_start: start, pos_end: start + exact.length };
    document.getElementById('ann-btn').style.display = 'block';
  }, 100);
});

document.addEventListener('mouseup', function() {
  var sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    document.getElementById('ann-btn').style.display = 'none';
    pendingSel = null;
    return;
  }
  var exact = sel.toString().trim();
  var range = sel.getRangeAt(0);
  var start = getCharOffset(range);
  var ctx = getContext(range, 64);
  pendingSel = { exact: exact, prefix: ctx.prefix, suffix: ctx.suffix, pos_start: start, pos_end: start + exact.length };
  document.getElementById('ann-btn').style.display = 'block';
});

document.getElementById('ann-btn').addEventListener('click', function() {
  if (!pendingSel) return;
  document.getElementById('ann-btn').style.display = 'none';
  window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'selection', data: pendingSel }));
  pendingSel = null;
  window.getSelection && window.getSelection().removeAllRanges();
});

document.addEventListener('click', function(e) {
  var mark = e.target.closest && e.target.closest('mark[data-ann-id]');
  if (mark) {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'tap_annotation', id: mark.dataset.annId }));
  }
});

window.addMark = function(a) { applyMark(a); };
window.removeMark = function(id) {
  var marks = document.querySelectorAll('mark[data-ann-id="' + id + '"]');
  marks.forEach(function(m) {
    var parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
};
})();
</script>
</body>
</html>`, escapeHTMLAttr(title), string(annsJSON), bodyBuf.String())

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(page))
}

func escapeHTMLAttr(s string) string {
	var buf bytes.Buffer
	for _, r := range s {
		switch r {
		case '<':
			buf.WriteString("&lt;")
		case '>':
			buf.WriteString("&gt;")
		case '"':
			buf.WriteString("&quot;")
		case '&':
			buf.WriteString("&amp;")
		default:
			buf.WriteRune(r)
		}
	}
	return buf.String()
}
