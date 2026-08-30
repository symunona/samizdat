package cmd

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/spf13/cobra"
)

var llmCmd = &cobra.Command{
	Use:   "llm",
	Short: "Inspect the LLM providers the server routes to",
}

var llmCheckCmd = &cobra.Command{
	Use:   "check",
	Short: "Probe every configured/discovered LLM provider (auth, credits, models)",
	RunE:  runLLMCheck,
	// A broken routing chain is a normal outcome of this command, reported by the
	// exit code — dumping the flag usage over the table would bury the answer.
	SilenceUsage: true,
}

var llmModelsCmd = &cobra.Command{
	Use:   "models",
	Short: "List the models each provider serves",
	RunE:  runLLMModels,
}

var (
	llmCheckShallow  bool
	llmCheckColor    string
	llmModelsFilter  string
	llmModelsRefresh bool
)

func init() {
	// Deep is the default: `check` is a manual command and the 1-token ping costs
	// ~$0.000001, while the alternative — reporting whatever a real call happened to
	// discover — is exactly the passive answer the Settings screen already gives.
	llmCheckCmd.Flags().BoolVar(&llmCheckShallow, "shallow", false,
		"skip the 1-token credit ping (no tokens spent; credits read from the last recorded call)")
	llmCheckCmd.Flags().StringVar(&llmCheckColor, "color", "auto", "colorize the table: auto | always | never")
	llmModelsCmd.Flags().StringVar(&llmModelsFilter, "provider", "", "only this provider id")
	llmModelsCmd.Flags().BoolVar(&llmModelsRefresh, "refresh", false, "bypass the server's 5-minute cache")
	llmCmd.AddCommand(llmCheckCmd, llmModelsCmd)
	Root.AddCommand(llmCmd)
}

type llmProbeResult struct {
	ID          string `json:"id"`
	Role        string `json:"role"`
	Reachable   bool   `json:"reachable"`
	Auth        string `json:"auth"`
	Credits     string `json:"credits"`
	CreditsNote string `json:"credits_note"`
	Models      int    `json:"models"`
	LatencyMs   int64  `json:"latency_ms"`
	BaseURL     string `json:"base_url"`
	Error       string `json:"error"`
}

// llmPipelineMismatch is one stored pipeline step whose PINNED provider+model no
// longer resolves on that provider — the exact failure mode that let four steps
// keep pointing at a decommissioned Ollama model for days: a 404 on every call,
// silently escalating to the fallback instead of failing loud (see
// server/internal/api/llm_status.go checkPipelineModels).
type llmPipelineMismatch struct {
	PipelineID   string `json:"pipeline_id"`
	PipelineName string `json:"pipeline_name"`
	StepKind     string `json:"step_kind"`
	Provider     string `json:"provider"`
	Model        string `json:"model"`
	Reason       string `json:"reason"`
}

func runLLMCheck(_ *cobra.Command, _ []string) error {
	c, err := newAPIClient()
	if err != nil {
		return err
	}
	path := "/llm/probe?deep=1"
	if llmCheckShallow {
		path = "/llm/probe"
	}
	resp, err := c.do(http.MethodPost, path, nil)
	if err != nil {
		return fmt.Errorf("probe llm providers: %w", err)
	}
	var out struct {
		Results            []llmProbeResult      `json:"results"`
		PipelineMismatches []llmPipelineMismatch `json:"pipeline_mismatches"`
	}
	if err := decode(resp, &out); err != nil {
		return err
	}
	if len(out.Results) == 0 {
		fmt.Println("No LLM providers configured or discovered.")
		fmt.Println("Set [llm] in config.toml, or export ANTHROPIC_API_KEY / OPENROUTER_API_KEY.")
		return fmt.Errorf("no llm providers")
	}

	color := resolveColor(llmCheckColor, os.Stdout)
	fmt.Print(renderProbeTable(out.Results, color))

	if len(out.PipelineMismatches) > 0 {
		fmt.Println()
		fmt.Print(renderMismatchTable(out.PipelineMismatches, color))
	}

	if !chainUsable(out.Results) {
		return fmt.Errorf("no usable provider in the routing chain")
	}
	if len(out.PipelineMismatches) > 0 {
		return fmt.Errorf("%d pipeline step(s) pin a model that does not exist on its provider", len(out.PipelineMismatches))
	}
	return nil
}

