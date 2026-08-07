package api

import (
	"context"
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
				ErrorReason:  row.ErrorReason,
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
		CaptureMs int64       `json:"capture_ms"`
		AddedVia  docAddedVia `json:"added_via"`
	}{Document: doc, CaptureMs: captureMs, AddedVia: h.addedVia(r.Context(), doc)})
}

// docAddedVia is how a Document got here. Kind is "feed" (a Subscription poll),
// "pipeline" (a step followed a link out of another Document), "manual" (a URL
// pushed to POST /jobs by app, clipper or CLI) or "unknown" (no scrape job on
// record — imports and documents older than their pruned job).
type docAddedVia struct {
	Kind          string `json:"kind"`
	DeviceName    string `json:"device_name,omitempty"`
	PipelineName  string `json:"pipeline_name,omitempty"`
	DocumentID    string `json:"document_id,omitempty"`
	DocumentTitle string `json:"document_title,omitempty"`
}

// addedVia derives provenance from the scrape job that produced the Document:
// a pipeline-spawned scrape carries the driving run_pipeline_step as its parent
// job, a manual one carries the pushing device in its payload. A feed poll is
// already on the Document itself.
func (h *documentsHandler) addedVia(ctx context.Context, doc store.Document) docAddedVia {
	if doc.SourceFeedID != nil && *doc.SourceFeedID != "" {
		return docAddedVia{Kind: "feed"}
	}
	job, err := h.q.GetScrapeJobByDocument(ctx, doc.ID)
	if err != nil {
		return docAddedVia{Kind: "unknown"}
	}
	if job.ParentJobID != nil {
		parent, err := h.q.GetJob(ctx, *job.ParentJobID)
		if err == nil && (parent.Kind == "run_pipeline_step" || parent.Kind == "run_pipeline") {
			var p struct {
				PipelineName  string `json:"pipeline_name"`
				DocumentID    string `json:"document_id"`
				DocumentTitle string `json:"document_title"`
			}
			_ = json.Unmarshal([]byte(parent.Payload), &p)
			return docAddedVia{
				Kind:          "pipeline",
				PipelineName:  p.PipelineName,
				DocumentID:    p.DocumentID,
				DocumentTitle: p.DocumentTitle,
			}
		}
	}
	var p struct {
		DeviceName string `json:"device_name"`
	}
	_ = json.Unmarshal([]byte(job.Payload), &p)
	return docAddedVia{Kind: "manual", DeviceName: p.DeviceName}
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

// POST /api/v1/documents/{id}/queue-video
// Enqueues a fetch_video job to download a native playable stream for this video
// Document, so the app can play it without the YouTube embed. Idempotent (mirrors
// queue-pipelines): no-op "ready" if the video asset already exists, "queued":0 if
// a fetch is already in flight.
func (h *documentsHandler) queueVideo(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	if docID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	doc, err := h.q.GetDocumentByID(r.Context(), docID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "document not found")
		return
	}

	// Already fetched — nothing to do.
	if _, err := h.q.GetMediaAssetByDocumentAndKind(r.Context(), store.GetMediaAssetByDocumentAndKindParams{
		DocumentID: docID,
		Kind:       "video",
	}); err == nil {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "queued": 0})
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// Don't stack duplicate fetches while one is already in flight.
	active, err := h.q.CountActiveFetchVideoJobsForDoc(r.Context(), docID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if active > 0 {
		writeJSON(w, http.StatusOK, map[string]any{"status": "pending", "queued": 0})
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	var parentJobID *string
	if p := r.URL.Query().Get("parent_job_id"); p != "" {
		parentJobID = &p
	}
	payload, _ := json.Marshal(map[string]string{
		"document_id":    docID,
		"document_title": doc.Title,
	})
	if _, err := h.q.InsertJob(r.Context(), store.InsertJobParams{
		ID:          uuid.NewString(),
		Kind:        "fetch_video",
		Payload:     string(payload),
		RunAfter:    now,
		CreatedAt:   now,
		UpdatedAt:   now,
		ParentJobID: parentJobID,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"status": "pending", "queued": 1})
}
