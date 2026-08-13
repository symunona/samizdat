package pipeline

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestEstimateTokensCountsRunesNotBytes(t *testing.T) {
	// Six runes, eighteen bytes. A byte-based estimate would read 3x high and
	// shrink every chunk to a third of what the model can hold.
	if got, want := EstimateTokens("日本語日本語"), 2; got != want {
		t.Fatalf("EstimateTokens(CJK) = %d, want %d", got, want)
	}
	if EstimateTokens("") != 0 {
		t.Fatalf("empty string must estimate 0")
	}
	// Rounds up: a 1-rune string is one token, not zero.
	if EstimateTokens("a") != 1 {
		t.Fatalf("EstimateTokens must round up")
	}
}

func TestChunkBudgetLeavesHeadroom(t *testing.T) {
	// 7000 ctx * 2/3 = 4666, minus 300 completion minus 200 prompt = 4166 tokens.
	got := ChunkBudget(7000, 300, 200)
	if want := 4166 * runesPerToken; got != want {
		t.Fatalf("ChunkBudget = %d, want %d", got, want)
	}
	// A completion cap that swallows the whole window yields no room at all,
	// rather than a negative budget the splitter would treat as "no limit".
	if got := ChunkBudget(1000, 5000, 0); got != 0 {
		t.Fatalf("over-subscribed window must budget 0, got %d", got)
	}
}

func TestSplitShortDocumentIsUntouched(t *testing.T) {
	md := "# Title\n\nOne short paragraph."
	got := Split(md, 10000, 200)
	if len(got) != 1 || got[0] != md {
		t.Fatalf("a fitting document must come back verbatim as one chunk, got %q", got)
	}
}

func TestSplitPrefersHeadings(t *testing.T) {
	section := func(n string) string {
		return "## Section " + n + "\n\n" + strings.Repeat("word ", 60)
	}
	md := section("A") + "\n\n" + section("B") + "\n\n" + section("C")

	chunks := Split(md, 400, 0)
	if len(chunks) < 2 {
		t.Fatalf("expected multiple chunks, got %d", len(chunks))
	}
	for i, c := range chunks {
		if !strings.HasPrefix(strings.TrimSpace(c), "## Section") {
			t.Fatalf("chunk %d does not start at a heading: %.60q", i, c)
		}
	}
}

func TestSplitFallsBackToParagraphs(t *testing.T) {
	para := strings.Repeat("word ", 40)
	md := strings.Join([]string{para, para, para, para}, "\n\n")

	chunks := Split(md, 300, 0)
	if len(chunks) < 2 {
		t.Fatalf("expected a paragraph split, got %d chunk(s)", len(chunks))
	}
	for i, c := range chunks {
		if n := utf8.RuneCountInString(c); n > 300 {
			t.Fatalf("chunk %d is %d runes, over the 300 budget", i, n)
		}
	}
}

func TestSplitBreaksAnOversizeParagraph(t *testing.T) {
	// One paragraph, no headings, no blank lines: only sentence splitting can
	// bring it under budget.
	md := strings.Repeat("This is a sentence. ", 60)
	chunks := Split(md, 200, 0)
	if len(chunks) < 2 {
		t.Fatalf("expected sentence splitting, got %d chunk(s)", len(chunks))
	}
	for i, c := range chunks {
		if n := utf8.RuneCountInString(c); n > 200 {
			t.Fatalf("chunk %d is %d runes, over the 200 budget", i, n)
		}
	}
}

func TestSplitHardCutsAnUnbreakableRun(t *testing.T) {
	// No sentence terminators anywhere — a data URI or a minified line.
	md := strings.Repeat("x", 1000)
	chunks := Split(md, 100, 0)
	if len(chunks) != 10 {
		t.Fatalf("expected 10 hard-cut chunks, got %d", len(chunks))
	}
	if strings.Join(chunks, "") != md {
		t.Fatal("a hard cut must lose no content")
	}
}

func TestSplitNeverSplitsARune(t *testing.T) {
	md := strings.Repeat("日本語のテキストです", 200)
	for _, c := range Split(md, 90, 20) {
		if !utf8.ValidString(c) {
			t.Fatalf("chunk is not valid UTF-8: %q", c)
		}
	}
}

func TestSplitKeepsCodeFencesWhole(t *testing.T) {
	code := "```go\nfunc a() {\n\n\tx := 1\n\n\treturn x\n}\n```"
	md := strings.Repeat("word ", 80) + "\n\n" + code + "\n\n" + strings.Repeat("word ", 80)

	for i, c := range Split(md, 500, 0) {
		if n := strings.Count(c, "```"); n%2 != 0 {
			t.Fatalf("chunk %d has an unbalanced code fence (%d markers): %q", i, n, c)
		}
	}
}

func TestSplitOverlapCarriesContext(t *testing.T) {
	md := strings.Repeat("alpha beta gamma delta. ", 100)
	chunks := Split(md, 300, 50)
	if len(chunks) < 2 {
		t.Fatalf("expected multiple chunks, got %d", len(chunks))
	}
	for i := 1; i < len(chunks); i++ {
		if !strings.HasPrefix(chunks[i], "…") {
			t.Fatalf("chunk %d carries no overlap prefix", i)
		}
	}
	// Overlap must not compound: it always comes from the previous chunk's own
	// text, so no chunk carries a chain of every earlier tail.
	if strings.Count(chunks[len(chunks)-1], "…") != 1 {
		t.Fatal("overlap compounded across chunks")
	}
}

func TestSplitIsDeterministic(t *testing.T) {
	md := strings.Repeat("## H\n\nsome words here and there. ", 40)
	first := Split(md, 250, 30)
	for i := 0; i < 3; i++ {
		again := Split(md, 250, 30)
		if len(again) != len(first) {
			t.Fatalf("run %d produced %d chunks, first produced %d", i, len(again), len(first))
		}
		for j := range first {
			if again[j] != first[j] {
				t.Fatalf("run %d chunk %d differs", i, j)
			}
		}
	}
}
