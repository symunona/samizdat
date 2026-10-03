package cmd

import (
	"strings"
	"testing"
)

func TestFindDigest(t *testing.T) {
	digests := []digestRow{
		{ID: "id-1", Name: "AI Weekly"},
		{ID: "id-2", Name: "Twins"},
		{ID: "id-3", Name: "twins"},
		// A Digest named like another one's id: the id still wins.
		{ID: "id-4", Name: "id-1"},
	}
	for arg, want := range map[string]string{"ai weekly": "id-1", "id-3": "id-3", "id-1": "id-1"} {
		if got, err := findDigest(digests, arg); err != nil || got.ID != want {
			t.Errorf("findDigest(%q) = %q, %v; want %q", arg, got.ID, err, want)
		}
	}
	if _, err := findDigest(digests, "Twins"); err == nil || !strings.Contains(err.Error(), "id-2, id-3") {
		t.Errorf("an ambiguous name must list the ids to pick from, got %v", err)
	}
	if _, err := findDigest(digests, "nope"); err == nil {
		t.Error("an unknown name resolved")
	}
}

func TestRenderDigestTable(t *testing.T) {
	last := "2026-10-02T05:00:00Z"
	got := renderDigestTable([]digestRow{
		{ID: "id-1", Name: "AI", Enabled: true, Period: "weekly", Weekdays: []int{2, 5}, Hour: 7, NextRunAt: "2026-10-06T05:00:00Z", LastRunAt: &last},
		{ID: "id-2", Name: "Off", Period: "daily", Hour: 18, NextRunAt: "2026-10-03T16:00:00Z"},
	}, false)
	lines := strings.Split(strings.TrimRight(got, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("want a header and two rows, got:\n%s", got)
	}
	if !strings.Contains(lines[1], "weekly Tue,Fri 07:00") || !strings.Contains(lines[1], localStamp(last)) {
		t.Errorf("weekly row = %q", lines[1])
	}
	// A disabled Digest shows no next run, and has never run.
	if f := strings.Fields(lines[2]); strings.Join(f, " ") != "Off daily 18:00 no — — id-2" {
		t.Errorf("disabled row = %q", lines[2])
	}
}
