package agent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/sipeed/picoclaw/pkg/config"
)

func (al *AgentLoop) maybeResetDailySession(
	ctx context.Context,
	agent *AgentInstance,
	sessionKey, channel string,
	now time.Time,
) error {
	if al == nil || al.cfg == nil || agent == nil || agent.Sessions == nil {
		return nil
	}
	resetCfg := al.cfg.Agents.Defaults.DailySessionReset
	if !dailySessionResetApplies(resetCfg, channel) {
		return nil
	}

	location := time.Local
	if timezone := strings.TrimSpace(resetCfg.Timezone); timezone != "" {
		loaded, err := time.LoadLocation(timezone)
		if err != nil {
			return fmt.Errorf("load timezone %q: %w", timezone, err)
		}
		location = loaded
	}
	localNow := now.In(location)
	if localNow.Hour() < resetCfg.AfterHour {
		return nil
	}

	history := agent.Sessions.GetHistory(sessionKey)
	if len(history) == 0 {
		return nil
	}
	lastCreatedAt := history[len(history)-1].CreatedAt
	if lastCreatedAt == nil || sameLocalDay(lastCreatedAt.In(location), localNow) {
		return nil
	}
	return al.trimSessionToRecentTurns(ctx, agent, sessionKey, al.cfg.Agents.Defaults.SessionMaintenance.RetainRecentTurns)
}

func dailySessionResetApplies(cfg config.DailySessionResetConfig, channel string) bool {
	if !cfg.Enabled || cfg.AfterHour < 0 || cfg.AfterHour > 23 {
		return false
	}
	for _, configured := range cfg.Channels {
		if strings.EqualFold(strings.TrimSpace(configured), strings.TrimSpace(channel)) {
			return true
		}
	}
	return false
}

func sameLocalDay(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}
