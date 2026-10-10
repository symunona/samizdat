// Package digest is the per-period stage after the Pipelines: a Digest reads the
// Highlights its Feeds produced since its last DigestIssue and answers a list of
// questions over them, each answer a ranked list of DigestTopics that point back
// at the exact bullets they came from. It reads Highlights, never Documents.
package digest

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/store"
)

// Kind is the Job kind, and the name a Digest call carries in errors, progress
// and provenance.
const Kind = "run_digest"

const (
	PeriodDaily  = "daily"
	PeriodWeekly = "weekly"
)

// DigestIssue statuses.
const (
	StatusRunning = "running"
	StatusDone    = "done"
	StatusEmpty   = "empty" // nothing to read in the window; no call was made
	StatusFailed  = "failed"
)

const (
	defaultTopN = 5
	maxTopN     = 20
)

// Colors is the palette a Digest's colour is picked from, by NAME: the app maps a
// name to a hex that reads in both themes (PALETTE in app/src/tagColor.ts —
// TestColorsMatchAppPalette keeps the two lists identical).
var Colors = []string{"red", "orange", "yellow", "green", "blue", "purple", "pink"}

// NextColor is the colour a Digest saved without one gets: the first in Colors
// that the fewest other Digests use, so each is distinct while the palette lasts.
func NextColor(used []string) string {
	count := map[string]int{}
	for _, c := range used {
		count[c]++
	}
	return slices.MinFunc(Colors, func(a, b string) int { return count[a] - count[b] })
}

// Question is one editable prompt inside a Digest.
type Question struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Prompt  string `json:"prompt"`
	TopN    int    `json:"top_n"`
	Enabled bool   `json:"enabled"`
	// History compares each topic the question finds with earlier Highlights of
	// the same family, from before the window (history.go).
	History bool `json:"history,omitempty"`
}

// Digest is the config as the API serves it: the row with its JSON columns
// decoded and its flags as booleans.
type Digest struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	Period  string `json:"period"`
	// Weekdays are time.Weekday numbers (0 = Sunday); weekly only.
	Weekdays []int `json:"weekdays"`
	// Hour is the server-local hour the run is due.
	Hour          int        `json:"hour"`
	SourceFeedIDs []string   `json:"source_feed_ids"` // empty = every Feed
	Questions     []Question `json:"questions"`
	Provider      string     `json:"provider"`
	Model         string     `json:"model"`
	Color         string     `json:"color"` // a Colors name; "" = saved before colours existed
	NextRunAt     string     `json:"next_run_at"`
	LastRunAt     *string    `json:"last_run_at"`
	CreatedAt     string     `json:"created_at"`
	UpdatedAt     string     `json:"updated_at"`
	Rev           int64      `json:"rev"`
	DeletedAt     *string    `json:"deleted_at"`
}

// FromRow decodes a stored Digest. A JSON column that does not parse reads as
// empty — the lists are never nil, so they serialize as [].
func FromRow(row store.Digest) Digest {
	d := Digest{
		ID:            row.ID,
		Name:          row.Name,
		Enabled:       row.Enabled != 0,
		Period:        row.Period,
		Weekdays:      []int{},
		Hour:          int(row.Hour),
		SourceFeedIDs: []string{},
		Questions:     []Question{},
		Provider:      row.Provider,
		Model:         row.Model,
		Color:         row.Color,
		NextRunAt:     row.NextRunAt,
		LastRunAt:     row.LastRunAt,
		CreatedAt:     row.CreatedAt,
		UpdatedAt:     row.UpdatedAt,
		Rev:           row.Rev,
		DeletedAt:     row.DeletedAt,
	}
	_ = json.Unmarshal([]byte(row.Weekdays), &d.Weekdays)
	_ = json.Unmarshal([]byte(row.SourceFeedIds), &d.SourceFeedIDs)
	_ = json.Unmarshal([]byte(row.Questions), &d.Questions)
	return d
}

// Lists encodes the three JSON columns.
func (d Digest) Lists() (weekdays, sourceFeedIDs, questions string) {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return string(b)
	}
	return enc(d.Weekdays), enc(d.SourceFeedIDs), enc(d.Questions)
}

