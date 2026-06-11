package api

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
)

type syncHandler struct{ q *store.Queries }

type syncResponse struct {
	ServerTime     string                `json:"server_time"`
	Documents      []store.Document      `json:"documents"`
	Highlights     []store.Highlight     `json:"highlights"`
	Annotations    []store.Annotation    `json:"annotations"`
	Tags           []store.Tag           `json:"tags"`
	DocumentTags   []store.DocumentTag   `json:"document_tags"`
	AnnotationTags []store.AnnotationTag `json:"annotation_tags"`
	HighlightTags  []store.HighlightTag  `json:"highlight_tags"`
}

// GET /api/v1/sync?since=<ISO8601>
// Returns all rows changed after `since` (inclusive of tombstones).
// Default since = epoch → full sync.
func (h *syncHandler) sync(w http.ResponseWriter, r *http.Request) {
	since := r.URL.Query().Get("since")
	if since == "" {
		since = "1970-01-01T00:00:00Z"
	}

	ctx := r.Context()

	docs, err := h.q.ListDocumentsSince(ctx, since)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error: documents")
		return
	}

	highlights, err := h.q.ListHighlightsSince(ctx, since)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error: highlights")
		return
	}

	annotations, err := h.q.ListAnnotationsSince(ctx, since)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error: annotations")
		return
	}

	tags, err := h.q.ListTagsSince(ctx, since)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error: tags")
		return
	}

	docTags, err := h.q.ListDocumentTagsSince(ctx, since)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error: document_tags")
		return
	}

	annTags, err := h.q.ListAnnotationTagsSince(ctx, since)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error: annotation_tags")
		return
	}

	hlTags, err := h.q.ListHighlightTagsSince(ctx, since)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error: highlight_tags")
		return
	}

	logSync(since, docs, highlights, annotations, tags, docTags, annTags, hlTags)

	writeJSON(w, http.StatusOK, syncResponse{
		ServerTime:     time.Now().UTC().Format(time.RFC3339),
		Documents:      nullSlice(docs),
		Highlights:     nullSlice(highlights),
		Annotations:    nullSlice(annotations),
		Tags:           nullSlice(tags),
		DocumentTags:   nullSlice(docTags),
		AnnotationTags: nullSlice(annTags),
		HighlightTags:  nullSlice(hlTags),
	})
}

func logSync(
	since string,
	docs []store.Document,
	highlights []store.Highlight,
	annotations []store.Annotation,
	tags []store.Tag,
	docTags []store.DocumentTag,
	annTags []store.AnnotationTag,
	hlTags []store.HighlightTag,
) {
	total := len(docs) + len(highlights) + len(annotations) + len(tags) +
		len(docTags) + len(annTags) + len(hlTags)

	if total == 0 {
		logAPI.Printf("sync EMPTY  since=%s", since)
		return
	}

	var parts []string
	add := func(n int, singular, plural string) {
		if n == 0 {
			return
		}
		label := plural
		if n == 1 {
			label = singular
		}
		parts = append(parts, fmt.Sprintf("%d %s", n, label))
	}
	add(len(docs), "doc", "docs")
	add(len(highlights), "highlight", "highlights")
	add(len(annotations), "annotation", "annotations")
	add(len(tags), "tag", "tags")
	add(len(docTags)+len(annTags)+len(hlTags), "tag-link", "tag-links")

	logAPI.Printf("\033[92mSYNCED\033[0m  %s  (since=%s)", strings.Join(parts, ", "), since)
}

func nullSlice[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
