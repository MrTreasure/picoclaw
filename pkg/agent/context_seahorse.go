//go:build !mipsle && !netbsd && !(freebsd && arm)

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	runtimeevents "github.com/sipeed/picoclaw/pkg/events"
	"github.com/sipeed/picoclaw/pkg/logger"
	"github.com/sipeed/picoclaw/pkg/providers"
	"github.com/sipeed/picoclaw/pkg/providers/protocoltypes"
	"github.com/sipeed/picoclaw/pkg/seahorse"
	"github.com/sipeed/picoclaw/pkg/session"
	"github.com/sipeed/picoclaw/pkg/tokenizer"
)

// seahorseContextManager adapts seahorse.Engine to agent.ContextManager.
type seahorseContextManager struct {
	engine   *seahorse.Engine
	sessions session.SessionStore // for startup bootstrap
	al       *AgentLoop           // for resolving the agent that owns a session
}

// newSeahorseContextManager creates a seahorse-backed ContextManager.
func newSeahorseContextManager(_ json.RawMessage, al *AgentLoop) (ContextManager, error) {
	if al == nil {
		return nil, fmt.Errorf("seahorse: AgentLoop is required")
	}

	// Resolve workspace for DB path
	// DB stores session data, so it goes in sessions/ directory
	agent := al.registry.GetDefaultAgent()
	dbPath := agent.Workspace + "/sessions/seahorse.db"

	// Create CompleteFn from provider
	completeFn := providerToCompleteFn(agent.Provider, agent.Model)

	// Create engine
	engine, err := seahorse.NewEngine(seahorse.Config{
		DBPath: dbPath,
	}, completeFn)
	if err != nil {
		return nil, fmt.Errorf("seahorse: create engine: %w", err)
	}

	mgr := &seahorseContextManager{
		engine:   engine,
		sessions: agent.Sessions,
		al:       al,
	}

	// Register seahorse tools with the agent's tool registry
	retrieval := mgr.engine.GetRetrieval()
	// Pass the workspace so short_grep can also reach the daily notes on disk —
	// they are not in the database, so the engine alone cannot see them.
	al.RegisterTool(seahorse.NewGrepTool(retrieval, agent.Workspace))
	al.RegisterTool(seahorse.NewExpandTool(retrieval))

	// Bootstrap all existing sessions at startup
	if agent.Sessions != nil {
		ctx := context.Background()
		for _, sessionKey := range agent.Sessions.ListSessions() {
			mgr.bootstrapSession(ctx, sessionKey)
		}
	}

	return mgr, nil
}

// providerToCompleteFn wraps providers.LLMProvider as a seahorse.CompleteFn.
func providerToCompleteFn(provider providers.LLMProvider, model string) seahorse.CompleteFn {
	return func(ctx context.Context, prompt string, opts seahorse.CompleteOptions) (string, error) {
		resp, err := provider.Chat(
			ctx,
			[]providers.Message{{Role: "user", Content: prompt}},
			nil, // no tools for summarization
			model,
			map[string]any{
				"max_tokens":       opts.MaxTokens,
				"temperature":      opts.Temperature,
				"prompt_cache_key": "seahorse",
			},
		)
		if err != nil {
			return "", err
		}
		return resp.Content, nil
	}
}

// Assemble builds budget-aware context from seahorse SQLite.
func (m *seahorseContextManager) Assemble(ctx context.Context, req *AssembleRequest) (*AssembleResponse, error) {
	if req == nil {
		return nil, fmt.Errorf("seahorse assemble: nil request")
	}

	budget := req.Budget
	if budget <= 0 {
		budget = 100000
	}

	// Reserve space for model response (spec lines 1400-1410)
	effectiveBudget := budget - req.MaxTokens
	if effectiveBudget <= 0 {
		// MaxTokens >= budget is a configuration problem
		// Use 50% as minimum to avoid guaranteed overflow
		logger.WarnCF("agent", "MaxTokens >= budget, using 50% fallback",
			map[string]any{"budget": budget, "max_tokens": req.MaxTokens})
		effectiveBudget = budget / 2
	}

	result, err := m.engine.Assemble(ctx, req.SessionKey, seahorse.AssembleInput{
		Budget: effectiveBudget,
	})
	if err != nil {
		return nil, fmt.Errorf("seahorse assemble: %w", err)
	}

	history := seahorseToProviderMessages(result)

	// Summary is already formatted as XML with system prompt addition by assembler
	return &AssembleResponse{
		History: history,
		Summary: result.Summary,
	}, nil
}

