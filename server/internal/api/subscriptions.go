package api

import (
	"encoding/json"
	"net/http"
	"net/url"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/extractor"
	"github.com/symunona/samizdat/server/internal/store"
	"github.com/symunona/samizdat/server/internal/worker"
)

type subscriptionsHandler struct {
	q             *store.Queries
	reg           extractor.Registry
	extractorsDir string
}

// POST /api/v1/subscriptions
// Body: {url, interval_h?}
func (h *subscriptionsHandler) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL       string `json:"url"`
		IntervalH int    `json:"interval_h"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if body.URL == "" {
		writeErr(w, http.StatusBadRequest, "url required")
		return
	}
	if body.IntervalH <= 0 {
		body.IntervalH = 24
	}

	cfg, ok := h.reg.LookupByURL(body.URL)
	if !ok {
		detected, err := extractor.AutoDetectFeedURL(r.Context(), body.URL)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "no extractor config and RSS auto-detection failed: "+err.Error())
			return
		}
		u, _ := url.Parse(body.URL)
		domain := u.Hostname()
		cfg = extractor.ExtractorConfig{Kind: "rss", FeedURL: detected, MaxURLs: 100}
		if h.extractorsDir != "" {
			if saveErr := h.reg.SaveConfig(h.extractorsDir, domain, cfg); saveErr != nil {
				logSubs.Errorf("auto-save config for %s: %v", domain, saveErr)
				h.reg[domain] = cfg
			}
		} else {
			h.reg[domain] = cfg
		}
		logSubs.Printf("auto-detected RSS feed for %s → %s", domain, detected)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	feedID := worker.IDFromURL(body.URL)

	feed, err := h.q.UpsertFeed(r.Context(), store.UpsertFeedParams{
		ID:        feedID,
		Url:       body.URL,
		Kind:      cfg.Kind,
		Title:     "",
		Config:    "{}",
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error creating feed")
		return
	}

	sub, err := h.q.InsertSubscription(r.Context(), store.InsertSubscriptionParams{
		ID:        uuid.NewString(),
		FeedID:    feed.ID,
		IntervalH: int64(body.IntervalH),
		NextRunAt: now,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error creating subscription")
		return
	}

	// Enqueue an immediate poll_feed job.
	payload, _ := json.Marshal(map[string]string{"feed_id": feed.ID, "feed_url": feed.Url})
	_, err = h.q.InsertJob(r.Context(), store.InsertJobParams{
		ID:        uuid.NewString(),
		Kind:      "poll_feed",
		Payload:   string(payload),
		RunAfter:  now,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error enqueueing poll")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"feed":         feed,
		"subscription": sub,
	})
}

// GET /api/v1/subscriptions
func (h *subscriptionsHandler) list(w http.ResponseWriter, r *http.Request) {
	subs, err := h.q.ListSubscriptions(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, subs)
}

// GET /api/v1/feeds/{id}/items
func (h *subscriptionsHandler) listFeedItems(w http.ResponseWriter, r *http.Request) {
	feedID := r.PathValue("id")
	if feedID == "" {
		writeErr(w, http.StatusBadRequest, "feed id required")
		return
	}
	items, err := h.q.ListFeedItemsByFeed(r.Context(), feedID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// GET /api/v1/feeds
func (h *subscriptionsHandler) listFeeds(w http.ResponseWriter, r *http.Request) {
	feeds, err := h.q.ListFeeds(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, feeds)
}

// POST /api/v1/subscriptions/{id}/poll — enqueue immediate poll_feed job.
func (h *subscriptionsHandler) poll(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	sub, err := h.q.GetSubscription(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "subscription not found")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	feedURL := ""
	if feed, err := h.q.GetFeed(r.Context(), sub.FeedID); err == nil {
		feedURL = feed.Url
	}
	payload, _ := json.Marshal(map[string]string{"feed_id": sub.FeedID, "feed_url": feedURL})
	job, err := h.q.InsertJob(r.Context(), store.InsertJobParams{
		ID:        uuid.NewString(),
		Kind:      "poll_feed",
		Payload:   string(payload),
		RunAfter:  now,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"job_id": job.ID})
}

// PATCH /api/v1/subscriptions/{id}
// Body: {paused: bool}
func (h *subscriptionsHandler) patch(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	var body struct {
		Paused bool `json:"paused"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	paused := int64(0)
	if body.Paused {
		paused = 1
	}
	if err := h.q.UpdateSubscriptionPaused(r.Context(), store.UpdateSubscriptionPausedParams{
		Paused:    paused,
		UpdatedAt: now,
		ID:        id,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	sub, err := h.q.GetSubscription(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "subscription not found")
		return
	}
	writeJSON(w, http.StatusOK, sub)
}

// GET /api/v1/feeds/{id}
func (h *subscriptionsHandler) getFeed(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	feed, err := h.q.GetFeed(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "feed not found")
		return
	}
	writeJSON(w, http.StatusOK, feed)
}

// DELETE /api/v1/subscriptions/{id}
func (h *subscriptionsHandler) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.DeleteSubscription(r.Context(), store.DeleteSubscriptionParams{
		DeletedAt: &now,
		UpdatedAt: now,
		ID:        id,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
