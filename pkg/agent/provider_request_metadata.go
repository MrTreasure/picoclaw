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

func hashedProviderRequestID(prefix, value string) string {
	digest := sha256.Sum256([]byte(value))
	return prefix + hex.EncodeToString(digest[:providerRequestIDHashBytes])
}
