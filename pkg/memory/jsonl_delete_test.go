package memory

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestJSONLDeleteSessionOnlyTarget(t *testing.T) {
	dir := t.TempDir()
	store, err := NewJSONLStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"pico:first", "agent:cron-unrelated"} {
		if err := store.AddMessage(context.Background(), key, "user", "hello"); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := store.DeleteSession("pico:first")
	if err != nil || !removed {
		t.Fatalf("delete: %v %v", removed, err)
	}
	removed, err = store.DeleteSession("pico:first")
	if err != nil || removed {
		t.Fatalf("repeat delete: %v %v", removed, err)
	}
	for _, ext := range []string{".jsonl", ".meta.json"} {
		if _, err := os.Stat(filepath.Join(dir, "pico_first"+ext)); !os.IsNotExist(err) {
			t.Errorf("target remains: %v", err)
		}
		if _, err := os.Stat(filepath.Join(dir, "agent_cron-unrelated"+ext)); err != nil {
			t.Errorf("unrelated missing: %v", err)
		}
	}
}
