package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/symunona/samizdat/cli/config"
)

var ytCmd = &cobra.Command{
	Use:     "yt <url>",
	Aliases: []string{"youtube"},
	Short:   "Enqueue a YouTube video for ingestion",
	Args:    cobra.ExactArgs(1),
	RunE:    runYt,
}

func init() {
	Root.AddCommand(ytCmd)
}

func runYt(_ *cobra.Command, args []string) error {
	url := args[0]
	if !isYouTubeURL(url) {
		return fmt.Errorf("not a YouTube URL: %s (expected youtube.com or youtu.be)", url)
	}

	port, err := loadPort()
	if err != nil {
		return err
	}
	cfgPath, err := config.DefaultPath()
	if err != nil {
		return fmt.Errorf("config path: %w", err)
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	// /api/v1/jobs is bearer-authed. Reuse the cached local-trust token; mint one
	// only if absent or revoked (so we don't churn a new device on every call).
	token := cfg.DeviceToken
	if token == "" {
		if token, err = pairAndCache(port, cfg, cfgPath); err != nil {
			return err
		}
	}

	resp, err := enqueueScrape(port, token, url)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not reach server on port %d. Is `samizdat serve` running?\n", port)
		return fmt.Errorf("enqueue job: %w", err)
	}
	// Cached token revoked → re-pair once and retry.
	if resp.StatusCode == http.StatusUnauthorized {
		_ = resp.Body.Close()
		if token, err = pairAndCache(port, cfg, cfgPath); err != nil {
			return err
		}
		if resp, err = enqueueScrape(port, token, url); err != nil {
			return fmt.Errorf("enqueue job: %w", err)
		}
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&e)
		if e.Error != "" {
			fmt.Fprintf(os.Stderr, "server error: %s\n", e.Error)
		} else {
			fmt.Fprintf(os.Stderr, "server returned %s\n", resp.Status)
		}
		return fmt.Errorf("server error")
	}

	var result struct {
		JobID string `json:"job_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}

	fmt.Printf("Enqueued job %s — watch progress in the Jobs screen.\n", result.JobID)
	return nil
}

// enqueueScrape POSTs a scrape_url job for url with the given bearer token.
func enqueueScrape(port int, token, url string) (*http.Response, error) {
	body, _ := json.Marshal(map[string]string{"kind": "scrape_url", "url": url})
	endpoint := fmt.Sprintf("http://localhost:%d/api/v1/jobs", port)
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req) //nolint:noctx
	if err != nil {
		return nil, fmt.Errorf("do request: %w", err)
	}
	return resp, nil
}

// isYouTubeURL reports whether u points at youtube.com or youtu.be.
func isYouTubeURL(u string) bool {
	l := strings.ToLower(u)
	return strings.Contains(l, "youtube.com") || strings.Contains(l, "youtu.be")
}

// pairAndCache mints a device token via the loopback pair flow, caches it in the
// CLI config (0600), and returns it. The CLI is local-trust, so this is the same
// loopback flow the app uses to pair — no passphrase needed.
func pairAndCache(port int, cfg *config.Config, cfgPath string) (string, error) {
	token, err := localDeviceToken(port)
	if err != nil {
		return "", err
	}
	cfg.DeviceToken = token
	if err := config.Save(cfg, cfgPath); err != nil {
		return "", fmt.Errorf("cache device token: %w", err)
	}
	return token, nil
}

// localDeviceToken mints a pair code via the localhost-only admin endpoint and
// immediately claims it, returning a bearer token.
func localDeviceToken(port int) (string, error) {
	base := fmt.Sprintf("http://localhost:%d/api/v1", port)

	mintResp, err := http.Post(base+"/admin/pair/new", "application/json", strings.NewReader("{}")) //nolint:noctx
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not reach server on port %d. Is `samizdat serve` running?\n", port)
		return "", fmt.Errorf("mint pair code: %w", err)
	}
	defer func() { _ = mintResp.Body.Close() }()
	if mintResp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("mint pair code: server returned %s", mintResp.Status)
	}
	var minted struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(mintResp.Body).Decode(&minted); err != nil {
		return "", fmt.Errorf("decode pair code: %w", err)
	}

	claimBody, _ := json.Marshal(map[string]string{"code": minted.Code, "name": "sam-cli"})
	claimResp, err := http.Post(base+"/pair", "application/json", bytes.NewReader(claimBody)) //nolint:noctx
	if err != nil {
		return "", fmt.Errorf("claim pair code: %w", err)
	}
	defer func() { _ = claimResp.Body.Close() }()
	if claimResp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("claim pair code: server returned %s", claimResp.Status)
	}
	var claimed struct {
		DeviceToken string `json:"device_token"`
	}
	if err := json.NewDecoder(claimResp.Body).Decode(&claimed); err != nil {
		return "", fmt.Errorf("decode device token: %w", err)
	}
	return claimed.DeviceToken, nil
}
