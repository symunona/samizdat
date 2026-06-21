package api

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
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

	writeJSON(w, http.StatusOK, map[string]string{"document_id": doc.ID, "status": "ok"})
}

// POST /api/v1/feeds/newsletter — localhost-only, creates a newsletter feed.
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

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"feed":  feed,
		"email": email,
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

func extractHTMLBody(msg *mail.Message) (string, error) {
	ct := msg.Header.Get("Content-Type")
	if ct == "" {
		body, err := io.ReadAll(msg.Body)
		return string(body), err
	}
	mediaType, params, err := mime.ParseMediaType(ct)
	if err != nil {
		body, err2 := io.ReadAll(msg.Body)
		return string(body), err2
	}

	switch {
	case strings.HasPrefix(mediaType, "text/html"):
		body, err := io.ReadAll(msg.Body)
		return string(body), err

	case strings.HasPrefix(mediaType, "text/plain"):
		body, err := io.ReadAll(msg.Body)
		return "<pre>" + string(body) + "</pre>", err

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
		body, err := io.ReadAll(msg.Body)
		return string(body), err
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
