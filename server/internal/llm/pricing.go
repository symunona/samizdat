package llm

import "strings"

// modelPricing holds input/output cost per million tokens (USD).
// Prices as of 2026-10-06: https://www.anthropic.com/pricing
type modelPricing struct {
	InputPerMTok  float64
	OutputPerMTok float64
	// LongAbove is the prompt size (input tokens) past which the whole call is
	// billed at the Long* rates; 0 = one rate at any length.
	LongAbove         int
	LongInputPerMTok  float64
	LongOutputPerMTok float64
}

var pricingTable = map[string]modelPricing{
	"claude-haiku-5-5": {InputPerMTok: 0.10, OutputPerMTok: 0.50,
		LongAbove: 100_000, LongInputPerMTok: 0.50, LongOutputPerMTok: 2.50},
	"claude-haiku-4-5-20251001": {InputPerMTok: 1.00, OutputPerMTok: 5.00},
	"claude-haiku-4-5":          {InputPerMTok: 1.00, OutputPerMTok: 5.00},
	"claude-sonnet-4-6":         {InputPerMTok: 3.00, OutputPerMTok: 15.00},
	"claude-opus-4-8":           {InputPerMTok: 5.00, OutputPerMTok: 25.00},
	"claude-fable-5":            {InputPerMTok: 10.00, OutputPerMTok: 50.00},
}

// EstimateCost returns the USD cost for an LLM call given model and token counts.
// Returns 0 if the model is unknown (e.g. local/openai-compat).
func EstimateCost(model string, inputTokens, outputTokens int) float64 {
	p, ok := pricingTable[strings.ToLower(model)]
	if !ok {
		return 0
	}
	in, out := p.InputPerMTok, p.OutputPerMTok
	if p.LongAbove > 0 && inputTokens > p.LongAbove {
		in, out = p.LongInputPerMTok, p.LongOutputPerMTok
	}
	return float64(inputTokens)/1_000_000*in + float64(outputTokens)/1_000_000*out
}
