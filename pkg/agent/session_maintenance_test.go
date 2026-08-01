package agent

import (
	"testing"

	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/providers"
)

func TestSessionMaintenanceApplies(t *testing.T) {
	cfg := config.SessionMaintenanceConfig{Enabled: true, Channels: []string{"weixin"}}
	if !sessionMaintenanceApplies(cfg, "WEIXIN") {
		t.Fatal("expected configured channel to enable session maintenance")
	}
	if sessionMaintenanceApplies(cfg, "telegram") {
		t.Fatal("unexpected maintenance for unconfigured channel")
	}
}

func TestShouldSummarizeAtTurnCount(t *testing.T) {
	if !shouldSummarizeAtTurnCount(40, 40) || !shouldSummarizeAtTurnCount(40, 80) {
		t.Fatal("expected summarization at configured turn multiples")
	}
	if shouldSummarizeAtTurnCount(40, 41) || shouldSummarizeAtTurnCount(0, 40) {
		t.Fatal("unexpected summarization outside configured turn multiples")
	}
}

func TestRecentHistoryByUserTurns(t *testing.T) {
	history := []providers.Message{
		{Role: "system", Content: "system"},
		{Role: "user", Content: "u1"},
		{Role: "assistant", Content: "a1"},
		{Role: "tool", Content: "t1"},
		{Role: "user", Content: "u2"},
		{Role: "assistant", Content: "a2"},
		{Role: "user", Content: "u3"},
		{Role: "assistant", Content: "a3"},
	}

	if got := countUserTurns(history); got != 3 {
		t.Fatalf("countUserTurns() = %d, want 3", got)
	}
	recent := recentHistoryByUserTurns(history, 2)
	if len(recent) != 4 || recent[0].Content != "u2" || recent[3].Content != "a3" {
		t.Fatalf("unexpected retained history: %#v", recent)
	}
}
