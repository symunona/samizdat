package langpref

import (
	"reflect"
	"testing"
)

func TestBaseLang(t *testing.T) {
	cases := map[string]string{
		"en": "en", "EN": "en", "en-US": "en", "en_GB": "en",
		"en-orig": "en", "hu": "hu", " HU ": "hu", "": "",
	}
	for in, want := range cases {
		if got := BaseLang(in); got != want {
			t.Errorf("BaseLang(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWanted(t *testing.T) {
	tests := []struct {
		name  string
		prefs Prefs
		orig  string
		want  []string
	}{
		{
			// The Borízű case: user preserves Hungarian → keep only the original,
			// never the English machine-translation.
			name:  "preserved original, no translation",
			prefs: Prefs{PreservedLangs: []string{"hu", "en"}},
			orig:  "hu",
			want:  []string{"hu"},
		},
		{
			// Not preserved → English is primary, original kept alongside to switch.
			name:  "non-preserved translates to english (primary)",
			prefs: Prefs{PreservedLangs: []string{"en"}},
			orig:  "de",
			want:  []string{"en", "de"},
		},
		{
			// Empty policy: a non-English video → English primary + original.
			name:  "default non-english → english primary",
			prefs: Default(),
			orig:  "hu",
			want:  []string{"en", "hu"},
		},
		{
			name:  "english original is single track",
			prefs: Default(),
			orig:  "en-US",
			want:  []string{"en"},
		},
		{
			name:  "empty original falls back to english",
			prefs: Default(),
			orig:  "",
			want:  []string{"en"},
		},
		{
			name:  "preserved non-english original kept as-is",
			prefs: Prefs{PreservedLangs: []string{"fr"}},
			orig:  "fr-CA",
			want:  []string{"fr"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.prefs.Wanted(tc.orig); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("Wanted(%q) = %v, want %v", tc.orig, got, tc.want)
			}
		})
	}
}

func TestParse(t *testing.T) {
	if got := Parse(""); got.PreservedLangs == nil {
		t.Error("empty Parse should yield non-nil PreservedLangs")
	}
	if got := Parse("not json"); got.PreservedLangs == nil {
		t.Error("malformed Parse should yield non-nil PreservedLangs")
	}
	// New key.
	got := Parse(`{"preserved_langs":["hu","en"]}`)
	if len(got.PreservedLangs) != 2 || got.PreservedLangs[0] != "hu" {
		t.Errorf("Parse round-trip mismatch: %+v", got)
	}
	// Legacy key still honored.
	legacy := Parse(`{"native_langs":["fr"]}`)
	if len(legacy.PreservedLangs) != 1 || legacy.PreservedLangs[0] != "fr" {
		t.Errorf("legacy native_langs not migrated: %+v", legacy)
	}
	// Slice must be non-nil so the API emits [] not null (the app calls .map).
	for _, raw := range []string{"", "{}", `{"preserved_langs":null}`} {
		if p := Parse(raw); p.PreservedLangs == nil {
			t.Errorf("Parse(%q) left a nil slice", raw)
		}
	}
}
