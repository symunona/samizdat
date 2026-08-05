package api

import (
	"net/http"

	"github.com/symunona/samizdat/server/internal/pipeline"
)

// handleStepCatalog lists every registered step kind and its configurable
// fields, so a client can render a config editor it never has to hardcode.
//
// No field is a credential: endpoints and API keys belong to the LLM Router
// (config.toml + env), never to a pipeline row. A step names a provider id; the
// Router resolves it to an endpoint and a key.
func handleStepCatalog(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, pipeline.Catalog())
}
