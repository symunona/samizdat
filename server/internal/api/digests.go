package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/digest"
	"github.com/symunona/samizdat/server/internal/store"
)

type digestsHandler struct {
	q  *store.Queries
	db *sql.DB
	// runner is the worker's own: a save is checked against rule 5 by the same
	// code, Router and registry that will run it.
	runner digest.Runner
}

// digestRequest is the body of a create and of a PATCH. Every field is optional:
// absent keeps the stored value (or, on create, the default).
type digestRequest struct {
	Name          *string            `json:"name"`
	Enabled       *bool              `json:"enabled"`
	Period        *string            `json:"period"`
	Weekdays      *[]int             `json:"weekdays"`
	Hour          *int               `json:"hour"`
	SourceFeedIDs *[]string          `json:"source_feed_ids"`
	Questions     *[]digest.Question `json:"questions"`
	Provider      *string            `json:"provider"`
	Model         *string            `json:"model"`
	Color         *string            `json:"color"`
}

func patch[T any](dst *T, src *T) {
	if src != nil {
		*dst = *src
	}
}

func (req digestRequest) apply(d *digest.Digest) {
	patch(&d.Name, req.Name)
	patch(&d.Enabled, req.Enabled)
	patch(&d.Period, req.Period)
	patch(&d.Weekdays, req.Weekdays)
	patch(&d.Hour, req.Hour)
	patch(&d.SourceFeedIDs, req.SourceFeedIDs)
	patch(&d.Questions, req.Questions)
	patch(&d.Provider, req.Provider)
	patch(&d.Model, req.Model)
	patch(&d.Color, req.Color)
}

// decode reads the request onto d and validates the result. It answers the
// request itself when the Digest must not be saved.
func (h *digestsHandler) decode(w http.ResponseWriter, r *http.Request, d *digest.Digest) bool {
	var req digestRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return false
	}
	req.apply(d)
	if !h.defaultColor(w, r, d) {
		return false
	}
	if err := d.Normalize(); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return false
	}
	for _, id := range d.SourceFeedIDs {
		if _, err := h.q.GetFeed(r.Context(), id); err != nil {
			writeErr(w, http.StatusBadRequest, "unknown feed "+id)
			return false
		}
	}
	// Rule 5, at save. The run checks again: a Feed can gain a login later.
	if err := h.runner.CheckRoute(r.Context(), *d); err != nil {
		if errors.Is(err, digest.ErrCloudRoute) {
			writeErr(w, http.StatusUnprocessableEntity, err.Error())
			return false
		}
		logAPI.Errorf("digest route check: %v", err)
		writeErr(w, http.StatusInternalServerError, "route check failed")
		return false
	}
	return true
}

// defaultColor gives a Digest saved with no colour the first one no other Digest
// uses — a new Digest, and a row older than the column on its next save.
func (h *digestsHandler) defaultColor(w http.ResponseWriter, r *http.Request, d *digest.Digest) bool {
	if d.Color != "" {
		return true
	}
	rows, err := h.q.ListDigests(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list digests failed")
		return false
	}
	used := make([]string, 0, len(rows))
	for _, row := range rows {
		if row.ID != d.ID {
			used = append(used, row.Color)
		}
	}
	d.Color = digest.NextColor(used)
	return true
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func (h *digestsHandler) list(w http.ResponseWriter, r *http.Request) {
	rows, err := h.q.ListDigests(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list digests failed")
		return
	}
	writeJSON(w, http.StatusOK, mapRows(rows, digest.FromRow))
}

func (h *digestsHandler) get(w http.ResponseWriter, r *http.Request) {
	row, err := h.q.GetDigest(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "digest not found")
		return
	}
	writeJSON(w, http.StatusOK, digest.FromRow(row))
}

func (h *digestsHandler) create(w http.ResponseWriter, r *http.Request) {
	d := digest.Digest{Enabled: true, Period: digest.PeriodDaily, Hour: 7}
	if !h.decode(w, r, &d) {
		return
	}
	now := time.Now()
	stamp := now.UTC().Format(time.RFC3339)
	weekdays, feeds, questions := d.Lists()
	row, err := h.q.InsertDigest(r.Context(), store.InsertDigestParams{
		ID:            uuid.NewString(),
		Name:          d.Name,
		Enabled:       boolInt(d.Enabled),
		Period:        d.Period,
		Weekdays:      weekdays,
		Hour:          int64(d.Hour),
		SourceFeedIds: feeds,
		Questions:     questions,
		Provider:      d.Provider,
		Model:         d.Model,
		Color:         d.Color,
		NextRunAt:     d.NextRun(now).UTC().Format(time.RFC3339),
		CreatedAt:     stamp,
		UpdatedAt:     stamp,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "create digest failed")
		return
	}
	writeJSON(w, http.StatusCreated, digest.FromRow(row))
}

