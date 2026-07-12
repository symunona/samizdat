package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/symunona/samizdat/cli/config"
)

var subAddInterval int

var subCmd = &cobra.Command{
	Use:     "sub",
	Aliases: []string{"subs", "subscription"},
	Short:   "Manage feed subscriptions",
}

var subAddCmd = &cobra.Command{
	Use:   "add <url>",
	Short: "Subscribe to a feed (RSS auto-detected if no extractor config)",
	Args:  cobra.ExactArgs(1),
	RunE:  runSubAdd,
}

var subListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List subscriptions",
	RunE:    runSubList,
}

var subRmCmd = &cobra.Command{
	Use:   "rm <id>",
	Short: "Delete a subscription",
	Args:  cobra.ExactArgs(1),
	RunE:  runSubRm,
}

var subPollCmd = &cobra.Command{
	Use:   "poll <id>",
	Short: "Enqueue an immediate poll of a subscription",
	Args:  cobra.ExactArgs(1),
	RunE:  runSubPoll,
}

var subPauseCmd = &cobra.Command{
	Use:   "pause <id>",
	Short: "Pause a subscription",
	Args:  cobra.ExactArgs(1),
	RunE:  func(c *cobra.Command, a []string) error { return runSubSetPaused(a[0], true) },
}

var subResumeCmd = &cobra.Command{
	Use:   "resume <id>",
	Short: "Resume a paused subscription",
	Args:  cobra.ExactArgs(1),
	RunE:  func(c *cobra.Command, a []string) error { return runSubSetPaused(a[0], false) },
}

func init() {
	subAddCmd.Flags().IntVar(&subAddInterval, "interval-h", 24, "poll interval in hours")
	subCmd.AddCommand(subAddCmd, subListCmd, subRmCmd, subPollCmd, subPauseCmd, subResumeCmd)
	Root.AddCommand(subCmd)
}

func runSubAdd(_ *cobra.Command, args []string) error {
	body := map[string]interface{}{"url": args[0], "interval_h": subAddInterval}
	resp, err := authedRequest(http.MethodPost, "/subscriptions", body)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if err := checkStatus(resp); err != nil {
		return err
	}

	var result struct {
		Feed struct {
			ID  string `json:"id"`
			Url string `json:"url"`
		} `json:"feed"`
		Subscription struct {
			ID        string `json:"id"`
			IntervalH int64  `json:"interval_h"`
		} `json:"subscription"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	fmt.Printf("Subscribed: %s\n  feed         %s\n  subscription %s (every %dh)\n",
		result.Feed.Url, result.Feed.ID, result.Subscription.ID, result.Subscription.IntervalH)
	fmt.Println("Enqueued an immediate poll — watch progress in the Jobs screen.")
	return nil
}

func runSubList(_ *cobra.Command, _ []string) error {
	subs, err := getJSON[[]struct {
		ID        string `json:"id"`
		FeedID    string `json:"feed_id"`
		IntervalH int64  `json:"interval_h"`
		Paused    int64  `json:"paused"`
		NextRunAt string `json:"next_run_at"`
	}]("/subscriptions")
	if err != nil {
		return err
	}
	feeds, err := getJSON[[]struct {
		ID           string  `json:"id"`
		Url          string  `json:"url"`
		Title        string  `json:"title"`
		LastPolledAt *string `json:"last_polled_at"`
	}]("/feeds")
	if err != nil {
		return err
	}
	feedByID := map[string]string{}
	for _, f := range feeds {
		label := f.Url
		if f.Title != "" {
			label = f.Title + "  " + f.Url
		}
		feedByID[f.ID] = label
	}

	if len(subs) == 0 {
		fmt.Println("(no subscriptions)")
		return nil
	}
	for _, s := range subs {
		state := "active"
		if s.Paused != 0 {
			state = "paused"
		}
		fmt.Printf("%s  [%s, every %dh]  %s\n", s.ID, state, s.IntervalH, feedByID[s.FeedID])
	}
	return nil
}

func runSubRm(_ *cobra.Command, args []string) error {
	resp, err := authedRequest(http.MethodDelete, "/subscriptions/"+args[0], nil)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if err := checkStatus(resp); err != nil {
		return err
	}
	fmt.Printf("Deleted subscription %s\n", args[0])
	return nil
}

func runSubPoll(_ *cobra.Command, args []string) error {
	resp, err := authedRequest(http.MethodPost, "/subscriptions/"+args[0]+"/poll", nil)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if err := checkStatus(resp); err != nil {
		return err
	}
	var result struct {
		JobID string `json:"job_id"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&result)
	fmt.Printf("Enqueued poll job %s\n", result.JobID)
	return nil
}

func runSubSetPaused(id string, paused bool) error {
	resp, err := authedRequest(http.MethodPatch, "/subscriptions/"+id, map[string]bool{"paused": paused})
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if err := checkStatus(resp); err != nil {
		return err
	}
	verb := "Resumed"
	if paused {
		verb = "Paused"
	}
	fmt.Printf("%s subscription %s\n", verb, id)
	return nil
}

// getJSON GETs an authed endpoint and decodes the body into T.
func getJSON[T any](path string) (T, error) {
	var out T
	resp, err := authedRequest(http.MethodGet, path, nil)
	if err != nil {
		return out, err
	}
	defer func() { _ = resp.Body.Close() }()
	if err := checkStatus(resp); err != nil {
		return out, err
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return out, fmt.Errorf("decode response: %w", err)
	}
	return out, nil
}

// authedRequest fires a bearer-authed request at /api/v1<path>, reusing the
// cached local-trust token and re-pairing once on 401 (mirrors yt.go's flow).
func authedRequest(method, path string, body interface{}) (*http.Response, error) {
	port, err := loadPort()
	if err != nil {
		return nil, err
	}
	cfgPath, err := config.DefaultPath()
	if err != nil {
		return nil, fmt.Errorf("config path: %w", err)
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}

	token := cfg.DeviceToken
	if token == "" {
		if token, err = pairAndCache(port, cfg, cfgPath); err != nil {
			return nil, err
		}
	}

	do := func(tok string) (*http.Response, error) {
		var r io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			r = bytes.NewReader(b)
		}
		endpoint := fmt.Sprintf("http://localhost:%d/api/v1%s", port, path)
		req, err := http.NewRequest(method, endpoint, r) //nolint:noctx
		if err != nil {
			return nil, fmt.Errorf("build request: %w", err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		return http.DefaultClient.Do(req)
	}

	resp, err := do(token)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not reach server on port %d. Is `samizdat serve` running?\n", port)
		return nil, fmt.Errorf("do request: %w", err)
	}
	if resp.StatusCode == http.StatusUnauthorized {
		_ = resp.Body.Close()
		if token, err = pairAndCache(port, cfg, cfgPath); err != nil {
			return nil, err
		}
		if resp, err = do(token); err != nil {
			return nil, fmt.Errorf("do request: %w", err)
		}
	}
	return resp, nil
}

// checkStatus turns a non-2xx response into an error, surfacing the server's
// {"error":...} message when present.
func checkStatus(resp *http.Response) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	var e struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&e)
	msg := e.Error
	if msg == "" {
		msg = strings.TrimSpace(resp.Status)
	}
	fmt.Fprintf(os.Stderr, "server error: %s\n", msg)
	return fmt.Errorf("server returned %s", resp.Status)
}
