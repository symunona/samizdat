package worker

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"time"

	"github.com/gen2brain/go-fitz"
	"github.com/symunona/samizdat/server/internal/store"
)

// pdfRenderDPI is the resolution figure crops are rendered at. 150 keeps axis
// labels and sub/superscripts legible on a phone without turning a full-page
// figure into a multi-megabyte asset.
const pdfRenderDPI = 150

// pdfRenderer draws PDF pages to raster images so a figure can be cut out of
// one.
//
// This is MuPDF (cgo, AGPL) rather than one of the pure-Go readers, because a
// figure is usually *not* an embedded image: TikZ, matplotlib and pgfplots all
// emit drawing operators, and there is nothing to extract from those — they
// have to be drawn. Of the engines that can draw a page, MuPDF was the only one
// that both rendered real papers correctly and stayed small enough for this box
// (15MB RSS, ~30-95ms/page; the pdfium-wasm alternative needed 292MB).
type pdfRenderer struct {
	doc *fitz.Document
}

// newPDFRenderer opens an already-downloaded PDF for rendering. The caller owns
// Close.
func newPDFRenderer(raw []byte) (*pdfRenderer, error) {
	doc, err := fitz.NewFromMemory(raw)
	if err != nil {
		return nil, fmt.Errorf("open pdf for render: %w", err)
	}
	return &pdfRenderer{doc: doc}, nil
}

func (r *pdfRenderer) Close() {
	if r.doc != nil {
		_ = r.doc.Close()
	}
}

// renderPage draws one page (1-based, as everywhere else in this package) at
// pdfRenderDPI.
func (r *pdfRenderer) renderPage(page int) (*image.RGBA, error) {
	img, err := r.doc.ImageDPI(page-1, pdfRenderDPI)
	if err != nil {
		return nil, fmt.Errorf("render page %d: %w", page, err)
	}
	return img, nil
}

// storePDFFigures renders each figure, writes it to the media cache and
// registers a media_asset, returning the placeholder token → media URL mapping
// that turns the extracted markdown into something servable.
//
// A figure that fails to render is skipped rather than failing the scrape: a
// Document with most of its figures beats no Document at all. The caller strips
// any token left unmapped.
func storePDFFigures(ctx context.Context, q *store.Queries, cacheDir, docID string, raw []byte, figs []pdfFigure) map[string]string {
	if len(figs) == 0 {
		return nil
	}

	r, err := newPDFRenderer(raw)
	if err != nil {
		logAssets.Warnf("pdf figures for %s: %v", docID[:8], err)
		return nil
	}
	defer r.Close()

	mediaDir := filepath.Join(cacheDir, "media")
	if err := os.MkdirAll(mediaDir, 0755); err != nil {
		logAssets.Errorf("mkdir media: %v", err)
		return nil
	}

	urls := make(map[string]string, len(figs))
	var (
		pageImg *image.RGBA
		pageNum int
	)
	for _, fig := range figs {
		// Figures arrive grouped by page, so one render serves all of a page's.
		if pageImg == nil || pageNum != fig.page {
			img, err := r.renderPage(fig.page)
			if err != nil {
				logAssets.Warnf("pdf figure p%d: %v", fig.page, err)
				continue
			}
			pageImg, pageNum = img, fig.page
		}

		assetID := IDFromURL(fig.assetURL(docID))
		localPath := filepath.Join("media", assetID+".png")
		w, h, err := writeFigurePNG(pageImg, fig, filepath.Join(cacheDir, localPath))
		if err != nil {
			logAssets.Warnf("pdf figure p%d: %v", fig.page, err)
			continue
		}

		now := time.Now().UTC().Format(time.RFC3339)
		w64, h64 := int64(w), int64(h)
		if _, err := q.UpsertMediaAsset(ctx, store.UpsertMediaAssetParams{
			ID:          assetID,
			DocumentID:  docID,
			OriginalUrl: fig.assetURL(docID),
			LocalPath:   localPath,
			Kind:        "content",
			Width:       &w64,
			Height:      &h64,
			CreatedAt:   now,
			UpdatedAt:   now,
		}); err != nil {
			logAssets.Errorf("insert pdf figure asset: %v", err)
			_ = os.Remove(filepath.Join(cacheDir, localPath))
			continue
		}
		urls[fig.token()] = "/api/v1/media/" + assetID
	}

	logAssets.Printf("document %s: stored %d/%d pdf figures", docID[:8], len(urls), len(figs))
	return urls
}

// writeFigurePNG cuts a figure out of its rendered page and writes it as PNG.
// PNG rather than JPEG because a figure is line art, where JPEG ringing is
// exactly what ruins thin strokes and small axis labels.
func writeFigurePNG(page *image.RGBA, fig pdfFigure, destPath string) (int, int, error) {
	rect := fig.pixelRect(page.Bounds())
	if rect.Empty() {
		return 0, 0, fmt.Errorf("figure box outside page")
	}

	scaled, err := scaleToMax(page.SubImage(rect), maxAssetDim)
	if err != nil {
		return 0, 0, err
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, scaled); err != nil {
		return 0, 0, fmt.Errorf("png encode: %w", err)
	}
	if err := os.WriteFile(destPath, buf.Bytes(), 0644); err != nil {
		return 0, 0, fmt.Errorf("write file: %w", err)
	}
	return scaled.Bounds().Dx(), scaled.Bounds().Dy(), nil
}
