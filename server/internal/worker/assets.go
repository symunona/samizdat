package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	_ "golang.org/x/image/webp"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
	"golang.org/x/image/draw"
)

type fetchAssetsPayload struct {
	DocumentID string `json:"document_id"`
}

// markdownImageRe matches ![alt](https://...) in markdown.
var markdownImageRe = regexp.MustCompile(`!\[([^\]]*)\]\((https?://[^)]+)\)`)

// skipPathFragments are substrings in the URL path that indicate non-content images.
var skipPathFragments = []string{
	"icon", "logo", "avatar", "sprite", "pixel", "tracker",
	"badge", "button", "banner",
}

// shouldDownload returns true if the image URL and alt text pass the heuristic filter.
func shouldDownload(rawURL, altText string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}

	lpath := strings.ToLower(u.Path)

	// Skip by extension.
	if strings.HasSuffix(lpath, ".gif") || strings.HasSuffix(lpath, ".svg") {
		return false
	}

	// Skip by path fragment.
	for _, frag := range skipPathFragments {
		if strings.Contains(lpath, frag) {
			return false
		}
	}

	// Skip decorative alt labels; empty alt is fine (common in real content images).
	alt := strings.ToLower(strings.TrimSpace(altText))
	if alt == "logo" || alt == "icon" {
		return false
	}

	return true
}

func handleFetchAssets(ctx context.Context, q *store.Queries, job store.Job, cacheDir string) (string, error) {
	var p fetchAssetsPayload
	if err := json.Unmarshal([]byte(job.Payload), &p); err != nil {
		return "", fmt.Errorf("bad payload: %w", err)
	}

	doc, err := q.GetDocumentByID(ctx, p.DocumentID)
	if err != nil {
		return "", fmt.Errorf("get document: %w", err)
	}

	// Collect image candidates: hero first, then content images from markdown.
	type candidate struct {
		url  string
		alt  string
		kind string
	}
	var candidates []candidate

	if doc.HeroImageUrl != "" {
		candidates = append(candidates, candidate{
			url:  doc.HeroImageUrl,
			alt:  "hero",
			kind: "hero",
		})
	}

	matches := markdownImageRe.FindAllStringSubmatch(doc.Markdown, -1)
	for _, m := range matches {
		alt := m[1]
		imgURL := m[2]
		candidates = append(candidates, candidate{url: imgURL, alt: alt, kind: "content"})
	}

	mediaDir := filepath.Join(cacheDir, "media")
	if err := os.MkdirAll(mediaDir, 0755); err != nil {
		return "", fmt.Errorf("mkdir media: %w", err)
	}

	client := &http.Client{Timeout: 20 * time.Second}

	for _, c := range candidates {
		// For hero images we skip the alt-text filter (alt is synthetic "hero").
		if c.kind != "hero" && !shouldDownload(c.url, c.alt) {
			continue
		}
		if c.kind == "hero" {
			// Still apply URL-based filters for hero.
			u, _ := url.Parse(c.url)
			if u == nil {
				continue
			}
			lpath := strings.ToLower(u.Path)
			if strings.HasSuffix(lpath, ".gif") || strings.HasSuffix(lpath, ".svg") {
				continue
			}
		}

		// Skip if already cached.
		_, err := q.GetMediaAssetByOriginalURL(ctx, c.url)
		if err == nil {
			continue // already have it
		}

		assetID := IDFromURL(c.url)
		localPath := filepath.Join("media", assetID+".jpg")
		fullPath := filepath.Join(cacheDir, localPath)

		width, height, err := downloadAndThumbnail(ctx, client, c.url, fullPath)
		if err != nil {
			log.Printf("assets: skip %s: %v", c.url, err)
			continue
		}

		now := time.Now().UTC().Format(time.RFC3339)
		w64 := int64(width)
		h64 := int64(height)
		_, err = q.UpsertMediaAsset(ctx, store.UpsertMediaAssetParams{
			ID:          assetID,
			DocumentID:  doc.ID,
			OriginalUrl: c.url,
			LocalPath:   localPath,
			Kind:        c.kind,
			Width:       &w64,
			Height:      &h64,
			CreatedAt:   now,
			UpdatedAt:   now,
		})
		if err != nil {
			log.Printf("assets: insert media_asset: %v", err)
			_ = os.Remove(fullPath)
		}
	}
	jobResult, _ := json.Marshal(map[string]int{"assets": len(candidates)})
	return string(jobResult), nil
}

// downloadAndThumbnail fetches the image at imgURL, resizes it to max 800px on
// the longest side (JPEG quality 80), and saves it to destPath.
// Returns the thumbnail dimensions.
func downloadAndThumbnail(ctx context.Context, client *http.Client, imgURL, destPath string) (int, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imgURL, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "Samizdat/1 (+https://github.com/symunona/samizdat)")

	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, fmt.Errorf("fetch: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return 0, 0, fmt.Errorf("http %d", resp.StatusCode)
	}

	src, _, err := image.Decode(resp.Body)
	if err != nil {
		return 0, 0, fmt.Errorf("decode image: %w", err)
	}

	bounds := src.Bounds()
	origW := bounds.Dx()
	origH := bounds.Dy()
	if origW == 0 || origH == 0 {
		return 0, 0, fmt.Errorf("zero-size image")
	}

	const maxDim = 800
	dstW, dstH := origW, origH
	if origW > maxDim || origH > maxDim {
		if origW >= origH {
			dstW = maxDim
			dstH = origH * maxDim / origW
		} else {
			dstH = maxDim
			dstW = origW * maxDim / origH
		}
	}
	if dstW < 1 {
		dstW = 1
	}
	if dstH < 1 {
		dstH = 1
	}

	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	draw.BiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Over, nil)

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 80}); err != nil {
		return 0, 0, fmt.Errorf("jpeg encode: %w", err)
	}

	if err := os.WriteFile(destPath, buf.Bytes(), 0644); err != nil {
		return 0, 0, fmt.Errorf("write file: %w", err)
	}

	return dstW, dstH, nil
}
