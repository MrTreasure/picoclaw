package common

import (
	"context"
	"strings"
)

// RequestMetadata carries stable conversation identity to HTTP providers
// without adding provider-specific fields to the request body.
type RequestMetadata struct {
	SessionID string
	RequestID string
	Client    string
}

type requestMetadataContextKey struct{}

// WithRequestMetadata attaches provider request metadata to ctx.
func WithRequestMetadata(ctx context.Context, metadata RequestMetadata) context.Context {
	metadata.SessionID = strings.TrimSpace(metadata.SessionID)
	metadata.RequestID = strings.TrimSpace(metadata.RequestID)
	metadata.Client = strings.TrimSpace(metadata.Client)
	return context.WithValue(ctx, requestMetadataContextKey{}, metadata)
}

// RequestMetadataFromContext returns provider request metadata carried by ctx.
func RequestMetadataFromContext(ctx context.Context) (RequestMetadata, bool) {
	if ctx == nil {
		return RequestMetadata{}, false
	}
	metadata, ok := ctx.Value(requestMetadataContextKey{}).(RequestMetadata)
	return metadata, ok
}
