package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"github.com/spf13/cobra"
	"github.com/symunona/samizdat/cli/config"
)

var (
	flagLoginPort int
	flagLoginUser string
	flagLoginPass string
)

var loginCmd = &cobra.Command{
	Use:   "login <domain>",
	Short: "Log in to a paywalled domain and persist the scraper session",
	Long: `Log in to a paywalled domain so scrapes render full-text.

The domain must have an auth block in extractors/<domain>/feed.yaml. The server
runs a headless form login, verifies success, and persists a session cookie jar.
Credentials are used once and never stored — only the resulting jar is kept.

  sam login 444.hu --user me@example.com --pass 'secret'
  SAM_LOGIN_USER=me@example.com SAM_LOGIN_PASS=secret sam login 444.hu`,
	Args: cobra.ExactArgs(1),
	RunE: runLogin,
}

func init() {
	loginCmd.Flags().IntVar(&flagLoginPort, "port", 0, "server port (overrides config)")
	loginCmd.Flags().StringVar(&flagLoginUser, "user", "", "account username/email (or env SAM_LOGIN_USER)")
	loginCmd.Flags().StringVar(&flagLoginPass, "pass", "", "account password (or env SAM_LOGIN_PASS)")
	Root.AddCommand(loginCmd)
}

func runLogin(_ *cobra.Command, args []string) error {
	domain := args[0]
	user := flagLoginUser
	if user == "" {
		user = os.Getenv("SAM_LOGIN_USER")
	}
	pass := flagLoginPass
	if pass == "" {
		pass = os.Getenv("SAM_LOGIN_PASS")
	}
	if user == "" || pass == "" {
		return fmt.Errorf("credentials required: pass --user/--pass or set SAM_LOGIN_USER/SAM_LOGIN_PASS")
	}

	cfgPath, err := resolveConfigPath()
	if err != nil {
		return err
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	port := cfg.Server.Port
	if flagLoginPort != 0 {
		port = flagLoginPort
	}

	payload, _ := json.Marshal(map[string]string{"domain": domain, "username": user, "password": pass})
	url := fmt.Sprintf("http://localhost:%d/api/v1/admin/scraper/login", port)
	resp, err := http.Post(url, "application/json", bytes.NewReader(payload)) //nolint:noctx
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not reach server on port %d. Is `samizdat serve` running?\n", port)
		return fmt.Errorf("post login: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	var result struct {
		OK     bool   `json:"ok"`
		Detail string `json:"detail"`
		Error  string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&result)
	if resp.StatusCode != http.StatusOK {
		if result.Error == "" {
			result.Error = resp.Status
		}
		return fmt.Errorf("login failed: %s", result.Error)
	}
	fmt.Printf("✓ Logged in to %s — %s\n", domain, result.Detail)
	return nil
}
