// PicoClaw - Ultra-lightweight personal AI agent

package agent

import (
	"errors"
	"strings"
	"testing"

	"github.com/sipeed/picoclaw/pkg/providers"
)

func TestValidateSplitMarkerResponseRejectsDelimiterLoop(t *testing.T) {
	response := &providers.LLMResponse{
		Content: "A useful opening." + strings.Repeat(responseSplitMarker+"\n", 632),
	}

	got, err := validateSplitMarkerResponse(response, nil, "openai", "deepseek-v4.1-flash")
	if got != nil {
		t.Fatalf("response = %#v, want nil", got)
	}
	var failoverErr *providers.FailoverError
	if !errors.As(err, &failoverErr) {
		t.Fatalf("error = %T %v, want FailoverError", err, err)
	}
	if failoverErr.Reason != providers.FailoverFormat {
		t.Fatalf("reason = %q, want %q", failoverErr.Reason, providers.FailoverFormat)
	}
}

func TestValidateSplitMarkerResponseAllowsNormalMessageSplits(t *testing.T) {
	response := &providers.LLMResponse{
		Content: strings.Join([]string{"one", "two", "three", "four", "five"}, responseSplitMarker),
	}

	got, err := validateSplitMarkerResponse(response, nil, "openai", "model")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != response {
		t.Fatalf("response pointer changed: got %#v, want %#v", got, response)
	}
}

func TestValidateSplitMarkerResponsePreservesProviderError(t *testing.T) {
	wantErr := errors.New("provider unavailable")
	response := &providers.LLMResponse{Content: strings.Repeat(responseSplitMarker, 10)}

	got, err := validateSplitMarkerResponse(response, wantErr, "openai", "model")
	if got != response || !errors.Is(err, wantErr) {
		t.Fatalf("got (%#v, %v), want original response and error", got, err)
	}
}
