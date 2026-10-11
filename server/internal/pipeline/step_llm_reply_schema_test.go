package pipeline

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// jsonKeys lists the JSON keys a reply type decodes, embedded structs excluded.
func jsonKeys(v any) []string {
	t := reflect.TypeOf(v)
	var keys []string
	for i := range t.NumField() {
		keys = append(keys, strings.Split(t.Field(i).Tag.Get("json"), ",")[0])
	}
	slices.Sort(keys)
	return keys
}

// objectSchema is the slice of JSON Schema the reply schemas use.
type objectSchema struct {
	Type       string                     `json:"type"`
	Required   []string                   `json:"required"`
	Properties map[string]json.RawMessage `json:"properties"`
	Items      json.RawMessage            `json:"items"`
}

// requireObject decodes an object schema and fails unless it declares and
// requires exactly keys — a key the parser reads but the grammar leaves out is a
// field a constrained model can never write.
func requireObject(t *testing.T, name string, raw json.RawMessage, keys []string) objectSchema {
	t.Helper()
	var s objectSchema
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("%s: not valid JSON: %v", name, err)
	}
	declared := make([]string, 0, len(s.Properties))
	for k := range s.Properties {
		declared = append(declared, k)
	}
	slices.Sort(declared)
	slices.Sort(s.Required)
	if s.Type != "object" || !slices.Equal(declared, keys) || !slices.Equal(s.Required, keys) {
		t.Fatalf("%s: type %q declares %v, requires %v; the parser reads %v", name, s.Type, declared, s.Required, keys)
	}
	return s
}

// Each reply schema must be the shape its step's parser decodes: the wrapper
// keys, and under "highlights" the item type's own JSON keys.
func TestReplySchemasMatchTheirParsers(t *testing.T) {
	cases := []struct {
		name    string
		schema  json.RawMessage
		wrapper []string
		item    any
	}{
		{kindLLMAINewsletter, aiNewsletterReplySchema, jsonKeys(aiNewsletterResponse{}), aiNewsletterHighlight{}},
		{kindLLM321Newsletter, nl321ReplySchema, []string{"highlights"}, nl321Highlight{}},
		{kindLLMTopics, topicsReplySchema, []string{"highlights"}, topicHighlight{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			top := requireObject(t, c.name, c.schema, c.wrapper)
			var list objectSchema
			if err := json.Unmarshal(top.Properties["highlights"], &list); err != nil || list.Type != "array" {
				t.Fatalf("highlights must be an array, got %s (%v)", top.Properties["highlights"], err)
			}
			requireObject(t, c.name+" item", list.Items, jsonKeys(c.item))
		})
	}
}

// sentSchema pulls the schema out of one recorded response_format.
func sentSchema(t *testing.T, format string) any {
	t.Helper()
	var f struct {
		Type string `json:"type"`
		Spec struct {
			Schema any `json:"schema"`
		} `json:"json_schema"`
	}
	if err := json.Unmarshal([]byte(format), &f); err != nil || f.Type != "json_schema" {
		t.Fatalf("response_format %q: type %q, err %v", format, f.Type, err)
	}
	return f.Spec.Schema
}

