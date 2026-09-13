package worker

import (
	"strings"
	"testing"
)

// The Works in Progress bug: Cookiebot injects its declaration into the rendered
// DOM as a role="dialog" overlay full of <li> rows. trafilatura drops it, then
// extractLeadLists recovered it as a "list trafilatura missed" and prepended 6.8KB
// of cookie text above the article. Stripping tier-A chrome before either of them
// runs fixes it once, for every consent vendor.
const consentFixtureHTML = `<html><body>` +
	`<div id="CybotCookiebotDialog" role="dialog" aria-modal="true">` +
	`<ul><li>Necessary 20 Necessary cookies help make a website usable. ` +
	`<a href="https://www.cookiebot.com/goto/privacy-policy/">Learn more about this provider</a> ` +
	`CookieConsent Stores the user's cookie consent state for the current domain. ` +
	`Maximum Storage Duration: 1 year Type: HTTP Cookie</li>` +
	`<li>Marketing 7 Marketing cookies are used to track visitors across websites. ` +
	`Maximum Storage Duration: 3 months Type: HTTP Cookie</li></ul></div>` +
	`<article><p>Every child is taught that landfill is the worst place our trash can end up.</p></article>` +
	`</body></html>`

func TestStripInvisible_DropsConsentDialog(t *testing.T) {
	out := string(stripInvisible([]byte(consentFixtureHTML)))

	if strings.Contains(out, "Maximum Storage Duration") {
		t.Error("consent dialog survived the strip")
	}
	if !strings.Contains(out, "landfill is the worst place") {
		t.Error("article body did not survive the strip")
	}
}

// With the dialog gone, the list recovery has nothing to recover — no rule of its
// own needed, which is the point of doing it upstream. The unstripped fixture must
// still tempt it, or the test above proves nothing.
func TestStripInvisible_LeavesNothingForLeadListsToRecover(t *testing.T) {
	extractedMD := "Every child is taught that landfill is the worst place our trash can end up."

	if got := extractLeadLists([]byte(consentFixtureHTML), extractedMD); got == "" {
		t.Fatal("fixture is stale: the raw consent dialog no longer tempts extractLeadLists")
	}
	if got := extractLeadLists(stripInvisible([]byte(consentFixtureHTML)), extractedMD); got != "" {
		t.Fatalf("consent rows recovered as content after the strip:\n%s", got)
	}
}

func TestStripInvisible_DropsHiddenAndTemplate(t *testing.T) {
	raw := []byte(`<html><body>` +
		`<div aria-hidden="true">decorative icon caption text</div>` +
		`<div style="display: none">hidden tracking pixel legend</div>` +
		`<div hidden>collapsed drawer contents</div>` +
		`<template><p>never rendered</p></template>` +
		`<p>` + strings.Repeat("Real article prose that must survive the strip untouched. ", 5) + `</p>` +
		`</body></html>`)

	out := string(stripInvisible(raw))
	for _, junk := range []string{"decorative icon", "tracking pixel", "collapsed drawer", "never rendered"} {
		if strings.Contains(out, junk) {
			t.Errorf("%q survived the strip", junk)
		}
	}
	if !strings.Contains(out, "Real article prose") {
		t.Error("article prose did not survive")
	}
}

// An open modal marks the page BEHIND it aria-hidden="true". When the consent
// dismissal fails, that wrapper is the whole article — keeping the banner beats
// losing the body, and the landmark inside says which is which.
func TestStripInvisible_GuardKeepsAriaHiddenMainContent(t *testing.T) {
	raw := []byte(`<html><body>` +
		`<div aria-hidden="true"><main><p>` +
		strings.Repeat("The entire article body sits behind the open modal. ", 20) +
		`</p></main></div>` +
		`<div role="dialog"><p>We value your privacy and use cookies.</p></div>` +
		`</body></html>`)

	out := string(stripInvisible(raw))
	if !strings.Contains(out, "entire article body") {
		t.Fatal("guard failed: aria-hidden wrapper around <main> was stripped")
	}
	if strings.Contains(out, "value your privacy") {
		t.Error("consent dialog survived alongside the protected article")
	}
}

// Nothing visible left means the page was misread, not that it was all chrome.
func TestStripInvisible_GuardKeepsPageStrippedEmpty(t *testing.T) {
	raw := []byte(`<html><body><div hidden><p>` +
		strings.Repeat("Every scrap of text on this page is inside the hidden div. ", 5) +
		`</p></div></body></html>`)

	if out := string(stripInvisible(raw)); !strings.Contains(out, "Every scrap of text") {
		t.Fatal("guard failed: strip emptied the body")
	}
}

func TestStripInvisible_NoMatchPassthrough(t *testing.T) {
	raw := []byte(`<html><body><p>plain page, nothing hidden anywhere in it</p></body></html>`)
	if out := stripInvisible(raw); string(out) != string(raw) {
		t.Fatalf("expected byte-identical passthrough, got:\n%s", out)
	}
}

// Tier B is by role as well as by tag: a <div role="navigation"> is a nav to
// everything except a tag-name comparison, which is what the old private
// skip-lists did.
func TestIsRegionSkip_MatchesRoleTwins(t *testing.T) {
	extractedMD := "Article prose with no bullets."
	raw := []byte(`<html><body><div role="navigation"><ul>` +
		`<li>First navigation entry with plenty of text</li>` +
		`<li>Second navigation entry with plenty of text</li>` +
		`</ul></div></body></html>`)

	if got := extractLeadLists(raw, extractedMD); got != "" {
		t.Fatalf("nav list recovered as content:\n%s", got)
	}
}

// A list of prose blocks is not a lead list the reader lost.
func TestListToMarkdown_RejectsOversizedItems(t *testing.T) {
	extractedMD := "Article prose with no bullets."
	long := strings.Repeat("a paragraph masquerading as a list item ", 15) // >400 runes
	raw := []byte(`<html><body><ul><li>` + long + `</li><li>` + long + `</li></ul></body></html>`)

	if got := extractLeadLists(raw, extractedMD); got != "" {
		t.Fatalf("oversized list recovered as content:\n%s", got[:80])
	}
}
