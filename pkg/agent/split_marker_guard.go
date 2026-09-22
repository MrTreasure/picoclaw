// PicoClaw - Ultra-lightweight personal AI agent

package agent

import (
	"fmt"
	"strings"

	"github.com/sipeed/picoclaw/pkg/channels"
	"github.com/sipeed/picoclaw/pkg/logger"
	"github.com/sipeed/picoclaw/pkg/providers"
)

const responseSplitMarker = channels.MessageSplitMarker

func sanitizeSplitMarkerContentForChannel(content, channel string, enabled bool) string {
	if content == "" || channels.SplitMarkerEnabledForChannel(enabled, channel) ||
		!strings.Contains(content, responseSplitMarker) {
		return stripTrailingSplitMarkerPrefix(content, channel, enabled)
	}
	return stripTrailingSplitMarkerPrefix(channels.StripSplitMarkers(content), channel, enabled)
}

func stripTrailingSplitMarkerPrefix(content, channel string, enabled bool) string {
	if channels.SplitMarkerEnabledForChannel(enabled, channel) {
		return content
	}
	for length := len(responseSplitMarker) - 1; length > 0; length-- {
		if strings.HasSuffix(content, responseSplitMarker[:length]) {
			return strings.TrimSuffix(content, responseSplitMarker[:length])
		}
	}
	return content
}

func sanitizeSplitMarkerResponseForChannel(
	response *providers.LLMResponse,
	channel string,
	enabled bool,
) {
	if response == nil || channels.SplitMarkerEnabledForChannel(enabled, channel) {
		return
	}
	response.Content = sanitizeSplitMarkerContentForChannel(response.Content, channel, enabled)
	response.Reasoning = sanitizeSplitMarkerContentForChannel(response.Reasoning, channel, enabled)
	response.ReasoningContent = sanitizeSplitMarkerContentForChannel(
		response.ReasoningContent,
		channel,
		enabled,
	)
}

func sanitizeSplitMarkerMessagesForChannel(
	messages []providers.Message,
	channel string,
	enabled bool,
) []providers.Message {
	if channels.SplitMarkerEnabledForChannel(enabled, channel) || len(messages) == 0 {
		return messages
	}
	cleaned := append([]providers.Message(nil), messages...)
	for index := range cleaned {
		if cleaned[index].Role != "assistant" {
			continue
		}
		cleaned[index].Content = sanitizeSplitMarkerContentForChannel(
			cleaned[index].Content,
			channel,
			enabled,
		)
		cleaned[index].ReasoningContent = sanitizeSplitMarkerContentForChannel(
			cleaned[index].ReasoningContent,
			channel,
			enabled,
		)
	}
	return cleaned
}

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
