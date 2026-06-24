package api

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/JohannesKaufmann/html-to-markdown/v2/converter"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/base"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/commonmark"
	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/pipeline"
	"github.com/symunona/samizdat/server/internal/store"
	"github.com/symunona/samizdat/server/internal/worker"
)

const newsletterEmailDomain = "sam.tmpx.space"

type newsletterHandler struct {
	q *store.Queries
}

// POST /api/v1/inbound/email — public, secret-authenticated webhook from CF Worker.
func (h *newsletterHandler) inbound(w http.ResponseWriter, r *http.Request) {
	secret, err := h.q.GetSetting(r.Context(), "newsletter_webhook_secret")
	if err != nil || secret == "" {
		writeErr(w, http.StatusUnauthorized, "newsletter ingest not configured")
		return
	}
	if r.Header.Get("X-Webhook-Secret") != secret {
		writeErr(w, http.StatusUnauthorized, "invalid webhook secret")
		return
	}

	token := r.Header.Get("X-Recipient-Token")
	if token == "" {
		writeErr(w, http.StatusBadRequest, "X-Recipient-Token required")
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read body: "+err.Error())
		return
	}

	msg, err := mail.ReadMessage(strings.NewReader(string(raw)))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "parse email: "+err.Error())
		return
	}

	subject := decodeHeader(msg.Header.Get("Subject"))
	from := msg.Header.Get("From")
	messageID := strings.Trim(msg.Header.Get("Message-Id"), "<> ")
	if messageID == "" {
		messageID = uuid.NewString()
	}

	htmlBody, err := extractHTMLBody(msg)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "extract body: "+err.Error())
		return
	}
	md := emailHTMLToMarkdown(htmlBody)

	feed, err := h.q.GetNewsletterFeedByToken(r.Context(), &token)
	if err == sql.ErrNoRows {
		writeErr(w, http.StatusNotFound, "unknown newsletter token")
		return
	}
	if err != nil {
		logAPI.Errorf("newsletter inbound: get feed by token: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}

	canonicalURL := "email:" + messageID

	// Idempotent: if document already exists, return ok.
	if existing, err := h.q.GetDocumentByCanonicalURL(r.Context(), canonicalURL); err == nil {
		writeJSON(w, http.StatusOK, map[string]string{"document_id": existing.ID, "status": "duplicate"})
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	docID := worker.IDFromURL(canonicalURL)
	doc, err := h.q.UpsertDocument(r.Context(), store.UpsertDocumentParams{
		ID:           docID,
		CanonicalUrl: canonicalURL,
		Title:        subject,
		Markdown:     md,
		FetchedAt:    now,
		Excerpt:      emailExcerpt(md, 200),
		HeroImageUrl: "",
		Author:       from,
		SourceFeedID: &feed.ID,
		CreatedAt:    now,
		UpdatedAt:    now,
	})
	if err != nil {
		logAPI.Errorf("newsletter inbound: upsert document: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}

	newsletterTriggerPipelines(r.Context(), h.q, doc, now)

	// Record "last received" + capture unsubscribe info from headers so a later
	// delete can honor the sender's List-Unsubscribe (RFC 2369 / RFC 8058).
	_ = h.q.MarkFeedPolled(r.Context(), store.MarkFeedPolledParams{
		LastPolledAt: &now,
		UpdatedAt:    now,
		ID:           feed.ID,
	})
	if unsub := parseUnsubscribe(msg.Header); unsub != nil {
		var cfg map[string]any
		if json.Unmarshal([]byte(feed.Config), &cfg) != nil || cfg == nil {
			cfg = map[string]any{}
		}
		cfg["unsubscribe"] = unsub.httpURL
		cfg["unsubscribe_mailto"] = unsub.mailto
		cfg["unsubscribe_one_click"] = unsub.oneClick
		if b, err := json.Marshal(cfg); err == nil {
			_ = h.q.UpdateFeedConfig(r.Context(), store.UpdateFeedConfigParams{
				Config:    string(b),
				UpdatedAt: now,
				ID:        feed.ID,
			})
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"document_id": doc.ID, "status": "ok"})
}

// DELETE /api/v1/feeds/{id} — bearer-authed. Honors List-Unsubscribe (best-effort),
// then soft-deletes the feed + its subscriptions so future mail to its token is
// rejected (GetNewsletterFeedByToken filters deleted_at IS NULL).
func (h *newsletterHandler) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	feed, err := h.q.GetFeed(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "feed not found")
		return
	}

	// Best-effort unsubscribe before deleting. One-click (RFC 8058) only — never
	// auto-send mailto unsubscribes; surface those to the user instead.
	var cfg struct {
		Unsubscribe   string `json:"unsubscribe"`
		UnsubOneClick bool   `json:"unsubscribe_one_click"`
	}
	_ = json.Unmarshal([]byte(feed.Config), &cfg)
	unsubscribed := false
	if cfg.Unsubscribe != "" && cfg.UnsubOneClick {
		unsubscribed = oneClickUnsubscribe(cfg.Unsubscribe)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.DeleteSubscriptionsByFeed(r.Context(), store.DeleteSubscriptionsByFeedParams{
		DeletedAt: &now,
		UpdatedAt: now,
		FeedID:    feed.ID,
	}); err != nil {
		logAPI.Errorf("newsletter delete: subscriptions: %v", err)
	}
	if err := h.q.SoftDeleteFeed(r.Context(), store.SoftDeleteFeedParams{
		DeletedAt: &now,
		UpdatedAt: now,
		ID:        feed.ID,
	}); err != nil {
		logAPI.Errorf("newsletter delete: feed: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true, "unsubscribed": unsubscribed})
}

// POST /api/v1/feeds/newsletter — bearer-authed, creates a newsletter feed.
func (h *newsletterHandler) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if body.Title == "" {
		writeErr(w, http.StatusBadRequest, "title required")
		return
	}

	// Token = readable slug from title + random suffix. Slug keeps the address
	// memorable; the suffix keeps it unguessable and globally unique (which lets
	// the address alone resolve to one feed/user once multiuser lands).
	var suffixBytes [2]byte
	if _, err := rand.Read(suffixBytes[:]); err != nil {
		writeErr(w, http.StatusInternalServerError, "token generation failed")
		return
	}
	token := slugify(body.Title) + "-" + hex.EncodeToString(suffixBytes[:])
	email := token + "@" + newsletterEmailDomain

	cfg, _ := json.Marshal(map[string]string{
		"token": token,
		"email": email,
	})

	now := time.Now().UTC().Format(time.RFC3339)
	syntheticURL := "email-newsletter:" + token
	feed, err := h.q.UpsertFeed(r.Context(), store.UpsertFeedParams{
		ID:        worker.IDFromURL(syntheticURL),
		Url:       syntheticURL,
		Kind:      "newsletter",
		Title:     body.Title,
		Config:    string(cfg),
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		logAPI.Errorf("newsletter create: upsert feed: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Create a paused subscription so the newsletter shows up in the Subscriptions
	// list. paused=1 keeps the scheduler from ever polling a non-pollable email feed.
	sub, err := h.q.InsertSubscription(r.Context(), store.InsertSubscriptionParams{
		ID:        uuid.NewString(),
		FeedID:    feed.ID,
		IntervalH: 24,
		NextRunAt: now,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		logAPI.Errorf("newsletter create: insert subscription: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	if err := h.q.UpdateSubscriptionPaused(r.Context(), store.UpdateSubscriptionPausedParams{
		Paused:    1,
		UpdatedAt: now,
		ID:        sub.ID,
	}); err != nil {
		logAPI.Errorf("newsletter create: pause subscription: %v", err)
	}
	sub.Paused = 1

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"feed":         feed,
		"subscription": sub,
		"email":        email,
	})
}

func newsletterTriggerPipelines(ctx context.Context, q *store.Queries, doc store.Document, now string) {
	pipelines, err := q.ListEnabledPipelines(ctx)
	if err != nil {
		logAPI.Errorf("newsletter pipeline trigger: list: %v", err)
		return
	}

	feedURL := ""
	if doc.SourceFeedID != nil {
		if feed, err := q.GetFeed(ctx, *doc.SourceFeedID); err == nil {
			feedURL = feed.Url
		}
	}

	for _, pl := range pipelines {
		if pl.Trigger != "on_new_document" {
			continue
		}
		if !pipeline.MatchesDocument(pl, doc, feedURL) {
			continue
		}
		payload, _ := json.Marshal(map[string]string{
			"pipeline_id":    pl.ID,
			"document_id":    doc.ID,
			"pipeline_name":  pl.Name,
			"document_title": doc.Title,
		})
		if _, err := q.InsertJob(ctx, store.InsertJobParams{
			ID:        uuid.NewString(),
			Kind:      "run_pipeline",
			Payload:   string(payload),
			RunAfter:  now,
			CreatedAt: now,
			UpdatedAt: now,
		}); err != nil {
			logAPI.Errorf("newsletter pipeline trigger: enqueue %s: %v", pl.ID, err)
		}
	}
}

func readBody(r io.Reader) (string, error) {
	b, err := io.ReadAll(r)
	if err != nil {
		return "", fmt.Errorf("read email body: %w", err)
	}
	return string(b), nil
}

func extractHTMLBody(msg *mail.Message) (string, error) {
	ct := msg.Header.Get("Content-Type")
	if ct == "" {
		return readBody(msg.Body)
	}
	mediaType, params, err := mime.ParseMediaType(ct)
	if err != nil {
		return readBody(msg.Body)
	}

	switch {
	case strings.HasPrefix(mediaType, "text/html"):
		return readBody(msg.Body)

	case strings.HasPrefix(mediaType, "text/plain"):
		body, err := readBody(msg.Body)
		return "<pre>" + body + "</pre>", err

	case strings.HasPrefix(mediaType, "multipart/"):
		mr := multipart.NewReader(msg.Body, params["boundary"])
		var htmlPart, textPart string
		for {
			p, err := mr.NextPart()
			if err != nil {
				break
			}
			pct := p.Header.Get("Content-Type")
			pmedia, _, _ := mime.ParseMediaType(pct)
			body, _ := io.ReadAll(p)
			switch {
			case strings.HasPrefix(pmedia, "text/html") && htmlPart == "":
				htmlPart = string(body)
			case strings.HasPrefix(pmedia, "text/plain") && textPart == "":
				textPart = string(body)
			}
		}
		if htmlPart != "" {
			return htmlPart, nil
		}
		return "<pre>" + textPart + "</pre>", nil

	default:
		return readBody(msg.Body)
	}
}

func emailHTMLToMarkdown(htmlStr string) string {
	conv := converter.NewConverter(
		converter.WithPlugins(base.NewBasePlugin(), commonmark.NewCommonmarkPlugin()),
	)
	md, err := conv.ConvertString(htmlStr)
	if err != nil {
		return htmlStr
	}
	return md
}

func decodeHeader(s string) string {
	dec := new(mime.WordDecoder)
	decoded, err := dec.DecodeHeader(s)
	if err != nil {
		return s
	}
	return decoded
}

func emailExcerpt(md string, n int) string {
	text := strings.Join(strings.Fields(strings.ReplaceAll(md, "\n", " ")), " ")
	if len(text) <= n {
		return text
	}
	return text[:n]
}

// slugify lowercases a title and reduces it to [a-z0-9-], collapsing runs of
// non-alphanumerics into single hyphens. Empty/exotic titles fall back to "nl".
func slugify(s string) string {
	var b strings.Builder
	lastHyphen := true // skip leading hyphens
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastHyphen = false
		default:
			if !lastHyphen {
				b.WriteByte('-')
				lastHyphen = true
			}
		}
	}
	slug := strings.Trim(b.String(), "-")
	if len(slug) > 40 {
		slug = strings.Trim(slug[:40], "-")
	}
	if slug == "" {
		return "nl"
	}
	return slug
}

type unsubInfo struct {
	httpURL  string // first https unsubscribe URL, if any
	mailto   string // first mailto: unsubscribe address, if any
	oneClick bool   // sender supports RFC 8058 one-click POST
}

// parseUnsubscribe reads RFC 2369 List-Unsubscribe + RFC 8058
// List-Unsubscribe-Post headers. The header value is a comma-separated list of
// <…> URIs, e.g. "<https://…>, <mailto:…>".
func parseUnsubscribe(h mail.Header) *unsubInfo {
	raw := h.Get("List-Unsubscribe")
	if raw == "" {
		return nil
	}
	info := &unsubInfo{
		oneClick: strings.Contains(strings.ToLower(h.Get("List-Unsubscribe-Post")), "one-click"),
	}
	for _, part := range strings.Split(raw, ",") {
		uri := strings.TrimSpace(part)
		uri = strings.TrimPrefix(uri, "<")
		uri = strings.TrimSuffix(uri, ">")
		switch {
		case strings.HasPrefix(uri, "https://") && info.httpURL == "":
			info.httpURL = uri
		case strings.HasPrefix(uri, "mailto:") && info.mailto == "":
			info.mailto = strings.TrimPrefix(uri, "mailto:")
		}
	}
	if info.httpURL == "" && info.mailto == "" {
		return nil
	}
	return info
}

// oneClickUnsubscribe performs an RFC 8058 one-click unsubscribe POST. Returns
// true on a 2xx response. Best-effort: any error means "not unsubscribed".
func oneClickUnsubscribe(url string) bool {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(url, "application/x-www-form-urlencoded",
		strings.NewReader("List-Unsubscribe=One-Click"))
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
