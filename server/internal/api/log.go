package api

import "github.com/symunona/samizdat/server/internal/logger"

var (
	logAPI  = logger.New("api")
	logPair = logger.New("pair")
	logDevs = logger.New("devices")
	logSubs = logger.New("subscriptions")
)
