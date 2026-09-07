package agent

import (
	"context"
	"testing"

	"github.com/sipeed/picoclaw/pkg/providers/common"
)

func TestWithProviderRequestMetadataStableForConversation(t *testing.T) {
	first := &turnState{agentID: "main", sessionKey: "chat-1", turnID: "turn-1"}
	second := &turnState{agentID: "main", sessionKey: "chat-1", turnID: "turn-2"}

	firstMetadata := requestMetadataForTest(t, withProviderRequestMetadata(context.Background(), first))
	secondMetadata := requestMetadataForTest(t, withProviderRequestMetadata(context.Background(), second))

	if firstMetadata.SessionID != secondMetadata.SessionID {
		t.Fatalf("session IDs differ: %q != %q", firstMetadata.SessionID, secondMetadata.SessionID)
	}
	if firstMetadata.RequestID == secondMetadata.RequestID {
		t.Fatalf("request IDs unexpectedly match: %q", firstMetadata.RequestID)
	}
}

func TestWithProviderRequestMetadataSeparatesConversationsAndSubTurns(t *testing.T) {
	root := requestMetadataForTest(t, withProviderRequestMetadata(context.Background(), &turnState{
		agentID: "main", sessionKey: "chat-1", turnID: "turn-1",
	}))
	other := requestMetadataForTest(t, withProviderRequestMetadata(context.Background(), &turnState{
		agentID: "main", sessionKey: "chat-2", turnID: "turn-2",
	}))
	child := requestMetadataForTest(t, withProviderRequestMetadata(context.Background(), &turnState{
		agentID: "main", sessionKey: "subturn-1", turnID: "subturn-1", parentTurnID: "turn-1",
	}))

	if root.SessionID == other.SessionID || root.SessionID == child.SessionID || other.SessionID == child.SessionID {
		t.Fatalf("session IDs are not isolated: root=%q other=%q child=%q",
			root.SessionID, other.SessionID, child.SessionID)
	}
}

func requestMetadataForTest(t *testing.T, ctx context.Context) common.RequestMetadata {
	t.Helper()
	metadata, ok := common.RequestMetadataFromContext(ctx)
	if !ok {
		t.Fatal("request metadata missing from context")
	}
	return metadata
}
