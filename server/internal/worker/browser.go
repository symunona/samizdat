package worker

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/mxschmitt/playwright-go"
	"github.com/symunona/samizdat/server/internal/extractor"
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
func (b *BrowserPool) FetchHTML(url, statePath string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	logBrowser.Printf("fetch %s", url)
	ctx, err := b.newContext(statePath)
	if err != nil {
		return "", err
	}
	defer func() { _ = ctx.Close() }()

	page, err := ctx.NewPage()
	if err != nil {
		return "", fmt.Errorf("new page: %w", err)
	}
	defer func() { _ = page.Close() }()

	if _, err := page.Goto(url, playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateLoad,
		Timeout:   playwright.Float(30_000),
	}); err != nil {
		return "", fmt.Errorf("goto %s: %w", url, err)
	}

	dismissConsent(page, url)

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

// dismissConsent waits briefly for a cookie/consent banner and clicks the first
// visible accept control it finds, so gated content becomes visible. Best-effort:
// every step is a no-op when no banner is present.
func dismissConsent(page playwright.Page, url string) {
	_ = page.Locator("[class*='consent'],[id*='consent'],[class*='cookie'],[id*='cookie']").First().
		WaitFor(playwright.LocatorWaitForOptions{Timeout: playwright.Float(3_000)})

	consentSelectors := []string{
		"button:has-text('Elfogad')", // Hungarian (Telex, 444, index.hu)
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
		btn := page.Locator(sel).First()
		if visible, _ := btn.IsVisible(); visible {
			_ = btn.Click()
			logBrowser.Printf("dismissed consent banner (%s) on %s", sel, url)
			_ = page.WaitForLoadState(playwright.PageWaitForLoadStateOptions{
				State:   playwright.LoadStateNetworkidle,
				Timeout: playwright.Float(5_000),
			})
			break
		}
	}
}

// newContext builds a fresh isolated BrowserContext with our desktop UserAgent.
// When statePath is non-empty and the file exists, its persisted cookies +
// localStorage (a Playwright storageState jar) are loaded so authed domains
// render as the logged-in owner.
func (b *BrowserPool) newContext(statePath string) (playwright.BrowserContext, error) {
	opts := playwright.BrowserNewContextOptions{
		UserAgent: playwright.String(
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
				"(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		),
	}
	if statePath != "" {
		if _, err := os.Stat(statePath); err == nil {
			opts.StorageStatePath = playwright.String(statePath)
			logBrowser.Printf("loaded auth session %s", statePath)
		}
	}
	ctx, err := b.browser.NewContext(opts)
	if err != nil {
		return nil, fmt.Errorf("new context: %w", err)
	}
	return ctx, nil
}

// Login performs a headless form login for a paywalled domain and persists the
// resulting session to statePath (chmod 0600). It verifies auth.SuccessText is
// present on the post-login landing page before saving; otherwise it returns an
// error without writing a jar. Returns a short human detail on success.
func (b *BrowserPool) Login(auth extractor.AuthConfig, user, pass, statePath string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	logBrowser.Printf("login %s", auth.LoginURL)

	ctx, err := b.newContext("")
	if err != nil {
		return "", err
	}
	defer func() { _ = ctx.Close() }()

	page, err := ctx.NewPage()
	if err != nil {
		return "", fmt.Errorf("new page: %w", err)
	}
	defer func() { _ = page.Close() }()

	if _, err := page.Goto(auth.LoginURL, playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateLoad,
		Timeout:   playwright.Float(30_000),
	}); err != nil {
		return "", fmt.Errorf("goto login page: %w", err)
	}
	dismissConsent(page, auth.LoginURL)

	if err := page.Locator(auth.UserSelector).Fill(user); err != nil {
		return "", fmt.Errorf("fill user (%s): %w", auth.UserSelector, err)
	}
	if err := page.Locator(auth.PassSelector).Fill(pass); err != nil {
		return "", fmt.Errorf("fill password (%s): %w", auth.PassSelector, err)
	}
	if err := page.Locator(auth.SubmitSelector).Click(); err != nil {
		return "", fmt.Errorf("click submit (%s): %w", auth.SubmitSelector, err)
	}
	// Let the post-login redirect settle.
	_ = page.WaitForLoadState(playwright.PageWaitForLoadStateOptions{
		State:   playwright.LoadStateNetworkidle,
		Timeout: playwright.Float(15_000),
	})

	// Success detector: wait for the logged-in marker to render on the landing
	// page (the target site may be a JS SPA that hydrates after networkidle).
	// Timeout = login failed (wrong credentials / changed form).
	if auth.SuccessText != "" {
		marker := page.Locator("text=" + auth.SuccessText).First()
		if err := marker.WaitFor(playwright.LocatorWaitForOptions{
			State:   playwright.WaitForSelectorStateVisible,
			Timeout: playwright.Float(20_000),
		}); err != nil {
			return "", fmt.Errorf("login failed: success marker %q not found (wrong credentials?)", auth.SuccessText)
		}
	}

	if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
		return "", fmt.Errorf("mkdir auth dir: %w", err)
	}
	if _, err := ctx.StorageState(playwright.BrowserContextStorageStateOptions{Path: playwright.String(statePath)}); err != nil {
		return "", fmt.Errorf("save session: %w", err)
	}
	if err := os.Chmod(statePath, 0o600); err != nil {
		return "", fmt.Errorf("chmod session: %w", err)
	}
	logBrowser.Printf("login ok, session saved to %s", statePath)
	return "session saved to " + statePath, nil
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
