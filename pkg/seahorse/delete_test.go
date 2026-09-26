package seahorse

import (
	"context"
	"path/filepath"
	"testing"
)

func TestDeleteSessionRemovesConversationAndSearchRows(t *testing.T) {
	ctx := context.Background()
	e, err := NewEngine(Config{DBPath: filepath.Join(t.TempDir(), "short.db")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	for _, key := range []string{"pico-one", "untouched"} {
		if _, err := e.Ingest(ctx, key, []Message{{Role: "user", Content: "distinct searchable conversation text"}}); err != nil {
			t.Fatal(err)
		}
	}
	conv, err := e.store.GetConversationBySessionKey(ctx, "pico-one")
	if err != nil || conv == nil {
		t.Fatalf("conversation missing: %v", err)
	}
	if err := e.DeleteSession(ctx, "pico-one"); err != nil {
		t.Fatal(err)
	}
	if err := e.DeleteSession(ctx, "pico-one"); err != nil {
		t.Fatal(err)
	}
	oldID := conv.ConversationID
	conv, err = e.store.GetConversationBySessionKey(ctx, "pico-one")
	if err != nil || conv != nil {
		t.Fatalf("conversation remains: %v %v", conv, err)
	}
	other, err := e.store.GetConversationBySessionKey(ctx, "untouched")
	if err != nil || other == nil {
		t.Fatalf("other conversation missing: %v", err)
	}
	for _, table := range []string{"messages", "summaries", "context_items"} {
		var n int
		if err := e.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table+" WHERE conversation_id = ?", oldID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Errorf("%s: %d rows remain", table, n)
		}
	}
}
