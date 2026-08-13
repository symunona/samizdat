package transcript

import "testing"

// cue is a terse constructor for test input.
func cue(startMs, endMs int64, text string) Segment {
	return Segment{StartMs: startMs, EndMs: endMs, Text: text}
}

func TestReflowJoinsDisplayWraps(t *testing.T) {
	// YouTube wraps at display width, mid-sentence.
	got := Reflow([]Segment{
		cue(0, 1500, "this morning, there was the Michael"),
		cue(1500, 3000, "Jordan quote. He was wrong about"),
		cue(3000, 4500, "quitting."),
	})
	if len(got) != 2 {
		t.Fatalf("want 2 sentences, got %d: %+v", len(got), got)
	}
	if got[0].Text != "this morning, there was the Michael Jordan quote." {
		t.Errorf("seg0 = %q", got[0].Text)
	}
	if got[1].Text != "He was wrong about quitting." {
		t.Errorf("seg1 = %q", got[1].Text)
	}
	if got[0].StartMs != 0 {
		t.Errorf("seg0 start = %d, want 0", got[0].StartMs)
	}
	// The second sentence starts inside cue 2 — interpolated, not the cue start.
	if got[1].StartMs <= 1500 || got[1].StartMs >= 3000 {
		t.Errorf("seg1 start = %d, want interpolated in (1500,3000)", got[1].StartMs)
	}
}

func TestReflowSpeakerChangeBreaksParagraph(t *testing.T) {
	got := Reflow([]Segment{
		cue(0, 2000, ">> It's okay. You can quit things."),
		cue(2000, 4000, ">> Hang on a minute. When I went to the gym"),
		cue(4000, 6000, "this morning, I disagreed."),
	})
	if len(got) != 2 {
		t.Fatalf("want 2 segments, got %d: %+v", len(got), got)
	}
	if got[0].Text != "It's okay. You can quit things." {
		t.Errorf("seg0 = %q (>> should be stripped, short sentence glued forward)", got[0].Text)
	}
	if !got[1].NewPara {
		t.Errorf("speaker change must open a paragraph: %+v", got[1])
	}
	// "Hang on a minute." is under the minimum, so it keeps its speaker's next line.
	if got[1].Text != "Hang on a minute. When I went to the gym this morning, I disagreed." {
		t.Errorf("seg1 = %q", got[1].Text)
	}
}

func TestReflowSilenceGapBreaksParagraph(t *testing.T) {
	got := Reflow([]Segment{
		cue(0, 2000, "So that is the whole story about quitting."),
		cue(9000, 12000, "Now let us talk about something entirely different."),
	})
	if len(got) != 2 {
		t.Fatalf("want 2 segments, got %d: %+v", len(got), got)
	}
	if !got[1].NewPara {
		t.Errorf("7s of silence must open a paragraph: %+v", got[1])
	}
}

func TestReflowSplitsRunOn(t *testing.T) {
	// ASR drops punctuation for minutes at a time.
	long := "and then I realized that the dip is the thing nobody talks about " +
		"and everybody feels it but almost nobody names it so they quit at the " +
		"wrong moment which is exactly when the reward is closest and that is " +
		"the whole tragedy of it because the people who push through are not " +
		"braver they are simply better informed about where they actually are " +
		"on the curve and that changes everything about the decision"
	got := Reflow([]Segment{cue(0, 30000, long)})
	if len(got) < 2 {
		t.Fatalf("run-on must be split, got %d: %+v", len(got), got)
	}
	for i, s := range got {
		if n := len([]rune(s.Text)); n > maxSentenceRunes {
			t.Errorf("seg%d is %d runes, over the %d cap", i, n, maxSentenceRunes)
		}
	}
}

func TestReflowKeepsAbbreviationsWhole(t *testing.T) {
	got := Reflow([]Segment{
		cue(0, 4000, "Dr. Smith went to the U.S. Capitol with 3.5 million dollars in mind."),
	})
	if len(got) != 1 {
		t.Fatalf("abbreviations must not split the sentence, got %d: %+v", len(got), got)
	}
}

func TestReflowTimingsMonotonic(t *testing.T) {
	got := Reflow([]Segment{
		cue(0, 1000, "One. Two."),
		cue(1000, 2000, "Three. Four."),
		cue(2000, 3000, "Five is a longer sentence to clear the minimum length."),
	})
	if len(got) == 0 {
		t.Fatal("no segments")
	}
	var prev int64 = -1
	for i, s := range got {
		if s.StartMs < prev {
			t.Errorf("seg%d start %d goes backwards (prev %d)", i, s.StartMs, prev)
		}
		if s.EndMs < s.StartMs {
			t.Errorf("seg%d ends %d before it starts %d", i, s.EndMs, s.StartMs)
		}
		if s.StartMs < 0 || s.EndMs > 3000 {
			t.Errorf("seg%d timing %d..%d outside the source cues", i, s.StartMs, s.EndMs)
		}
		prev = s.StartMs
	}
	if !got[0].NewPara {
		t.Error("first segment must open a paragraph")
	}
}

func TestDedupRollupStoredSegments(t *testing.T) {
	// What the pre-fix cue-level parser stored: A, "A B", B, "B C", C …
	got := DedupRollup([]Segment{
		cue(0, 1630, "What advice do you give for the average"),
		cue(1640, 2950, "What advice do you give for the average person that's looking to invest their"),
		cue(2950, 2960, "person that's looking to invest their"),
		cue(2960, 4310, "person that's looking to invest their salary or their wages?"),
		cue(4310, 4320, "salary or their wages?"),
	})
	want := []string{
		"What advice do you give for the average",
		"person that's looking to invest their",
		"salary or their wages?",
	}
	if len(got) != len(want) {
		t.Fatalf("want %d lines, got %d: %+v", len(want), len(got), got)
	}
	for i, w := range want {
		if got[i].Text != w {
			t.Errorf("seg%d = %q, want %q", i, got[i].Text, w)
		}
	}
}

func TestDedupRollupLeavesCleanSegmentsAlone(t *testing.T) {
	in := []Segment{cue(0, 1000, "One sentence."), cue(1000, 2000, "Another one entirely.")}
	got := DedupRollup(in)
	if len(got) != 2 || got[0].Text != in[0].Text || got[1].Text != in[1].Text {
		t.Errorf("clean transcript was altered: %+v", got)
	}
}

func TestFlattenTextParagraphs(t *testing.T) {
	segs := []Segment{
		{Text: "One.", NewPara: true},
		{Text: "Two."},
		{Text: "Three.", NewPara: true},
	}
	want := "One. Two.\n\nThree."
	if got := FlattenText(segs); got != want {
		t.Errorf("FlattenText = %q, want %q", got, want)
	}
}
