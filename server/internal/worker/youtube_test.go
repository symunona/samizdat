package worker

import "testing"

func TestYoutubeID(t *testing.T) {
	cases := map[string]string{
		"https://www.youtube.com/watch?v=PqtggjVAi8M":              "PqtggjVAi8M",
		"https://youtube.com/watch?v=PqtggjVAi8M&t=42s":            "PqtggjVAi8M",
		"https://youtu.be/PqtggjVAi8M":                             "PqtggjVAi8M",
		"https://youtu.be/PqtggjVAi8M?si=abc":                      "PqtggjVAi8M",
		"https://www.youtube.com/shorts/PqtggjVAi8M":               "PqtggjVAi8M",
		"https://www.youtube.com/embed/PqtggjVAi8M":                "PqtggjVAi8M",
		"https://m.youtube.com/watch?v=PqtggjVAi8M":                "PqtggjVAi8M",
		"https://music.youtube.com/watch?v=PqtggjVAi8M&list=RDxyz": "PqtggjVAi8M",
	}
	for in, want := range cases {
		got, ok := youtubeID(in)
		if !ok || got != want {
			t.Errorf("youtubeID(%q) = %q,%v want %q", in, got, ok, want)
		}
	}

	nonYT := []string{
		"https://example.com/watch?v=PqtggjVAi8M",
		"https://vimeo.com/12345",
		"https://www.youtube.com/results?search_query=foo",
	}
	for _, in := range nonYT {
		if _, ok := youtubeID(in); ok {
			t.Errorf("youtubeID(%q) = ok, want not-a-video", in)
		}
	}
}

func TestCanonicalizeYouTube(t *testing.T) {
	got, err := canonicalize("https://youtu.be/PqtggjVAi8M?si=tracking&t=10")
	if err != nil {
		t.Fatal(err)
	}
	want := "https://www.youtube.com/watch?v=PqtggjVAi8M"
	if got != want {
		t.Errorf("canonicalize = %q, want %q", got, want)
	}
}
