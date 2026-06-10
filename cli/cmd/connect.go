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

	// Pick one address: prefer Tailscale/LAN over localhost.
	addr := bestAddr(result.ServerURLs)

	// Payload: one address without scheme — keeps base64 short.
	payload, _ := json.Marshal(map[string]any{
		"v":    1,
		"code": result.Code,
		"urls": []string{stripScheme(addr)},
	})
	connectStr := base64.StdEncoding.EncodeToString(payload)

	fmt.Println()
	fmt.Println("  Samizdat pairing code")
	fmt.Println("  ─────────────────────")
	fmt.Printf("  Code:      %s\n", result.Code)
	fmt.Printf("  Expires:   in %s\n", ttl)
	if len(result.ServerURLs) > 0 {
		fmt.Println("  Click to connect:")
		for _, u := range result.ServerURLs {
			perURL, _ := json.Marshal(map[string]any{
				"v":    1,
				"code": result.Code,
				"urls": []string{stripScheme(u)},
			})
			fullLink := fmt.Sprintf("%s/connect?c=%s", u, base64.StdEncoding.EncodeToString(perURL))
			fmt.Printf("    %s\n", osc8(fullLink, stripScheme(u)))
		}
	}
	fmt.Println()

	// Terminal QR (ASCII art)
	qrterminal.GenerateWithConfig(string(payload), qrterminal.Config{
		Level:     qrterminal.L,
		Writer:    os.Stdout,
		BlackChar: qrterminal.BLACK,
		WhiteChar: qrterminal.WHITE,
		QuietZone: 1,
	})

	// Connect string: paste into app's connect field.
	fmt.Println()
	fmt.Println("  Connect string (paste into app):")
	fmt.Printf("  %s\n", connectStr)
	fmt.Println()
	return nil
}

// bestAddr picks the best server address: last non-localhost URL, fallback to first.
func bestAddr(urls []string) string {
	var best string
	for _, u := range urls {
		if !strings.HasPrefix(u, "http://localhost") && !strings.HasPrefix(u, "https://localhost") {
			best = u
		}
	}
	if best == "" && len(urls) > 0 {
		best = urls[0]
	}
	return best
}

// stripScheme removes http:// or https:// prefix.
func stripScheme(u string) string {
	u = strings.TrimPrefix(u, "https://")
	u = strings.TrimPrefix(u, "http://")
	return u
}

// osc8 wraps text as an OSC 8 hyperlink so terminals render it clickable without showing the full URL.
func osc8(href, text string) string {
	return fmt.Sprintf("\033]8;;%s\033\\%s\033]8;;\033\\", href, text)
}
