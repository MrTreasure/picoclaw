package agent

import (
	"context"

	"github.com/sipeed/picoclaw/pkg/bus"
)

// computeContextUsage estimates current context window consumption for the
// given agent and session. Includes history, system prompt (with dynamic context,
// summary, and skills — mirroring BuildMessages composition), and tool definitions.
// The output reserve (MaxTokens) is not counted as "used" but reduces the
// effective budget, matching isOverContextBudget's compression trigger:
//
//	compress when: history + system + tools + maxTokens > contextWindow
//	equivalent to: history + system + tools > contextWindow - maxTokens
//
// When the active ContextManager is Seahorse, turns do not send the raw JSONL
// history: they send the budget-assembled context, which may contain summaries
// and may have evicted older messages. Counting the JSONL history would then
// report a number that never reaches the model. In that case the assembled
// context is measured instead, using a read-only lookup so merely displaying
// usage does not create a conversation for an untouched session.
//
// Returns nil when the agent or session is unavailable.
func computeContextUsage(agent *AgentInstance, sessionKey string) *bus.ContextUsage {
	return computeContextUsageWith(agent, nil, sessionKey)
}

// computeContextUsageForLoop is computeContextUsage with the AgentLoop's active
// ContextManager, so Seahorse sessions can be measured from the budget-assembled
// context instead of the raw JSONL history.
func computeContextUsageForLoop(al *AgentLoop, agent *AgentInstance, sessionKey string) *bus.ContextUsage {
	var cm ContextManager
	if al != nil {
		cm = al.contextManager
	}
	return computeContextUsageWith(agent, cm, sessionKey)
}

func computeContextUsageWith(agent *AgentInstance, cm ContextManager, sessionKey string) *bus.ContextUsage {
	if agent == nil || agent.Sessions == nil {
		return nil
	}
	contextWindow := agent.ContextWindow
	if contextWindow <= 0 {
		return nil
	}

	// Effective budget = contextWindow minus output reserve (maxTokens)
	effectiveWindow := contextWindow - agent.MaxTokens
	if effectiveWindow < 0 {
		effectiveWindow = contextWindow
	}

	// History tokens. The active ContextManager lives on the AgentLoop, so the
	// caller supplies it (see computeContextUsageForLoop) when available.
	historyTokens := 0
	summary := agent.Sessions.GetSummary(sessionKey)
	if scm, isSeahorse := cm.(*seahorseContextManager); isSeahorse {
		assembled, err := assembleMeterContext(scm, sessionKey, effectiveWindow)
		if err != nil {
			// A failed assembly is unknown, not JSONL: JSONL is not the context
			// Seahorse sends. Do not display a confidently incorrect value.
			return nil
		}
		if assembled != nil {
			summary = assembled.Summary
			for _, m := range assembled.History {
				historyTokens += EstimateMessageTokens(m)
			}
		} else {
			// No Seahorse conversation exists. JSONL may have unrelated raw
			// history, but it is not budget-assembled model context.
			summary = ""
		}
	} else {
		for _, m := range agent.Sessions.GetHistory(sessionKey) {
			historyTokens += EstimateMessageTokens(m)
		}
	}

	// System message tokens: uses EstimateSystemTokens which mirrors
	// the full system message composition in BuildMessages (static prompt,
	// dynamic context, active skills, summary with wrapping prefix).
	systemTokens := 0
	if agent.ContextBuilder != nil {
		// Pass nil for active skills: skills are only injected when the user
		// explicitly activates them via /use, which is rare. Using nil matches
		// the common case and avoids over-counting all installed skills.
		systemTokens = agent.ContextBuilder.EstimateSystemTokens(summary, nil)
	}

	// Tool definition tokens
	toolTokens := 0
	if agent.Tools != nil {
		toolTokens = EstimateToolDefsTokens(agent.Tools.ToProviderDefs())
	}

	// Used = history + system (includes summary) + tools
	usedTokens := historyTokens + systemTokens + toolTokens

	// compressAt = effectiveWindow: aligns with isOverContextBudget's
	// proactive trigger (msgTokens + toolTokens + maxTokens > contextWindow).
	compressAt := effectiveWindow

	// summarizeAt = soft summarization trigger: matches maybeSummarize's
	// threshold (contextWindow * SummarizeTokenPercent / 100).
	//
	// The engine compares this against history-message tokens ONLY (not
	// UsedTokens).  HistoryTokens is exposed alongside UsedTokens so the
	// UI can show both values and avoid user confusion.
	summarizeAt := summarizeContextBudget(agent)

	usedPercent := 0
	if compressAt > 0 {
		usedPercent = usedTokens * 100 / compressAt
	}
	if usedPercent > 100 {
		usedPercent = 100
	}

	return &bus.ContextUsage{
		UsedTokens:        usedTokens,
		TotalTokens:       contextWindow,
		HistoryTokens:     historyTokens,
		CompressAtTokens:  compressAt,
		SummarizeAtTokens: summarizeAt,
		UsedPercent:       usedPercent,
	}
}

// assembleMeterContext assembles the same effective budget used by real turns,
// but checks for an existing conversation before calling Assemble, since
// Engine.Assemble would otherwise create an empty conversation on read.
func assembleMeterContext(cm *seahorseContextManager, sessionKey string, budget int) (*AssembleResponse, error) {
	if cm == nil || cm.engine == nil {
		return nil, nil
	}
	ctx := context.Background()
	conv, err := cm.engine.GetRetrieval().Store().GetConversationBySessionKey(ctx, sessionKey)
	if err != nil || conv == nil {
		return nil, err
	}
	return cm.Assemble(ctx, &AssembleRequest{SessionKey: sessionKey, Budget: budget})
}

// summarizeContextBudget keeps the displayed threshold and the compactor budget
// in sync as the configured window or output reserve changes.
func summarizeContextBudget(agent *AgentInstance) int {
	budget := agent.ContextWindow - agent.MaxTokens
	if budget <= 0 {
		budget = max(1, agent.ContextWindow/2)
	}
	percent := agent.SummarizeTokenPercent
	if percent <= 0 {
		percent = 75
	}
	return min(budget, agent.ContextWindow*min(percent, 100)/100)
}
