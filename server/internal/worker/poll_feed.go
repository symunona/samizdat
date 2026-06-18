package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/extractor"
	"github.com/symunona/samizdat/server/internal/store"
)

type pollFeedPayload struct {
	FeedID  string `json:"feed_id"`
	FeedURL string `json:"feed_url,omitempty"`
	Manual  bool   `json:"manual,omitempty"`
}

func handlePollFeed(ctx context.Context, q *store.Queries, job store.Job, browser *BrowserPool, reg extractor.Registry) (string, error) {
	var p pollFeedPayload
	if err := json.Unmarshal([]byte(job.Payload), &p); err != nil {
		return "", fmt.Errorf("bad payload: %w", err)
	}

	feed, err := q.GetFeed(ctx, p.FeedID)
	if err != nil {
		return "", fmt.Errorf("get feed %s: %w", p.FeedID, err)
	}

	logPollFeed.Printf("polling feed %s (%s)", feed.ID[:8], feed.Url)

	cfg, ok := reg.LookupByURL(feed.Url)
	if !ok {
		return "", fmt.Errorf("no extractor config for %s", feed.Url)
	}

	logPollFeed.Printf("extractor kind=%s for %s", cfg.Kind, feed.Url)

	adapter := extractor.AdapterFor(cfg.Kind)
	if adapter == nil {
		return "", fmt.Errorf("unknown adapter kind %q", cfg.Kind)
	}

	// For html_links we need to fetch the page via the browser first.
	var htmlContent string
	if cfg.Kind == "html_links" {
		htmlContent, err = browser.FetchHTML(feed.Url)
		if err != nil {
			return "", fmt.Errorf("browser fetch %s: %w", feed.Url, err)
		}
	}

	urls, err := adapter.Discover(ctx, feed.Url, cfg, htmlContent)
	if err != nil {
		return "", fmt.Errorf("discover: %w", err)
	}

	logPollFeed.Printf("feed %s (%s) discovered %d URLs", feed.ID[:8], feed.Url, len(urls))

	now := time.Now().UTC().Format(time.RFC3339)
	newCount := 0

	for _, u := range urls {
		itemID := IDFromURL(feed.ID + u)
		item, err := q.UpsertFeedItem(ctx, store.UpsertFeedItemParams{
			ID:        itemID,
			FeedID:    feed.ID,
			Url:       u,
			SeenAt:    now,
			CreatedAt: now,
			UpdatedAt: now,
		})
		if err != nil {
			logPollFeed.Errorf("upsert feed_item %s: %v", u, err)
			continue
		}

		// Only enqueue scrape for newly inserted items (rev == 0 means first insert,
		// status == "pending" means not yet scraped).
		if item.Status == "pending" && item.Rev == 0 {
			// Dedup: skip if an active (queued/running/paused) scrape_url job already exists for this URL.
			activeCount, countErr := q.CountActiveScrapeJobsForURL(ctx, u)
			if countErr != nil {
				logPollFeed.Errorf("count active scrape jobs for %s: %v", u, countErr)
			} else if activeCount > 0 {
				logPollFeed.Printf("skipping scrape_url for %s: active job already exists", u)
				continue
			}

			feedID := feed.ID
			itemPayload, _ := json.Marshal(struct {
				URL     string  `json:"url"`
				FeedID  *string `json:"feed_id,omitempty"`
				FeedURL string  `json:"feed_url,omitempty"`
				Manual  bool    `json:"manual,omitempty"`
			}{URL: u, FeedID: &feedID, FeedURL: feed.Url, Manual: p.Manual})
			parentID := job.ID

			if p.Manual {
				_, err = q.InsertJobPaused(ctx, store.InsertJobPausedParams{
					ID:          uuid.NewString(),
					Kind:        "scrape_url",
					Payload:     string(itemPayload),
					RunAfter:    now,
					CreatedAt:   now,
					UpdatedAt:   now,
					ParentJobID: &parentID,
				})
				if err != nil {
					logPollFeed.Errorf("enqueue paused scrape_url for %s: %v", u, err)
				} else {
					logPollFeed.Printf("enqueued paused scrape_url (hold): %s", u)
					newCount++
				}
			} else {
				_, err = q.InsertJob(ctx, store.InsertJobParams{
					ID:          uuid.NewString(),
					Kind:        "scrape_url",
					Payload:     string(itemPayload),
					RunAfter:    now,
					CreatedAt:   now,
					UpdatedAt:   now,
					ParentJobID: &parentID,
				})
				if err != nil {
					logPollFeed.Errorf("enqueue scrape_url for %s: %v", u, err)
				} else {
					logPollFeed.Printf("enqueued scrape_url: %s", u)
					newCount++
				}
			}
		}
	}

	logPollFeed.Printf("feed %s done: discovered=%d new=%d", feed.ID[:8], len(urls), newCount)

	if err := q.MarkFeedPolled(ctx, store.MarkFeedPolledParams{
		LastPolledAt: &now,
		UpdatedAt:    now,
		ID:           feed.ID,
	}); err != nil {
		logPollFeed.Errorf("mark polled: %v", err)
	}

	jobResult, _ := json.Marshal(map[string]int{"discovered": len(urls), "new": newCount})
	return string(jobResult), nil
}
