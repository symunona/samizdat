package api

import (
	"database/sql"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/symunona/samizdat/server/internal/store"
)

// New returns the root HTTP handler. webDir may be empty (API-only mode).
// serverURLs is the ordered list of reachable base URLs for this server.
func New(db *sql.DB, webDir string, serverURLs []string) http.Handler {
	q := store.New(db)
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("POST /pair", (&pairHandler{db: db, q: q, serverURLs: serverURLs}).ServeHTTP)
	mux.HandleFunc("GET /me", bearerAuth(q, handleMe))
	mux.HandleFunc("POST /admin/pair/new", localhostOnly((&adminPairHandler{q: q, serverURLs: serverURLs}).ServeHTTP))

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