// ErrInvalid marks a Digest the editor must not be allowed to save.
var ErrInvalid = errors.New("invalid digest")

// Normalize validates d and fills what the editor may leave out: a question id,
// a top_n. It leaves no nil list behind.
func (d *Digest) Normalize() error {
	d.Name = strings.TrimSpace(d.Name)
	if d.Name == "" {
		return fmt.Errorf("%w: name required", ErrInvalid)
	}
	if d.Hour < 0 || d.Hour > 23 {
		return fmt.Errorf("%w: hour must be 0-23", ErrInvalid)
	}
	if d.Color != "" && !slices.Contains(Colors, d.Color) {
		return fmt.Errorf("%w: color must be one of %s", ErrInvalid, strings.Join(Colors, ", "))
	}
	switch d.Period {
	case PeriodDaily:
		d.Weekdays = []int{}
	case PeriodWeekly:
		if len(d.Weekdays) == 0 {
			return fmt.Errorf("%w: a weekly digest needs at least one weekday", ErrInvalid)
		}
		for _, wd := range d.Weekdays {
			if wd < 0 || wd > 6 {
				return fmt.Errorf("%w: weekday must be 0 (Sunday) - 6", ErrInvalid)
			}
		}
		slices.Sort(d.Weekdays)
		d.Weekdays = slices.Compact(d.Weekdays)
	default:
		return fmt.Errorf("%w: period must be %s or %s", ErrInvalid, PeriodDaily, PeriodWeekly)
	}
	if d.SourceFeedIDs == nil {
		d.SourceFeedIDs = []string{}
	}
	if d.Questions == nil {
		d.Questions = []Question{}
	}
	seen := map[string]bool{}
	for i := range d.Questions {
		q := &d.Questions[i]
		q.Title, q.Prompt = strings.TrimSpace(q.Title), strings.TrimSpace(q.Prompt)
		if q.Title == "" || q.Prompt == "" {
			return fmt.Errorf("%w: question %d needs a title and a prompt", ErrInvalid, i+1)
		}
		if q.ID == "" {
			q.ID = uuid.NewString()
		}
		if seen[q.ID] {
			return fmt.Errorf("%w: duplicate question id %q", ErrInvalid, q.ID)
		}
		seen[q.ID] = true
		if q.TopN < 1 {
			q.TopN = defaultTopN
		}
		q.TopN = min(q.TopN, maxTopN)
	}
	// Refused at save, not left for the run to trip over: a Digest that asks
	// nothing would only say so as a failed issue on its first due date.
	if !slices.ContainsFunc(d.Questions, func(q Question) bool { return q.Enabled }) {
		return fmt.Errorf("%w: a digest needs at least one enabled question", ErrInvalid)
	}
	return nil
}

// NextRun is the first due time strictly after `after`, in after's zone: the
// next Hour o'clock, on one of Weekdays when weekly.
func (d Digest) NextRun(after time.Time) time.Time {
	for day := 0; day <= 7; day++ {
		t := time.Date(after.Year(), after.Month(), after.Day()+day, d.Hour, 0, 0, 0, after.Location())
		if !t.After(after) {
			continue
		}
		if d.Period == PeriodWeekly && !slices.Contains(d.Weekdays, int(t.Weekday())) {
			continue
		}
		return t
	}
	// A weekly Digest with no weekday (Normalize refuses it): still move on, or
	// the scheduler would find it due on every tick.
	return after.AddDate(0, 0, 7)
}

// WindowStart is where a run starting at now begins reading: the end of the last
// issue, so a skipped or failed run loses nothing. A first run reads one period
// back.
func (d Digest) WindowStart(now time.Time) time.Time {
	if d.LastRunAt != nil {
		if t, err := time.Parse(time.RFC3339, *d.LastRunAt); err == nil {
			return t
		}
	}
	if d.Period == PeriodWeekly {
		return now.AddDate(0, 0, -7)
	}
	return now.AddDate(0, 0, -1)
}