// The three JSON steps hold a local box to their own schema on every call that
// returns step JSON: the one call of a small document and each partition chunk.
func TestJSONStepsSendTheirReplySchema(t *testing.T) {
	steps := []struct {
		kind   string
		h      Handler
		schema json.RawMessage
	}{
		{kindLLMAINewsletter, handleLLMAINewsletter, aiNewsletterReplySchema},
		{kindLLM321Newsletter, handleLLM321Newsletter, nl321ReplySchema},
		{kindLLMTopics, handleLLMTopics, topicsReplySchema},
	}
	docs := []struct {
		band     string
		markdown string
		chunked  bool
	}{
		{"small", "Short body about foxes.", false},
		{"partition", strings.Repeat("Foxes run fast across the field. ", 150), true},
	}
	for _, s := range steps {
		var want any
		if err := json.Unmarshal(s.schema, &want); err != nil {
			t.Fatal(err)
		}
		for _, d := range docs {
			t.Run(s.kind+"/"+d.band, func(t *testing.T) {
				ctx, q, run := setupRun(t)
				setMarkdown(t, ctx, q, run, d.markdown)
				box, url := newFakeBox(t, func(int, string, string) (string, int) {
					return `{"summary":[],"highlights":[]}`, 200
				})
				if _, err := driveHandler(t, ctx, q, run, s.h, bandRouter(url, partitionTestLimits()), 30); err != nil {
					t.Fatalf("%s: %v", s.kind, err)
				}
				if chunked := box.calls() > 1; chunked != d.chunked {
					t.Fatalf("test setup: %d calls, want chunked=%v", box.calls(), d.chunked)
				}
				for i, format := range box.formats() {
					if got := sentSchema(t, format); !reflect.DeepEqual(got, want) {
						t.Fatalf("call %d sent schema %v, want %v", i, got, want)
					}
				}
			})
		}
	}
}

// A prose reply is never constrained: llm_summarize's single call, its map pass
// and its fold all go out with no response_format.
func TestProseCallsSendNoReplySchema(t *testing.T) {
	for band, markdown := range map[string]string{
		"small":   "Short body about foxes.",
		"chunked": strings.Repeat("Foxes run fast across the field. ", 150),
	} {
		t.Run(band, func(t *testing.T) {
			ctx, q, run := setupRun(t)
			setMarkdown(t, ctx, q, run, markdown)
			box, url := newFakeBox(t, func(int, string, string) (string, int) {
				return "- **foxes** run fast", 200
			})
			if _, err := driveSteps(t, ctx, q, run, bandRouter(url, testLimits()), 30); err != nil {
				t.Fatalf("summarize: %v", err)
			}
			sawMap := false
			for i, p := range box.prompts() {
				sawMap = sawMap || chunkMarker.MatchString(p)
				if f := box.formats()[i]; f != "" {
					t.Fatalf("call %d (%.60q) sent response_format %s", i, p, f)
				}
			}
			if sawMap != (band == "chunked") {
				t.Fatalf("test setup: map pass ran = %v in the %s band", sawMap, band)
			}
		})
	}
}

// The schema belongs to the step's OWN prompt. A request that carries one still
// sends none on the map pass — its prompt is mapDefaultPrompt and its reply is
// bullets — while the fold, which runs the step's prompt, does.
func TestMapPassNeverSendsReplySchema(t *testing.T) {
	ctx, q, run := setupRun(t)
	box, url := newFakeBox(t, func(int, string, string) (string, int) {
		return "- fragment fact", 200
	})
	router := bandRouter(url, testLimits())
	req := longRequest{
		Kind:        kindLLMSummarize,
		Cfg:         llmStepConfig{Prompt: defaultPrompt(kindLLMSummarize)},
		Title:       "A",
		Content:     strings.Repeat("Foxes run fast across the field. ", 150),
		ReplySchema: topicsReplySchema,
	}
	for tick := 0; ; tick++ {
		if tick == 30 {
			t.Fatal("run never finished")
		}
		out, err := llmStepCallLong(ctx, q, run, req, router)
		if err != nil {
			t.Fatalf("tick %d: %v", tick, err)
		}
		if out.Step.Done {
			break
		}
		run.State = out.Step.NewState
	}

	prompts, formats := box.prompts(), box.formats()
	if len(prompts) < 3 {
		t.Fatalf("test setup did not chunk: %d calls", len(prompts))
	}
	for i, p := range prompts {
		isMap := chunkMarker.MatchString(p)
		if isMap != (i < len(prompts)-1) {
			t.Fatalf("call %d: map prompt = %v, want every call but the last", i, isMap)
		}
		if isMap != (formats[i] == "") {
			t.Fatalf("call %d (map=%v) sent response_format %q", i, isMap, formats[i])
		}
	}
}
