package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/sipeed/picoclaw/pkg/bus"
	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/providers/protocoltypes"
	"github.com/sipeed/picoclaw/pkg/seahorse"
	"github.com/sipeed/picoclaw/pkg/session"
)

func busyCommandLoop(t *testing.T) (*AgentLoop, *bus.MessageBus) {
	t.Helper()
	cfg := &config.Config{
		Agents: config.AgentsConfig{
			Defaults: config.AgentDefaults{
				Workspace:         t.TempDir(),
				ModelName:         "test-model",
				MaxTokens:         4096,
				MaxToolIterations: 10,
			},
		},
	}
	msgBus := bus.NewMessageBus()
	al := NewAgentLoop(cfg, msgBus, &mockProvider{})
	return al, msgBus
}

// A command sent while a turn is active must never be enqueued as steering,
// because steering messages are injected into the LLM context as user content.
func TestBusyContextCommandRejectedNotSteered(t *testing.T) {
	for _, cmd := range []string{"/compact", "/clear"} {
		t.Run(cmd, func(t *testing.T) {
			al, msgBus := busyCommandLoop(t)
			defer al.Close()
			sessionKey := "pico:busy-session"
			// Simulate an active turn holding the session.
			al.activeTurnStates.Store(sessionKey, &turnState{turnID: "turn-active", phase: TurnPhaseRunning})

			msg := bus.InboundMessage{
				Channel:    "pico",
				ChatID:     "chat-1",
				SessionKey: sessionKey,
				Content:    cmd,
				Context:    bus.NewOutboundContext("pico", "chat-1", ""),
			}

			handled := al.rejectBusyContextCommand(context.Background(), msg, sessionKey)
			if !handled {
				t.Fatalf("%s should be rejected while a turn is active", cmd)
			}
			if depth := al.pendingSteeringCountForScope(sessionKey); depth != 0 {
				t.Fatalf("steering queue depth = %d, want 0 (command must not be steered)", depth)
			}

			select {
			case out := <-msgBus.OutboundChan():
				if !strings.Contains(out.Content, strings.TrimPrefix(cmd, "/")) {
					t.Fatalf("reply = %q, want it to mention %s", out.Content, cmd)
				}
				if !strings.Contains(out.Content, "active turn") {
					t.Fatalf("reply = %q, want an explicit busy message", out.Content)
				}
				if got := out.Context.Raw[metadataKeyOutboundKind]; got != outboundKindFinal {
					t.Fatalf("outbound kind = %q, want final", got)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("expected a user-visible rejection reply")
			}
		})
	}
}

// Exercise the actual Run receive loop: a busy slash command must leave the
// steering queue empty and produce an outbound reply without touching the LLM.
func TestRunBusyContextCommandsNotQueuedAsSteering(t *testing.T) {
	for _, cmd := range []string{"/compact", "/clear"} {
		t.Run(cmd, func(t *testing.T) {
			al, msgBus := busyCommandLoop(t)
			defer al.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runDone := make(chan error, 1)
			go func() { runDone <- al.Run(ctx) }()
			defer func() {
				cancel()
				select {
				case err := <-runDone:
					if err != nil {
						t.Errorf("Run: %v", err)
					}
				case <-time.After(2 * time.Second):
					t.Error("Run did not exit after cancellation")
				}
			}()

			msg := bus.InboundMessage{
				Channel: "pico", ChatID: "chat-1", SenderID: "user-1", Content: cmd,
				Context: bus.NewOutboundContext("pico", "chat-1", ""),
			}
			key, _, ok := al.resolveSteeringTarget(msg)
			if !ok {
				t.Fatal("could not resolve session")
			}
			al.activeTurnStates.Store(key, &turnState{turnID: "turn-active", phase: TurnPhaseRunning})
			if err := msgBus.PublishInbound(ctx, msg); err != nil {
				t.Fatalf("publish inbound: %v", err)
			}
			select {
			case out := <-msgBus.OutboundChan():
				if !strings.Contains(out.Content, "cannot run during an active turn") {
					t.Fatalf("outbound = %q, want busy response", out.Content)
				}
				if n := al.pendingSteeringCountForScope(key); n != 0 {
					t.Fatalf("steering queue depth = %d, want 0", n)
				}
			case <-time.After(4 * time.Second):
				t.Fatal("busy command was not answered")
			}
		})
	}
}

// Ordinary messages must still be steerable while a turn is active.
func TestBusyContextCommandAllowsPlainMessage(t *testing.T) {
	al, _ := busyCommandLoop(t)
	defer al.Close()
	sessionKey := "pico:normal-session"
	if al.rejectBusyContextCommand(context.Background(), bus.InboundMessage{
		Channel: "pico",
		ChatID:  "chat-1",
		Content: "just a follow-up",
	}, sessionKey) {
		t.Fatal("plain messages must not be rejected")
	}
}

// The Seahorse meter must reflect the budget-assembled context, not the raw
// JSONL history, and must not create a conversation just to display usage.
func TestComputeContextUsageUsesAssembledContextForSeahorse(t *testing.T) {
	engine, err := seahorse.NewEngine(seahorse.Config{DBPath: t.TempDir() + "/test.db"}, nil)
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	defer engine.Close()

	mgr := &seahorseContextManager{engine: engine}
	ctx := context.Background()
	sessionKey := "pico:usage-session"

	// Untouched session: read-only lookup must not create a conversation.
	if conv, err := engine.GetRetrieval().Store().GetConversationBySessionKey(ctx, sessionKey); err != nil || conv != nil {
		t.Fatalf("lookup before ingest = (%v, %v), want (nil, nil)", conv, err)
	}

	for i := 0; i < 60; i++ {
		_ = mgr.Ingest(ctx, &IngestRequest{
			SessionKey: sessionKey,
			Message: protocoltypes.Message{
				Role:    "user",
				Content: strings.Repeat("filler text ", 40),
			},
		})
	}

	sessions := session.NewSessionManager(t.TempDir())
	// JSONL has deliberately divergent, much larger content. Seahorse usage
	// must not use it even when JSONL contains a valid session record.
	sessions.AddFullMessage(sessionKey, protocoltypes.Message{Role: "user", Content: strings.Repeat("JSONL ONLY ", 20000)})
	agent := &AgentInstance{
		ContextWindow:         2000,
		MaxTokens:             100,
		SummarizeTokenPercent: 80,
		Sessions:              sessions,
	}
	usage := computeContextUsageWith(agent, mgr, sessionKey)
	if usage == nil {
		t.Fatal("expected non-nil usage")
	}

	assembled, err := engine.Assemble(ctx, sessionKey, seahorseAssembleInput(2000, 100))
	if err != nil {
		t.Fatalf("AssembleForSessionKey: %v", err)
	}
	want := 0
	for _, m := range seahorseToProviderMessages(assembled) {
		want += EstimateMessageTokens(m)
	}
	if usage.HistoryTokens != want {
		t.Fatalf("HistoryTokens = %d, want assembled %d", usage.HistoryTokens, want)
	}
	if usage.UsedTokens != want {
		t.Fatalf("UsedTokens = %d, want assembled %d with no system prompt/tools", usage.UsedTokens, want)
	}
	if usage.HistoryTokens > usage.CompressAtTokens {
		t.Fatalf("assembled tokens %d should fit the budget %d", usage.HistoryTokens, usage.CompressAtTokens)
	}
}

func TestComputeContextUsageDoesNotCreateSeahorseConversation(t *testing.T) {
	engine, err := seahorse.NewEngine(seahorse.Config{DBPath: t.TempDir() + "/test.db"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	key := "pico:untouched"
	sessions := session.NewSessionManager(t.TempDir())
	sessions.AddFullMessage(key, protocoltypes.Message{Role: "user", Content: strings.Repeat("raw JSONL ", 1000)})
	agent := &AgentInstance{Sessions: sessions, ContextWindow: 2000, MaxTokens: 100}
	usage := computeContextUsageWith(agent, &seahorseContextManager{engine: engine}, key)
	if usage == nil || usage.HistoryTokens != 0 {
		t.Fatalf("untouched Seahorse session usage = %+v, want zero history", usage)
	}
	conv, err := engine.GetRetrieval().Store().GetConversationBySessionKey(context.Background(), key)
	if err != nil || conv != nil {
		t.Fatalf("usage lookup created a conversation: (%v, %v)", conv, err)
	}
}

// Non-Seahorse managers keep the session-history behavior.
func TestComputeContextUsageFallsBackForNonSeahorse(t *testing.T) {
	sessions := session.NewSessionManager(t.TempDir())
	key := "pico:legacy-session"
	msg := protocoltypes.Message{Role: "user", Content: "legacy context"}
	sessions.AddFullMessage(key, msg)
	agent := &AgentInstance{Sessions: sessions, ContextWindow: 1000, MaxTokens: 100, SummarizeTokenPercent: 80}
	usage := computeContextUsageWith(agent, nil, key)
	if usage == nil || usage.HistoryTokens != EstimateMessageTokens(msg) {
		t.Fatalf("legacy history tokens = %+v, want %d", usage, EstimateMessageTokens(msg))
	}
}
