package api

import (
	"archive/zip"
	"encoding/json"
	"io"
	"net/http"
)

// extensionVersion reports the version of the Chrome extension bundled in the
// served zip, read live from its manifest.json. The clipper popup compares this
// to its own manifest version to offer a "Download new version" action. Reading
// the zip per request keeps the reported version coupled to the served artifact,
// not to any build-time constant.
func extensionVersionHandler(zipPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, ok := readExtensionVersion(zipPath)
		if !ok {
			writeErr(w, http.StatusNotFound, "extension bundle not built")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"version": v})
	}
}

// readExtensionVersion returns the "version" field of manifest.json inside the
// zip, or ("", false) if the zip is missing/unreadable or has no version.
func readExtensionVersion(zipPath string) (string, bool) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return "", false
	}
	defer func() { _ = zr.Close() }()

	for _, f := range zr.File {
		if f.Name != "manifest.json" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", false
		}
		defer func() { _ = rc.Close() }()
		var m struct {
			Version string `json:"version"`
		}
		if err := json.NewDecoder(io.LimitReader(rc, 1<<20)).Decode(&m); err != nil {
			return "", false
		}
		return m.Version, m.Version != ""
	}
	return "", false
}
