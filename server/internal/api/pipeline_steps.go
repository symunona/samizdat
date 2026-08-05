package api

import (
	"net/http"

	"github.com/symunona/samizdat/server/internal/pipeline"
)

// handleStepCatalog lists every registered step kind and its configurable
// fields, so a client can render a config editor it never has to hardcode.
//
// A secret field (api_key) keeps its spec but loses its Default: the client must
// be TOLD which keys are credentials, or it is left guessing from key names. The
// value never travels — RedactSecrets strips it from the pipeline row itself.
func handleStepCatalog(w http.ResponseWriter, _ *http.Request) {
	specs := pipeline.Catalog()
	out := make([]pipeline.KindSpec, 0, len(specs))
	for _, s := range specs {
		fields := make([]pipeline.FieldSpec, 0, len(s.Fields))
		for _, f := range s.Fields {
			if f.Secret {
				f.Default = nil
			}
			fields = append(fields, f)
		}
		s.Fields = fields
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, out)
}
