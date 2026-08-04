package extractor

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Mirrors the live shape of /api/v1/reader/feed/profile/<id>?types[]=note:
// two own notes, one restack of another writer, and one non-note activity item.
const notesFeedFixture = `{"items":[
{"entity_key":"c-306746759","type":"comment","context":{"type":"note"},"comment":{"handle":"noahpinion"}},
{"entity_key":"c-306527002","type":"comment","context":{"type":"note"},"comment":{"handle":"NoahPinion"}},
{"entity_key":"c-111111111","type":"comment","context":{"type":"note"},"comment":{"handle":"someoneelse"}},
{"entity_key":"c-222222222","type":"post","context":{"type":"feed"},"comment":{"handle":"noahpinion"}}
],"nextCursor":"x"}`

func substackTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/user/noahpinion/public_profile":
			_, _ = w.Write([]byte(`{"id":8243895,"handle":"noahpinion"}`))
		case "/api/v1/reader/feed/profile/8243895":
			if r.URL.Query().Get("types[]") != "note" {
				t.Errorf("missing types[]=note, got %q", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(notesFeedFixture))
		default:
			http.NotFound(w, r)
		}
	}))
	orig := substackAPIBase
	substackAPIBase = srv.URL
	t.Cleanup(func() { substackAPIBase = orig; srv.Close() })
	return srv
}

func TestSubstackNotesDiscover(t *testing.T) {
	substackTestServer(t)

	urls, err := (&SubstackNotesAdapter{}).Discover(
		context.Background(),
		"https://substack.com/@noahpinion/notes",
		ExtractorConfig{Kind: "substack_notes", MaxURLs: 50},
		"",
	)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(urls) != 2 {
		t.Fatalf("want 2 own notes (restack and non-note filtered), got %d: %v", len(urls), urls)
	}
	for _, u := range urls {
		if !strings.HasSuffix(strings.Split(u, "/note/")[0], "/@noahpinion") {
			t.Errorf("foreign author leaked into results: %s", u)
		}
	}
	if !strings.HasSuffix(urls[0], "/@noahpinion/note/c-306746759") {
		t.Errorf("unexpected permalink shape: %s", urls[0])
	}
}

func TestSubstackNotesMaxURLs(t *testing.T) {
	substackTestServer(t)

	urls, err := (&SubstackNotesAdapter{}).Discover(
		context.Background(),
		"https://substack.com/@noahpinion/notes",
		ExtractorConfig{Kind: "substack_notes", MaxURLs: 1},
		"",
	)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	// The live API ignores a limit param, so the cap has to bite client-side.
	if len(urls) != 1 {
		t.Fatalf("max_urls not applied: got %d urls", len(urls))
	}
}

func TestSubstackHandle(t *testing.T) {
	cases := map[string]string{
		"https://substack.com/@samuelalbanie/notes": "samuelalbanie",
		"https://substack.com/@noah.smith-1":        "noah.smith-1",
	}
	for in, want := range cases {
		got, err := substackHandle(in)
		if err != nil {
			t.Errorf("substackHandle(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("substackHandle(%q) = %q, want %q", in, got, want)
		}
	}
	if _, err := substackHandle("https://substack.com/home"); err == nil {
		t.Error("want error for a non-profile substack.com URL, got nil")
	}
}

func TestAdapterForSubstackNotes(t *testing.T) {
	a := AdapterFor("substack_notes")
	if a == nil || a.Kind() != "substack_notes" {
		t.Fatalf("AdapterFor(substack_notes) = %v", a)
	}
}

func TestShippedSubstackConfig(t *testing.T) {
	reg, err := LoadAll("../../../extractors")
	if err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	cfg, ok := reg.LookupByURL("https://substack.com/@samuelalbanie/note/c-193123272")
	if !ok {
		t.Fatal("no extractor config for substack.com")
	}
	if cfg.Kind != "substack_notes" {
		t.Errorf("kind = %q, want substack_notes", cfg.Kind)
	}
	// Both are load-bearing: without the selector trafilatura keeps Substack's
	// marketing chrome instead of the note; without short_form every note trips
	// the false-parse length floor.
	if cfg.ArticleSelector == "" {
		t.Error("article_selector missing — notes would scrape as Substack chrome")
	}
	if !reg.IsShortForm("https://substack.com/@samuelalbanie/note/c-193123272") {
		t.Error("short_form missing — every note would be flagged as an empty stub")
	}
}
