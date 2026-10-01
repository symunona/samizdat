// Package progress is the live state of a running Job: which phase it is in,
// since when, and the detail worth showing while it runs (egress, percent, LLM
// endpoint). It knows nothing about the store — the worker hands a Reporter a
// sink, and everything below the worker reports through the context.
package progress

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// Phases a job reports. The app maps each to a label.
const (
	PhaseFetch    = "fetch"    // browser / plain-HTTP fetch of the page or PDF
	PhaseProbe    = "probe"    // yt-dlp metadata probe, no media
	PhaseDownload = "download" // yt-dlp media download
	PhaseConvert  = "convert"  // yt-dlp post-processing (ffmpeg re-encode / merge)
	PhaseLLM      = "llm"      // a pipeline step waiting on a model
)

// State is the JSON stored in jobs.progress. Every field but Phase/Since is
// optional and owned by whoever reports it.
type State struct {
	Phase string `json:"phase"`
	Since string `json:"since"` // RFC3339, when Phase began

	// yt-dlp
	Media   string   `json:"media,omitempty"` // audio | video
	Proxy   string   `json:"proxy,omitempty"` // egress label, "direct" when none
	Tried   []string `json:"tried,omitempty"` // egresses that failed before Proxy
	Percent float64  `json:"percent,omitempty"`
	// Part/Parts: yt-dlp fetches a video as separate streams (video, then
	// audio), each with its own 0–100%. Percent is of the current Part.
	Part       int    `json:"part,omitempty"`
	Parts      int    `json:"parts,omitempty"`
	DurationMs int64  `json:"duration_ms,omitempty"` // media length, once probed
	Title      string `json:"title,omitempty"`

	// LLM
	Step     string `json:"step,omitempty"`     // step kind
	Provider string `json:"provider,omitempty"` // endpoint being asked
	Model    string `json:"model,omitempty"`
	Try      int    `json:"try,omitempty"`
	Tries    int    `json:"tries,omitempty"`
	Chunk    int    `json:"chunk,omitempty"` // 1-based
	Chunks   int    `json:"chunks,omitempty"`
	// Fallback: the configured chain moved past its primary, or the step
	// escalated to the big role. Either way, not the endpoint first asked.
	Fallback bool `json:"fallback,omitempty"`
}

// percentEvery is the floor between two percent-only writes. yt-dlp prints a
// progress line several times a second; the app polls every few seconds.
const percentEvery = 2 * time.Second

// Reporter owns one job's State. The zero of *Reporter (nil) is a valid
// reporter that drops everything, so code that may run outside a job needs no
// guard.
type Reporter struct {
	mu      sync.Mutex
	state   State
	sink    func(json string)
	now     func() time.Time
	flushed time.Time
}

// New returns a Reporter seeded from a job's stored progress ("" or unreadable
// = empty), writing every change to sink.
func New(stored string, sink func(json string)) *Reporter {
	r := &Reporter{sink: sink, now: time.Now}
	_ = json.Unmarshal([]byte(stored), &r.state)
	return r
}

// Update applies fn and writes the result. A phase change restarts Since and
// clears Percent — both describe the phase, not the job.
func (r *Reporter) Update(fn func(*State)) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	before := r.state.Phase
	fn(&r.state)
	if r.state.Phase != before || r.state.Since == "" {
		r.state.Since = r.now().UTC().Format(time.RFC3339)
		if r.state.Phase != before {
			r.state.Percent = 0
		}
	}
	r.flush()
}

// Percent records download progress, written at most once per percentEvery.
func (r *Reporter) Percent(p float64) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.state.Percent = p
	if r.now().Sub(r.flushed) >= percentEvery {
		r.flush()
	}
}

// JSON is the current state as stored, "" when nothing was ever reported.
func (r *Reporter) JSON() string {
	if r == nil {
		return ""
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.encode()
}

func (r *Reporter) encode() string {
	if r.state.Phase == "" {
		return ""
	}
	b, _ := json.Marshal(r.state)
	return string(b)
}

func (r *Reporter) flush() {
	r.flushed = r.now()
	if r.sink != nil {
		r.sink(r.encode())
	}
}

type ctxKey struct{}

// With carries r in ctx for everything a job handler calls.
func With(ctx context.Context, r *Reporter) context.Context {
	return context.WithValue(ctx, ctxKey{}, r)
}

// From returns the job's Reporter, or nil (a no-op reporter) outside a job.
func From(ctx context.Context) *Reporter {
	r, _ := ctx.Value(ctxKey{}).(*Reporter)
	return r
}
