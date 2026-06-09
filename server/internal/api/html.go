package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	ghtml "github.com/yuin/goldmark/renderer/html"
	"github.com/symunona/samizdat/server/internal/store"
)

var reLinkTag = regexp.MustCompile(`<a href="(https?://[^"]+)"`)

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

	body := markDocumentLinks(r.Context(), h.q, bodyBuf.String())
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
a{color:#e8743b;text-decoration:none;margin:0 0.15em}a:hover{text-decoration:underline}
a.has-doc::after{content:" 📄";font-size:0.75em;opacity:0.7;margin-left:0.1em}
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
mark.focused{outline:2px solid rgba(232,116,59,0.8);filter:brightness(1.5);transition:filter 0.3s;}
#ann-btn{position:fixed;bottom:80px;right:24px;background:#e8743b;color:#0b0b0c;border:none;border-radius:20px;padding:8px 16px;font-weight:700;font-size:14px;cursor:pointer;display:none;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,0.4)}
#ann-gutter{position:fixed;top:0;right:0;width:6px;height:100%%;pointer-events:none;z-index:90;}
</style>
</head>
<body>
<script>window.__annotations=%s;</script>
<div id="ann-gutter"></div>
%s
<button id="ann-btn">Annotate</button>
<script>
(function(){
var anns = window.__annotations || [];
var pendingSel = null;

function sendMsg(data) {
  var msg = JSON.stringify(data);
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(msg);
  else if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
}

// Scroll tracking
var lastFrac = -1;
window.addEventListener('scroll', function() {
  var max = document.body.scrollHeight - window.innerHeight;
  if (max <= 0) return;
  var frac = Math.min(1, Math.max(0, window.scrollY / max));
  if (Math.abs(frac - lastFrac) > 0.01) {
    lastFrac = frac;
    sendMsg({ type: 'scroll', fraction: frac });
  }
}, { passive: true });
window.__scrollTo = function(frac) {
  var max = document.body.scrollHeight - window.innerHeight;
  if (max > 0) window.scrollTo(0, frac * max);
};

// Accept commands from parent (web iframe mode)
window.addEventListener('message', function(e) {
  if (e.source !== window.parent) return;
  var msg; try { msg = JSON.parse(e.data); } catch(err) { return; }
  if (msg.type === 'scrollTo') { window.__scrollTo && window.__scrollTo(msg.fraction); }
  else if (msg.type === 'addMark') { window.addMark && window.addMark(msg.annotation); }
  else if (msg.type === 'removeMark') { window.removeMark && window.removeMark(msg.id); }
  else if (msg.type === 'highlightAnnotation') {
    var m = document.querySelector('mark[data-ann-id="' + msg.id + '"]');
    if (m) { m.classList.add('focused'); m.scrollIntoView({behavior:'smooth', block:'center'}); }
  }
});

// TreeWalker that skips <script>/<style>/<noscript> text nodes
// (body.innerText also skips these — this keeps char offsets consistent)
function visibleWalker() {
  return document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    { acceptNode: function(node) {
        var p = node.parentNode;
        while (p && p !== document.body) {
          var t = p.nodeName.toUpperCase();
          if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
    }}
  );
}

function getBodyText() {
  var w = visibleWalker(); var parts = [];
  while (w.nextNode()) parts.push(w.currentNode.nodeValue);
  return parts.join('');
}

function getCharOffset(range) {
  var w = visibleWalker(); var offset = 0;
  while (w.nextNode()) {
    var node = w.currentNode;
    if (node === range.startContainer) return offset + range.startOffset;
    offset += node.nodeValue.length;
  }
  return 0;
}

function getContext(range, n) {
  var body = getBodyText();
  var start = getCharOffset(range);
  return {
    prefix: body.substring(Math.max(0, start - n), start),
    suffix: body.substring(start + range.toString().length, start + range.toString().length + n)
  };
}

function colorForClass(cls) {
  if (cls === 'color-yellow') return 'rgba(250,204,21,0.8)';
  if (cls === 'color-green')  return 'rgba(74,222,128,0.8)';
  if (cls === 'color-blue')   return 'rgba(96,165,250,0.8)';
  if (cls === 'color-pink')   return 'rgba(244,114,182,0.8)';
  return 'rgba(232,116,59,0.8)';
}

function updateGutter() {
  var gutter = document.getElementById('ann-gutter');
  if (!gutter) return;
  gutter.innerHTML = '';
  var total = document.body.scrollHeight;
  if (total <= 0) return;
  document.querySelectorAll('mark[data-ann-id]').forEach(function(m) {
    var top = m.getBoundingClientRect().top + window.scrollY;
    var pct = Math.min(98, (top / total) * 100);
    var dot = document.createElement('div');
    dot.style.cssText = 'position:absolute;right:0;left:0;height:14px;border-radius:2px 0 0 2px;cursor:pointer;pointer-events:auto;transition:left 0.12s;';
    dot.style.top = pct + '%%';
    dot.style.backgroundColor = colorForClass(m.className);
    dot.dataset.annId = m.dataset.annId;
    dot.addEventListener('mouseenter', function() { this.style.left = '-2px'; });
    dot.addEventListener('mouseleave', function() { this.style.left = '0'; });
    dot.addEventListener('click', function(e) {
      e.stopPropagation();
      m.scrollIntoView({ behavior: 'smooth', block: 'center' });
      sendMsg({ type: 'tap_annotation', id: m.dataset.annId });
    });
    gutter.appendChild(dot);
  });
}

function highlightTextNode(exact, charIdx, annId, color) {
  var w = visibleWalker(); var offset = 0;
  while (w.nextNode()) {
    var node = w.currentNode;
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

function applyMark(a) {
  var text = getBodyText();
  var idx = -1;
  if (a.pos_start > 0 && a.pos_end > a.pos_start) {
    if (text.substring(a.pos_start, a.pos_end) === a.exact) idx = a.pos_start;
  }
  if (idx < 0) idx = text.indexOf(a.exact);
  if (idx < 0) return;
  highlightTextNode(a.exact, idx, a.id, a.color || 'yellow');
}

anns.forEach(applyMark);
setTimeout(updateGutter, 80);

document.addEventListener('touchend', function() {
  setTimeout(function() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      document.getElementById('ann-btn').style.display = 'none';
      pendingSel = null; return;
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
    pendingSel = null; return;
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
  sendMsg({ type: 'selection', data: pendingSel });
  pendingSel = null;
  window.getSelection && window.getSelection().removeAllRanges();
});

document.addEventListener('click', function(e) {
  var mark = e.target.closest && e.target.closest('mark[data-ann-id]');
  if (mark) {
    sendMsg({ type: 'tap_annotation', id: mark.dataset.annId });
    return;
  }
  var a = e.target.closest && e.target.closest('a[href]');
  if (a && a.href && (a.href.startsWith('http://') || a.href.startsWith('https://'))) {
    e.preventDefault();
    var msg = { type: 'link_press', href: a.href };
    if (a.dataset.docId) msg.doc_id = a.dataset.docId;
    sendMsg(msg);
  }
});

window.addMark = function(a) { applyMark(a); setTimeout(updateGutter, 50); };
window.removeMark = function(id) {
  document.querySelectorAll('mark[data-ann-id="' + id + '"]').forEach(function(m) {
    var p = m.parentNode;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
  });
  updateGutter();
};
window.addEventListener('resize', function() { setTimeout(updateGutter, 100); });
})();
</script>
</body>
</html>`, escapeHTMLAttr(title), string(annsJSON), body)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(page))
}

// markDocumentLinks scans the rendered HTML for http(s) links, checks which
// ones have a Document in the DB, and injects class="has-doc" data-doc-id="…"
// on matching <a> tags so the client can show a 📄 indicator and skip a round-trip.
func markDocumentLinks(ctx context.Context, q *store.Queries, htmlStr string) string {
	matches := reLinkTag.FindAllStringSubmatch(htmlStr, -1)
	if len(matches) == 0 {
		return htmlStr
	}

	seen := map[string]bool{}
	docsByURL := map[string]string{}
	for _, m := range matches {
		url := m[1]
		if seen[url] {
			continue
		}
		seen[url] = true
		doc, err := q.GetDocumentByCanonicalURL(ctx, url)
		if err == nil {
			docsByURL[url] = doc.ID
		}
	}

	if len(docsByURL) == 0 {
		return htmlStr
	}

	return reLinkTag.ReplaceAllStringFunc(htmlStr, func(match string) string {
		sub := reLinkTag.FindStringSubmatch(match)
		docID, ok := docsByURL[sub[1]]
		if !ok {
			return match
		}
		return `<a class="has-doc" data-doc-id="` + docID + `" href="` + sub[1] + `"`
	})
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
