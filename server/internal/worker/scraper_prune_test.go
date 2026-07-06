package worker

import (
	"bytes"
	"strings"
	"testing"
)

// Mirrors the 444.hu shape: the article body lives in div.slotArticle, while the
// trailing "Kapcsolódó cikkek" (recommended articles) block is a sibling OUTSIDE
// it. pruneToArticle must keep the article, drop the recommendations, and preserve
// <head> (trafilatura's metadata source).
const pruneFixtureHTML = `<html><head><title>Az oroszok támadják a lázadókat</title>` +
	`<meta property="og:image" content="https://444.hu/hero.jpg"></head><body>` +
	`<header><nav>menu</nav></header>` +
	`<div class="fkng932 slotArticle"><p>Oroszország légicsapások sorozatát indította Szíria több területe ellen.</p>` +
	`<p>A HTS szövetségeseivel együtt szombaton elfoglalták a várost.</p></div>` +
	`<section><div>Kapcsolódó cikkek</div>` +
	`<a href="/2024/12/01/masik-cikk">Egy teljesen más ajánlott cikk címe</a></section>` +
	`</body></html>`

func TestPruneToArticle_DropsRecommended(t *testing.T) {
	out := string(pruneToArticle([]byte(pruneFixtureHTML), "div.slotArticle"))

	// Article body survives.
	for _, want := range []string{"Oroszország légicsapások", "elfoglalták a várost"} {
		if !strings.Contains(out, want) {
			t.Errorf("pruned HTML dropped article text %q:\n%s", want, out)
		}
	}
	// Recommended block is gone.
	for _, gone := range []string{"Kapcsolódó cikkek", "más ajánlott cikk"} {
		if strings.Contains(out, gone) {
			t.Errorf("pruned HTML still contains recommended text %q:\n%s", gone, out)
		}
	}
	// <head> / metadata preserved (trafilatura reads title + og:image from here).
	for _, want := range []string{"<title>Az oroszok támadják a lázadókat</title>", "og:image", "hero.jpg"} {
		if !strings.Contains(out, want) {
			t.Errorf("pruned HTML lost head content %q:\n%s", want, out)
		}
	}
}

func TestPruneToArticle_NoMatchPassthrough(t *testing.T) {
	in := []byte(pruneFixtureHTML)
	out := pruneToArticle(in, "div.no-such-class")
	if !bytes.Equal(in, out) {
		t.Errorf("no-match selector should pass raw HTML through unchanged;\n in: %s\nout: %s", in, out)
	}
}

func TestPruneToArticle_BadSelectorPassthrough(t *testing.T) {
	in := []byte(pruneFixtureHTML)
	out := pruneToArticle(in, "div[")
	if !bytes.Equal(in, out) {
		t.Errorf("uncompilable selector should pass raw HTML through unchanged;\n in: %s\nout: %s", in, out)
	}
}
