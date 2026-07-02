package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/pipeline"
	"github.com/symunona/samizdat/server/internal/store"
)

type documentsHandler struct{ q *store.Queries }

type documentListItem struct {
	store.Document
	AnnotationCount interface{} `json:"annotation_count"`
	HighlightCount  interface{} `json:"highlight_count"`
}

func (h *documentsHandler) list(w http.ResponseWriter, r *http.Request) {
	feedID := r.URL.Query().Get("feed_id")
	if feedID != "" {
		docs, err := h.q.ListDocumentsByFeed(r.Context(), &feedID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		if docs == nil {
			docs = []store.Document{}
		}
		writeJSON(w, http.StatusOK, docs)
		return
	}

	rows, err := h.q.ListDocumentsWithAnnotationCount(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	items := make([]documentListItem, len(rows))
	for i, row := range rows {
		items[i] = documentListItem{
			Document: store.Document{
				ID:           row.ID,
				CanonicalUrl: row.CanonicalUrl,
				Title:        row.Title,
				Markdown:     row.Markdown,
				FetchedAt:    row.FetchedAt,
				Excerpt:      row.Excerpt,
				HeroImageUrl: row.HeroImageUrl,
				Author:       row.Author,
				SourceFeedID: row.SourceFeedID,
				CreatedAt:    row.CreatedAt,
				UpdatedAt:    row.UpdatedAt,
				Rev:          row.Rev,
				DeletedAt:    row.DeletedAt,
			},
			AnnotationCount: row.AnnotationCount,
			HighlightCount:  row.HighlightCount,
		}
	}
	writeJSON(w, http.StatusOK, items)
}

func (h *documentsHandler) get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	doc, err := h.q.GetDocumentByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	// Attach the originating scrape job's execution time (capture time). 0 when
	// no scrape job is recorded (e.g. older documents or feed imports).
	captureMs, err := h.q.GetScrapeDurationByDocument(r.Context(), doc.ID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		store.Document
		CaptureMs int64 `json:"capture_ms"`
	}{Document: doc, CaptureMs: captureMs})
}

func (h *documentsHandler) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.SoftDeleteDocument(r.Context(), store.SoftDeleteDocumentParams{
		DeletedAt: &now,
		UpdatedAt: now,
		ID:        id,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *documentsHandler) lookupByURL(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" {
		writeErr(w, http.StatusBadRequest, "url required")
		return
	}
	doc, err := h.q.GetDocumentByCanonicalURL(r.Context(), rawURL)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (h *documentsHandler) listMedia(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	assets, err := h.q.ListMediaAssetsByDocument(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if assets == nil {
		assets = []store.MediaAsset{}
	}
	writeJSON(w, http.StatusOK, assets)
}

// POST /api/v1/documents/{id}/queue-pipelines?hold=true
// Enqueues run_pipeline jobs (paused if hold=true) for every enabled pipeline
// whose filter matches this document (same rule as the auto on_new_document
// trigger — see worker.triggerPipelines), skipping any pipeline that already has
// an active job for this document.
func (h *documentsHandler) queuePipelines(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	if docID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	hold := r.URL.Query().Get("hold") == "true"
	var parentJobID *string
	if p := r.URL.Query().Get("parent_job_id"); p != "" {
		parentJobID = &p
	}

	doc, err := h.q.GetDocumentByID(r.Context(), docID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "document not found")
		return
	}

	// Resolve the document's feed URL so pipeline filters (feed-id / feed-url
	// include+exclude) can be evaluated exactly as the scraper does.
	feedURL := ""
	if doc.SourceFeedID != nil {
		if feed, err := h.q.GetFeed(r.Context(), *doc.SourceFeedID); err == nil {
			feedURL = feed.Url
		}
	}

	pipelines, err := h.q.ListEnabledPipelines(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	var queued, skipped int
	for _, pl := range pipelines {
		// Honour each pipeline's filter — a manual "queue pipelines" must not run
		// pipelines scoped to other feeds (or explicitly excluding this one).
		if !pipeline.MatchesDocument(pl, doc, feedURL) {
			continue
		}
		count, err := h.q.CountActiveRunPipelineJobsForDoc(r.Context(), store.CountActiveRunPipelineJobsForDocParams{
			Payload:   docID,
			Payload_2: pl.ID,
		})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		if count > 0 {
			skipped++
			continue
		}

		payload, _ := json.Marshal(map[string]string{
			"pipeline_id":    pl.ID,
			"document_id":    docID,
			"pipeline_name":  pl.Name,
			"document_title": doc.Title,
		})
		jobID := uuid.NewString()
		if hold {
			_, err = h.q.InsertJobPaused(r.Context(), store.InsertJobPausedParams{
				ID:          jobID,
				Kind:        "run_pipeline",
				Payload:     string(payload),
				RunAfter:    now,
				CreatedAt:   now,
				UpdatedAt:   now,
				ParentJobID: parentJobID,
			})
		} else {
			_, err = h.q.InsertJob(r.Context(), store.InsertJobParams{
				ID:          jobID,
				Kind:        "run_pipeline",
				Payload:     string(payload),
				RunAfter:    now,
				CreatedAt:   now,
				UpdatedAt:   now,
				ParentJobID: parentJobID,
			})
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		queued++
	}

	writeJSON(w, http.StatusOK, map[string]int{"queued": queued, "skipped": skipped})
}
