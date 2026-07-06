// Package langpref holds the user's transcript language policy: the set of
// languages to keep in their ORIGINAL form (never translated). A video whose
// original language is on that list is preserved as-is; every other video is
// translated to English. Persisted as a JSON blob in server_settings.
package langpref

import (
	"encoding/json"
	"strings"
)

// SettingKey is the server_settings key holding the JSON-encoded Prefs.
const SettingKey = "language_prefs"

// Prefs is the transcript language policy: a single list of languages the user
// reads and wants kept original. Everything else is translated to English.
type Prefs struct {
	PreservedLangs []string `json:"preserved_langs"`
}

// Default is the policy used when nothing is stored yet: no preserved languages
// (the app seeds this from the device locale on first run).
func Default() Prefs {
	return Prefs{PreservedLangs: []string{}}
}

// Parse decodes a stored JSON blob into Prefs, falling back to Default on empty
// or malformed input. Accepts the legacy `native_langs` key. The slice is always
// non-nil so the API emits a JSON array (never null), which the app reads as
// string[].
func Parse(raw string) Prefs {
	var p Prefs
	if strings.TrimSpace(raw) != "" {
		_ = json.Unmarshal([]byte(raw), &p)
		if p.PreservedLangs == nil {
			// Legacy blob from the first cut used native_langs.
			var legacy struct {
				NativeLangs []string `json:"native_langs"`
			}
			_ = json.Unmarshal([]byte(raw), &legacy)
			p.PreservedLangs = legacy.NativeLangs
		}
	}
	if p.PreservedLangs == nil {
		p.PreservedLangs = []string{}
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

// preserves reports whether the original language is on the keep-as-is list.
func (p Prefs) preserves(orig string) bool {
	for _, l := range p.PreservedLangs {
		if BaseLang(l) == orig {
			return true
		}
	}
	return false
}

// Wanted computes the ordered subtitle tracks to request for a video whose
// original language is origTag. result[0] is the PRIMARY track — shown by
// default and fed to the Pipeline:
//   - original language preserved (or already English) → [orig] (kept as-is)
//   - otherwise → [en, orig]: English is primary; the original is kept alongside
//     so the reader can still switch to it on the video screen.
func (p Prefs) Wanted(origTag string) []string {
	orig := BaseLang(origTag)
	if orig == "" {
		orig = "en"
	}
	if orig == "en" || p.preserves(orig) {
		return []string{orig}
	}
	return []string{"en", orig}
}