// Compact compresses conversation history via seahorse summarization.
func (m *seahorseContextManager) Compact(ctx context.Context, req *CompactRequest) error {
	if req == nil {
		return nil
	}

	var (
		result  *seahorse.CompactResult
		compact error
	)

	// For retry (LLM overflow), use aggressive CompactUntilUnder to guarantee
	// context shrinks below budget (spec lines ~1410).
	if req.Reason == ContextCompressReasonRetry && req.Budget > 0 {
		result, compact = m.engine.CompactUntilUnder(ctx, req.SessionKey, req.Budget)
	} else {
		result, compact = m.engine.Compact(ctx, req.SessionKey, seahorse.CompactInput{
			Force: req.Reason == ContextCompressReasonRetry ||
				req.Reason == ContextCompressReasonTurnThreshold,
			Budget: &req.Budget,
		})
	}

	m.emitCompactionEvents(req.SessionKey, req.Reason, result, compact)
	return compact
}

// emitCompactionEvents reports a compaction to the event bus.
//
// These events used to be emitted only by the legacy context manager. seahorse
// replaced it without taking the reporting with it, so every downstream
// consumer — the observer, and the dashboard built on it — counted zero
// compressions and zero summaries forever while compaction ran constantly.
// The counts read as "nothing is being compacted", which is the opposite of
// the truth and hides exactly the signal needed to tell whether context
// management is healthy.
func (m *seahorseContextManager) emitCompactionEvents(
	sessionKey string,
	reason ContextCompressReason,
	result *seahorse.CompactResult,
	compactErr error,
) {
	if m.al == nil {
		return
	}
	scope := m.al.newTurnEventScope("", sessionKey, nil)

	payload := ContextCompressPayload{Reason: reason}
	if result != nil {
		payload.SummaryCount = len(result.SummariesCreated)
		payload.TokensSaved = result.TokensSaved
		payload.LeafSummaries = result.LeafSummaries
		payload.CondensedSummaries = result.CondensedSummaries
	}
	if compactErr != nil {
		payload.Error = compactErr.Error()
	}
	m.al.emitEvent(
		runtimeevents.KindAgentContextCompress,
		scope.meta(0, "compact", "turn.context.compress"),
		payload,
	)

	// Only report a summarisation when summaries were actually produced;
	// emitting one per compaction attempt would inflate the count.
	if result != nil && len(result.SummariesCreated) > 0 {
		m.al.emitEvent(
			runtimeevents.KindAgentSessionSummarize,
			scope.meta(0, "compact", "turn.session.summarize"),
			SessionSummarizePayload{SummariesCreated: len(result.SummariesCreated)},
		)
	}
}

// Ingest records a message into seahorse SQLite.
// All existing sessions are bootstrapped at startup, so this only ingests new messages.
func (m *seahorseContextManager) Ingest(ctx context.Context, req *IngestRequest) error {
	if req == nil {
		return nil
	}

	msg := providerToSeahorseMessage(req.Message)
	_, err := m.engine.Ingest(ctx, req.SessionKey, []seahorse.Message{msg})
	return err
}

func (m *seahorseContextManager) ActiveWindowState(ctx context.Context, sessionKey string) (int, int, error) {
	return m.engine.ActiveWindowState(ctx, sessionKey)
}

func (m *seahorseContextManager) RotateActiveWindow(ctx context.Context, sessionKey string, retainTurns int) error {
	return m.engine.RotateActiveWindow(ctx, sessionKey, retainTurns)
}

func (m *seahorseContextManager) MarkActiveWindowSummarized(ctx context.Context, sessionKey string, turn int) error {
	return m.engine.MarkActiveWindowSummarized(ctx, sessionKey, turn)
}

// Clear removes all stored context for a session (seahorse DB + JSONL).
func (m *seahorseContextManager) Clear(ctx context.Context, sessionKey string) error {
	if err := m.engine.ClearSession(ctx, sessionKey); err != nil {
		return err
	}
	// The session may belong to a routed (non-default) agent whose JSONL
	// store differs from the bootstrap store, so clear the owner's store.
	sessions := m.sessions
	if m.al != nil {
		if agent := m.al.agentForSession(sessionKey); agent != nil && agent.Sessions != nil {
			sessions = agent.Sessions
		}
	}
	if sessions != nil {
		sessions.SetHistory(sessionKey, []providers.Message{})
		sessions.SetSummary(sessionKey, "")
		return sessions.Save(sessionKey)
	}
	return nil
}

