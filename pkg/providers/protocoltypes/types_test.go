package protocoltypes

import (
	"encoding/json"
	"testing"
)

// The provider sends the cache accounting as a nested object. It used to be
// dropped on the floor, which made every cache-hit metric downstream read a
// confident 0% rather than "unknown".
func TestUsageInfoParsesCachedTokens(t *testing.T) {
	raw := `{"prompt_tokens":12319,"completion_tokens":3,"total_tokens":12322,
	         "prompt_tokens_details":{"cached_tokens":12288}}`

	var usage UsageInfo
	if err := json.Unmarshal([]byte(raw), &usage); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if usage.PromptTokens != 12319 {
		t.Fatalf("PromptTokens = %d, want 12319", usage.PromptTokens)
	}
	if got := usage.CachedPromptTokens(); got != 12288 {
		t.Fatalf("CachedPromptTokens() = %d, want 12288", got)
	}
}

// Providers that do not cache omit the details object entirely; that must read
// as 0 rather than panicking.
func TestUsageInfoWithoutPromptTokensDetails(t *testing.T) {
	var usage UsageInfo
	if err := json.Unmarshal([]byte(`{"prompt_tokens":10,"completion_tokens":1}`), &usage); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if got := usage.CachedPromptTokens(); got != 0 {
		t.Fatalf("CachedPromptTokens() = %d, want 0", got)
	}
}

// A nil *UsageInfo reaches this helper whenever a response carries no usage
// block at all, so the nil receiver must stay safe.
func TestCachedPromptTokensNilReceiver(t *testing.T) {
	var usage *UsageInfo
	if got := usage.CachedPromptTokens(); got != 0 {
		t.Fatalf("CachedPromptTokens() on nil = %d, want 0", got)
	}
}
