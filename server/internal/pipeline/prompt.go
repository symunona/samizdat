package pipeline

import "strings"

// promptTemplateTail is what every catalog default prompt ends with: the
// document is appended to the instructions, with the cross-issue dedup block (if
// the step produces one) in between. Kept as one const so all four LLM steps
// compose their message identically.
const promptTemplateTail = "{{recently_covered}}\n\n# {{title}}\n\n{{content}}"

// legacyPromptTail is appended to a stored template that never mentions
// {{content}} — a hand-typed one-line prompt still gets the document, exactly
// the way the steps composed it before templating existed.
const legacyPromptTail = "\n\n# {{title}}\n\n{{content}}"

// promptTokens are the placeholders renderPrompt expands. Any token missing from
// vars renders empty, so a template can name one the step doesn't produce
// (only llm_ai_newsletter fills recently_covered; only the chunked map pass
// fills chunk/chunks).
var promptTokens = []string{"title", "content", "recently_covered", "chunk", "chunks"}

// renderPrompt expands the {{...}} placeholders of a step's prompt template.
// Replacement is single-pass, so document text that happens to contain a token
// is never re-expanded.
func renderPrompt(tmpl string, vars map[string]string) string {
	if !strings.Contains(tmpl, "{{content}}") {
		tmpl += legacyPromptTail
	}
	args := make([]string, 0, len(promptTokens)*2)
	for _, k := range promptTokens {
		args = append(args, "{{"+k+"}}", vars[k])
	}
	return strings.NewReplacer(args...).Replace(tmpl)
}
