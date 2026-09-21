package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"github.com/sipeed/picoclaw/pkg/providers/common"
)

const providerRequestIDHashBytes = 16

func withProviderRequestMetadata(ctx context.Context, ts *turnState) context.Context {
	if ts == nil {
		return ctx
	}

	sessionSeed := ts.agentID + "\x00" + ts.sessionKey
	if ts.parentTurnID != "" {
		// Sub-turn session keys are process-local counters. Include their parent
		// and turn IDs so independently spawned agents never share affinity.
		sessionSeed += "\x00" + ts.parentTurnID + "\x00" + ts.turnID
	}
	sessionID := hashedProviderRequestID("ses_", sessionSeed)
	requestID := hashedProviderRequestID("req_", sessionID+"\x00"+ts.turnID)

	return common.WithRequestMetadata(ctx, common.RequestMetadata{
		SessionID: sessionID,
		RequestID: requestID,
		Client:    "picoclaw",
	})
}

// withSessionProviderRequestMetadata attaches provider request metadata for a
// conversation handled outside of a turn. Session-maintenance compaction is the
// main caller: it runs from the inbound-message entry point, before runTurn
// installs the turn-scoped metadata, so without this its LLM calls go out with
// no session header at all.
//
// The session ID must match the one withProviderRequestMetadata derives for the
// same conversation, otherwise the provider sees one conversation under two
// identities and the cached routing affinity is lost — OpenCode answers
// header-less calls with 400 MissingSessionID.
func withSessionProviderRequestMetadata(ctx context.Context, agentID, sessionKey string) context.Context {
	sessionID := hashedProviderRequestID("ses_", agentID+"\x00"+sessionKey)

	return common.WithRequestMetadata(ctx, common.RequestMetadata{
		SessionID: sessionID,
		RequestID: hashedProviderRequestID("req_", sessionID+"\x00maintenance"),
		Client:    "picoclaw",
	})
}

func hashedProviderRequestID(prefix, value string) string {
	digest := sha256.Sum256([]byte(value))
	return prefix + hex.EncodeToString(digest[:providerRequestIDHashBytes])
}