// chainUsable reports whether anything could actually serve a completion right
// now. Only the routing chain counts — a merely *available* provider is an offer,
// not a dependency — and only stateOK counts: a chain provider with no key is not
// "broken", but it cannot serve a request either, so it must not green-light the
// exit code.
func chainUsable(results []llmProbeResult) bool {
	for _, p := range results {
		if p.Role != rolePrimary && p.Role != roleFallback {
			continue
		}
		if providerState(p) == stateOK {
			return true
		}
	}
	return false
}

func runLLMModels(_ *cobra.Command, _ []string) error {
	c, err := newAPIClient()
	if err != nil {
		return err
	}
	path := "/llm/models"
	if llmModelsRefresh {
		path += "?refresh=1"
	}
	resp, err := c.do(http.MethodGet, path, nil)
	if err != nil {
		return fmt.Errorf("list llm models: %w", err)
	}
	var out struct {
		Groups []struct {
			ProviderID    string `json:"provider_id"`
			ProviderLabel string `json:"provider_label"`
			Role          string `json:"role"`
			Error         string `json:"error"`
			Models        []struct {
				ID            string `json:"id"`
				ContextLength int    `json:"context_length"`
			} `json:"models"`
		} `json:"groups"`
	}
	if err := decode(resp, &out); err != nil {
		return err
	}

	for _, g := range out.Groups {
		if llmModelsFilter != "" && g.ProviderID != llmModelsFilter {
			continue
		}
		fmt.Printf("\n%s  (%s, %s)\n", g.ProviderLabel, g.ProviderID, g.Role)
		if g.Error != "" {
			fmt.Printf("  ! %s\n", g.Error)
			continue
		}
		if len(g.Models) == 0 {
			fmt.Println("  (no models)")
			continue
		}
		for _, m := range g.Models {
			if m.ContextLength > 0 {
				fmt.Printf("  %s  (%dk ctx)\n", m.ID, m.ContextLength/1000)
			} else {
				fmt.Printf("  %s\n", m.ID)
			}
		}
	}
	return nil
}

// Provider roles and the probe vocabulary the server speaks (server/internal/llm).
// Named here because the exit code and the colors both branch on them — a magic
// string in two places is a silent contract with the API.
const (
	rolePrimary  = "primary"
	roleFallback = "fallback"

	authOK         = "ok"
	authMissingKey = "missing_key"
	authBadKey     = "bad_key"

	creditsOK        = "ok"
	creditsExhausted = "exhausted"
)

// The three things a human does with this table: use it, configure it, fix it.
const (
	stateOK   = iota // reachable, keyed, has headroom
	stateWarn        // nothing is broken — there is just no key to try
	stateBad         // unusable right now
)

// providerState collapses a probe into one verdict. A provider with no key was
// never contacted, so it is unconfigured, NOT unreachable — colouring it red would
// tell the user to fix a box that is probably fine.
func providerState(p llmProbeResult) int {
	switch {
	case p.Auth == authMissingKey:
		return stateWarn
	case !p.Reachable, p.Auth == authBadKey, p.Credits == creditsExhausted:
		return stateBad
	}
	return stateOK
}

func stateColor(state int) string {
	switch state {
	case stateOK:
		return sgrGreen
	case stateWarn:
		return sgrYellow
	default:
		return sgrRed
	}
}

// cell is one table cell: the text whose width drives the column, plus the color
// it is painted with. Keeping the two apart is the whole trick — padding measures
// `text`, never the escapes.
type cell struct {
	text  string
	color string
}

var probeHeaders = []string{"PROVIDER", "ROLE", "REACHABLE", "AUTH", "CREDITS", "MODELS", "LATENCY", "DETAIL"}

// renderProbeTable lays out the probe results. Errors do NOT go in a column: a
// provider error is a sentence, and squeezing it into the last cell either wraps
// the terminal or truncates the one thing the user needs. It gets an indented
// line of its own under its row.
func renderProbeTable(results []llmProbeResult, color bool) string {
	rows := make([][]cell, 0, len(results))
	for _, p := range results {
		state := providerState(p)
		rows = append(rows, []cell{
			{p.ID, stateColor(state) + ";" + sgrBold},
			{p.Role, dimUnless(p.Role == rolePrimary || p.Role == roleFallback)},
			reachableCell(p),
			{p.Auth, authColor(p.Auth)},
			creditsCell(p),
			{dashIfZero(p.Models), dimUnless(p.Models > 0)},
			{latency(p), dimUnless(p.LatencyMs > 0)},
			{detail(p), ""},
		})
	}

	widths := make([]int, len(probeHeaders))
	for i, h := range probeHeaders {
		widths[i] = len(h)
	}
	for _, row := range rows {
		for i, c := range row {
			if n := utf8.RuneCountInString(c.text); n > widths[i] {
				widths[i] = n
			}
		}
	}

	var b strings.Builder
	header := make([]cell, len(probeHeaders))
	for i, h := range probeHeaders {
		header[i] = cell{h, sgrBold}
	}
	writeRow(&b, header, widths, color)
	for i, row := range rows {
		writeRow(&b, row, widths, color)
		if e := errorLine(results[i]); e != "" {
			// Indented under its row so a failing provider reads as one block, and
			// the columns above stay aligned with the columns below.
			b.WriteString("    " + paintIf(color, sgrRed, "! "+e) + "\n")
		}
	}
	return b.String()
}

