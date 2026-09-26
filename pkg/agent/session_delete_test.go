package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/sipeed/picoclaw/pkg/bus"
	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/memory"
	"github.com/sipeed/picoclaw/pkg/seahorse"
	"github.com/sipeed/picoclaw/pkg/session"
)

func TestMatchesVisibleSessionNeverMatchesCron(t *testing.T) {
	scope, _ := json.Marshal(session.SessionScope{Channel: "pico", Values: map[string]string{"chat": "pico:target"}})
	for _, tc := range []struct {
		meta memory.SessionMeta
		id   string
		want bool
	}{
		{memory.SessionMeta{Key: "sk_v1_abc", Scope: scope}, "target", true},
		{memory.SessionMeta{Key: "sk_v1_legacy"}, "sk_v1_legacy", true},
		{memory.SessionMeta{Key: "sk_v1_legacy", Scope: json.RawMessage(`{"channel":"cron"}`)}, "sk_v1_legacy", false},
		{memory.SessionMeta{Key: "sk_v1_abc", Scope: scope}, "different", false},
		{memory.SessionMeta{Key: "agent:cron-abc", Scope: scope}, "target", false},
		{memory.SessionMeta{Key: "agent:cron-abc", Scope: json.RawMessage(`{"channel":"weixin"}`)}, "weixin:agent:cron-abc", false},
		{memory.SessionMeta{Key: "agent:main:pico:direct:pico:target", Scope: json.RawMessage(`{"channel":"cron"}`)}, "target", false},
		{memory.SessionMeta{Key: "agent:main:pico:direct:pico:target"}, "target", true},
	} {
		if got := matchesVisibleSession(tc.meta, tc.id); got != tc.want {
			t.Errorf("%q %q got %v want %v", tc.meta.Key, tc.id, got, tc.want)
		}
	}
}

