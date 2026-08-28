package ctxmenu

import "testing"

func TestParseEmptyGivesDefaults(t *testing.T) {
	p := Parse("")
	if len(p.Items) != len(Default().Items) {
		t.Fatalf("empty blob: got %d items, want the defaults", len(p.Items))
	}
	if Parse("{not json").Items == nil {
		t.Fatal("malformed blob must fall back to defaults, not nil")
	}
}

// A row the device cannot execute renders in the sheet and does nothing — worse
// than a missing one. Those are dropped; the blanks a kind implies are filled.
func TestNormalizeDropsUnrunnableAndFillsBlanks(t *testing.T) {
	p := Prefs{
		MasterPrompt: "  you are terse  ",
		Items: []Item{
			{ID: "", Kind: KindCopy, Enabled: true},                       // no id
			{ID: "x", Kind: "launch_missiles", Enabled: true},             // unknown kind
			{ID: "s", Kind: KindWebSearch, Enabled: true},                 // no template
			{ID: "t", Kind: KindTranslate, Enabled: true, Engine: "junk"}, // no lang, bad engine
		},
	}.Normalize()

	if len(p.Items) != 2 {
		t.Fatalf("got %d items, want 2 (the id-less and unknown-kind rows dropped)", len(p.Items))
	}
	if p.MasterPrompt != "you are terse" {
		t.Fatalf("master prompt not trimmed: %q", p.MasterPrompt)
	}
	search, translate := p.Items[0], p.Items[1]
	if search.Template != DefaultSearchTemplate {
		t.Fatalf("web_search template: %q", search.Template)
	}
	if search.Title == "" || translate.Title == "" {
		t.Fatal("a blank title must fall back to the kind's name")
	}
	if translate.Lang != "en" || translate.Engine != "llm" {
		t.Fatalf("translate defaults: lang=%q engine=%q", translate.Lang, translate.Engine)
	}
}

// The browser engine is the one non-llm value that must survive normalization.
func TestNormalizeKeepsBrowserEngine(t *testing.T) {
	p := Prefs{Items: []Item{{ID: "t", Kind: KindTranslate, Lang: "hu", Engine: "browser"}}}.Normalize()
	if p.Items[0].Engine != "browser" {
		t.Fatalf("engine = %q, want browser", p.Items[0].Engine)
	}
}
