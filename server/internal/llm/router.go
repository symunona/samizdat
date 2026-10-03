package llm

import (
	"cmp"
	"context"
	"errors"
	"fmt"

	"github.com/symunona/samizdat/server/internal/config"
)

// ErrNoProvider means nothing is configured at all — no config section, no env
// key. It is distinct from "the provider you named does not exist".
var ErrNoProvider = errors.New("llm: no provider configured")

// Router is the single owner of "which LLM endpoints exist and which one serves
// this call". Before it, each pipeline step re-declared an endpoint (and a
// credential) that config.toml already declared, four times over.
//
// It satisfies Client, so a caller with nothing to say about routing keeps the
// old behavior: the configured chain, primary first.
type Router struct {
	providers []*Provider
	byID      map[string]*Provider
	clients   map[string]Client
	chain     Client
	summarize config.SummarizeSection
}

// Route names where a call should go (Provider) and how it should be made (Params).
// Both are optional: an empty Route is "the configured chain, that chain's model,
// that provider's own knobs".
type Route struct {
	Provider string // a Provider.ID, or a legacy transport name ("anthropic")
	Params   Params
}

// NewRouter discovers every provider reachable from cfg + the environment and
// builds the fallback chain from the configured ones.
func NewRouter(cfg config.LLMSection) *Router {
	r := &Router{byID: map[string]*Provider{}, clients: map[string]Client{}, summarize: cfg.Summarize}
	r.providers = Discover(cfg)

	var entries []entry
	for _, p := range r.providers {
		c := p.client()
		r.byID[p.ID] = p
		r.clients[p.ID] = c
		switch p.Role {
		case "primary":
			// The primary serves the caller's model: tier routing is the caller's call.
			entries = append(entries, entry{client: c, id: p.ID, def: p.Model, model: ""})
		case "fallback":
			// A fallback overrides with its own model — the caller's tier model does
			// not exist on a different provider.
			entries = append(entries, entry{client: c, id: p.ID, def: p.Model, model: p.Model})
		}
	}
	switch len(entries) {
	case 0:
	case 1:
		r.chain = announced(entries[0])
	default:
		r.chain = &fallbackClient{entries: entries}
	}
	return r
}

// Providers returns every known provider, in routing order. The copies carry no
// credential (apiKey is unexported).
func (r *Router) Providers() []Provider {
	out := make([]Provider, 0, len(r.providers))
	for _, p := range r.providers {
		out = append(out, *p)
	}
	return out
}

// Provider looks one up by ID (or legacy transport name).
func (r *Router) Provider(id string) (Provider, bool) {
	p := r.resolve(id)
	if p == nil {
		return Provider{}, false
	}
	return *p, true
}

// CloudReach names the first non-local provider a call routed to id could land
// on, "" when it stays on self-hosted boxes. A pin reaches only itself; an empty
// id walks the chain, so every primary and fallback counts. An id nothing
// resolves reaches nowhere — CompleteRoute refuses it before the wire.
func (r *Router) CloudReach(id string) string {
	if r == nil {
		return ""
	}
	if id != "" {
		if p := r.resolve(id); p != nil && !p.Local() {
			return p.ID
		}
		return ""
	}
	for _, p := range r.providers {
		if (p.Role == "primary" || p.Role == "fallback") && !p.Local() {
			return p.ID
		}
	}
	return ""
}

// Configured reports whether any provider can serve a call.
func (r *Router) Configured() bool { return r != nil && len(r.providers) > 0 }

// Summarize returns the size bands a step kind runs with. It lives on the Router
// because how much a call may carry is a property of the endpoint that serves it,
// and the Router is the one owner of endpoints. A Router built without config
// (tests) reports the built-in defaults rather than zeroes, which would read as
// "no context window" and route every document to the big band.
func (r *Router) Summarize(kind string) config.SummarizeLimits {
	if r == nil || r.summarize.Big.CtxTokens == 0 {
		return config.DefaultSummarize().ForStep(kind)
	}
	return r.summarize.ForStep(kind)
}

// Complete routes through the configured chain. This is the Client interface, so
// every pre-Router caller keeps its exact behavior.
func (r *Router) Complete(ctx context.Context, p Params, msgs []Message) (string, Usage, error) {
	return r.CompleteRoute(ctx, Route{Params: p}, msgs)
}

