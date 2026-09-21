package agent

import (
	"testing"

	"github.com/sipeed/picoclaw/pkg/config"
)

func TestParseThinkingLevel(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  ThinkingLevel
	}{
		{"off", "off", ThinkingOff},
		{"empty", "", ThinkingOff},
		{"low", "low", ThinkingLow},
		{"medium", "medium", ThinkingMedium},
		{"high", "high", ThinkingHigh},
		{"xhigh", "xhigh", ThinkingXHigh},
		{"adaptive", "adaptive", ThinkingAdaptive},
		{"unknown", "unknown", ThinkingOff},
		// Case-insensitive and whitespace-tolerant
		{"upper_Medium", "Medium", ThinkingMedium},
		{"upper_HIGH", "HIGH", ThinkingHigh},
		{"mixed_Adaptive", "Adaptive", ThinkingAdaptive},
		{"leading_space", " high", ThinkingHigh},
		{"trailing_space", "low ", ThinkingLow},
		{"both_spaces", " medium ", ThinkingMedium},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseThinkingLevel(tt.input); got != tt.want {
				t.Errorf("parseThinkingLevel(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestActiveThinkingSettingsAgentOverrideWinsModelConfig(t *testing.T) {
	agent := &AgentInstance{
		ThinkingLevel:              ThinkingOff,
		ThinkingLevelConfigured:    true,
		ThinkingLevelAgentOverride: true,
	}
	modelCfg := &config.ModelConfig{ThinkingLevel: "medium"}

	got := activeThinkingSettings(agent, modelCfg)
	if !got.configured || got.level != ThinkingOff {
		t.Fatalf("activeThinkingSettings() = %+v, want configured off", got)
	}
}
