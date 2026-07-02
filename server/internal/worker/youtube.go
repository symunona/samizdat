package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/store"
	"github.com/symunona/samizdat/server/internal/transcript"
)

// youtubeID extracts the video id from a YouTube URL (watch, youtu.be, shorts,
// embed). Returns ok=false for non-YouTube URLs.
func youtubeID(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", false
	}
	host := strings.ToLower(strings.TrimPrefix(u.Host, "www."))
	switch host {
	case "youtu.be":
		id := strings.Trim(u.Path, "/")
		if isVideoID(id) {
			return id, true
		}
	case "youtube.com", "m.youtube.com", "music.youtube.com":
		if v := u.Query().Get("v"); isVideoID(v) {
			return v, true
		}
		// /shorts/<id> or /embed/<id>
		for _, prefix := range []string{"/shorts/", "/embed/", "/v/"} {
			if strings.HasPrefix(u.Path, prefix) {
				id := strings.Trim(strings.TrimPrefix(u.Path, prefix), "/")
				if i := strings.IndexAny(id, "/?"); i >= 0 {
					id = id[:i]
				}
				if isVideoID(id) {
					return id, true
				}
			}
		}
	}
	return "", false
}

func isVideoID(s string) bool {
	if len(s) != 11 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '_', r == '-':
			// valid base64url id char
		default:
			return false
		}
	}
	return true
}

// youtubeCanonical returns the canonical watch URL for dedup (scrape-once rule).
func youtubeCanonical(id string) string {
	return "https://www.youtube.com/watch?v=" + id
}

// ytInfo is the subset of yt-dlp's info.json we use.
type ytInfo struct {
	Title             string                     `json:"title"`
	Uploader          string                     `json:"uploader"`
	Channel           string                     `json:"channel"`
	UploadDate        string                     `json:"upload_date"` // YYYYMMDD
	Duration          float64                    `json:"duration"`    // seconds
	Thumbnail         string                     `json:"thumbnail"`
	Description       string                     `json:"description"`
	Subtitles         map[string]json.RawMessage `json:"subtitles"`
	AutomaticCaptions map[string]json.RawMessage `json:"automatic_captions"`
}

type ytMediaMetadata struct {
	Provider         string `json:"provider"`
	ExternalID       string `json:"external_id"`
	DurationMs       int64  `json:"duration_ms"`
	TranscriptStatus string `json:"transcript_status"` // subs | auto | none
	Description      string `json:"description,omitempty"`
}

