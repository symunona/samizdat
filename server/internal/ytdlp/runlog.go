package ytdlp

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// LastRunKey is the server_settings key holding the most recent Run as JSON, so
// a failed download still shows after a restart instead of reading as healthy.
const LastRunKey = "ytdlp_last_run"

// Run is the outcome of the most recent yt-dlp invocation that reached a
// verdict. Probes passing while every download fails is exactly the state the
// proxy and version checks cannot see — this is the one field that does.
type Run struct {
	OK    bool     `json:"ok"`
	At    string   `json:"at"`              // RFC3339
	What  string   `json:"what"`            // probe | audio[en] | video
	URL   string   `json:"url"`             // the canonical video URL
	Proxy string   `json:"proxy"`           // label of the egress that ran the final attempt
	Tried []string `json:"tried,omitempty"` // labels that failed before it
	Error string   `json:"error,omitempty"`
}

// Persist is the slice of settings storage the log needs.
type Persist interface {
	Get(ctx context.Context, key string) (string, error)
	Set(ctx context.Context, key, value string) error
}

// RunLog keeps the last Run in memory and mirrors it to settings.
type RunLog struct {
	persist Persist

	mu   sync.Mutex
	last *Run
}

func NewRunLog(persist Persist) *RunLog { return &RunLog{persist: persist} }

// Seed loads the persisted last Run.
func (l *RunLog) Seed(ctx context.Context) {
	if l == nil || l.persist == nil {
		return
	}
	v, err := l.persist.Get(ctx, LastRunKey)
	if err != nil || v == "" {
		return
	}
	var r Run
	if json.Unmarshal([]byte(v), &r) == nil {
		l.mu.Lock()
		l.last = &r
		l.mu.Unlock()
	}
}

// Record stores r as the last Run, stamping At. Nil-safe so tests and CLI paths
// can run yt-dlp without a log.
func (l *RunLog) Record(ctx context.Context, r Run) {
	if l == nil {
		return
	}
	r.At = time.Now().UTC().Format(time.RFC3339)
	l.mu.Lock()
	l.last = &r
	l.mu.Unlock()
	if l.persist == nil {
		return
	}
	if b, err := json.Marshal(r); err == nil {
		_ = l.persist.Set(ctx, LastRunKey, string(b))
	}
}

// Last returns a copy of the last Run, or nil before the first one.
func (l *RunLog) Last() *Run {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.last == nil {
		return nil
	}
	r := *l.last
	return &r
}
