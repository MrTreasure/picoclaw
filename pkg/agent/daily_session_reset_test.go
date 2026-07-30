package agent

import (
	"testing"
	"time"

	"github.com/sipeed/picoclaw/pkg/config"
)

func TestDailySessionResetAppliesOnlyToConfiguredChannels(t *testing.T) {
	cfg := config.DailySessionResetConfig{
		Enabled:  true,
		Channels: []string{"weixin"},
	}
	if !dailySessionResetApplies(cfg, "WEIXIN") {
		t.Fatal("expected configured channel to enable daily reset")
	}
	if dailySessionResetApplies(cfg, "telegram") {
		t.Fatal("unexpected reset for an unconfigured channel")
	}
}

func TestDailySessionResetRejectsInvalidAfterHour(t *testing.T) {
	cfg := config.DailySessionResetConfig{
		Enabled:   true,
		Channels:  []string{"weixin"},
		AfterHour: 24,
	}
	if dailySessionResetApplies(cfg, "weixin") {
		t.Fatal("invalid after_hour must disable reset")
	}
}

func TestSameLocalDay(t *testing.T) {
	location := time.FixedZone("UTC+8", 8*60*60)
	beforeMidnight := time.Date(2026, 7, 30, 23, 59, 0, 0, location)
	afterMidnight := beforeMidnight.Add(2 * time.Minute)
	if sameLocalDay(beforeMidnight, afterMidnight) {
		t.Fatal("messages on opposite sides of midnight must be different days")
	}
	if !sameLocalDay(afterMidnight, afterMidnight.Add(time.Hour)) {
		t.Fatal("messages on the same date must share a day")
	}
}
