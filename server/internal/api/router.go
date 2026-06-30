package api

import (
	"compress/gzip"
	"context"
	"database/sql"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
	"github.com/symunona/samizdat/server/internal/worker"
)

// New returns the root HTTP handler. webDir may be empty (API-only mode).
// serverURLs is the ordered list of reachable base URLs for this server.
func New(ctx context.Context, db *sql.DB, webDir string, extensionZip string, serverURLs []string, cacheDir string, extractorDir string, ytdlp config.YTDLPSection, llmCfg ...config.LLMSection) http.Handler {
	q := store.New(db)

	var llmClient llm.Client
	if len(llmCfg) > 0 {
		llmClient = llm.New(llmCfg[0])
	}

	w := worker.New(q, db, cacheDir, extractorDir, llmClient, ytdlp)
	w.Start(ctx)

	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/v1/health", handleHealth)
	mux.HandleFunc("POST /api/v1/pair", (&pairHandler{db: db, q: q, serverURLs: serverURLs}).ServeHTTP)
	mux.HandleFunc("GET /api/v1/me", bearerAuth(q, handleMe))
	mux.HandleFunc("PATCH /api/v1/me", handlePatchMe(q))
	mux.HandleFunc("GET /api/v1/devices", handleListDevices(q))
	mux.HandleFunc("DELETE /api/v1/devices/{id}", handleRevokeDevice(q))
	mux.HandleFunc("POST /api/v1/devices/extension-token", handleMintExtensionToken(q, serverURLs))
	mux.HandleFunc("POST /api/v1/admin/pair/new", localhostOnly((&adminPairHandler{q: q, serverURLs: serverURLs}).ServeHTTP))
	mux.HandleFunc("POST /api/v1/admin/test-device", localhostOnly((&adminTestDeviceHandler{q: q, serverURLs: serverURLs}).ServeHTTP))

	devH := &adminDevicesHandler{q: q}
	mux.HandleFunc("GET /api/v1/admin/devices", localhostOnly(devH.list))
	mux.HandleFunc("DELETE /api/v1/admin/devices/{id}", localhostOnly(devH.revoke))

	jobsH := &jobsHandler{q: q, db: db}
	mux.HandleFunc("POST /api/v1/jobs", bearerAuth(q, jobsH.create))
	mux.HandleFunc("GET /api/v1/jobs", bearerAuth(q, jobsH.list))
	mux.HandleFunc("GET /api/v1/jobs/{id}", bearerAuth(q, jobsH.get))
	mux.HandleFunc("DELETE /api/v1/jobs", bearerAuth(q, jobsH.clearCompleted))
	mux.HandleFunc("DELETE /api/v1/jobs/queued", bearerAuth(q, jobsH.clearQueued))
	// resume-all must be registered before {id}/resume so the literal path takes priority
	mux.HandleFunc("POST /api/v1/jobs/resume-all", bearerAuth(q, jobsH.resumeAll))
	mux.HandleFunc("POST /api/v1/jobs/{id}/resume", bearerAuth(q, jobsH.resume))
	mux.HandleFunc("POST /api/v1/jobs/{id}/retry", bearerAuth(q, jobsH.retry))
	mux.HandleFunc("POST /api/v1/jobs/{id}/rerun", bearerAuth(q, jobsH.rerun))
	mux.HandleFunc("DELETE /api/v1/jobs/{id}", bearerAuth(q, jobsH.softDelete))

	subsH := &subscriptionsHandler{q: q, reg: w.ExtractorRegistry(), extractorsDir: extractorDir}
	mux.HandleFunc("POST /api/v1/subscriptions", bearerAuth(q, subsH.create))
	mux.HandleFunc("GET /api/v1/subscriptions", bearerAuth(q, subsH.list))
	mux.HandleFunc("PATCH /api/v1/subscriptions/{id}", bearerAuth(q, subsH.patch))
	mux.HandleFunc("DELETE /api/v1/subscriptions/{id}", bearerAuth(q, subsH.delete))
	mux.HandleFunc("POST /api/v1/subscriptions/{id}/poll", bearerAuth(q, subsH.poll))
	mux.HandleFunc("GET /api/v1/feeds", bearerAuth(q, subsH.listFeeds))
	mux.HandleFunc("GET /api/v1/feeds/{id}", bearerAuth(q, subsH.getFeed))
	mux.HandleFunc("GET /api/v1/feeds/{id}/items", bearerAuth(q, subsH.listFeedItems))
	mux.HandleFunc("POST /api/v1/feeds/{id}/queue-pipelines", bearerAuth(q, subsH.queuePipelines))

	adminFeedsH := &adminFeedsHandler{reg: w.ExtractorRegistry(), browser: w}
	mux.HandleFunc("POST /api/v1/admin/feeds/preview", localhostOnly(adminFeedsH.preview))

	nlH := &newsletterHandler{q: q}
	mux.HandleFunc("POST /api/v1/inbound/email", nlH.inbound)
	mux.HandleFunc("POST /api/v1/feeds/newsletter", bearerAuth(q, nlH.create))
	mux.HandleFunc("DELETE /api/v1/feeds/{id}", bearerAuth(q, nlH.delete))

	syncH := &syncHandler{q: q}
	mux.HandleFunc("GET /api/v1/sync", bearerAuth(q, syncH.sync))

	docsH := &documentsHandler{q: q}
	mux.HandleFunc("GET /api/v1/documents", bearerAuth(q, docsH.list))
	mux.HandleFunc("GET /api/v1/documents/by-url", bearerAuth(q, docsH.lookupByURL))
	mux.HandleFunc("GET /api/v1/documents/{id}", bearerAuth(q, docsH.get))
	mux.HandleFunc("DELETE /api/v1/documents/{id}", bearerAuth(q, docsH.delete))
	mux.HandleFunc("GET /api/v1/documents/{id}/media", bearerAuth(q, docsH.listMedia))
	mux.HandleFunc("POST /api/v1/documents/{id}/queue-pipelines", bearerAuth(q, docsH.queuePipelines))

	annH := &annotationsHandler{q: q}
	mux.HandleFunc("GET /api/v1/documents/{id}/annotations", bearerAuth(q, annH.list))
	mux.HandleFunc("POST /api/v1/documents/{id}/annotations", bearerAuth(q, annH.create))
	mux.HandleFunc("PUT /api/v1/annotations/{id}", bearerAuth(q, annH.update))
	mux.HandleFunc("DELETE /api/v1/annotations/{id}", bearerAuth(q, annH.delete))

	tagsH := &tagsHandler{q: q}
	mux.HandleFunc("GET /api/v1/tags", bearerAuth(q, tagsH.list))
	mux.HandleFunc("POST /api/v1/tags", bearerAuth(q, tagsH.create))
	mux.HandleFunc("DELETE /api/v1/tags/{id}", bearerAuth(q, tagsH.delete))
	mux.HandleFunc("GET /api/v1/tags/{id}/documents", bearerAuth(q, tagsH.listDocumentsByTag))
	mux.HandleFunc("GET /api/v1/tags/{id}/annotations", bearerAuth(q, tagsH.listAnnotationsByTag))

	docTagsH := &documentTagsHandler{q: q}
	mux.HandleFunc("GET /api/v1/documents/{id}/tags", bearerAuth(q, docTagsH.list))
	mux.HandleFunc("POST /api/v1/documents/{id}/tags", bearerAuth(q, docTagsH.add))
	mux.HandleFunc("DELETE /api/v1/documents/{id}/tags/{tag_id}", bearerAuth(q, docTagsH.remove))

	annTagsH := &annotationTagsHandler{q: q}
	mux.HandleFunc("GET /api/v1/annotations/{id}/tags", bearerAuth(q, annTagsH.list))
	mux.HandleFunc("POST /api/v1/annotations/{id}/tags", bearerAuth(q, annTagsH.add))
	mux.HandleFunc("DELETE /api/v1/annotations/{id}/tags/{tag_id}", bearerAuth(q, annTagsH.remove))

	mediaH := &mediaHandler{q: q, cacheDir: cacheDir}
	mux.HandleFunc("GET /api/v1/media/{id}", mediaH.serve)
	mux.HandleFunc("GET /api/v1/documents/{id}/audio", mediaH.serveDocAudio)

	rsH := &readStatesHandler{q: q}
	mux.HandleFunc("GET /api/v1/documents/{id}/progress", bearerAuth(q, rsH.get))
	mux.HandleFunc("PUT /api/v1/documents/{id}/progress", bearerAuth(q, rsH.put))

	settingsH := &settingsHandler{q: q}
	mux.HandleFunc("GET /api/v1/settings", bearerAuth(q, settingsH.get))
	mux.HandleFunc("PUT /api/v1/settings", bearerAuth(q, settingsH.put))

	ytStatusH := newYtdlpStatusHandler(ctx, q, ytdlp.Proxy)
	mux.HandleFunc("GET /api/v1/ytdlp/status", bearerAuth(q, ytStatusH.get))

	plH := &pipelinesHandler{q: q}
	mux.HandleFunc("GET /api/v1/pipelines", bearerAuth(q, plH.list))
	mux.HandleFunc("POST /api/v1/pipelines", bearerAuth(q, plH.create))
	mux.HandleFunc("GET /api/v1/pipelines/{id}", bearerAuth(q, plH.get))
	mux.HandleFunc("PUT /api/v1/pipelines/{id}", bearerAuth(q, plH.update))
	mux.HandleFunc("DELETE /api/v1/pipelines/{id}", bearerAuth(q, plH.delete))
	mux.HandleFunc("POST /api/v1/pipelines/{id}/run", bearerAuth(q, plH.run))
	mux.HandleFunc("GET /api/v1/pipelines/{id}/documents", bearerAuth(q, plH.listDocuments))
	mux.HandleFunc("GET /api/v1/pipelines/{id}/jobs", bearerAuth(q, plH.listJobs))

	hlH := &highlightsHandler{q: q}
	mux.HandleFunc("GET /api/v1/highlights", bearerAuth(q, hlH.listAll))
	mux.HandleFunc("GET /api/v1/documents/{id}/highlights", bearerAuth(q, hlH.listByDocument))
	mux.HandleFunc("GET /api/v1/documents/{id}/pipeline-runs", bearerAuth(q, hlH.listRunsByDocument))
	mux.HandleFunc("DELETE /api/v1/documents/{id}/highlights", bearerAuth(q, hlH.deleteAllByDocument))
	mux.HandleFunc("DELETE /api/v1/highlights/{id}", bearerAuth(q, hlH.deleteOne))
	mux.HandleFunc("PATCH /api/v1/highlights/{id}", bearerAuth(q, hlH.patchOne))

	hlTagsH := &highlightTagsHandler{q: q}
	mux.HandleFunc("GET /api/v1/highlights/{id}/tags", bearerAuth(q, hlTagsH.list))
	mux.HandleFunc("POST /api/v1/highlights/{id}/tags", bearerAuth(q, hlTagsH.add))
	mux.HandleFunc("DELETE /api/v1/highlights/{id}/tags/{tag_id}", bearerAuth(q, hlTagsH.remove))

	if extensionZip != "" {
		mux.HandleFunc("GET /extension/sam-chrome.zip", func(w http.ResponseWriter, r *http.Request) {
			if _, err := os.Stat(extensionZip); err != nil {
				writeErr(w, http.StatusNotFound, "extension bundle not built")
				return
			}
			w.Header().Set("Content-Type", "application/zip")
			w.Header().Set("Content-Disposition", `attachment; filename="sam-chrome.zip"`)
			http.ServeFile(w, r, extensionZip)
		})
		mux.HandleFunc("GET /api/v1/extension/version", extensionVersionHandler(extensionZip))
		logAPI.Printf("serving extension bundle from %s", extensionZip)
	}

	if webDir != "" {
		if _, err := os.Stat(webDir); err == nil {
			mux.Handle("/", spaHandler(webDir))
			logAPI.Printf("serving web app from %s", webDir)
		} else {
			logAPI.Warnf("webdir %q not found, skipping static serving", webDir)
		}
	}

	return corsMiddleware(mux)
}