func (h *digestsHandler) update(w http.ResponseWriter, r *http.Request) {
	existing, err := h.q.GetDigest(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "digest not found")
		return
	}
	before := digest.FromRow(existing)
	d := before
	if !h.decode(w, r, &d) {
		return
	}
	// next_run_at follows the schedule, so it moves only when the schedule did
	// (or the Digest was switched back on, its old due time long past). A rename
	// landing between a due time and the scheduler's tick must not skip that run.
	now := time.Now()
	nextRun := existing.NextRunAt
	if d.Period != before.Period || d.Hour != before.Hour || !slices.Equal(d.Weekdays, before.Weekdays) ||
		(d.Enabled && !before.Enabled) {
		nextRun = d.NextRun(now).UTC().Format(time.RFC3339)
	}
	weekdays, feeds, questions := d.Lists()
	row, err := h.q.UpdateDigest(r.Context(), store.UpdateDigestParams{
		Name:          d.Name,
		Enabled:       boolInt(d.Enabled),
		Period:        d.Period,
		Weekdays:      weekdays,
		Hour:          int64(d.Hour),
		SourceFeedIds: feeds,
		Questions:     questions,
		Provider:      d.Provider,
		Model:         d.Model,
		Color:         d.Color,
		NextRunAt:     nextRun,
		UpdatedAt:     now.UTC().Format(time.RFC3339),
		ID:            existing.ID,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "update digest failed")
		return
	}
	writeJSON(w, http.StatusOK, digest.FromRow(row))
}

// delete tombstones the Digest and its issues together, so a device drops both.
func (h *digestsHandler) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := h.q.GetDigest(r.Context(), id); err != nil {
		writeErr(w, http.StatusNotFound, "digest not found")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := store.InTx(r.Context(), h.db, func(q *store.Queries) error {
		if err := q.SoftDeleteDigestIssuesByDigest(r.Context(), store.SoftDeleteDigestIssuesByDigestParams{
			DeletedAt: &now, UpdatedAt: now, DigestID: id,
		}); err != nil {
			return err //nolint:wrapcheck // logged below with its context
		}
		//nolint:wrapcheck // logged below with its context
		return q.SoftDeleteDigest(r.Context(), store.SoftDeleteDigestParams{DeletedAt: &now, UpdatedAt: now, ID: id})
	}); err != nil {
		logAPI.Errorf("delete digest %s: %v", id, err)
		writeErr(w, http.StatusInternalServerError, "delete digest failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// run is "Run now": the same Job the scheduler inserts. It works on a disabled
// Digest too — the switch is about the calendar, and this is a person asking.
func (h *digestsHandler) run(w http.ResponseWriter, r *http.Request) {
	row, err := h.q.GetDigest(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "digest not found")
		return
	}
	queued, err := digest.Enqueue(r.Context(), h.q, row)
	if err != nil {
		logAPI.Errorf("run digest %s: %v", row.ID, err)
		writeErr(w, http.StatusInternalServerError, "enqueue failed")
		return
	}
	writeJSON(w, http.StatusOK, queued)
}

// listIssues serves a Digest's issues, newest first, refs unresolved — the issue
// picker needs dates and counts, not every bullet of every past issue.
func (h *digestsHandler) listIssues(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := h.q.GetDigest(r.Context(), id); err != nil {
		writeErr(w, http.StatusNotFound, "digest not found")
		return
	}
	limit := int64(50)
	if v, err := strconv.ParseInt(r.URL.Query().Get("limit"), 10, 64); err == nil && v > 0 && v <= 200 {
		limit = v
	}
	rows, err := h.q.ListDigestIssuesByDigest(r.Context(), store.ListDigestIssuesByDigestParams{DigestID: id, Limit: limit})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list issues failed")
		return
	}
	writeJSON(w, http.StatusOK, mapRows(rows, digest.IssueFromRow))
}

// getIssue serves one issue with every ref resolved to what it points at.
func (h *digestsHandler) getIssue(w http.ResponseWriter, r *http.Request) {
	row, err := h.q.GetDigestIssue(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "digest issue not found")
		return
	}
	issue := digest.IssueFromRow(row)
	if err := issue.Resolve(r.Context(), h.q); err != nil {
		logAPI.Errorf("resolve digest issue %s: %v", row.ID, err)
		writeErr(w, http.StatusInternalServerError, "resolve issue failed")
		return
	}
	writeJSON(w, http.StatusOK, issue)
}

// mapRows converts store rows to their API shape. Never nil: an empty list must
// serialize as [], not null.
func mapRows[R, T any](rows []R, fn func(R) T) []T {
	out := make([]T, len(rows))
	for i, row := range rows {
		out[i] = fn(row)
	}
	return out
}
