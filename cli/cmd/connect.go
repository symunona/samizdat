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
		return err
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	port := cfg.Server.Port
	if flagConnectPort != 0 {
		port = flagConnectPort
	}

	url := fmt.Sprintf("http://localhost:%d/admin/pair/new", port)
	resp, err := http.Post(url, "application/json", strings.NewReader("{}")) //nolint:noctx
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not reach server on port %d. Is `samizdat serve` running?\n", port)
		return err
	}
	defer resp.Body.Close()

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

	fmt.Println()
	fmt.Println("  Samizdat pairing code")
	fmt.Println("  ─────────────────────")
	fmt.Printf("  Code:      %s\n", result.Code)
	fmt.Printf("  Expires:   in %s\n", ttl)
	if len(result.ServerURLs) > 0 {
		fmt.Printf("  Reachable:\n")
		for _, u := range result.ServerURLs {
			fmt.Printf("    %s\n", u)
		}
	}
	fmt.Println()

	// QR payload: JSON so future QR scan can auto-fill code + URLs.
	qrPayload, _ := json.Marshal(map[string]any{
		"v":    1,
		"code": result.Code,
		"urls": result.ServerURLs,
	})
	payload := string(qrPayload)

	// Terminal QR (ASCII art)
	qrterminal.GenerateWithConfig(payload, qrterminal.Config{
		Level:     qrterminal.L,
		Writer:    os.Stdout,
		BlackChar: qrterminal.BLACK,
		WhiteChar: qrterminal.WHITE,
		QuietZone: 1,
	})

	// Connect string: base64 of the JSON payload — paste into the app's connect field.
	b64 := base64.StdEncoding.EncodeToString(qrPayload)
	fmt.Println()
	fmt.Println("  Connect string (paste into app):")
	fmt.Printf("  %s\n", b64)

	fmt.Println()
	fmt.Println("  Open the app → enter any server URL + the code → Connect.")
	fmt.Println()
	return nil
}
