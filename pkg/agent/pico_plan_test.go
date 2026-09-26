package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/sipeed/picoclaw/pkg/bus"
	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/providers"
	"github.com/sipeed/picoclaw/pkg/tools"
)

type planProvider struct {
	calls          int
	draftTools     int
	executionTools int
	rogue          bool
}

func (p *planProvider) GetDefaultModel() string { return "test-model" }
func (p *planProvider) Chat(_ context.Context, messages []providers.Message, defs []providers.ToolDefinition, _ string, _ map[string]any) (*providers.LLMResponse, error) {
	p.calls++
	isDraft := len(messages) == 2 && messages[0].Role == "system" && messages[0].Content == planDraftInstruction
	if isDraft {
		p.draftTools = len(defs)
		if p.rogue {
			return &providers.LLMResponse{Content: "rogue", ToolCalls: []providers.ToolCall{{Name: "exec"}}}, nil
		}
		return &providers.LLMResponse{Content: "First, inspect. Then write only after approval."}, nil
	}
	p.executionTools = len(defs)
	return &providers.LLMResponse{Content: "Execution phase reached."}, nil
}

type planBridge struct {
	accepted                 bool
	calls                    int
	chat, conn, turn, prompt string
}

func (b *planBridge) ConfirmPico(_ context.Context, chat, conn, turn, prompt string) (bool, error) {
	b.calls++
	b.chat = chat
	b.conn = conn
	b.turn = turn
	b.prompt = prompt
	return b.accepted, nil
}

type planSideEffectTool struct{ called int }

func (*planSideEffectTool) Name() string               { return "exec" }
func (*planSideEffectTool) Description() string        { return "side effect" }
func (*planSideEffectTool) Parameters() map[string]any { return map[string]any{"type": "object"} }
func (t *planSideEffectTool) Execute(_ context.Context, _ map[string]any) *tools.ToolResult {
	t.called++
	return tools.NewToolResult("executed")
}

func planTestLoop(t *testing.T, rogue, accept bool) (*AgentLoop, *planProvider, *planBridge, *planSideEffectTool) {
	t.Helper()
	cfg := &config.Config{Agents: config.AgentsConfig{Defaults: config.AgentDefaults{Workspace: t.TempDir(), ModelName: "test-model", MaxTokens: 4096, MaxToolIterations: 3}}}
	p := &planProvider{rogue: rogue}
	al := NewAgentLoop(cfg, bus.NewMessageBus(), p)
	b := &planBridge{accepted: accept}
	al.planConfirmation = b
	side := &planSideEffectTool{}
	al.GetRegistry().GetDefaultAgent().Tools.Register(side)
	return al, p, b, side
}
func planTestMessage(mode bool) bus.InboundMessage {
	raw := map[string]string{"conn_id": "socket-1"}
	if mode {
		raw["pico_mode"] = "plan"
	}
	return bus.InboundMessage{Context: bus.InboundContext{Channel: "pico", ChatID: "pico:session", ChatType: "direct", SenderID: "pico-user", MessageID: "turn-1", Raw: raw}, Content: "Perform task"}
}
func TestPicoPlanDeniedHasNoExecution(t *testing.T) {
	al, p, b, side := planTestLoop(t, false, false)
	answer, err := al.processMessage(context.Background(), planTestMessage(true))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(answer, "rejected") || p.calls != 1 || p.draftTools != 0 || b.calls != 1 || side.called != 0 {
		t.Fatalf("answer=%q provider=%+v bridge=%+v side=%+v", answer, p, b, side)
	}
	if b.chat != "pico:session" || b.conn != "socket-1" || b.turn != "turn-1" || !strings.Contains(b.prompt, "First, inspect") || !strings.Contains(b.prompt, "Original request:\nPerform task") || !strings.Contains(b.prompt, "Request/plan SHA-256:") {
		t.Fatalf("wrong confirmation binding: %+v", b)
	}
}
func TestPicoPlanApprovalDoesNotExecuteWithoutConnectionLease(t *testing.T) {
	al, p, b, side := planTestLoop(t, false, true)
	answer, err := al.processMessage(context.Background(), planTestMessage(true))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(answer, "execution remains disabled") || p.calls != 1 || p.draftTools != 0 || b.calls != 1 || side.called != 0 {
		t.Fatalf("answer=%q provider=%+v bridge=%+v", answer, p, b)
	}
}
func TestPicoPlanUnadvertisedToolFailsClosed(t *testing.T) {
	al, p, b, side := planTestLoop(t, true, true)
	_, err := al.processMessage(context.Background(), planTestMessage(true))
	if err == nil || !strings.Contains(err.Error(), "unauthorized tool") || p.calls != 1 || b.calls != 0 || side.called != 0 {
		t.Fatalf("err=%v provider=%+v bridge=%+v side=%+v", err, p, b, side)
	}
}
func TestPicoNormalModeUnaffected(t *testing.T) {
	al, p, b, _ := planTestLoop(t, false, false)
	answer, err := al.processMessage(context.Background(), planTestMessage(false))
	if err != nil {
		t.Fatal(err)
	}
	if answer != "Execution phase reached." || p.calls != 1 || p.executionTools == 0 || b.calls != 0 {
		t.Fatalf("answer=%q provider=%+v bridge=%+v", answer, p, b)
	}
}
func TestPicoPlanWithoutBridgeFailsClosed(t *testing.T) {
	al, p, _, _ := planTestLoop(t, false, false)
	al.planConfirmation = nil
	answer, err := al.processMessage(context.Background(), planTestMessage(true))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(answer, "unavailable") || p.calls != 0 {
		t.Fatalf("answer=%q provider=%+v", answer, p)
	}
}

func TestPicoPlanDraftDoesNotCreateSession(t *testing.T) {
	al, p, _, _ := planTestLoop(t, false, false)
	agent := al.GetRegistry().GetDefaultAgent()
	_, err := al.processMessage(context.Background(), planTestMessage(true))
	if err != nil {
		t.Fatal(err)
	}
	if p.calls != 1 {
		t.Fatalf("draft calls: %d", p.calls)
	}
	// Draft must never create a :plan-draft session or write conversation history.
	for _, key := range []string{"pico:session", "pico:pico:session", "pico:session:plan-draft:turn-1"} {
		if got := agent.Sessions.GetHistory(key); len(got) != 0 {
			t.Fatalf("unexpected draft history at %q: %+v", key, got)
		}
	}
}
func TestPicoPlanMediaFailsClosed(t *testing.T) {
	al, p, b, _ := planTestLoop(t, false, true)
	msg := planTestMessage(true)
	msg.Media = []string{"media://unsafe"}
	answer, err := al.processMessage(context.Background(), msg)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(answer, "cannot safely draft") || p.calls != 0 || b.calls != 0 {
		t.Fatalf("answer=%q calls=%d confirmations=%d", answer, p.calls, b.calls)
	}
}