// bootstrapSession reconciles JSONL session history into seahorse SQLite.
func (m *seahorseContextManager) bootstrapSession(ctx context.Context, sessionKey string) {
	if m.sessions == nil {
		return
	}

	history := m.sessions.GetHistory(sessionKey)
	if len(history) == 0 {
		return
	}

	// Convert provider messages to seahorse messages
	msgs := make([]seahorse.Message, len(history))
	for i, h := range history {
		msgs[i] = providerToSeahorseMessage(h)
	}

	if err := m.engine.Bootstrap(ctx, sessionKey, msgs); err != nil {
		logger.WarnCF("seahorse", "bootstrap", map[string]any{
			"session": sessionKey,
			"error":   err.Error(),
		})
	}
}

// providerToSeahorseMessage converts a providers.Message to a seahorse.Message.
func providerToSeahorseMessage(msg protocoltypes.Message) seahorse.Message {
	result := seahorse.Message{
		Role:             msg.Role,
		Content:          msg.Content,
		ModelName:        msg.ModelName,
		ReasoningContent: msg.ReasoningContent,
		TokenCount:       tokenizer.EstimateMessageTokens(msg),
		CreatedAt:        normalizeSeahorseMessageCreatedAt(msg.CreatedAt),
	}

	// Convert ToolCalls → MessageParts
	for _, tc := range msg.ToolCalls {
		part := seahorse.MessagePart{
			Type:       "tool_use",
			Name:       tc.Function.Name,
			Arguments:  tc.Function.Arguments,
			ToolCallID: tc.ID,
		}
		result.Parts = append(result.Parts, part)
	}

	// Convert tool result
	if msg.ToolCallID != "" {
		part := seahorse.MessagePart{
			Type:       "tool_result",
			ToolCallID: msg.ToolCallID,
			Text:       msg.Content,
		}
		result.Parts = append(result.Parts, part)
	}

	// Convert media attachments
	for _, mediaURI := range msg.Media {
		part := seahorse.MessagePart{
			Type:     "media",
			MediaURI: mediaURI,
		}
		result.Parts = append(result.Parts, part)
	}

	return result
}

func normalizeSeahorseMessageCreatedAt(createdAt *time.Time) time.Time {
	if createdAt == nil || createdAt.IsZero() {
		return time.Time{}
	}
	return createdAt.UTC().Truncate(time.Second)
}

// seahorseToProviderMessages converts a seahorse.AssembleResult to []providers.Message.
func seahorseToProviderMessages(result *seahorse.AssembleResult) []protocoltypes.Message {
	messages := make([]protocoltypes.Message, 0, len(result.Messages))

	// Convert assembled messages (which already include summary XML messages)
	for _, msg := range result.Messages {
		pm := protocoltypes.Message{
			Role:             msg.Role,
			Content:          msg.Content,
			ModelName:        msg.ModelName,
			ReasoningContent: msg.ReasoningContent,
		}

		// Reconstruct ToolCalls from parts
		for _, part := range msg.Parts {
			if part.Type == "tool_use" {
				pm.ToolCalls = append(pm.ToolCalls, protocoltypes.ToolCall{
					ID:   part.ToolCallID,
					Type: "function", // Required by OpenAI-compatible APIs (GLM, etc.)
					Function: &protocoltypes.FunctionCall{
						Name:      part.Name,
						Arguments: part.Arguments,
					},
				})
			}
			if part.Type == "tool_result" {
				pm.ToolCallID = part.ToolCallID
				if pm.Content == "" && part.Text != "" {
					pm.Content = part.Text
				}
			}
			if part.Type == "media" && part.MediaURI != "" {
				pm.Media = append(pm.Media, part.MediaURI)
			}
		}

		messages = append(messages, pm)
	}

	return messages
}

func init() {
	if err := RegisterContextManager("seahorse", newSeahorseContextManager); err != nil {
		panic(fmt.Sprintf("register seahorse context manager: %v", err))
	}
}
