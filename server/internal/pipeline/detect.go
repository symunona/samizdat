package pipeline

import (
	"regexp"
	"strings"
)

// False-parse reasons. These strings are surfaced verbatim as the job's
// last_error and the Document's error_reason, so keep them short and stable.
const (
	ReasonBotProtection = "bot protection"
	ReasonUnparseable   = "could not parse document"
)

// FalseParseError signals that a scraped Document is not real article content
// (a bot challenge, a login/paywall wall, or a near-empty stub) rather than a
// transient failure. The worker treats it as PERMANENT — the job dies without a
// retry (re-scraping a bot-blocked/paywalled URL is what design rule 3 forbids)
// and its Error() is the clean reason shown to the user.
type FalseParseError struct{ Reason string }

func (e *FalseParseError) Error() string { return e.Reason }

// botMarkers are specific multi-word phrases that appear on bot-challenge,
// login-wall and paywall interstitials but not in genuine article bodies. Kept
// deliberately concrete (no single common words like "captcha"/"cloudflare"/
// "log in" that legitimately appear in real articles) — extend as new gates
// show up rather than building a generic registry.
var botMarkers = []string{
	"checking your browser",
	"verify you are human",
	"verifying you are human",
	"are you a robot",
	"enable javascript and cookies",
	"please enable javascript",
	"attention required! | cloudflare",
	"ddos protection by cloudflare",
	"please complete a security check",
	"access to this page has been denied",
	"this content is for subscribers",
	"subscribe to keep reading",
	"sign in to read this article",
	"please log in to continue reading",
}

// minContentChars is the plain-text floor below which a text-only Document is
// treated as an empty stub. Real scraped articles are far longer; a genuinely
// tiny text-only post is the accepted false-positive tradeoff.
const minContentChars = 200

var imageMarkdownRe = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)

// DetectFalseParse returns a *FalseParseError when title+markdown looks like a
// bot challenge / login wall / near-empty stub instead of real article content,
// or nil for genuine content. Intended for article Documents only — callers must
// not run it on video (transcript) Documents.
func DetectFalseParse(title, markdown string) *FalseParseError {
	hay := strings.ToLower(title + "\n" + markdown)
	for _, m := range botMarkers {
		if strings.Contains(hay, m) {
			return &FalseParseError{Reason: ReasonBotProtection}
		}
	}
	// Length floor: only for text-only docs. Image-bearing docs are handled by
	// extract_images + the summarizer's own empty-return, so never length-flagged.
	if imageMarkdownRe.MatchString(markdown) {
		return nil
	}
	plain := strings.TrimSpace(imageMarkdownRe.ReplaceAllString(markdown, ""))
	if len([]rune(plain)) < minContentChars {
		return &FalseParseError{Reason: ReasonUnparseable}
	}
	return nil
}
