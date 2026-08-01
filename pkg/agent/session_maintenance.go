package agent

import (
	"context"
	"strings"

	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/providers"
)

func (al *AgentLoop) maybeMaintainSession(
	ctx context.Context,
	agent *AgentInstance,
	sessionKey, channel string,
) error {
	if al == nil || al.cfg == nil || agent == nil || agent.Sessions == nil {
		return nil
	}
	maintenance := al.cfg.Agents.Defaults.SessionMaintenance
	if !sessionMaintenanceApplies(maintenance, channel) {
		return nil
	}

	history := agent.Sessions.GetHistory(sessionKey)
	turnCount := countUserTurns(history)
	if maintenance.CleanupAfterTurns > 0 && turnCount >= maintenance.CleanupAfterTurns {
		return al.trimSessionToRecentTurns(ctx, agent, sessionKey, maintenance.RetainRecentTurns)
	}
	if shouldSummarizeAtTurnCount(maintenance.SummarizeEveryTurns, turnCount) {
		return al.contextManager.Compact(ctx, &CompactRequest{
			SessionKey: sessionKey,
			Reason:     ContextCompressReasonTurnThreshold,
			Budget:     agent.ContextWindow,
		})
	}
	return nil
}

func (al *AgentLoop) trimSessionToRecentTurns(
	ctx context.Context,
	agent *AgentInstance,
	sessionKey string,
	retainTurns int,
) error {
	history := agent.Sessions.GetHistory(sessionKey)
	recent := recentHistoryByUserTurns(history, retainTurns)
	if err := al.contextManager.Clear(ctx, sessionKey); err != nil {
		return err
	}
	if len(recent) == 0 {
		return nil
	}

	agent.Sessions.SetHistory(sessionKey, recent)
	if err := agent.Sessions.Save(sessionKey); err != nil {
		return err
	}
	for _, message := range recent {
		if err := al.contextManager.Ingest(ctx, &IngestRequest{
			SessionKey: sessionKey,
			Message:    message,
		}); err != nil {
			return err
		}
	}
	return nil
}

func sessionMaintenanceApplies(cfg config.SessionMaintenanceConfig, channel string) bool {
	if !cfg.Enabled {
		return false
	}
	for _, configured := range cfg.Channels {
		if strings.EqualFold(strings.TrimSpace(configured), strings.TrimSpace(channel)) {
			return true
		}
	}
	return false
}

func countUserTurns(history []providers.Message) int {
	count := 0
	for _, message := range history {
		if strings.EqualFold(strings.TrimSpace(message.Role), "user") {
			count++
		}
	}
	return count
}

func shouldSummarizeAtTurnCount(every, turnCount int) bool {
	return every > 0 && turnCount > 0 && turnCount%every == 0
}

func recentHistoryByUserTurns(history []providers.Message, retainTurns int) []providers.Message {
	if retainTurns <= 0 || len(history) == 0 {
		return nil
	}
	seen := 0
	start := 0
	for i := len(history) - 1; i >= 0; i-- {
		if !strings.EqualFold(strings.TrimSpace(history[i].Role), "user") {
			continue
		}
		seen++
		if seen == retainTurns {
			start = i
			break
		}
	}
	if seen < retainTurns {
		start = 0
	}
	return append([]providers.Message(nil), history[start:]...)
}
