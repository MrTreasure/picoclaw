//go:build !mipsle && !netbsd && !(freebsd && arm)

package agent

import (
	"context"
	"testing"
	"time"

	runtimeevents "github.com/sipeed/picoclaw/pkg/events"
	"github.com/sipeed/picoclaw/pkg/seahorse"
)

// newCompactionEventCollector wires an AgentLoop to a live bus and returns a channel of
// the given kind. Mirrors the pattern in eventbus_test.go.
func newCompactionEventCollector(t *testing.T, kind runtimeevents.Kind) (*AgentLoop, <-chan runtimeevents.Event) {
	t.Helper()
	bus := runtimeevents.NewBus()
	t.Cleanup(func() { _ = bus.Close() })

	al := &AgentLoop{runtimeEvents: bus}
	sub, ch, err := al.RuntimeEvents().
		OfKind(kind).
		SubscribeChan(context.Background(), runtimeevents.SubscribeOptions{Name: "test", Buffer: 4})
	if err != nil {
		t.Fatalf("SubscribeChan(%s) failed: %v", kind, err)
	}
	t.Cleanup(func() { _ = sub.Close() })
	return al, ch
}

func recvEvent(t *testing.T, ch <-chan runtimeevents.Event, what string) runtimeevents.Event {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(2 * time.Second):
		t.Fatalf("no %s event was emitted", what)
		return runtimeevents.Event{}
	}
}

// The seahorse context manager replaced the legacy one without inheriting its
// reporting. Compaction ran constantly while every downstream consumer counted
// zero — which reads as "nothing is being compacted", the opposite of the
// truth.
func TestSeahorseCompactEmitsCompressEvent(t *testing.T) {
	al, ch := newCompactionEventCollector(t, runtimeevents.KindAgentContextCompress)

	m := &seahorseContextManager{al: al}
	m.emitCompactionEvents("session-1", ContextCompressReasonProactive, &seahorse.CompactResult{
		SummariesCreated:   []string{"s1", "s2"},
		TokensSaved:        1234,
		LeafSummaries:      2,
		CondensedSummaries: 1,
	}, nil)

	payload, ok := recvEvent(t, ch, "compress").Payload.(ContextCompressPayload)
	if !ok {
		t.Fatalf("payload type = %T, want ContextCompressPayload", payload)
	}
	if payload.Reason != ContextCompressReasonProactive {
		t.Fatalf("Reason = %q, want %q", payload.Reason, ContextCompressReasonProactive)
	}
	if payload.SummaryCount != 2 {
		t.Fatalf("SummaryCount = %d, want 2", payload.SummaryCount)
	}
	if payload.TokensSaved != 1234 {
		t.Fatalf("TokensSaved = %d, want 1234", payload.TokensSaved)
	}
}

func TestSeahorseCompactEmitsSummarizeEventWhenSummariesCreated(t *testing.T) {
	al, ch := newCompactionEventCollector(t, runtimeevents.KindAgentSessionSummarize)

	m := &seahorseContextManager{al: al}
	m.emitCompactionEvents("session-1", ContextCompressReasonTurnThreshold, &seahorse.CompactResult{
		SummariesCreated: []string{"s1", "s2", "s3"},
	}, nil)

	payload, ok := recvEvent(t, ch, "summarize").Payload.(SessionSummarizePayload)
	if !ok {
		t.Fatalf("payload type = %T, want SessionSummarizePayload", payload)
	}
	if payload.SummariesCreated != 3 {
		t.Fatalf("SummariesCreated = %d, want 3", payload.SummariesCreated)
	}
}

// A compaction that produced no summaries must not inflate the summary count —
// otherwise the dashboard's "summaries" metric drifts away from reality.
func TestSeahorseCompactSkipsSummarizeEventWhenNothingCreated(t *testing.T) {
	al, ch := newCompactionEventCollector(t, runtimeevents.KindAgentSessionSummarize)

	m := &seahorseContextManager{al: al}
	m.emitCompactionEvents("session-1", ContextCompressReasonProactive, &seahorse.CompactResult{
		TokensSaved: 10,
	}, nil)

	select {
	case ev := <-ch:
		t.Fatalf("unexpected summarize event: %+v", ev.Payload)
	case <-time.After(300 * time.Millisecond):
	}
}

// A failed compaction still has to be visible, otherwise a session that cannot
// compress looks identical to one that never needed to.
func TestSeahorseCompactReportsFailure(t *testing.T) {
	al, ch := newCompactionEventCollector(t, runtimeevents.KindAgentContextCompress)

	m := &seahorseContextManager{al: al}
	m.emitCompactionEvents("session-1", ContextCompressReasonProactive, nil, context.DeadlineExceeded)

	payload, ok := recvEvent(t, ch, "compress").Payload.(ContextCompressPayload)
	if !ok {
		t.Fatalf("payload type = %T, want ContextCompressPayload", payload)
	}
	if payload.Error == "" {
		t.Fatal("Error should carry the compaction failure")
	}
}
