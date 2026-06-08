package api

import (
	"context"
	"database/sql"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/symunona/samizdat/server/internal/store"
	"github.com/symunona/samizdat/server/internal/worker"
)

// New returns the root HTTP handler. webDir may be empty (API-only mode).
// serverURLs is the ordered list of reachable base URLs for this server.
func New(ctx context.Context, db *sql.DB, webDir string, serverURLs []string, cacheDir string) http.Handler {
	q := store.New(db)

	w := worker.New(q, cacheDir)
	w.Start(ctx)

	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/v1/health", handleHealth)
	mux.HandleFunc("POST /api/v1/pair", (&pairHandler{db: db, q: q, serverURLs: serverURLs}).ServeHTTP)
	mux.HandleFunc("GET /api/v1/me", bearerAuth(q, handleMe))
	mux.HandleFunc("GET /api/v1/devices", handleListDevices(q))
	mux.HandleFunc("DELETE /api/v1/devices/{id}", handleRevokeDevice(q))
	mux.HandleFunc("POST /api/v1/admin/pair/new", localhostOnly((&adminPairHandler{q: q, serverURLs: serverURLs}).ServeHTTP))

	devH := &adminDevicesHandler{q: q}
	mux.HandleFunc("GET /api/v1/admin/devices", localhostOnly(devH.list))
	mux.HandleFunc("DELETE /api/v1/admin/devices/{id}", localhostOnly(devH.revoke))

	jobsH := &jobsHandler{q: q}
	mux.HandleFunc("POST /api/v1/jobs", bearerAuth(q, jobsH.create))

	docsH := &documentsHandler{q: q}
	mux.HandleFunc("GET /api/v1/documents", bearerAuth(q, docsH.list))
	mux.HandleFunc("GET /api/v1/documents/{id}", bearerAuth(q, docsH.get))
	mux.HandleFunc("GET /api/v1/documents/{id}/media", bearerAuth(q, docsH.listMedia))

	mediaH := &mediaHandler{q: q, cacheDir: cacheDir}
	mux.HandleFunc("GET /api/v1/media/{id}", mediaH.serve)

	rsH := &readStatesHandler{q: q}
	mux.HandleFunc("GET /api/v1/documents/{id}/progress", bearerAuth(q, rsH.get))
	mux.HandleFunc("PUT /api/v1/documents/{id}/progress", bearerAuth(q, rsH.put))

	if webDir != "" {
		if _, err := os.Stat(webDir); err == nil {
			mux.Handle("/", spaHandler(webDir))
			log.Printf("serving web app from %s", webDir)
		} else {
			log.Printf("webdir %q not found, skipping static serving", webDir)
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
			http.ServeFileFS(w, r2, root, "index.html")
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}
