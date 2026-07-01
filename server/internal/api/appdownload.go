package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
)

// The Android APK is served like the clipper extension zip: a static artifact
// on disk plus a version endpoint the app polls to offer a "Download update"
// action. Unlike a zip's manifest.json, an APK's versionCode lives in binary
// AndroidManifest.xml, so `just build-android` writes a sidecar `<apk>.json`
// atomically next to the apk; the version handler reads that sidecar per request
// to keep the reported version coupled to the served artifact.

// appDownloadHandler serves the built debug APK as an attachment.
func appDownloadHandler(apkPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(apkPath); err != nil {
			writeErr(w, http.StatusNotFound, "apk not built")
			return
		}
		w.Header().Set("Content-Type", "application/vnd.android.package-archive")
		w.Header().Set("Content-Disposition", `attachment; filename="samizdat.apk"`)
		http.ServeFile(w, r, apkPath)
	}
}

// appVersionHandler reports the version of the served APK, read live from its
// sidecar manifest. The app compares this to its own build's versionCode to
// offer an update download.
func appVersionHandler(apkPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f, err := os.Open(apkPath + ".json")
		if err != nil {
			writeErr(w, http.StatusNotFound, "apk not built")
			return
		}
		defer func() { _ = f.Close() }()
		var m map[string]any
		if err := json.NewDecoder(io.LimitReader(f, 1<<20)).Decode(&m); err != nil {
			writeErr(w, http.StatusInternalServerError, "invalid apk manifest")
			return
		}
		writeJSON(w, http.StatusOK, m)
	}
}
