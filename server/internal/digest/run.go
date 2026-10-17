package digest

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/extractor"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/logger"
	"github.com/symunona/samizdat/server/internal/pipeline"
	"github.com/symunona/samizdat/server/internal/progress"
	"github.com/symunona/samizdat/server/internal/store"
)

var logDigest = logger.New("digest")

// Runner is what a Digest needs to run: the store, the Router that owns every
// endpoint, and the extractor registry that knows which domains need a login.
type Runner struct {
	Q        *store.Queries
	Router   *llm.Router
	Registry extractor.Registry
}

// ErrCloudRoute is design rule 5 refusing a Digest: credentialed text may only
// go to a local provider.
var ErrCloudRoute = errors.New("digest would send paywalled text to a cloud provider")

// gate refuses rawURL when its domain scrapes behind a login and the Digest's
// route can land on a cloud provider. what names the thing for the error.
func (r Runner) gate(d Digest, rawURL, what string) error {
	cfg, ok := r.Registry.LookupByURL(rawURL)
	if !ok || cfg.Auth == nil {
		return nil
	}
	cloud := r.Router.CloudReach(d.Provider)
	if cloud == "" {
		return nil
	}
	return fmt.Errorf("%w: %s is scraped with a login and %q is not local — pin a local provider or take the feed out",
		ErrCloudRoute, what, cloud)
}

// CheckRoute applies rule 5 to the Feeds d is scoped to. It runs when a Digest
// is saved AND when it runs: a Feed can gain a login after the save.
func (r Runner) CheckRoute(ctx context.Context, d Digest) error {
	feeds, err := r.Q.ListFeeds(ctx)
	if err != nil {
		return fmt.Errorf("list feeds: %w", err)
	}
	for _, f := range feeds {
		if !d.inScope(f.ID) {
			continue
		}
		if err := r.gate(d, f.Url, fmt.Sprintf("feed %q", store.FeedTitle(f.Title, f.Url))); err != nil {
			return err
		}
	}
	return nil
}

// inScope reports whether a Feed is one this Digest reads. No list = every Feed.
func (d Digest) inScope(feedID string) bool {
	return len(d.SourceFeedIDs) == 0 || slices.Contains(d.SourceFeedIDs, feedID)
}

// Run writes one DigestIssue: the Highlights created since the last issue, from
// the Feeds in scope, asked each enabled question once. issueID is minted by
// whoever enqueued the Job, so a retry reopens the same row. Whatever goes wrong
// is recorded on the issue before it is returned.
//
// last_run_at only moves when an issue is written (done or empty), which is what
// makes the next window cover a run that failed.
func (r Runner) Run(ctx context.Context, digestID, issueID string, now time.Time) (status string, err error) {
	row, err := r.Q.GetDigest(ctx, digestID)
	if err != nil {
		return "", fmt.Errorf("get digest: %w", err)
	}
	d := FromRow(row)
	start, end := d.WindowStart(now).UTC().Format(time.RFC3339), now.UTC().Format(time.RFC3339)

	if _, err := r.Q.UpsertDigestIssue(ctx, store.UpsertDigestIssueParams{
		ID: issueID, DigestID: d.ID, WindowStart: start, WindowEnd: end, CreatedAt: end, UpdatedAt: end,
	}); err != nil {
		return "", fmt.Errorf("open issue: %w", err)
	}

	topics, meta, err := r.answer(ctx, d, issueID, start, end)
	status = StatusDone
	switch {
	case err != nil:
		status, topics, meta.Error = StatusFailed, nil, err.Error()
	case len(meta.Questions) == 0:
		status = StatusEmpty
	}
	if topics == nil {
		topics = []Topic{}
	}
	topicsJSON, _ := json.Marshal(topics)
	metaJSON, _ := json.Marshal(meta)
	stamp := time.Now().UTC().Format(time.RFC3339)
	if ferr := r.Q.FinishDigestIssue(ctx, store.FinishDigestIssueParams{
		Status: status, Topics: string(topicsJSON), Metadata: string(metaJSON), UpdatedAt: stamp, ID: issueID,
	}); ferr != nil {
		return "", errors.Join(err, fmt.Errorf("finish issue: %w", ferr))
	}
	if err != nil {
		return status, err
	}
	if err := r.Q.MarkDigestRun(ctx, store.MarkDigestRunParams{LastRunAt: &end, UpdatedAt: stamp, ID: d.ID}); err != nil {
		return status, fmt.Errorf("mark digest run: %w", err)
	}
	logDigest.Printf("digest %s (%s) issue %s: %s, %d topics from window %s..%s",
		d.ID, d.Name, issueID, status, len(topics), start, end)
	return status, nil
}

