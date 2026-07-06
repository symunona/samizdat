// Package langpref holds the user's transcript language policy: which languages
// to keep in their original form vs. translate to English when ingesting
// videos. Persisted as a single JSON blob in server_settings under SettingKey.
package langpref

import (
	"encoding/json"
	"strings"
)

// SettingKey is the server_settings key holding the JSON-encoded Prefs.
const SettingKey = "language_prefs"

// Prefs is the transcript language policy.
type Prefs struct {
	// NativeLangs: languages the user reads. When a video's original language
	// is one of these, keep it native — do NOT also fetch an English translation.
	NativeLangs []string `json:"native_langs"`
	// TranslateToEnglish: for a video whose original language is NOT native,
	// also fetch the (auto-translated) English track. Default true.
	TranslateToEnglish bool `json:"translate_to_english"`
	// AlwaysStoreLangs: always also fetch these language tracks, regardless of
	// the video's original language.
	AlwaysStoreLangs []string `json:"always_store_langs"`
}

// Default is the policy used when nothing is stored yet: no known-native
// languages, translate-to-English on. This preserves the original transcript
// (the old code dropped it) while still keeping an English copy available.
func Default() Prefs {
	return Prefs{NativeLangs: []string{}, TranslateToEnglish: true, AlwaysStoreLangs: []string{}}
}

// Parse decodes a stored JSON blob into Prefs, falling back to Default on empty
// or malformed input. Slice fields are always non-nil so the API emits JSON
// arrays (never null), which the app consumes directly as string[].
func Parse(raw string) Prefs {
	p := Default()
	if strings.TrimSpace(raw) != "" {
		_ = json.Unmarshal([]byte(raw), &p)
	}
	if p.NativeLangs == nil {
		p.NativeLangs = []string{}
	}
	if p.AlwaysStoreLangs == nil {
		p.AlwaysStoreLangs = []string{}
	}
	return p
}

// BaseLang normalizes a language tag to its base subtag, lowercased:
// "en-US" → "en", "HU" → "hu", "en-orig" → "en". Empty stays empty.
func BaseLang(tag string) string {
	tag = strings.ToLower(strings.TrimSpace(tag))
	if i := strings.IndexAny(tag, "-_."); i >= 0 {
		tag = tag[:i]
	}
	return tag
}

// Wanted computes the ordered set of base language codes to request for a video
// whose original language is origTag. The original language is always first so
// callers can treat result[0] as the canonical/original track.
func (p Prefs) Wanted(origTag string) []string {
	orig := BaseLang(origTag)
	if orig == "" {
		orig = "en"
	}
	out := []string{orig}
	add := func(tag string) {
		l := BaseLang(tag)
		if l == "" {
			return
		}
		for _, x := range out {
			if x == l {
				return
			}
		}
		out = append(out, l)
	}

	native := make(map[string]bool, len(p.NativeLangs))
	for _, l := range p.NativeLangs {
		native[BaseLang(l)] = true
	}
	if !native[orig] && p.TranslateToEnglish {
		add("en")
	}
	for _, l := range p.AlwaysStoreLangs {
		add(l)
	}
	return out
}
