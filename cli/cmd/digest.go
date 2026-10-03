package cmd

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

var digestCmd = &cobra.Command{
	Use:   "digest",
	Short: "List Digests and run one now",
}

var digestListCmd = &cobra.Command{
	Use:   "list",
	Short: "List Digests with their schedule and last run",
	Args:  cobra.NoArgs,
	RunE:  runDigestList,
}

var digestRunCmd = &cobra.Command{
	Use:   "run <name-or-id>",
	Short: "Run a Digest now (the same Job the schedule inserts)",
	Args:  cobra.ExactArgs(1),
	RunE:  runDigestRun,
}

func init() {
	digestCmd.AddCommand(digestListCmd, digestRunCmd)
	Root.AddCommand(digestCmd)
}

// digestRow is the part of the server's Digest this command reads.
type digestRow struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Enabled   bool    `json:"enabled"`
	Period    string  `json:"period"`
	Weekdays  []int   `json:"weekdays"`
	Hour      int     `json:"hour"`
	NextRunAt string  `json:"next_run_at"`
	LastRunAt *string `json:"last_run_at"`
}

var digestHeaders = []string{"NAME", "SCHEDULE", "ENABLED", "LAST RUN", "NEXT RUN", "ID"}

func fetchDigests(c *apiClient) ([]digestRow, error) {
	resp, err := c.do(http.MethodGet, "/digests", nil)
	if err != nil {
		return nil, fmt.Errorf("list digests: %w", err)
	}
	var out []digestRow
	if err := decode(resp, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func runDigestList(_ *cobra.Command, _ []string) error {
	c, err := newAPIClient()
	if err != nil {
		return err
	}
	digests, err := fetchDigests(c)
	if err != nil {
		return err
	}
	if len(digests) == 0 {
		fmt.Println("No digests. Create one on the Digests screen.")
		return nil
	}
	fmt.Print(renderDigestTable(digests, resolveColor("auto", os.Stdout)))
	return nil
}

func renderDigestTable(digests []digestRow, color bool) string {
	rows := make([][]cell, 0, len(digests))
	for _, d := range digests {
		enabled, next := cell{"yes", sgrGreen}, localStamp(d.NextRunAt)
		if !d.Enabled {
			// A disabled Digest keeps its old due time; it is not going to run then.
			enabled, next = cell{"no", sgrDim}, "—"
		}
		last := "—"
		if d.LastRunAt != nil {
			last = localStamp(*d.LastRunAt)
		}
		rows = append(rows, []cell{
			{d.Name, sgrBold},
			{digestSchedule(d), ""},
			enabled,
			{last, ""},
			{next, ""},
			{d.ID, sgrDim},
		})
	}
	return renderTable(digestHeaders, rows, color)
}

// digestSchedule reads the way the app's list does: "daily 07:00",
// "weekly Tue,Fri 07:00". Weekdays are the server's time.Weekday numbers.
func digestSchedule(d digestRow) string {
	at := fmt.Sprintf("%02d:00", d.Hour)
	if d.Period != "weekly" {
		return d.Period + " " + at
	}
	days := make([]string, len(d.Weekdays))
	for i, wd := range d.Weekdays {
		days[i] = time.Weekday(wd).String()[:3]
	}
	return "weekly " + strings.Join(days, ",") + " " + at
}

// localStamp shows a server timestamp in this machine's zone — the zone the
// Digest's hour is in, since the CLI talks to a server on the same box.
func localStamp(ts string) string {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return ts
	}
	return t.Local().Format("2006-01-02 15:04")
}

// findDigest resolves what the user typed: an id, else a name (case-insensitive).
// Names are not unique, so two matches is an error that lists the ids to pick from.
func findDigest(digests []digestRow, nameOrID string) (digestRow, error) {
	var named []digestRow
	for _, d := range digests {
		if d.ID == nameOrID {
			return d, nil
		}
		if strings.EqualFold(d.Name, nameOrID) {
			named = append(named, d)
		}
	}
	switch len(named) {
	case 0:
		return digestRow{}, fmt.Errorf("no digest named %q (see `sam digest list`)", nameOrID)
	case 1:
		return named[0], nil
	}
	ids := make([]string, len(named))
	for i, d := range named {
		ids[i] = d.ID
	}
	return digestRow{}, fmt.Errorf("%d digests are named %q — pass an id: %s", len(named), nameOrID, strings.Join(ids, ", "))
}

func runDigestRun(_ *cobra.Command, args []string) error {
	c, err := newAPIClient()
	if err != nil {
		return err
	}
	digests, err := fetchDigests(c)
	if err != nil {
		return err
	}
	d, err := findDigest(digests, args[0])
	if err != nil {
		return err
	}
	resp, err := c.do(http.MethodPost, "/digests/"+d.ID+"/run", nil)
	if err != nil {
		return fmt.Errorf("run digest: %w", err)
	}
	var queued struct {
		JobID   string `json:"job_id"`
		IssueID string `json:"issue_id"`
		Deduped bool   `json:"deduped"`
	}
	if err := decode(resp, &queued); err != nil {
		return err
	}
	if queued.Deduped {
		fmt.Printf("%q already has a run in flight.\n", d.Name)
	} else {
		fmt.Printf("Enqueued a run of %q.\n", d.Name)
	}
	fmt.Printf("job:   %s\nissue: %s\n", queued.JobID, queued.IssueID)
	return nil
}