// CompleteRoute serves one call.
//
// An empty Route.Provider uses the chain (primary, then each fallback on a
// transport failure). A named provider is **pinned**: it does NOT fall back. That
// is the point of pinning — a step aimed at the local box must never quietly spend
// cloud money because the box was asleep.
func (r *Router) CompleteRoute(ctx context.Context, route Route, msgs []Message) (string, Usage, error) {
	if r == nil {
		return "", Usage{}, ErrNoProvider
	}
	if route.Provider == "" {
		if r.chain == nil {
			return "", Usage{}, ErrNoProvider
		}
		//nolint:wrapcheck // fallbackClient already prefixes "llm:"; wrapping again reads "llm: llm: …"
		return r.chain.Complete(ctx, route.Params, msgs)
	}
	p := r.resolve(route.Provider)
	if p == nil {
		return "", Usage{}, fmt.Errorf("llm: unknown provider %q (have %s)", route.Provider, r.ids())
	}
	notifyAttempt(ctx, Attempt{Provider: p.ID, Model: cmp.Or(route.Params.Model, p.Model)})
	reply, usage, err := r.clients[p.ID].Complete(ctx, route.Params, msgs)
	if err != nil {
		// Name the pin in the error: a pinned route has no fallback, so this IS the
		// failure the caller sees, and "which endpoint" is the first thing to know.
		return "", usage, fmt.Errorf("llm %s: %w", p.ID, err)
	}
	return reply, usage, nil
}

// resolve accepts a provider ID or a bare transport name. The transport form is
// what pipeline steps stored before the Router existed ("anthropic",
// "openai_compat"); it resolves to the first provider on that transport.
func (r *Router) resolve(id string) *Provider {
	if id == "" {
		return nil
	}
	if p, ok := r.byID[id]; ok {
		return p
	}
	for _, p := range r.providers {
		if p.Transport == id {
			return p
		}
	}
	return nil
}

func (r *Router) ids() string {
	out := ""
	for i, p := range r.providers {
		if i > 0 {
			out += ", "
		}
		out += p.ID
	}
	if out == "" {
		return "none"
	}
	return out
}

// entry is one provider in a fallback chain. A non-empty model overrides the
// caller's model when this entry serves the request.
type entry struct {
	client Client
	id     string // Provider.ID, for the attempt hook
	def    string // the provider's default_model, likewise
	model  string
}

// Attempt is one endpoint about to be asked. Model is what the call names, or
// the provider's default_model when it names none — empty only if neither is
// known.
type Attempt struct {
	Provider string
	Model    string
	// Fallback is true once the chain has moved past its primary.
	Fallback bool
}

type attemptHookKey struct{}

// WithAttemptHook has the Router call fn before every endpoint it tries for a
// call made with ctx. It is how a caller learns WHERE a call is going while it
// is still in flight — Usage only says so after the reply.
func WithAttemptHook(ctx context.Context, fn func(Attempt)) context.Context {
	return context.WithValue(ctx, attemptHookKey{}, fn)
}

func notifyAttempt(ctx context.Context, a Attempt) {
	if fn, ok := ctx.Value(attemptHookKey{}).(func(Attempt)); ok {
		fn(a)
	}
}

// announced is a chain of one: nothing to fall back to, but the attempt hook
// still learns which endpoint the call went to.
type announced entry

func (a announced) Complete(ctx context.Context, p Params, msgs []Message) (string, Usage, error) {
	notifyAttempt(ctx, Attempt{Provider: a.id, Model: cmp.Or(p.Model, a.def)})
	//nolint:wrapcheck // a pass-through: the adapter's error is the caller's error
	return a.client.Complete(ctx, p, msgs)
}

// fallbackClient tries each entry in order, falling through to the next only on
// transport-level failures (ErrTransport). Real API errors propagate immediately.
type fallbackClient struct {
	entries []entry
}

func (f *fallbackClient) Complete(ctx context.Context, p Params, msgs []Message) (string, Usage, error) {
	var errs []error
	for i, e := range f.entries {
		ep := p
		if e.model != "" {
			ep.Model = e.model // provider-specific model (caller's tier model won't exist here)
		}
		notifyAttempt(ctx, Attempt{Provider: e.id, Model: cmp.Or(ep.Model, e.def), Fallback: i > 0})
		reply, usage, err := e.client.Complete(ctx, ep, msgs)
		if err == nil {
			if i > 0 {
				logLLM.Warnf("primary failed; served by fallback provider %d (%s)", i, usage.Provider)
			}
			return reply, usage, nil
		}
		if ctx.Err() != nil {
			return "", Usage{}, fmt.Errorf("llm: context: %w", ctx.Err()) // canceled by caller — don't burn fallbacks
		}
		errs = append(errs, err)
		if !errors.Is(err, ErrTransport) {
			return "", Usage{}, fmt.Errorf("llm: %w", err) // real error (4xx etc.) — do not try fallbacks
		}
		logLLM.Warnf("provider %d transport failure, trying next: %v", i, err)
	}
	return "", Usage{}, fmt.Errorf("all llm providers failed: %w", errors.Join(errs...))
}
