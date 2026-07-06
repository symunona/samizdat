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
			// The Borizü bug: a Hungarian video with the user reading Hungarian must
			// keep only the original — never the English machine-translation.
			name:  "native original, no translation",
			prefs: Prefs{NativeLangs: []string{"hu", "en"}, TranslateToEnglish: true},
			orig:  "hu",
			want:  []string{"hu"},
		},
		{
			// Non-native original with default policy → keep original AND fetch English.
			name:  "non-native original translates to english",
			prefs: Prefs{NativeLangs: []string{"en"}, TranslateToEnglish: true},
			orig:  "de",
			want:  []string{"de", "en"},
		},
		{
			name:  "non-native but translation off keeps original only",
			prefs: Prefs{NativeLangs: []string{"en"}, TranslateToEnglish: false},
			orig:  "de",
			want:  []string{"de"},
		},
		{
			name:  "always-store langs are unioned in",
			prefs: Prefs{NativeLangs: []string{"hu"}, AlwaysStoreLangs: []string{"fr", "hu"}},
			orig:  "hu",
			want:  []string{"hu", "fr"},
		},
		{
			// Default (empty prefs) preserves the original AND keeps an English copy —
			// the old code dropped the original entirely.
			name:  "default preserves original plus english",
			prefs: Default(),
			orig:  "hu",
			want:  []string{"hu", "en"},
		},
		{
			name:  "english original is not duplicated",
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
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.prefs.Wanted(tc.orig); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("Wanted(%q) = %v, want %v", tc.orig, got, tc.want)
			}
		})
	}
}

func TestParseFallsBackToDefault(t *testing.T) {
	if got := Parse(""); !got.TranslateToEnglish {
		t.Error("empty Parse should default TranslateToEnglish=true")
	}
	if got := Parse("not json"); !got.TranslateToEnglish {
		t.Error("malformed Parse should default TranslateToEnglish=true")
	}
	got := Parse(`{"native_langs":["hu"],"translate_to_english":false}`)
	if len(got.NativeLangs) != 1 || got.NativeLangs[0] != "hu" || got.TranslateToEnglish {
		t.Errorf("Parse round-trip mismatch: %+v", got)
	}
	// Slice fields must be non-nil so the API emits [] not null (the app types
	// them as string[] and calls .length/.map — a null would crash Settings).
	for _, raw := range []string{"", "{}", `{"native_langs":null}`} {
		p := Parse(raw)
		if p.NativeLangs == nil || p.AlwaysStoreLangs == nil {
			t.Errorf("Parse(%q) left a nil slice: %+v", raw, p)
		}
	}
}