func TestDeleteVisibleSessionPicoAndSeahorseNoCronCollateral(t *testing.T) {
	workspace := t.TempDir()
	cfg := &config.Config{Agents: config.AgentsConfig{Defaults: config.AgentDefaults{Workspace: workspace, ModelName: "test-model", MaxTokens: 4096, MaxToolIterations: 3, ContextManager: "seahorse"}, List: []config.AgentConfig{{ID: "main", Default: true}, {ID: "pico-stream", Workspace: workspace}}}}
	al := NewAgentLoop(cfg, bus.NewMessageBus(), &seahorseTestProvider{})
	defer al.Close()
	store, ok := al.registry.GetDefaultAgent().Sessions.(*session.JSONLBackend)
	if !ok {
		t.Fatal("expected JSONL session backend")
	}
	scope, _ := json.Marshal(session.SessionScope{Version: 1, AgentID: "pico-stream", Channel: "pico", Values: map[string]string{"chat": "direct:pico:delete-me"}})
	for _, entry := range []struct {
		key   string
		scope json.RawMessage
	}{{"pico_20260926t111111111_main", scope}, {"agent:cron-keep", scope}} {
		store.AddMessage(entry.key, "user", "private data")
		if err := store.Save(entry.key); err != nil {
			t.Fatal(err)
		}
		underlying, err := memory.NewJSONLStore(filepath.Join(workspace, "sessions"))
		if err != nil {
			t.Fatal(err)
		}
		if err := underlying.UpsertSessionMeta(context.Background(), entry.key, entry.scope, nil); err != nil {
			t.Fatal(err)
		}
		if err := underlying.Close(); err != nil {
			t.Fatal(err)
		}
		mgr := al.contextManager.(*seahorseContextManager)
		if _, err := mgr.engine.Ingest(context.Background(), entry.key, []seahorse.Message{{Role: "user", Content: "private searchable data"}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := al.DeleteVisibleSession(context.Background(), "delete-me"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		key    string
		exists bool
	}{{"pico_20260926t111111111_main", false}, {"agent:cron-keep", true}} {
		path := filepath.Join(workspace, "sessions", sessionFilename(tc.key)+".meta.json")
		_, statErr := os.Stat(path)
		if (statErr == nil) != tc.exists {
			t.Errorf("%s: meta existence=%v want %v", tc.key, statErr == nil, tc.exists)
		}
		conv, err := al.contextManager.(*seahorseContextManager).engine.GetRetrieval().Store().GetConversationBySessionKey(context.Background(), tc.key)
		if err != nil || (conv != nil) != tc.exists {
			t.Errorf("%s: Seahorse=%v err=%v", tc.key, conv, err)
		}
	}
}

func TestDeleteVisibleSessionRejectsActiveTurnWithoutDataLoss(t *testing.T) {
	workspace := t.TempDir()
	cfg := &config.Config{Agents: config.AgentsConfig{Defaults: config.AgentDefaults{Workspace: workspace, ModelName: "test-model", MaxTokens: 4096, MaxToolIterations: 3, ContextManager: "seahorse"}}}
	al := NewAgentLoop(cfg, bus.NewMessageBus(), &seahorseTestProvider{})
	defer al.Close()
	key := "pico_20260926t111111111_main"
	store := al.registry.GetDefaultAgent().Sessions.(*session.JSONLBackend)
	store.AddMessage(key, "user", "keep on busy")
	scope, err := json.Marshal(session.SessionScope{Version: 1, AgentID: "main", Channel: "pico", Values: map[string]string{"chat": "direct:pico:busy-test"}})
	if err != nil {
		t.Fatal(err)
	}
	underlying, err := memory.NewJSONLStore(filepath.Join(workspace, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	if err := underlying.UpsertSessionMeta(context.Background(), key, scope, nil); err != nil {
		t.Fatal(err)
	}
	_ = underlying.Close()
	mgr := al.contextManager.(*seahorseContextManager)
	if _, err := mgr.engine.Ingest(context.Background(), key, []seahorse.Message{{Role: "user", Content: "keep searchable"}}); err != nil {
		t.Fatal(err)
	}
	placeholder := &turnState{turnID: "active", phase: TurnPhaseSetup}
	al.activeTurnStates.Store(key, placeholder)
	defer al.activeTurnStates.Delete(key)
	if err := al.DeleteVisibleSession(context.Background(), "busy-test"); !errors.Is(err, ErrSessionDeleteBusy) {
		t.Fatalf("got %v; want busy", err)
	}
	if _, err := os.Stat(filepath.Join(workspace, "sessions", sessionFilename(key)+".jsonl")); err != nil {
		t.Fatalf("active session file lost: %v", err)
	}
	if conv, err := mgr.engine.GetRetrieval().Store().GetConversationBySessionKey(context.Background(), key); err != nil || conv == nil {
		t.Fatalf("active session search lost: %v %v", conv, err)
	}
}

// Pre-scope Pico conversations may have only an opaque key, with no scope or
// aliases. The PWA lists those by filename; gateway deletion must agree.
func TestDeleteVisibleSessionLegacyOpaqueWithoutScope(t *testing.T) {
	workspace := t.TempDir()
	cfg := &config.Config{Agents: config.AgentsConfig{Defaults: config.AgentDefaults{Workspace: workspace, ModelName: "test-model", MaxTokens: 4096, MaxToolIterations: 3, ContextManager: "seahorse"}, List: []config.AgentConfig{{ID: "main", Default: true}, {ID: "pico-stream", Workspace: workspace}}}}
	al := NewAgentLoop(cfg, bus.NewMessageBus(), &seahorseTestProvider{})
	defer al.Close()
	key := session.BuildOpaqueSessionKey("agent:main:pico:direct:pico:old-session")
	store := al.registry.GetDefaultAgent().Sessions.(*session.JSONLBackend)
	store.AddMessage(key, "user", "old conversation")
	for _, suffix := range []string{".meta.json", ".jsonl"} {
		if _, err := os.Stat(filepath.Join(workspace, "sessions", sessionFilename(key)+suffix)); err != nil {
			t.Fatalf("missing fixture %s: %v", suffix, err)
		}
	}
	if err := al.DeleteVisibleSession(context.Background(), key); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{".meta.json", ".jsonl"} {
		if _, err := os.Stat(filepath.Join(workspace, "sessions", sessionFilename(key)+suffix)); !os.IsNotExist(err) {
			t.Errorf("%s remains: %v", suffix, err)
		}
	}
}
