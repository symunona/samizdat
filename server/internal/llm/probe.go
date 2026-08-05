package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Probing is the deliberate opposite of health.go: an *active* question asked
// only when a human asks it (`just check-llm`, the Settings Probe button). It
// never runs on a render path — that is why health.go exists.
//
// Every probe is chosen to be the cheapest honest answer:
//   - local / OpenAI-compatible: GET /models — reachability + model count, no tokens.
//   - OpenRouter: GET /key — real credit numbers, no tokens.
//   - Anthropic: GET /v1/models proves the key; credits have NO endpoint, so they
//     come from the last recorded quota error, or (deep) from a 1-token completion.

// Auth states.
const (
	AuthOK         = "ok"
	AuthMissingKey = "missing_key"
	AuthBadKey     = "bad_key"
	AuthUnknown    = "unknown"
)

// Credit states. "n/a" is a local box: it has no balance to run out of.
const (
	CreditsOK        = "ok"
	CreditsExhausted = "exhausted"
	CreditsUnknown   = "unknown"
	CreditsNA        = "n/a"
)

const probeTimeout = 10 * time.Second

var probeHTTPClient = &http.Client{Timeout: probeTimeout}

// ProbeResult is one provider's answer to "can I use you right now?".
type ProbeResult struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Role      string `json:"role"`
	Transport string `json:"transport"`
	Flavor    string `json:"flavor"`
	BaseURL   string `json:"base_url,omitempty"`

	Reachable   bool   `json:"reachable"`
	Auth        string `json:"auth"`
	Credits     string `json:"credits"`
	CreditsNote string `json:"credits_note,omitempty"`
	Models      int    `json:"models"`
	LatencyMs   int64  `json:"latency_ms"`
	Error       string `json:"error,omitempty"`
	ErrorKind   string `json:"error_kind,omitempty"`
}

// Probe checks every discovered provider concurrently. deep additionally spends a
// 1-token completion on cloud providers that expose no balance endpoint — the only
// way to tell "key is valid" from "key is valid but the account is empty".
func (r *Router) Probe(ctx context.Context, deep bool) []ProbeResult {
	if r == nil {
		return []ProbeResult{}
	}
	out := make([]ProbeResult, len(r.providers))
	done := make(chan int, len(r.providers))
	for i, p := range r.providers {
		go func(i int, p *Provider) {
			out[i] = r.probeOne(ctx, p, deep)
			done <- i
		}(i, p)
	}
	for range r.providers {
		<-done
	}
	return out
}

func (r *Router) probeOne(ctx context.Context, p *Provider, deep bool) ProbeResult {
	res := ProbeResult{
		ID: p.ID, Label: p.Label, Role: p.Role, Transport: p.Transport,
		Flavor: p.Flavor, BaseURL: p.BaseURL,
		Auth: AuthUnknown, Credits: CreditsUnknown,
	}
	if !p.NeedsKey {
		res.Credits = CreditsNA
	}
	if p.NeedsKey && !p.HasKey {
		// Nothing to ask with. Claiming reachable here would be a guess, and asking
		// anyway would spend a round trip to be told what we already know.
		res.Auth = AuthMissingKey
		return res
	}

	start := time.Now()
	models, err := p.listModels(ctx)
	res.LatencyMs = time.Since(start).Milliseconds()
	if err != nil {
		res.Error = truncErr(err.Error())
		res.ErrorKind = classify(err)
		// A 4xx came back over a working connection: the box is up, the request was
		// refused. Only a transport failure means "nothing is listening".
		res.Reachable = res.ErrorKind != KindTransport
		switch res.ErrorKind {
		case KindAuth:
			res.Auth = AuthBadKey
		case KindQuota:
			res.Auth = AuthOK
			res.Credits = CreditsExhausted
		}
		return res
	}
	res.Reachable = true
	res.Models = len(models)
	res.Auth = AuthOK

	switch p.Flavor {
	case flavorOpenRouter:
		r.fillOpenRouterCredits(ctx, p, &res)
	case flavorAnthropic, flavorOpenAI:
		r.fillCloudCredits(ctx, p, &res, deep)
	}
	return res
}

// fillOpenRouterCredits reads the real numbers — OpenRouter is the one provider
// that will tell you your balance without spending it.
func (r *Router) fillOpenRouterCredits(ctx context.Context, p *Provider, res *ProbeResult) {
	if !p.HasKey {
		return
	}
	var body struct {
		Data struct {
			Usage          float64  `json:"usage"`
			Limit          *float64 `json:"limit"`
			LimitRemaining *float64 `json:"limit_remaining"`
		} `json:"data"`
	}
	if err := p.getJSON(ctx, trimSlash(p.BaseURL)+"/key", &body); err != nil {
		res.CreditsNote = truncErr(err.Error())
		return
	}
	switch {
	case body.Data.LimitRemaining != nil && *body.Data.LimitRemaining <= 0:
		res.Credits = CreditsExhausted
		res.CreditsNote = fmt.Sprintf("$%.2f used, limit reached", body.Data.Usage)
	case body.Data.Limit != nil:
		res.Credits = CreditsOK
		res.CreditsNote = fmt.Sprintf("$%.2f used of $%.2f", body.Data.Usage, *body.Data.Limit)
	default:
		res.Credits = CreditsOK
		res.CreditsNote = fmt.Sprintf("$%.2f used, no limit set", body.Data.Usage)
	}
}

// fillCloudCredits answers for providers with no balance endpoint. Shallow: trust
// the last real call (the registry already knows when a pipeline died of quota).
// Deep: spend one token and know for certain.
func (r *Router) fillCloudCredits(ctx context.Context, p *Provider, res *ProbeResult, deep bool) {
	if res.Auth != AuthOK {
		return
	}
	if deep {
		_, _, err := p.client().Complete(ctx, "", []Message{{Role: "user", Content: "hi"}})
		if err == nil {
			res.Credits = CreditsOK
			res.CreditsNote = "verified by 1-token ping"
			return
		}
		kind := classify(err)
		res.Error = truncErr(err.Error())
		res.ErrorKind = kind
		switch kind {
		case KindQuota:
			res.Credits = CreditsExhausted
		case KindAuth:
			res.Auth = AuthBadKey
		}
		return
	}
	for _, h := range Snapshot() {
		if h.Key != p.HealthKey() {
			continue
		}
		if h.LastErrorKind == KindQuota && h.LastErrorAt.After(h.LastOKAt) {
			res.Credits = CreditsExhausted
			res.CreditsNote = "last call failed on quota"
		} else if !h.LastOKAt.IsZero() && h.LastOKAt.After(h.LastErrorAt) {
			res.Credits = CreditsOK
			res.CreditsNote = "last call succeeded"
		}
	}
}

// getJSON issues an authenticated GET and decodes the body. Non-2xx becomes an
// error carrying the status, so classify() can tell auth from quota from 5xx.
func (p *Provider) getJSON(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("new request: %w", err)
	}
	if p.Transport == transportAnthropic {
		req.Header.Set("x-api-key", p.apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")
	} else if p.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.apiKey)
	}

	resp, err := probeHTTPClient.Do(req)
	if err != nil {
		return transportErr(err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		e := fmt.Errorf("%s %d: %s", p.ID, resp.StatusCode, string(data))
		if resp.StatusCode >= 500 {
			return transportErr(e)
		}
		return e
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("%s: parse response: %w", p.ID, err)
	}
	return nil
}
