package api

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// debugLogsHandler receives live log batches from a paired device and appends
// them to a per-device NDJSON file under `dir` (CWD-relative `tmp/device-logs`,
// gitignored). It's a debugging channel — `tail -F tmp/device-logs/*.ndjson`
// (or `just device-logs`) on the server host to watch a physical device in real
// time. Body is raw NDJSON produced by app/src/debugLog.ts; we append verbatim.
type debugLogsHandler struct{ dir string }

// maxBatch caps a single POST body so a misbehaving client can't fill the disk
// in one shot. The app flushes small batches (~1s cadence), well under this.
const maxDebugLogBatch = 1 << 20 // 1 MiB

func (h *debugLogsHandler) ingest(w http.ResponseWriter, r *http.Request) {
	dev := deviceFromCtx(r)
	body, err := io.ReadAll(io.LimitReader(r.Body, maxDebugLogBatch))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read body")
		return
	}
	if len(body) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := os.MkdirAll(h.dir, 0o755); err != nil {
		logAPI.Errorf("device-logs: mkdir %s: %v", h.dir, err)
		writeErr(w, http.StatusInternalServerError, "log dir")
		return
	}
	path := filepath.Join(h.dir, deviceLogFilename(dev.Name, dev.ID))
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		logAPI.Errorf("device-logs: open %s: %v", path, err)
		writeErr(w, http.StatusInternalServerError, "log write")
		return
	}
	defer f.Close()
	// O_APPEND makes each write atomic vs. concurrent flushes; ensure a trailing
	// newline so consecutive batches stay line-delimited even if a client omits it.
	if !strings.HasSuffix(string(body), "\n") {
		body = append(body, '\n')
	}
	if _, err := f.Write(body); err != nil {
		logAPI.Errorf("device-logs: write %s: %v", path, err)
		writeErr(w, http.StatusInternalServerError, "log write")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// deviceLogFilename builds a safe, stable filename from a device's name + id.
// Name is user-controlled, so strip anything outside [A-Za-z0-9._-]; the first
// 8 chars of the id keep files distinct across identically-named devices.
func deviceLogFilename(name, id string) string {
	safe := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			return r
		default:
			return '-'
		}
	}, name)
	safe = strings.Trim(safe, "-")
	if safe == "" {
		safe = "device"
	}
	short := id
	if len(short) > 8 {
		short = short[:8]
	}
	return safe + "-" + short + ".ndjson"
}