var mismatchHeaders = []string{"PIPELINE", "STEP", "PROVIDER", "MODEL", "REASON"}

// renderMismatchTable lists every pinned pipeline step whose model does not
// exist on its provider. Unlike the probe table this has no keyless/warn state —
// a mismatch here means the NEXT run of that step 404s, so every row is red.
func renderMismatchTable(mismatches []llmPipelineMismatch, color bool) string {
	rows := make([][]cell, 0, len(mismatches))
	for _, m := range mismatches {
		rows = append(rows, []cell{
			{m.PipelineName, sgrBold},
			{m.StepKind, ""},
			{m.Provider, ""},
			{m.Model, sgrRed},
			{m.Reason, sgrRed},
		})
	}

	widths := make([]int, len(mismatchHeaders))
	for i, h := range mismatchHeaders {
		widths[i] = len(h)
	}
	for _, row := range rows {
		for i, c := range row {
			if n := utf8.RuneCountInString(c.text); n > widths[i] {
				widths[i] = n
			}
		}
	}

	var b strings.Builder
	header := make([]cell, len(mismatchHeaders))
	for i, h := range mismatchHeaders {
		header[i] = cell{h, sgrBold}
	}
	writeRow(&b, header, widths, color)
	for _, row := range rows {
		writeRow(&b, row, widths, color)
	}
	return b.String()
}

// writeRow pads from the plain text so an escape sequence never counts toward a
// column, then trims the run of padding a short last cell leaves behind — an empty
// DETAIL must not trail whitespace into the terminal (or a diff).
func writeRow(b *strings.Builder, row []cell, widths []int, color bool) {
	var line strings.Builder
	for i, c := range row {
		line.WriteString(paintIf(color, c.color, c.text))
		if i < len(row)-1 {
			line.WriteString(strings.Repeat(" ", widths[i]-utf8.RuneCountInString(c.text)+2))
		}
	}
	b.WriteString(strings.TrimRight(line.String(), " "))
	b.WriteString("\n")
}

func paintIf(color bool, code, s string) string {
	if !color {
		return s
	}
	return paint(code, s)
}

func dimUnless(prominent bool) string {
	if prominent {
		return ""
	}
	return sgrDim
}

// reachableCell: a provider with no key was never contacted, so "no" would be a
// claim we never tested. Say we do not know.
func reachableCell(p llmProbeResult) cell {
	if p.Auth == authMissingKey {
		return cell{"—", sgrDim}
	}
	if p.Reachable {
		return cell{"yes", sgrGreen}
	}
	return cell{"no", sgrRed}
}

func authColor(auth string) string {
	switch auth {
	case authOK:
		return sgrGreen
	case authMissingKey:
		return sgrYellow
	case authBadKey:
		return sgrRed
	}
	return sgrDim
}

func creditsCell(p llmProbeResult) cell {
	switch p.Credits {
	case creditsOK:
		return cell{p.Credits, sgrGreen}
	case creditsExhausted:
		return cell{p.Credits, sgrRed}
	}
	return cell{p.Credits, sgrDim}
}

func dashIfZero(n int) string {
	if n == 0 {
		return "—"
	}
	return fmt.Sprintf("%d", n)
}

func latency(p llmProbeResult) string {
	if p.LatencyMs == 0 {
		return "—"
	}
	return fmt.Sprintf("%dms", p.LatencyMs)
}

// detail carries only what fits a column: the credit numbers, else the endpoint.
// The failure reason is a full sentence and gets its own line (see errorLine).
func detail(p llmProbeResult) string {
	if p.CreditsNote != "" {
		return p.CreditsNote
	}
	if p.Error != "" {
		return ""
	}
	return p.BaseURL
}

// errorLine is the first line of the provider's error — the useful part of an LLM
// error body is always at the front, and the server already truncated it.
func errorLine(p llmProbeResult) string {
	if p.Error == "" {
		return ""
	}
	return strings.SplitN(strings.TrimSpace(p.Error), "\n", 2)[0]
}
