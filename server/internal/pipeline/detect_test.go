package pipeline

import "testing"

func TestDetectFalseParse(t *testing.T) {
	longArticle := "The quick brown fox jumped over the lazy dog. " // ~46 chars
	for i := 0; i < 20; i++ {
		longArticle += "This is a real paragraph of genuine article content that keeps going. "
	}

	cases := []struct {
		name       string
		title      string
		markdown   string
		wantReason string // "" = expect nil (genuine content)
	}{
		{
			name:       "cloudflare checking browser",
			title:      "Just a moment...",
			markdown:   "Checking your browser before accessing the site. This process is automatic.",
			wantReason: ReasonBotProtection,
		},
		{
			name:       "verify you are human",
			title:      "Attention Required!",
			markdown:   "Please verify you are human by completing the action below.",
			wantReason: ReasonBotProtection,
		},
		{
			name:       "enable javascript challenge",
			title:      "",
			markdown:   "Please enable JavaScript and cookies to continue to the page you requested.",
			wantReason: ReasonBotProtection,
		},
		{
			name:       "subscriber paywall",
			title:      "Exclusive report",
			markdown:   "This content is for subscribers only. Log in or sign up to keep reading the rest.",
			wantReason: ReasonBotProtection,
		},
		{
			name:       "near-empty teaser stub",
			title:      "Inside the fastest growing Canadian AI startup",
			markdown:   "Inside the fastest growing Canadian AI startup…",
			wantReason: ReasonUnparseable,
		},
		{
			name:       "empty markdown",
			title:      "Some title",
			markdown:   "",
			wantReason: ReasonUnparseable,
		},
		{
			name:       "genuine long article passes",
			title:      "A Real Article About Foxes",
			markdown:   longArticle,
			wantReason: "",
		},
		{
			name:       "image-only doc not length-flagged",
			title:      "Photo of the day",
			markdown:   "![a striking sunset over the hills](https://img.example.com/sunset.jpg)",
			wantReason: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DetectFalseParse(tc.title, tc.markdown)
			if tc.wantReason == "" {
				if got != nil {
					t.Fatalf("want genuine (nil), got false-parse %q", got.Reason)
				}
				return
			}
			if got == nil {
				t.Fatalf("want false-parse %q, got nil (genuine)", tc.wantReason)
			}
			if got.Reason != tc.wantReason {
				t.Fatalf("want reason %q, got %q", tc.wantReason, got.Reason)
			}
			// Error() must surface the clean reason verbatim (it becomes last_error).
			if got.Error() != tc.wantReason {
				t.Fatalf("Error() = %q, want %q", got.Error(), tc.wantReason)
			}
		})
	}
}
