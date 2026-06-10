package cmd

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	qrterminal "github.com/mdp/qrterminal/v3"
	"github.com/spf13/cobra"
	"github.com/symunona/samizdat/cli/config"
)

var connectCmd = &cobra.Command{
	Use:   "connect",
	Short: "Mint a pairing code and display it (+ QR) for a device to scan",
	RunE:  runConnect,
}

var flagConnectPort int

func init() {
	connectCmd.Flags().IntVar(&flagConnectPort, "port", 0, "server port (overrides config)")
	Root.AddCommand(connectCmd)
}

func runConnect(_ *cobra.Command, _ []string) error {
	cfgPath, err := config.DefaultPath()
	if err != nil {
		return fmt.Errorf("default config path: %w", err)
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	port := cfg.Server.Port
	if flagConnectPort != 0 {
		port = flagConnectPort
	}

	url := fmt.Sprintf("http://localhost:%d/api/v1/admin/pair/new", port)
	resp, err := http.Post(url, "application/json", strings.NewReader("{}")) //nolint:noctx
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not reach server on port %d. Is `samizdat serve` running?\n", port)
		return fmt.Errorf("post pairing request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "server returned %s\n", resp.Status)
		return fmt.Errorf("server error")
	}

	var result struct {
		Code       string   `json:"code"`
		ExpiresAt  string   `json:"expires_at"`
		ServerURLs []string `json:"server_urls"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}

	exp, _ := time.Parse(time.RFC3339, result.ExpiresAt)
	ttl := time.Until(exp).Round(time.Second)

	// QR payload: JSON so QR scan / connect string can auto-fill code + URLs.
	qrPayload, _ := json.Marshal(map[string]any{
		"v":    1,
		"code": result.Code,
		"urls": result.ServerURLs,
	})

	fmt.Println()
	fmt.Println("  Samizdat pairing code")
	fmt.Println("  ─────────────────────")
	fmt.Printf("  Code:      %s\n", result.Code)
	fmt.Printf("  Expires:   in %s\n", ttl)
	if len(result.ServerURLs) > 0 {
		fmt.Println("  Click to connect (opens browser, auto-pairs):")
		for _, u := range result.ServerURLs {
			// Per-URL payload puts this address first so the app connects to the right endpoint.
			perURL, _ := json.Marshal(map[string]any{
				"v":    1,
				"code": result.Code,
				"urls": prioritizeURL(u, result.ServerURLs),
			})
			fmt.Printf("    %s/connect?c=%s\n", u, base64.StdEncoding.EncodeToString(perURL))
		}
	}
	fmt.Println()

	// Terminal QR (ASCII art)
	qrterminal.GenerateWithConfig(string(qrPayload), qrterminal.Config{
		Level:     qrterminal.L,
		Writer:    os.Stdout,
		BlackChar: qrterminal.BLACK,
		WhiteChar: qrterminal.WHITE,
		QuietZone: 1,
	})

	// Connect string: base64 of the full JSON payload — paste into the app's connect field.
	fmt.Println()
	fmt.Println("  Connect string (paste into app):")
	fmt.Printf("  %s\n", base64.StdEncoding.EncodeToString(qrPayload))
	fmt.Println()
	return nil
}

// prioritizeURL returns urls with target moved to position 0.
func prioritizeURL(target string, urls []string) []string {
	out := []string{target}
	for _, u := range urls {
		if u != target {
			out = append(out, u)
		}
	}
	return out
}
