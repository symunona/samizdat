package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"github.com/symunona/samizdat/cli/config"
)

// apiClient talks to the local server over loopback. The CLI is local-trust, so
// it mints and caches a device token via the loopback pair flow rather than
// carrying a passphrase — and re-mints once if the cached one was revoked.
type apiClient struct {
	port    int
	token   string
	cfg     *config.Config
	cfgPath string
}

func newAPIClient() (*apiClient, error) {
	port, err := loadPort()
	if err != nil {
		return nil, err
	}
	cfgPath, err := resolveConfigPath()
	if err != nil {
		return nil, err
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	c := &apiClient{port: port, cfg: cfg, cfgPath: cfgPath, token: cfg.DeviceToken}
	if c.token == "" {
		if c.token, err = pairAndCache(port, cfg, cfgPath); err != nil {
			return nil, err
		}
	}
	return c, nil
}

// do issues an authenticated request against /api/v1<path>. A 401 means the
// cached token was revoked: re-pair once and retry, so a rotated device never
// costs the user a manual step.
func (c *apiClient) do(method, path string, body any) (*http.Response, error) {
	resp, err := c.send(method, path, body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not reach server on port %d. Is `samizdat serve` running?\n", c.port)
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		_ = resp.Body.Close()
		if c.token, err = pairAndCache(c.port, c.cfg, c.cfgPath); err != nil {
			return nil, err
		}
		return c.send(method, path, body)
	}
	return resp, nil
}

func (c *apiClient) send(method, path string, body any) (*http.Response, error) {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return nil, fmt.Errorf("encode request: %w", err)
		}
	}
	url := fmt.Sprintf("http://localhost:%d/api/v1%s", c.port, path)
	req, err := http.NewRequest(method, url, bytes.NewReader(payload)) //nolint:noctx
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("do request: %w", err)
	}
	return resp, nil
}

// decode reads a JSON response, turning a non-2xx into the server's own error
// message — a stack-free line the user can act on.
func decode(resp *http.Response, out any) error {
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&e)
		if e.Error != "" {
			return fmt.Errorf("server error: %s", e.Error)
		}
		return fmt.Errorf("server returned %s", resp.Status)
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}
