package tools

import (
	"context"
	"strings"
)

// PicoTodoBridge is implemented by the authenticated Pico channel. The agent
// cannot choose a session identifier in tool arguments.
type PicoTodoBridge interface {
	UpdatePicoTodos(context.Context, string, string, string, []PicoTodoItem) error
}

type PicoTodoItem struct {
	Content string `json:"content"`
	Short   string `json:"short,omitempty"`
	Status  string `json:"status"`
}

type UpdateTodoListTool struct{ bridge PicoTodoBridge }

func NewUpdateTodoListTool(bridge PicoTodoBridge) *UpdateTodoListTool {
	return &UpdateTodoListTool{bridge: bridge}
}
func (*UpdateTodoListTool) Name() string { return "update_todo_list" }
func (*UpdateTodoListTool) Description() string {
	return "Replace the complete TODO list for the current Pico session. Every item needs full content, a distinct concise short label for the progress chip, and pending, in_progress or completed status. Send the full list on each update; an empty list clears it."
}
func (*UpdateTodoListTool) Parameters() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{"items": map[string]any{"type": "array", "description": "Complete replacement TODO list (empty array clears it).", "maxItems": 50, "items": map[string]any{"type": "object", "properties": map[string]any{"content": map[string]any{"type": "string"}, "short": map[string]any{"type": "string", "description": "Brief label for the compact progress chip, distinct from the full content."}, "status": map[string]any{"type": "string", "enum": []string{"pending", "in_progress", "completed"}}}, "required": []string{"content", "short", "status"}, "additionalProperties": false}}}, "required": []string{"items"}}
}
func (t *UpdateTodoListTool) Execute(ctx context.Context, args map[string]any) *ToolResult {
	if t.bridge == nil || ToolChannel(ctx) != "pico" || !strings.HasPrefix(ToolChatID(ctx), "pico:") || ToolMessageID(ctx) == "" || ctx.Err() != nil {
		return ErrorResult("TODO updates require an active Pico user turn")
	}
	connID, _ := ctx.Value(picoOriginKey{}).(string)
	if connID == "" {
		return ErrorResult("TODO updates require the originating Pico connection")
	}
	raw, ok := args["items"].([]any)
	if !ok || len(raw) > 50 {
		return ErrorResult("items must be an array of at most 50 TODOs")
	}
	items := make([]PicoTodoItem, 0, len(raw))
	for _, entry := range raw {
		obj, ok := entry.(map[string]any)
		if !ok || len(obj) != 3 {
			return ErrorResult("each TODO must contain content, short and status")
		}
		content, ok := obj["content"].(string)
		if !ok {
			return ErrorResult("TODO content must be a string")
		}
		content = strings.TrimSpace(content)
		status, ok := obj["status"].(string)
		if !ok || (status != "pending" && status != "in_progress" && status != "completed") || content == "" || len(content) > 500 {
			return ErrorResult("invalid TODO content or status")
		}
		short, ok := obj["short"].(string)
		if !ok || strings.TrimSpace(short) == "" || len(short) > 80 {
			return ErrorResult("TODO short label must be a nonempty string of at most 80 bytes")
		}
		short = strings.TrimSpace(short)
		items = append(items, PicoTodoItem{Content: content, Short: short, Status: status})
	}
	if err := t.bridge.UpdatePicoTodos(ctx, ToolChatID(ctx), connID, ToolMessageID(ctx), items); err != nil {
		return ErrorResult("TODO update failed: " + err.Error())
	}
	return NewToolResult("TODO list updated for this Pico session.")
}
