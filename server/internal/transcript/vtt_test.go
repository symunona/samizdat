package transcript

import "testing"

func TestParseVTT(t *testing.T) {
	in := `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.500 align:start position:0%
Hello <00:00:01.000><c>world</c>

00:00:02.500 --> 00:00:05.000
Hello world

00:00:05.000 --> 00:00:07.000
this is a test

01:02:03.250 --> 01:02:05.000
late cue
`
	got := ParseVTT(in)
	if len(got) != 3 {
		t.Fatalf("want 3 segments (rolling dup dropped), got %d: %+v", len(got), got)
	}
	if got[0].StartMs != 0 || got[0].EndMs != 2500 {
		t.Errorf("seg0 timing = %d..%d, want 0..2500", got[0].StartMs, got[0].EndMs)
	}
	if got[0].Text != "Hello world" {
		t.Errorf("seg0 text = %q, want %q (tags stripped)", got[0].Text, "Hello world")
	}
	if got[1].Text != "this is a test" {
		t.Errorf("seg1 text = %q (duplicate 'Hello world' should be dropped)", got[1].Text)
	}
	// 01:02:03.250 = 3723250 ms
	if got[2].StartMs != 3723250 {
		t.Errorf("seg2 start = %d, want 3723250", got[2].StartMs)
	}
}

func TestParseVTTEntities(t *testing.T) {
	in := "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nMemories&nbsp; are real &amp; weird &#39;magic&#39;\n"
	got := ParseVTT(in)
	if len(got) != 1 {
		t.Fatalf("want 1 segment, got %d", len(got))
	}
	want := "Memories are real & weird 'magic'"
	if got[0].Text != want {
		t.Errorf("text = %q, want %q (entities decoded, nbsp collapsed)", got[0].Text, want)
	}
}

func TestParseTimestamp(t *testing.T) {
	cases := map[string]int64{
		"00:00:00.000": 0,
		"00:00:01.500": 1500,
		"01:02:03.250": 3723250,
		"02:05.000":    125000, // MM:SS form
	}
	for in, want := range cases {
		got, ok := parseTimestamp(in)
		if !ok || got != want {
			t.Errorf("parseTimestamp(%q) = %d,%v want %d", in, got, ok, want)
		}
	}
}

func TestFlattenText(t *testing.T) {
	segs := []Segment{{Text: "a"}, {Text: "b"}}
	if FlattenText(segs) != "a\nb" {
		t.Errorf("FlattenText = %q", FlattenText(segs))
	}
}
