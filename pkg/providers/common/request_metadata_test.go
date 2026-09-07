package common

import (
	"context"
	"testing"
)

func TestRequestMetadataContextRoundTrip(t *testing.T) {
	ctx := WithRequestMetadata(context.Background(), RequestMetadata{
		SessionID: "  ses_test  ",
		RequestID: "  req_test  ",
		Client:    "  picoclaw  ",
	})

	metadata, ok := RequestMetadataFromContext(ctx)
	if !ok {
		t.Fatal("RequestMetadataFromContext() ok = false")
	}
	if metadata.SessionID != "ses_test" || metadata.RequestID != "req_test" || metadata.Client != "picoclaw" {
		t.Fatalf("RequestMetadataFromContext() = %#v", metadata)
	}
}

func TestRequestMetadataFromNilContext(t *testing.T) {
	if _, ok := RequestMetadataFromContext(nil); ok {
		t.Fatal("RequestMetadataFromContext(nil) ok = true")
	}
}
