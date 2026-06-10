package worker

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/playwright-community/playwright-go"
)

// BrowserPool holds a single long-lived Chromium instance.
// Each scrape gets its own BrowserContext + Page (isolated cookies/storage).
// mu ensures at most one FetchHTML runs at a time.
type BrowserPool struct {
	pw      *playwright.Playwright
	browser playwright.Browser
	mu      sync.Mutex
}

// cleanPlaywrightTmp removes orphaned playwright temp dirs left by previous
// unclean shutdowns. Safe to call before launching a new browser instance.
func cleanPlaywrightTmp() {
	patterns := []string{
		"/tmp/playwright_chromiumdev_profile-*",
		"/tmp/playwright-artifacts-*",
	}
	for _, pat := range patterns {
		matches, err := filepath.Glob(pat)
		if err != nil || len(matches) == 0 {
			continue
		}
		for _, dir := range matches {
			if err := os.RemoveAll(dir); err != nil {
				logBrowser.Warnf("cleanup %s: %v", dir, err)
			} else {
				logBrowser.Printf("cleaned orphaned playwright dir: %s", dir)
			}
		}
	}
}

// NewBrowserPool installs Chromium if needed, then launches it headless.
func NewBrowserPool() (*BrowserPool, error) {
	cleanPlaywrightTmp()
	logBrowser.Println("installing playwright browsers (no-op if already present)...")
	if err := playwright.Install(&playwright.RunOptions{
		Browsers: []string{"chromium"},
		Verbose:  false,
	}); err != nil {
		return nil, fmt.Errorf("playwright install: %w", err)
	}

	pw, err := playwright.Run()
	if err != nil {
		return nil, fmt.Errorf("playwright run: %w", err)
	}

	browser, err := pw.Chromium.Launch(playwright.BrowserTypeLaunchOptions{
		Headless: playwright.Bool(true),
		Args: []string{
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
		},
	})
	if err != nil {
		_ = pw.Stop()
		return nil, fmt.Errorf("launch chromium: %w", err)
	}

	logBrowser.Println("chromium ready")
	return &BrowserPool{pw: pw, browser: browser}, nil
}

// FetchHTML navigates to url in a fresh isolated context, waits for the page
// to load, and returns the fully-rendered HTML. Only one fetch runs at a time.
func (b *BrowserPool) FetchHTML(url string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	logBrowser.Printf("fetch %s", url)
	ctx, err := b.browser.NewContext(playwright.BrowserNewContextOptions{
		UserAgent: playwright.String(
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
				"(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		),
	})
	if err != nil {
		return "", fmt.Errorf("new context: %w", err)
	}
	defer ctx.Close()

	page, err := ctx.NewPage()
	if err != nil {
		return "", fmt.Errorf("new page: %w", err)
	}
	defer page.Close()

	if _, err := page.Goto(url, playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateLoad,
		Timeout:   playwright.Float(30_000),
	}); err != nil {
		return "", fmt.Errorf("goto %s: %w", url, err)
	}

	// Wait briefly for async consent banners to render before trying to dismiss.
	_, _ = page.WaitForSelector("[class*='consent'],[id*='consent'],[class*='cookie'],[id*='cookie']",
		playwright.PageWaitForSelectorOptions{Timeout: playwright.Float(3_000)})

	// Dismiss common cookie/consent banners before scrolling so gated content
	// becomes visible. Try each selector; first match wins, rest are no-ops.
	consentSelectors := []string{
		"button:has-text('Elfogad')",       // Hungarian (Telex, 444, index.hu)
		"button:has-text('Elfogadom')",
		"button:has-text('Accept all')",
		"button:has-text('Accept All')",
		"button:has-text('Accept')",
		"button:has-text('Agree')",
		"button:has-text('Allow all')",
		"[id*='accept']:visible",
		"[class*='accept-all']:visible",
	}
	for _, sel := range consentSelectors {
		btn, err := page.QuerySelector(sel)
		if err == nil && btn != nil {
			if visible, _ := btn.IsVisible(); visible {
				_ = btn.Click()
				logBrowser.Printf("dismissed consent banner (%s) on %s", sel, url)
				// brief settle after dismissal
				_ = page.WaitForLoadState(playwright.PageWaitForLoadStateOptions{
					State:   playwright.LoadStateNetworkidle,
					Timeout: playwright.Float(5_000),
				})
				break
			}
		}
	}

	// Scroll through the page incrementally to trigger Intersection Observer
	// lazy-loading on image-heavy articles.
	if _, err := page.Evaluate(`() => {
		return new Promise(resolve => {
			let totalHeight = 0;
			const distance = 800;
			const timer = setInterval(() => {
				window.scrollBy(0, distance);
				totalHeight += distance;
				if (totalHeight >= document.body.scrollHeight) {
					clearInterval(timer);
					window.scrollTo(0, 0);
					resolve();
				}
			}, 80);
		});
	}`); err != nil {
		logBrowser.Warnf("scroll error for %s (continuing): %v", url, err)
	}

	// Wait for network to settle after lazy loads triggered by scrolling.
	if err := page.WaitForLoadState(playwright.PageWaitForLoadStateOptions{
		State:   playwright.LoadStateNetworkidle,
		Timeout: playwright.Float(10_000),
	}); err != nil {
		logBrowser.Warnf("networkidle timeout for %s (continuing)", url)
	}

	html, err := page.Content()
	if err != nil {
		return "", fmt.Errorf("page content: %w", err)
	}
	logBrowser.Printf("fetched %d bytes from %s", len(html), url)
	return html, nil
}

// Close shuts down the browser and the playwright server.
func (b *BrowserPool) Close() {
	if err := b.browser.Close(); err != nil {
		logBrowser.Errorf("close: %v", err)
	}
	if err := b.pw.Stop(); err != nil {
		logBrowser.Errorf("pw stop: %v", err)
	}
}