// answer collects the window's candidates and asks every enabled question. No
// QuestionMeta back means no call was made: the window held nothing to read.
func (r Runner) answer(ctx context.Context, d Digest, issueID, start, end string) ([]Topic, IssueMeta, error) {
	var meta IssueMeta
	var questions []Question
	for _, q := range d.Questions {
		if q.Enabled {
			questions = append(questions, q)
		}
	}
	if len(questions) == 0 {
		return nil, meta, errors.New("digest has no enabled question")
	}
	if !r.Router.Configured() {
		return nil, meta, llm.ErrNoProvider
	}
	if err := r.CheckRoute(ctx, d); err != nil {
		return nil, meta, err
	}

	rows, err := r.Q.ListDigestCandidates(ctx, store.ListDigestCandidatesParams{CreatedAt: start, CreatedAt_2: end})
	if err != nil {
		return nil, meta, fmt.Errorf("list candidates: %w", err)
	}
	rows = slices.DeleteFunc(rows, func(h store.ListDigestCandidatesRow) bool { return !d.inScope(h.FeedID) })
	// The Feed's own address is checked above; a Feed can also point at Documents
	// on a different, credentialed domain, and those are what would be sent.
	for _, h := range rows {
		if err := r.gate(d, h.DocumentCanonicalUrl, fmt.Sprintf("%q (feed %q)", h.Title, store.FeedTitle(h.FeedTitle, h.FeedUrl))); err != nil {
			return nil, meta, err
		}
	}
	cands := buildCandidates(rows, "", false)
	if len(cands) == 0 {
		return nil, meta, nil
	}

	var history []store.ListDigestCandidatesRow
	if slices.ContainsFunc(questions, func(q Question) bool { return q.History }) {
		if history, err = r.history(ctx, d, start); err != nil {
			return nil, meta, err
		}
	}

	covered := r.covered(ctx, d.ID, issueID)
	ctxTokens, replyTokens := window(r.Router.Summarize(Kind), d)
	route := llm.Route{Provider: d.Provider, Params: llm.Params{Model: d.Model, ReplySchema: topicsReplySchema}}
	rep := progress.From(ctx)

	var topics []Topic
	for i, q := range questions {
		head := promptHead(q, covered[q.ID])
		budget := pipeline.ChunkBudget(ctxTokens, replyTokens, pipeline.EstimateTokens(head))
		// Same rule as a step's big band: no room is an error, never "send it all".
		if budget < 1 {
			return nil, meta, fmt.Errorf("digest: ctx_tokens %d leaves no room for items after the prompt of %q", ctxTokens, q.Title)
		}
		sent, truncated := clamp(cands, budget)
		if len(sent) == 0 {
			return nil, meta, fmt.Errorf("digest: ctx_tokens %d cannot hold even one item for %q", ctxTokens, q.Title)
		}
		if truncated {
			logDigest.Warnf("digest %s question %q: %d of %d items fit ctx_tokens %d; oldest dropped",
				d.ID, q.Title, len(sent), len(cands), ctxTokens)
		}

		rep.Update(func(s *progress.State) {
			s.Phase, s.Step = progress.PhaseLLM, Kind
			s.Chunk, s.Chunks = i+1, len(questions)
			s.Provider, s.Model = "", ""
		})
		reply, usage, err := pipeline.MeteredComplete(ctx, r.Q, r.Router, Kind, route, nil, renderPrompt(head, sent))
		if err != nil {
			return nil, meta, err //nolint:wrapcheck // MeteredComplete already names the caller
		}
		got, dropped, trimmed, err := parseTopics(reply, q, indexRefs(sent))
		if err != nil {
			return nil, meta, err
		}

		template := promptContract + q.Prompt
		if q.History {
			template += diffContract
		}
		prov := pipeline.NewProvenance(Kind, route, template, usage)
		prov.Truncated, prov.OutputTruncated = truncated, usage.Truncated
		diffs, droppedDiffs := 0, 0
		if q.History {
			call := diffCall{d: d, route: route, ctxTokens: ctxTokens, replyTokens: replyTokens, sent: sent, history: history}
			if diffs, droppedDiffs, err = r.diffTopics(ctx, call, got, &prov); err != nil {
				return nil, meta, err
			}
		}
		meta.Questions = append(meta.Questions, QuestionMeta{
			QuestionID: q.ID, Provenance: prov,
			Candidates: len(cands), CandidatesSent: len(sent), DroppedTopics: dropped, TrimmedRefs: trimmed,
			Diffs: diffs, DroppedDiffs: droppedDiffs,
		})
		topics = append(topics, got...)
	}
	return topics, meta, nil
}

// covered is the previous issue's topic titles per question: what this run is
// told it already said.
func (r Runner) covered(ctx context.Context, digestID, issueID string) map[string][]string {
	out := map[string][]string{}
	prev, err := r.Q.GetPreviousDoneDigestIssue(ctx, store.GetPreviousDoneDigestIssueParams{DigestID: digestID, ID: issueID})
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			logDigest.Errorf("previous issue of digest %s: %v", digestID, err)
		}
		return out
	}
	for _, t := range IssueFromRow(prev).Topics {
		out[t.QuestionID] = append(out[t.QuestionID], t.Title)
	}
	return out
}

// window sizes one question's call. No endpoint declares its own context: the
// only ctx_tokens in config belong to the [llm.summarize] roles, so a Digest
// pinned to the provider a role names gets that role's window, and anything else
// is sized like the map role — the smallest box a call can land on. Being wrong
// low costs a visible `truncated`; being wrong high is a silently cut prompt.
//
// The match is on provider alone. A provider's models share its window class,
// and matching the role's model too clamped Opus and Sonnet on `anthropic` to
// the 7k local window because `big` named Haiku. A role naming no provider never
// matches: it keeps the step's routing and says nothing about where a Digest lands.
//
// The reply is reserved at the reduce role's cap: an answer is a fold's size.
func window(lim config.SummarizeLimits, d Digest) (ctxTokens, replyTokens int) {
	ctxTokens = lim.Map.CtxTokens
	for _, role := range []config.SummarizeRole{lim.Big, lim.Reduce} {
		if role.Provider != "" && role.Provider == d.Provider {
			ctxTokens = role.CtxTokens
			break
		}
	}
	return ctxTokens, lim.Reduce.MaxTokens
}
