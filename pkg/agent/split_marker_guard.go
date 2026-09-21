// PicoClaw - Ultra-lightweight personal AI agent

package agent

import (
	"fmt"
	"strings"

	"github.com/sipeed/picoclaw/pkg/logger"
	"github.com/sipeed/picoclaw/pkg/providers"
)

const responseSplitMarker = "<|[SPLIT]|>"

// validateSplitMarkerResponse rejects a characteristic model degeneration in
// which the semantic message delimiter is repeated with no text between most
// occurrences. Treating it as a format failure lets the fallback chain try the
// next candidate and keeps the malformed output out of conversation history.
func validateSplitMarkerResponse(
	response *providers.LLMResponse,
	err error,
	provider string,
	model string,
) (*providers.LLMResponse, error) {
	if err != nil || response == nil || !isDegenerateSplitMarkerOutput(response.Content) {
		return response, err
	}
	logger.WarnCF("agent", "rejecting degenerate split-marker response", map[string]any{
		"provider":     provider,
		"model":        model,
		"marker_count": strings.Count(response.Content, responseSplitMarker),
	})

	return nil, &providers.FailoverError{
		Reason:   providers.FailoverFormat,
		Provider: provider,
		Model:    model,
		Wrapped:  fmt.Errorf("degenerate response: repeated empty %s segments", responseSplitMarker),
	}
}

func isDegenerateSplitMarkerOutput(content string) bool {
	parts := strings.Split(content, responseSplitMarker)
	markerCount := len(parts) - 1
	if markerCount < 4 {
		return false
	}

	emptyParts := 0
	for _, part := range parts {
		if strings.TrimSpace(part) == "" {
			emptyParts++
		}
	}

	// Legitimate multi-message output has text on both sides of every marker.
	// A majority of empty segments indicates a delimiter token loop.
	return emptyParts*2 > len(parts)
}
