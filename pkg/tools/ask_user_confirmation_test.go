package tools

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type confirmationBridgeStub struct {
	called   int
	accepted bool
	err      error
}

func (b *confirmationBridgeStub) ConfirmPico(_ context.Context, chatID, connID, turnID, prompt string) (bool, error) {
	b.called++
	if chatID != "pico:session" || connID != "origin" || turnID != "turn" || prompt != "Approve this exact action" {
		return false, errors.New("unexpected scope")
	}
	return b.accepted, b.err
}
func TestAskUserConfirmationScopeAndResult(t *testing.T) {
	bridge := &confirmationBridgeStub{accepted: true}
	tool := NewAskUserConfirmationTool(bridge)
	args := map[string]any{"prompt": "Approve this exact action"}
	ctx := WithPicoOrigin(WithToolInboundContext(context.Background(), "pico", "pico:session", "turn", ""), "origin")
	for _, unauthorized := range []context.Context{
		WithPicoOrigin(WithToolInboundContext(context.Background(), "telegram", "pico:session", "turn", ""), "origin"),
		WithToolInboundContext(context.Background(), "pico", "pico:session", "turn", ""),
		WithPicoOrigin(WithToolInboundContext(context.Background(), "pico", "pico:session", "", ""), "origin"),
	} {
		if strings.Contains(tool.Execute(unauthorized, args).ForLLM, "Accepted") {
			t.Fatal("unauthorized approval")
		}
	}
	if bridge.called != 0 {
		t.Fatal("bridge called without authorization")
	}
	if !strings.Contains(tool.Execute(ctx, args).ForLLM, "Accepted") {
		t.Fatal("explicit approval lost")
	}
	bridge.accepted = false
	if !strings.Contains(tool.Execute(ctx, args).ForLLM, "Rejected") {
		t.Fatal("rejection lost")
	}
	bridge.err = errors.New("disconnected")
	if strings.Contains(tool.Execute(ctx, args).ForLLM, "Accepted") {
		t.Fatal("disconnect approved")
	}
}
