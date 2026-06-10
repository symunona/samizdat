package worker

import "github.com/symunona/samizdat/server/internal/logger"

var (
	logWorker    = logger.New("worker")
	logScheduler = logger.New("scheduler")
	logBrowser   = logger.New("browser")
	logScraper   = logger.New("scraper")
	logPipeline  = logger.New("pipeline")
	logPollFeed  = logger.New("poll_feed")
	logAssets    = logger.New("assets")
)