func spaHandler(dir string) http.Handler {
	root := os.DirFS(dir)
	fileServer := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" {
			path = "index.html"
		} else {
			path = filepath.Join(".", path)
		}
		if _, err := fs.Stat(root, path); err != nil {
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFileFS(w, r2, root, "index.html")
			return
		}
		// Never cache index.html — hashed JS chunks are fine to cache long-term
		if path == "index.html" {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			gzw := &gzipResponseWriter{ResponseWriter: w, gz: nil}
			defer gzw.close()
			w = gzw
		}
		fileServer.ServeHTTP(w, r)
	})
}

type gzipResponseWriter struct {
	http.ResponseWriter
	gz      *gzip.Writer
	skipped bool
}

func (g *gzipResponseWriter) WriteHeader(code int) {
	ct := g.ResponseWriter.Header().Get("Content-Type")
	if isCompressible(ct) {
		g.ResponseWriter.Header().Set("Content-Encoding", "gzip")
		g.ResponseWriter.Header().Del("Content-Length")
		g.gz = gzip.NewWriter(g.ResponseWriter)
	} else {
		g.skipped = true
	}
	g.ResponseWriter.WriteHeader(code)
}

func (g *gzipResponseWriter) Write(b []byte) (int, error) {
	if g.gz == nil && !g.skipped {
		// WriteHeader not called yet — default 200, check content type from header
		ct := g.ResponseWriter.Header().Get("Content-Type")
		if isCompressible(ct) {
			g.ResponseWriter.Header().Set("Content-Encoding", "gzip")
			g.ResponseWriter.Header().Del("Content-Length")
			g.gz = gzip.NewWriter(g.ResponseWriter)
		} else {
			g.skipped = true
		}
	}
	if g.gz != nil {
		return g.gz.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

func (g *gzipResponseWriter) close() {
	if g.gz != nil {
		g.gz.Close()
	}
}

func isCompressible(ct string) bool {
	return strings.HasPrefix(ct, "text/") ||
		strings.Contains(ct, "javascript") ||
		strings.Contains(ct, "json") ||
		strings.Contains(ct, "xml") ||
		strings.Contains(ct, "wasm")
}
