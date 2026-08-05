package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
)

// TestPipelineStripsLegacyCredential: credentials belong to the LLM Router, not
// to a pipeline row — but rows written before that still carry an api_key. It must
// never reach a client on any read path, and the save that drops it must still
// land the edit that came with it.
func TestPipelineStripsLegacyCredential(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := t.Context()
	now := time.Now().UTC().Format(time.RFC3339)

	if _, err := q.InsertPipeline(ctx, store.InsertPipelineParams{
		ID: "p1", Name: "P", Enabled: 1, Trigger: "on_new_document", Filter: "{}",
		Steps:     `[{"kind":"llm_summarize","config":{"model":"old","api_key":"sk-secret","prompt":"P"}}]`,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	h := &pipelinesHandler{q: q}

	getReq := httptest.NewRequest(http.MethodGet, "/api/v1/pipelines/p1", nil)
	getReq.SetPathValue("id", "p1")
	getRec := httptest.NewRecorder()
	h.get(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", getRec.Code, getRec.Body.String())
	}
	if strings.Contains(getRec.Body.String(), "sk-secret") {
		t.Fatalf("GET leaked api_key: %s", getRec.Body.String())
	}

	body, _ := json.Marshal(map[string]string{
		"steps": `[{"kind":"llm_summarize","config":{"model":"new","prompt":"P"}}]`,
	})
	putReq := httptest.NewRequest(http.MethodPut, "/api/v1/pipelines/p1", strings.NewReader(string(body)))
	putReq.SetPathValue("id", "p1")
	putRec := httptest.NewRecorder()
	h.update(putRec, putReq)
	if putRec.Code != http.StatusOK {
		t.Fatalf("put status = %d, body = %s", putRec.Code, putRec.Body.String())
	}
	if strings.Contains(putRec.Body.String(), "sk-secret") {
		t.Fatalf("PUT response leaked api_key: %s", putRec.Body.String())
	}

	stored, err := q.GetPipeline(ctx, "p1")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored.Steps, "sk-secret") {
		t.Fatalf("legacy api_key survived a save: %s", stored.Steps)
	}
	if !strings.Contains(stored.Steps, `"new"`) {
		t.Fatalf("edit not persisted: %s", stored.Steps)
	}
}

// TestStepCatalogDeclaresNoCredential: a step names a provider id and the Router
// resolves the endpoint + key. If a credential field ever reappears in a kind
// spec, a key is back in the DB and back on the wire — fail loudly.
func TestStepCatalogDeclaresNoCredential(t *testing.T) {
	rec := httptest.NewRecorder()
	handleStepCatalog(rec, httptest.NewRequest(http.MethodGet, "/api/v1/pipeline-steps", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var specs []struct {
		Kind   string `json:"kind"`
		Fields []struct {
			Key  string `json:"key"`
			Type string `json:"type"`
		} `json:"fields"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &specs); err != nil {
		t.Fatalf("decode catalog: %v", err)
	}
	if len(specs) != 7 {
		t.Fatalf("want 7 step kinds, got %d", len(specs))
	}
	var sawModelPicker bool
	for _, s := range specs {
		for _, f := range s.Fields {
			switch f.Key {
			case "api_key", "base_url":
				t.Fatalf("%s: %q is the Router's to own, not a step's", s.Kind, f.Key)
			}
			if f.Key == "model" {
				sawModelPicker = true
				if f.Type != "model" {
					t.Fatalf("%s: model field type = %q, want \"model\" (the app renders a picker off it)", s.Kind, f.Type)
				}
			}
		}
	}
	if !sawModelPicker {
		t.Fatal("no model field in the catalog — the model picker has nothing to bind to")
	}
}
