package tools

import (
	"context"
	"strings"
)

// PicoConfirmationBridge is injected from the authenticated Pico channel, not
// supplied by the caller or resolved from an arbitrary chat identifier.
type PicoConfirmationBridge interface {
	ConfirmPico(ctx context.Context, chatID, connID, turnID, prompt string) (bool, error)
}

type picoOriginKey struct{}

// WithPicoOrigin is applied only to the inbound turn's server-recorded connection ID.
func WithPicoOrigin(ctx context.Context, connID string) context.Context {
	return context.WithValue(ctx, picoOriginKey{}, connID)
}

type AskUserConfirmationTool struct{ bridge PicoConfirmationBridge }

func NewAskUserConfirmationTool(bridge PicoConfirmationBridge) *AskUserConfirmationTool {
	return &AskUserConfirmationTool{bridge: bridge}
}
func (*AskUserConfirmationTool) Name() string { return "ask_user_confirmation" }
func (*AskUserConfirmationTool) Description() string {
	return "Ask the user to explicitly accept or reject a specific action in the current Pico chat. Returns only after a response, timeout, cancellation, or disconnection. A confirmation is not authorization for unrelated actions."
}
func (*AskUserConfirmationTool) Parameters() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{"prompt": map[string]any{"type": "string", "description": "Explicitly describe the exact action requiring approval."}}, "required": []string{"prompt"}}
}
func (t *AskUserConfirmationTool) Execute(ctx context.Context, args map[string]any) *ToolResult {
	if ToolChannel(ctx) != "pico" || t.bridge == nil {
		return NewToolResult("Confirmation unavailable: only an active Pico user turn can request approval.")
	}
	prompt, _ := args["prompt"].(string)
	prompt = strings.TrimSpace(prompt)
	connID, _ := ctx.Value(picoOriginKey{}).(string)
	if len(prompt) == 0 || len(prompt) > 4000 || connID == "" || ToolMessageID(ctx) == "" || ToolChatID(ctx) == "" {
		return NewToolResult("Confirmation unavailable: missing prompt or active Pico turn/connection.")
	}
	accepted, err := t.bridge.ConfirmPico(ctx, ToolChatID(ctx), connID, ToolMessageID(ctx), prompt)
	if err != nil {
		return NewToolResult("Not approved: confirmation expired, connection closed, or request canceled.")
	}
	if !accepted {
		return NewToolResult("Rejected by the user. Do not perform the proposed action.")
	}
	return NewToolResult("Accepted by the user for the exact action described in the prompt, in this turn only.")
}