// handleYouTube ingests a YouTube URL into a video Document: audio-only download
// via yt-dlp + transcript (manual subs → auto-subs → none). Errors from the
// datacenter-IP bot wall are translated into an actionable message (docs link).
func handleYouTube(ctx context.Context, q *store.Queries, job store.Job, canonical, videoID string, cacheDir string, cfg config.YTDLPSection, manual bool) (string, error) {
	bin := cfg.Path
	if bin == "" {
		bin = "yt-dlp"
	}

	mediaDir := filepath.Join(cacheDir, "media")
	if err := os.MkdirAll(mediaDir, 0755); err != nil {
		return "", fmt.Errorf("mkdir media: %w", err)
	}

	audioAssetID := IDFromURL(canonical + "#audio")
	base := filepath.Join(mediaDir, audioAssetID)

	// One yt-dlp session: audio + metadata + subtitles. Minimizes bot exposure.
	// Re-encode to 64k AAC: transparent for speech, ~half the disk/sync size on
	// the 4GB box vs bestaudio (see docs/youtube-ingest.md).
	args := []string{
		"-f", "bestaudio",
		"-x", "--audio-format", "m4a", "--audio-quality", "64K",
		"--write-info-json",
		"--write-subs", "--write-auto-subs",
		"--sub-langs", "en.*,en,en-orig",
		"--sub-format", "vtt", "--convert-subs", "vtt",
		"--no-playlist", "--no-progress",
		"-o", base + ".%(ext)s",
	}
	if cfg.Proxy != "" {
		args = append(args, "--proxy", cfg.Proxy)
	}
	if cfg.Cookies != "" {
		args = append(args, "--cookies", cfg.Cookies)
	}
	args = append(args, canonical)

	logScraper.Printf("yt-dlp %s (proxy=%q)", canonical, cfg.Proxy)
	cmd := exec.CommandContext(ctx, bin, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", classifyYTDLPError(err, string(out), cfg)
	}

	// Parse metadata from the written info.json.
	info, err := readYTInfo(base + ".info.json")
	if err != nil {
		return "", fmt.Errorf("yt-dlp info: %w", err)
	}

	// Locate the downloaded audio file (ext should be .m4a).
	audioPath := base + ".m4a"
	if _, err := os.Stat(audioPath); err != nil {
		// Fall back to whatever audio yt-dlp produced.
		if found := firstMatch(base + ".*"); found != "" && !strings.HasSuffix(found, ".vtt") && !strings.HasSuffix(found, ".info.json") {
			audioPath = found
		} else {
			return "", fmt.Errorf("yt-dlp produced no audio file")
		}
	}

	// Transcript: prefer manual subs, fall back to auto-captions.
	segs, status := loadTranscript(base, info)
	transcriptJSON := "[]"
	if len(segs) > 0 {
		b, _ := json.Marshal(segs)
		transcriptJSON = string(b)
	}

	// Body markdown = flattened transcript (so Pipeline/Highlight/Annotation work);
	// fall back to the video description when there's no transcript.
	md := transcript.FlattenText(segs)
	if strings.TrimSpace(md) == "" {
		md = strings.TrimSpace(info.Description)
	}

	title := strings.TrimSpace(info.Title)
	author := strings.TrimSpace(info.Channel)
	if author == "" {
		author = strings.TrimSpace(info.Uploader)
	}

	var publishedAt *string
	if len(info.UploadDate) == 8 {
		if t, e := time.Parse("20060102", info.UploadDate); e == nil {
			pa := t.UTC().Format(time.RFC3339)
			publishedAt = &pa
		}
	}

	meta := ytMediaMetadata{
		Provider:         "youtube",
		ExternalID:       videoID,
		DurationMs:       int64(info.Duration * 1000),
		TranscriptStatus: status,
		Description:      strings.TrimSpace(info.Description),
	}
	metaJSON, _ := json.Marshal(meta)

	excerpt := strings.TrimSpace(info.Description)
	if len(excerpt) > 500 {
		excerpt = excerpt[:500]
	}

	now := time.Now().UTC().Format(time.RFC3339)
	docID := IDFromURL(canonical)
	sum := sha256.Sum256([]byte(md))
	contentHash := hex.EncodeToString(sum[:])

	doc, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID:            docID,
		CanonicalUrl:  canonical,
		Title:         title,
		Markdown:      md,
		FetchedAt:     now,
		Excerpt:       excerpt,
		HeroImageUrl:  strings.TrimSpace(info.Thumbnail),
		Author:        author,
		PublishedAt:   publishedAt,
		SourceFeedID:  nil,
		ContentHash:   contentHash,
		MediaType:     "video",
		MediaMetadata: string(metaJSON),
		Transcript:    transcriptJSON,
		CreatedAt:     now,
		UpdatedAt:     now,
	})
	if err != nil {
		return "", fmt.Errorf("insert document: %w", err)
	}

	// Record the audio file as a media asset (kind=audio).
	relPath := filepath.Join("media", filepath.Base(audioPath))
	if _, err := q.UpsertMediaAsset(ctx, store.UpsertMediaAssetParams{
		ID:          audioAssetID,
		DocumentID:  doc.ID,
		OriginalUrl: canonical + "#audio",
		LocalPath:   relPath,
		Kind:        "audio",
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		return "", fmt.Errorf("insert audio asset: %w", err)
	}

	// Drop intermediate files (info.json + subtitle vtts); keep only the audio.
	_ = os.Remove(base + ".info.json")
	for _, f := range globAll(base+".*.vtt", base+".vtt") {
		_ = os.Remove(f)
	}

	logScraper.Printf("youtube document %s: %q transcript=%s segs=%d dur=%dms",
		doc.ID[:8], title, status, len(segs), meta.DurationMs)

	// Reuse the shared finalize: thumbnail download + pipeline triggers.
	finishDocument(ctx, q, job, doc, title, manual)

	res, _ := json.Marshal(map[string]any{
		"document_id": doc.ID, "title": title, "media_type": "video",
		"transcript": status, "segments": len(segs),
	})
	return string(res), nil
}

