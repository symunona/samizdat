package worker

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/langpref"
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
	Language          string                     `json:"language"` // original language tag, e.g. "hu"
	Subtitles         map[string]json.RawMessage `json:"subtitles"`
	AutomaticCaptions map[string]json.RawMessage `json:"automatic_captions"`
}

type ytMediaMetadata struct {
	Provider         string   `json:"provider"`
	ExternalID       string   `json:"external_id"`
	DurationMs       int64    `json:"duration_ms"`
	TranscriptStatus string   `json:"transcript_status"`          // subs | auto | none (for orig_lang)
	OrigLang         string   `json:"orig_lang,omitempty"`        // original transcript language, e.g. "hu"
	TranscriptLangs  []string `json:"transcript_langs,omitempty"` // all languages present in transcript map
	Description      string   `json:"description,omitempty"`
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

	// Probe pass: read metadata (crucially the original language) WITHOUT
	// downloading media, so we can decide which subtitle tracks to request.
	// Blindly requesting "en" pulled YouTube's machine-translation for
	// non-English videos; now we keep the original per the user's language prefs.
	info, err := probeYTInfo(ctx, bin, canonical, cfg)
	if err != nil {
		return "", err
	}
	prefsRaw, _ := q.GetSetting(ctx, langpref.SettingKey)
	prefs := langpref.Parse(prefsRaw)
	wanted := prefs.Wanted(info.Language) // wanted[0] == original language
	origLang := wanted[0]

	// Download pass: audio + the wanted subtitle tracks in one session.
	// Re-encode to 64k AAC: transparent for speech, ~half the disk/sync size on
	// the 4GB box vs bestaudio (see docs/youtube-ingest.md).
	args := []string{
		"-f", "bestaudio",
		"-x", "--audio-format", "m4a", "--audio-quality", "64K",
		"--write-subs", "--write-auto-subs",
		"--sub-langs", buildSubLangs(wanted),
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

	logScraper.Printf("yt-dlp %s (proxy=%q langs=%v)", canonical, cfg.Proxy, wanted)
	cmd := exec.CommandContext(ctx, bin, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", classifyYTDLPError(err, string(out), cfg)
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

	// Transcript: lang-keyed map {lang: [segments]}. Per language, manual subs
	// win over auto-captions. status reflects the ORIGINAL language's track.
	transcriptMap, status := loadTranscripts(base, wanted, info)
	transcriptJSON := "{}"
	if len(transcriptMap) > 0 {
		b, _ := json.Marshal(transcriptMap)
		transcriptJSON = string(b)
	}
	langs := make([]string, 0, len(transcriptMap))
	for l := range transcriptMap {
		langs = append(langs, l)
	}
	sort.Strings(langs)
	origSegs := transcriptMap[origLang]

	// Body markdown = flattened ORIGINAL transcript (so Pipeline/Highlight/
	// Annotation work on the native language, never a machine translation);
	// fall back to the video description when there's no transcript.
	md := transcript.FlattenText(origSegs)
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
		OrigLang:         origLang,
		TranscriptLangs:  langs,
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

	// Keep the per-language .vtt files in the media cache: they make the
	// lang-keyed transcript map rebuildable (design rule 1) without re-fetching.
	// The probe pass writes no info.json, so there is nothing else to clean up.

	logScraper.Printf("youtube document %s: %q orig=%s transcript=%s langs=%v segs=%d dur=%dms",
		doc.ID[:8], title, origLang, status, langs, len(origSegs), meta.DurationMs)

	// Reuse the shared finalize: thumbnail download + pipeline triggers.
	finishDocument(ctx, q, job, doc, title, manual)

	res, _ := json.Marshal(map[string]any{
		"document_id": doc.ID, "title": title, "media_type": "video",
		"transcript": status, "orig_lang": origLang, "langs": langs, "segments": len(origSegs),
	})
	return string(res), nil
}

// fetchVideoPayload is the fetch_video job payload — an already-ingested video
// Document to download a playable stream for.
type fetchVideoPayload struct {
	DocumentID string `json:"document_id"`
}

// handleFetchVideo downloads a native video stream for an already-ingested video
// Document (by canonical URL) so the app can play it without the YouTube embed.
// On-demand — most video Docs are never watched, and video is far larger than the
// audio we always fetch. Idempotent: skips if a video asset already exists.
func handleFetchVideo(ctx context.Context, q *store.Queries, job store.Job, cacheDir string, cfg config.YTDLPSection) (string, error) {
	var p fetchVideoPayload
	if err := json.Unmarshal([]byte(job.Payload), &p); err != nil {
		return "", fmt.Errorf("bad payload: %w", err)
	}
	doc, err := q.GetDocumentByID(ctx, p.DocumentID)
	if err != nil {
		return "", fmt.Errorf("get document: %w", err)
	}
	// Already fetched — no-op (idempotent retries / duplicate triggers).
	if _, err := q.GetMediaAssetByDocumentAndKind(ctx, store.GetMediaAssetByDocumentAndKindParams{
		DocumentID: doc.ID, Kind: "video",
	}); err == nil {
		return `{"skipped":"video already fetched"}`, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("check video asset: %w", err)
	}
	vid, ok := youtubeID(doc.CanonicalUrl)
	if !ok {
		return "", fmt.Errorf("document %s is not a youtube video", doc.ID[:8])
	}
	return fetchDocVideo(ctx, q, doc.CanonicalUrl, vid, cacheDir, cfg)
}

// fetchDocVideo downloads a capped-resolution muxed mp4 for a video Document and
// records it as a media_asset with kind="video". Prefers a muxed mp4 ≤720p, falls
// back to merging ≤480p video+audio — capping resolution keeps the 4GB box's disk
// in check. Routed through the configured proxy (the VPS IP is bot-blocked).
func fetchDocVideo(ctx context.Context, q *store.Queries, canonical, videoID, cacheDir string, cfg config.YTDLPSection) (string, error) {
	bin := cfg.Path
	if bin == "" {
		bin = "yt-dlp"
	}

	mediaDir := filepath.Join(cacheDir, "media")
	if err := os.MkdirAll(mediaDir, 0755); err != nil {
		return "", fmt.Errorf("mkdir media: %w", err)
	}

	videoAssetID := IDFromURL(canonical + "#video")
	base := filepath.Join(mediaDir, videoAssetID)

	args := []string{
		"-f", "best[ext=mp4][vcodec!=none][acodec!=none][height<=720]/bv*[height<=480]+ba/best[height<=480]",
		"--merge-output-format", "mp4",
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

	logScraper.Printf("yt-dlp video %s (proxy=%q)", canonical, cfg.Proxy)
	cmd := exec.CommandContext(ctx, bin, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", classifyYTDLPError(err, string(out), cfg)
	}

	// Locate the produced file (ext should be .mp4 after the merge).
	videoPath := base + ".mp4"
	if _, err := os.Stat(videoPath); err != nil {
		if found := firstMatch(base + ".*"); found != "" {
			videoPath = found
		} else {
			return "", fmt.Errorf("yt-dlp produced no video file")
		}
	}

	now := time.Now().UTC().Format(time.RFC3339)
	docID := IDFromURL(canonical)
	relPath := filepath.Join("media", filepath.Base(videoPath))
	if _, err := q.UpsertMediaAsset(ctx, store.UpsertMediaAssetParams{
		ID:          videoAssetID,
		DocumentID:  docID,
		OriginalUrl: canonical + "#video",
		LocalPath:   relPath,
		Kind:        "video",
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		return "", fmt.Errorf("insert video asset: %w", err)
	}

	logScraper.Printf("youtube video asset %s for %s (%s)", videoAssetID[:8], canonical, filepath.Base(videoPath))

	res, _ := json.Marshal(map[string]any{
		"document_id": docID, "video_asset": videoAssetID, "file": filepath.Base(videoPath),
	})
	return string(res), nil
}

// probeYTInfo dumps a video's metadata (yt-dlp -J) without downloading media, so
// the ingest can read the original language before deciding which subtitle tracks
// to request. One lightweight extra hit per ingest — worth it to stop translating
// non-English videos by default.
func probeYTInfo(ctx context.Context, bin, canonical string, cfg config.YTDLPSection) (*ytInfo, error) {
	args := []string{"-J", "--skip-download", "--no-playlist", "--no-progress"}
	if cfg.Proxy != "" {
		args = append(args, "--proxy", cfg.Proxy)
	}
	if cfg.Cookies != "" {
		args = append(args, "--cookies", cfg.Cookies)
	}
	args = append(args, canonical)

	logScraper.Printf("yt-dlp probe %s (proxy=%q)", canonical, cfg.Proxy)
	cmd := exec.CommandContext(ctx, bin, args...)
	out, err := cmd.Output() // -J writes the info JSON to stdout
	if err != nil {
		stderr := ""
		if ee, ok := err.(*exec.ExitError); ok {
			stderr = string(ee.Stderr)
		}
		return nil, classifyYTDLPError(err, stderr, cfg)
	}
	var info ytInfo
	if err := json.Unmarshal(out, &info); err != nil {
		return nil, fmt.Errorf("parse yt-dlp -J: %w", err)
	}
	return &info, nil
}

// buildSubLangs turns wanted base language codes into a yt-dlp --sub-langs value.
// For each language we request the plain tag plus its "-orig" variant (yt-dlp
// names an original track "<lang>-orig" when it also offers translations).
func buildSubLangs(wanted []string) string {
	pats := make([]string, 0, len(wanted)*2)
	for _, l := range wanted {
		pats = append(pats, l, l+"-orig")
	}
	return strings.Join(pats, ",")
}

// loadTranscripts parses the per-language .vtt files written next to base into a
// lang-keyed map. Per language, manual subs win over auto-captions. The returned
// status reflects the original language's track (wanted[0]): subs | auto | none.
func loadTranscripts(base string, wanted []string, info *ytInfo) (map[string][]transcript.Segment, string) {
	out := make(map[string][]transcript.Segment, len(wanted))
	status := "none"
	for i, lang := range wanted {
		segs := readLangVTT(base, lang)
		if len(segs) == 0 {
			continue
		}
		out[lang] = segs
		if i == 0 { // original language
			if hasLangKey(info.Subtitles, lang) {
				status = "subs"
			} else {
				status = "auto"
			}
		}
	}
	return out, status
}

// readLangVTT finds and parses the first non-empty .vtt for a base language code.
func readLangVTT(base, lang string) []transcript.Segment {
	candidates := []string{base + "." + lang + ".vtt", base + "." + lang + "-orig.vtt"}
	if m := firstMatch(base + "." + lang + "*.vtt"); m != "" {
		candidates = append(candidates, m)
	}
	seen := map[string]bool{}
	for _, p := range candidates {
		if seen[p] {
			continue
		}
		seen[p] = true
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		if segs := transcript.ParseVTT(string(data)); len(segs) > 0 {
			return segs
		}
	}
	return nil
}

// hasLangKey reports whether a subtitle map declares a track for base lang.
func hasLangKey(m map[string]json.RawMessage, lang string) bool {
	for k := range m {
		if langpref.BaseLang(k) == lang {
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
