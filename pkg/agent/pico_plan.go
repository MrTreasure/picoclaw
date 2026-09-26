package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/sipeed/picoclaw/pkg/providers"
)

const planDraftInstruction = "Pico Plan Mode draft: Write a concise proposed plan for the user's request. Do not execute any action. No tools are available. Distinguish assumptions and actions requiring approval. Do not claim to have completed work."

// processPicoPlan is reachable only through the server-recorded mode metadata.
// Do not run a normal turn for drafting: that pipeline invokes hooks, records
// session metadata and emits events even when tool definitions are disabled.
func (al *AgentLoop) processPicoPlan(ctx context.Context, agent *AgentInstance, opts processOptions) (string, error) {
	inbound := opts.Dispatch.InboundContext
	if inbound == nil || inbound.Channel != "pico" || inbound.MessageID == "" || inbound.ChatID == "" || inbound.Raw["conn_id"] == "" || al.planConfirmation == nil {
		return "Plan Mode unavailable: no active originating Pico connection.", nil
	}
	if ctx.Err() != nil {
		return "Plan Mode canceled. No actions were executed.", nil
	}
	original := opts.Dispatch.UserMessage
	if strings.TrimSpace(original) == "" || len(original) > 3500 || len(opts.Dispatch.Media) != 0 {
		return "Plan Mode cannot safely draft this request or attached media. No actions were executed.", nil
	}
	// Isolate drafting from sessions, hooks, streaming, tools, skills, media,
	// follow-ups and providers' native search options. No state is written here.
	response, err := agent.Provider.Chat(ctx, []providers.Message{
		{Role: "system", Content: planDraftInstruction},
		{Role: "user", Content: original},
	}, nil, agent.Model, map[string]any{"native_search": false})
	if err != nil {
		return "Plan draft failed; nothing was approved or executed.", fmt.Errorf("plan draft failed: %w", err)
	}
	if response == nil || len(response.ToolCalls) != 0 {
		return "", errors.New("plan draft provider emitted an unauthorized tool call or empty response")
	}
	plan := strings.TrimSpace(response.Content)
	if plan == "" || len(plan) > 3500 {
		return "Plan draft failed or exceeded approval display limit; nothing was executed.", nil
	}
	// Include the *actual* original request and exact proposed plan in the
	// confirmation, not only an ambiguous reference to an earlier message.
	// The digest lets the user compare the displayed pair without relying on
	// model-produced text for identity or on a mutable session history.
	digest := sha256.Sum256([]byte(original + "\x00" + plan))
	prompt := "Review the ORIGINAL request and proposed plan below. Approval does not authorize unrelated or sensitive actions; those require separate confirmation.\n\nOriginal request:\n" + original + "\n\nProposed plan:\n" + plan + "\n\nRequest/plan SHA-256: " + hex.EncodeToString(digest[:])
	approved, err := al.planConfirmation.ConfirmPico(ctx, inbound.ChatID, inbound.Raw["conn_id"], inbound.MessageID, prompt)
	if err != nil || !approved {
		if err != nil && !errors.Is(err, context.Canceled) {
			return "Plan not approved (confirmation unavailable or expired). No actions were executed.", nil
		}
		return "Plan rejected. No actions were executed.", nil
	}
	// ConfirmPico checks the socket before returning, but it has no atomic
	// handoff to execution: the socket can disconnect immediately afterward.
	// Without a connection-bound execution lease, approval MUST NOT start work.
	// Keep the wire gate and hidden frontend entry in place as well.
	return "Plan approval received, but execution remains disabled until connection-bound handoff is implemented. No actions were executed.", nil
}
