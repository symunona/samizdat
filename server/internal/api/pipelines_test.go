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

// TestPipelineUpdatePreservesAPIKey: the UI never receives an api_key (GET
// redacts it), so a PUT whose steps omit it must keep the stored value — while
// the edit that came with it lands. GET must still hide the key afterwards.
func TestPipelineUpdatePreservesAPIKey(t *testing.T) {
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

	// GET must not leak the key.
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

	// Save the redacted steps back with one edited value.
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
	if !strings.Contains(stored.Steps, "sk-secret") {
		t.Fatalf("api_key wiped by save: %s", stored.Steps)
	}
	if !strings.Contains(stored.Steps, `"new"`) {
		t.Fatalf("edit not persisted: %s", stored.Steps)
	}
}

// TestStepCatalogMarksSecretFields: the catalog names a secret field and flags it,
// so the client hides it by spec rather than by guessing at the key name — but it
// never carries a value for one.
func TestStepCatalogMarksSecretFields(t *testing.T) {
	rec := httptest.NewRecorder()
	handleStepCatalog(rec, httptest.NewRequest(http.MethodGet, "/api/v1/pipeline-steps", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var specs []struct {
		Kind   string `json:"kind"`
		Fields []struct {
			Key     string `json:"key"`
			Secret  bool   `json:"secret"`
			Default any    `json:"default"`
		} `json:"fields"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &specs); err != nil {
		t.Fatalf("decode catalog: %v", err)
	}
	if len(specs) != 7 {
		t.Fatalf("want 7 step kinds, got %d", len(specs))
	}
	var sawSecret bool
	for _, s := range specs {
		for _, f := range s.Fields {
			if f.Key != "api_key" {
				continue
			}
			sawSecret = true
			if !f.Secret {
				t.Fatalf("%s: api_key not flagged secret", s.Kind)
			}
			if f.Default != nil {
				t.Fatalf("%s: secret field carries a value", s.Kind)
			}
		}
	}
	if !sawSecret {
		t.Fatal("no api_key field in catalog — the client cannot know which keys are credentials")
	}
}
