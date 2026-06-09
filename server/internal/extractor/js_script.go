package extractor

import (
	"context"
	"fmt"
)

// JSScriptAdapter is a stub for future Goja-based JS extraction.
type JSScriptAdapter struct{}

func (a *JSScriptAdapter) Kind() string { return "js_script" }

func (a *JSScriptAdapter) Discover(_ context.Context, _ string, _ ExtractorConfig, _ string) ([]string, error) {
	return nil, fmt.Errorf("js_script adapter not yet implemented")
}
