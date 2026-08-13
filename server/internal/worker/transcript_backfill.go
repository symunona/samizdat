package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
	"github.com/symunona/samizdat/server/internal/transcript"
)

// backfillSettingKey guards the one-shot transcript re-parse.
const backfillSettingKey = "transcripts_reparsed_rollup"

// BackfillTranscripts rebuilds every video Document's transcript in place.
//
// Video bodies written before the roll-up fix hold each spoken line three times (see
// transcript.ParseVTT) and are wrapped mid-sentence. The subtitle files are kept in
// the media cache exactly so a re-parse needs no yt-dlp and no network (design rule
// 1: the DB is a rebuildable index); a row whose .vtt is gone falls back to repairing
// its stored segments (transcript.DedupRollup). Rewrites markdown + transcript +
// content_hash and bumps rev so phones pull the corrected body.
//
// One-shot and self-guarded, like pipeline.BackfillStepPrompts. A row that yields
// nothing is left untouched — a partial repair beats replacing a body with nothing.
func BackfillTranscripts(ctx context.Context, q *store.Queries, cacheDir string) error {
	if v, err := q.GetSetting(ctx, backfillSettingKey); err == nil && v != "" {
		return nil
	}
	docs, err := q.ListDocumentsByMediaType(ctx, "video")
	if err != nil {
		return fmt.Errorf("reparse transcripts: list videos: %w", err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	repaired := 0
	for _, doc := range docs {
		ok, err := reparseDocument(ctx, q, doc, cacheDir, now)
		if err != nil {
			return err
		}
		if ok {
			repaired++
		}
	}
	if err := q.UpsertSetting(ctx, store.UpsertSettingParams{Key: backfillSettingKey, Value: now}); err != nil {
		return fmt.Errorf("reparse transcripts: mark done: %w", err)
	}
	if repaired > 0 {
		logScraper.Printf("re-parsed %d/%d video transcripts from cached subtitles", repaired, len(docs))
	}
	return nil
}

// reparseDocument rebuilds one video Document's transcript from disk. Reports false
// when nothing usable was found, leaving the row untouched.
func reparseDocument(ctx context.Context, q *store.Queries, doc store.Document, cacheDir, now string) (bool, error) {
	tracks, langs := vttTracks(doc, cacheDir)
	if len(langs) == 0 {
		// No cached subtitles — repair the stored segments in place instead.
		tracks, langs = storedTracks(doc)
	}
	if len(langs) == 0 {
		return false, nil
	}

	md := transcript.FlattenText(tracks[langs[0]])
	if strings.TrimSpace(md) == "" {
		return false, nil
	}
	transcriptJSON, err := marshalTracks(tracks, langs)
	if err != nil {
		return false, fmt.Errorf("reparse transcripts: marshal %s: %w", doc.ID[:8], err)
	}
	sum := sha256.Sum256([]byte(md))
	if hex.EncodeToString(sum[:]) == doc.ContentHash {
		return false, nil // already the reflowed body
	}
	if err := q.UpdateDocumentTranscript(ctx, store.UpdateDocumentTranscriptParams{
		Markdown:    md,
		Transcript:  transcriptJSON,
		ContentHash: hex.EncodeToString(sum[:]),
		UpdatedAt:   now,
		ID:          doc.ID,
	}); err != nil {
		return false, fmt.Errorf("reparse transcripts: update %s: %w", doc.ID[:8], err)
	}
	return true, nil
}

// legacyLang keys the one track of a pre-per-language row, whose transcript column
// is a bare array rather than a lang-keyed map. marshalTracks restores that shape.
const legacyLang = ""

// vttTracks re-parses the Document's cached .vtt files, in the stored language order
// (primary first) — a re-parse must not silently re-pick the app's default track.
func vttTracks(doc store.Document, cacheDir string) (map[string][]transcript.Segment, []string) {
	var meta ytMediaMetadata
	if json.Unmarshal([]byte(doc.MediaMetadata), &meta) != nil {
		return nil, nil
	}
	base := filepath.Join(cacheDir, "media", IDFromURL(doc.CanonicalUrl+"#audio"))
	tracks := make(map[string][]transcript.Segment, len(meta.TranscriptLangs))
	langs := make([]string, 0, len(meta.TranscriptLangs))
	for _, lang := range meta.TranscriptLangs {
		segs := readLangVTT(base, lang)
		if len(segs) == 0 {
			continue
		}
		tracks[lang] = segs
		langs = append(langs, lang)
	}
	return tracks, langs
}

// storedTracks repairs the Document's stored segments without touching disk — the
// path for a row whose subtitles were pruned, or that predates per-language ingest
// (bare array, no transcript_langs). Accepts both stored shapes.
func storedTracks(doc store.Document) (map[string][]transcript.Segment, []string) {
	var arr []transcript.Segment
	if json.Unmarshal([]byte(doc.Transcript), &arr) == nil {
		if len(arr) == 0 {
			return nil, nil
		}
		return map[string][]transcript.Segment{legacyLang: repair(arr)}, []string{legacyLang}
	}
	var byLang map[string][]transcript.Segment
	if json.Unmarshal([]byte(doc.Transcript), &byLang) != nil {
		return nil, nil
	}
	tracks := make(map[string][]transcript.Segment, len(byLang))
	langs := make([]string, 0, len(byLang))
	for _, lang := range storedTranscriptLangs(doc, byLang) {
		if len(byLang[lang]) == 0 {
			continue
		}
		tracks[lang] = repair(byLang[lang])
		langs = append(langs, lang)
	}
	return tracks, langs
}

// repair turns stored roll-up segments into sentence-sized display segments.
func repair(segs []transcript.Segment) []transcript.Segment {
	return transcript.Reflow(transcript.DedupRollup(segs))
}

// storedTranscriptLangs returns the languages of a lang-keyed transcript in the
// metadata's order (primary first), then any track the metadata does not name.
func storedTranscriptLangs(doc store.Document, byLang map[string][]transcript.Segment) []string {
	var meta ytMediaMetadata
	_ = json.Unmarshal([]byte(doc.MediaMetadata), &meta)
	out := make([]string, 0, len(byLang))
	seen := map[string]bool{}
	for _, lang := range meta.TranscriptLangs {
		if _, ok := byLang[lang]; ok && !seen[lang] {
			out = append(out, lang)
			seen[lang] = true
		}
	}
	rest := make([]string, 0, len(byLang))
	for lang := range byLang {
		if !seen[lang] {
			rest = append(rest, lang)
		}
	}
	sort.Strings(rest) // map order is random; the primary track must not be a coin flip
	return append(out, rest...)
}

// marshalTracks writes the transcript back in the shape the row already had.
func marshalTracks(tracks map[string][]transcript.Segment, langs []string) (string, error) {
	var v any = tracks
	if len(langs) == 1 && langs[0] == legacyLang {
		v = tracks[legacyLang]
	}
	b, err := json.Marshal(v)
	return string(b), err
}
