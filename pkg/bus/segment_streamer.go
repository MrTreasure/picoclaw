package bus

import "context"

// SegmentStreamer finalizes an intermediate stream segment without ending the turn.
type SegmentStreamer interface {
	FinalizeSegment(context.Context, string) error
}