// readYTInfo reads and parses a yt-dlp --write-info-json file.
func readYTInfo(path string) (*ytInfo, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read info.json: %w", err)
	}
	var info ytInfo
	if err := json.Unmarshal(b, &info); err != nil {
		return nil, fmt.Errorf("parse info.json: %w", err)
	}
	return &info, nil
}

// loadTranscript picks the best subtitle file written next to base and parses it.
// Manual subs (info.Subtitles) win over auto-captions (info.AutomaticCaptions).
func loadTranscript(base string, info *ytInfo) ([]transcript.Segment, string) {
	hasManualEN := hasENKey(info.Subtitles)
	hasAutoEN := hasENKey(info.AutomaticCaptions)

	// yt-dlp writes "<base>.<lang>.vtt"; prefer plain "en", then any "en*".
	candidates := []string{base + ".en.vtt", base + ".en-orig.vtt"}
	if m := firstMatch(base + ".en*.vtt"); m != "" {
		candidates = append(candidates, m)
	}
	if m := firstMatch(base + ".*.vtt"); m != "" {
		candidates = append(candidates, m)
	}
	for _, p := range candidates {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		segs := transcript.ParseVTT(string(data))
		if len(segs) > 0 {
			if hasManualEN {
				return segs, "subs"
			}
			return segs, "auto"
		}
	}
	if hasManualEN || hasAutoEN {
		return nil, "none" // declared but unreadable
	}
	return nil, "none"
}

func hasENKey(m map[string]json.RawMessage) bool {
	for k := range m {
		if k == "en" || strings.HasPrefix(k, "en-") || strings.HasPrefix(k, "en.") {
			return true
		}
	}
	return false
}

// firstMatch returns the first filesystem match for a glob, or "".
func firstMatch(pattern string) string {
	matches, _ := filepath.Glob(pattern)
	if len(matches) > 0 {
		return matches[0]
	}
	return ""
}

// globAll returns the union of filesystem matches for the given patterns.
func globAll(patterns ...string) []string {
	var out []string
	for _, p := range patterns {
		m, _ := filepath.Glob(p)
		out = append(out, m...)
	}
	return out
}

// classifyYTDLPError turns raw yt-dlp failures into actionable operator messages.
func classifyYTDLPError(err error, output string, cfg config.YTDLPSection) error {
	if execErr, ok := err.(*exec.Error); ok && execErr.Err != nil {
		return fmt.Errorf("yt-dlp not found (set [ytdlp].path in config; install: https://github.com/yt-dlp/yt-dlp#installation): %w", err)
	}
	low := strings.ToLower(output)
	if strings.Contains(low, "confirm you") || strings.Contains(low, "not a bot") || strings.Contains(low, "sign in to confirm") {
		hint := "this server's IP is blocked by YouTube (bot check)."
		if cfg.Proxy == "" {
			hint += " Set [ytdlp].proxy to a residential proxy (e.g. a home node over Tailscale) or [ytdlp].cookies to a cookies.txt."
		} else {
			hint += fmt.Sprintf(" Proxy %q is set but did not clear the block — verify it exits via a residential IP, or add [ytdlp].cookies.", cfg.Proxy)
		}
		return fmt.Errorf("youtube unavailable: %s See docs/youtube-ingest.md", hint)
	}
	if strings.Contains(low, "video unavailable") || strings.Contains(low, "private video") {
		return fmt.Errorf("youtube video unavailable (private/removed/region-locked)")
	}
	// Surface the last line of yt-dlp output for context.
	lines := strings.Split(strings.TrimSpace(output), "\n")
	last := ""
	if len(lines) > 0 {
		last = lines[len(lines)-1]
	}
	return fmt.Errorf("yt-dlp failed: %s", last)
}
