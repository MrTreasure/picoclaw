package agent

import (
	"context"
	"testing"

	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/providers"
)

// recordingContextManager captures the context handed to Compact so tests can
// inspect what the provider would have received.
type recordingContextManager struct {
	turnCount       int
	lastSummaryTurn int
	rotateCalls     int
	compactCtx      context.Context
	compactRequests []*CompactRequest
}

func (r *recordingContextManager) Assemble(context.Context, *AssembleRequest) (*AssembleResponse, error) {
	return &AssembleResponse{}, nil
}

func (r *recordingContextManager) Compact(ctx context.Context, req *CompactRequest) error {
	r.compactCtx = ctx
	r.compactRequests = append(r.compactRequests, req)
	return nil
}

func (r *recordingContextManager) Ingest(context.Context, *IngestRequest) error { return nil }

func (r *recordingContextManager) Clear(context.Context, string) error { return nil }

func (r *recordingContextManager) ActiveWindowState(context.Context, string) (int, int, error) {
	return r.turnCount, r.lastSummaryTurn, nil
}

func (r *recordingContextManager) RotateActiveWindow(context.Context, string, int) error {
	r.rotateCalls++
	return nil
}

func (r *recordingContextManager) MarkActiveWindowSummarized(context.Context, string, int) error {
	return nil
}

// Maintenance compaction runs from the inbound-message entry point, before
// runTurn installs the turn-scoped metadata. The context it hands to Compact
// must still identify the conversation, or OpenCode answers the header-less
// call with 400 MissingSessionID and the compaction silently never happens.
func TestMaybeMaintainSessionAttachesProviderMetadata(t *testing.T) {
	al, agent, cleanup := newTurnCoordTestLoop(t, &simpleConvProvider{})
	defer cleanup()

	cm := &recordingContextManager{turnCount: 40}
	al.contextManager = cm
	al.cfg.Agents.Defaults.SessionMaintenance = config.SessionMaintenanceConfig{
		Enabled:             true,
		Channels:            []string{"weixin"},
		SummarizeEveryTurns: 40,
	}

	if err := al.maybeMaintainSession(context.Background(), agent, "chat-1", "weixin"); err != nil {
		t.Fatalf("maybeMaintainSession() error = %v", err)
	}
	if len(cm.compactRequests) == 0 {
		t.Fatal("expected maintenance to invoke Compact")
	}
	if cm.compactCtx == nil {
		t.Fatal("Compact received a nil context")
	}

	maintenance := requestMetadataForTest(t, cm.compactCtx)
	turn := requestMetadataForTest(t, withProviderRequestMetadata(context.Background(), &turnState{
		agentID: agent.ID, sessionKey: "chat-1", turnID: "turn-1",
	}))

	if maintenance.SessionID == "" {
		t.Fatal("maintenance compaction context carried an empty session ID")
	}
	if maintenance.SessionID != turn.SessionID {
		t.Fatalf("maintenance session ID %q does not match the turn session ID %q",
			maintenance.SessionID, turn.SessionID)
	}
}

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
