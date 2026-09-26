package tools

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type todoBridgeStub struct {
	called int
	items  []PicoTodoItem
	err    error
}

func (s *todoBridgeStub) UpdatePicoTodos(_ context.Context, chat, conn, turn string, items []PicoTodoItem) error {
	if chat != "pico:session" || conn != "origin" || turn != "turn" {
		return errors.New("wrong origin")
	}
	s.called++
	s.items = items
	return s.err
}
func TestUpdateTodoListToolScopeAndValidation(t *testing.T) {
	bridge := &todoBridgeStub{}
	tool := NewUpdateTodoListTool(bridge)
	ctx := WithPicoOrigin(WithToolInboundContext(context.Background(), "pico", "pico:session", "turn", ""), "origin")
	valid := map[string]any{"items": []any{map[string]any{"content": " first ", "short": "first", "status": "in_progress"}}}
	bad := []struct {
		ctx  context.Context
		args map[string]any
	}{
		{WithToolInboundContext(context.Background(), "pico", "pico:session", "turn", ""), valid},
		{WithPicoOrigin(WithToolInboundContext(context.Background(), "telegram", "pico:session", "turn", ""), "origin"), valid},
		{ctx, map[string]any{"items": []any{map[string]any{"content": "first", "short": "first", "status": "invalid"}}}},
		{ctx, map[string]any{"items": []any{map[string]any{"content": "", "short": "first", "status": "pending"}}}},
		{ctx, map[string]any{"items": []any{map[string]any{"content": "first", "status": "pending"}}}},
		{ctx, map[string]any{"items": []any{map[string]any{"content": "first", "short": "", "status": "pending"}}}},
	}
	for _, tc := range bad {
		if !strings.Contains(tool.Execute(tc.ctx, tc.args).ForLLM, "TODO") && !strings.Contains(tool.Execute(tc.ctx, tc.args).ForLLM, "invalid") {
			t.Fatal("invalid request not rejected")
		}
	}
	if bridge.called != 0 {
		t.Fatal("unauthorized mutation")
	}
	if got := tool.Execute(ctx, valid).ForLLM; !strings.Contains(got, "updated") {
		t.Fatal(got)
	}
	if bridge.called != 1 || bridge.items[0].Content != "first" || bridge.items[0].Short != "first" {
		t.Fatalf("bad update: %+v", bridge)
	}
	if got := tool.Execute(ctx, map[string]any{"items": []any{}}).ForLLM; !strings.Contains(got, "updated") || len(bridge.items) != 0 {
		t.Fatal("clear failed")
	}
}
