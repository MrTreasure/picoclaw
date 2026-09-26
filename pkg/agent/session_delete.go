package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/sipeed/picoclaw/pkg/memory"
	"github.com/sipeed/picoclaw/pkg/session"
)

var ErrSessionDeleteBusy = errors.New("session has an active turn")
var ErrSessionDeleteNotFound = errors.New("session not found")

// DeleteVisibleSession operates only on explicitly identified Pico/Weixin
// sessions. It never treats a general opaque key as a user-visible session ID.
func (al *AgentLoop) DeleteVisibleSession(ctx context.Context, id string) error {
	if id == "" || strings.ContainsAny(id, "/\\") || id == "." || id == ".." {
		return ErrSessionDeleteNotFound
	}
	al.mu.RLock()
	defer al.mu.RUnlock() // prevent registry/context manager reload during deletion
	mgr, ok := al.contextManager.(*seahorseContextManager)
	if !ok || mgr == nil {
		return fmt.Errorf("permanent deletion requires seahorse context manager")
	}
	if len(al.registry.ListAgentIDs()) == 0 {
		return fmt.Errorf("session registry unavailable")
	}
	owner := al.registry.GetDefaultAgent()
	if owner == nil || owner.Sessions == nil {
		return fmt.Errorf("session store unavailable")
	}
	for _, agentID := range al.registry.ListAgentIDs() {
		member, exists := al.registry.GetAgent(agentID)
		if !exists || member == nil || member.Sessions == nil || member.Workspace != owner.Workspace {
			return fmt.Errorf("multi-workspace or incomplete agent registry unsupported")
		}
	}
	dir := filepath.Join(owner.Workspace, "sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	type target struct {
		key    string
		legacy string
	}
	targets := make([]target, 0)
	seen := make(map[string]bool)
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".meta.json") {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(dir, name))
		if readErr != nil {
			return readErr
		}
		var meta memory.SessionMeta
		if json.Unmarshal(data, &meta) != nil || meta.Key == "" {
			continue
		}
		if sessionFilename(meta.Key) != strings.TrimSuffix(name, ".meta.json") {
			continue
		}
		if !matchesVisibleSession(meta, id) {
			continue
		}
		if !seen[meta.Key] {
			targets = append(targets, target{key: meta.Key})
			seen[meta.Key] = true
		}
	}
	// Only legacy Pico keys with a verified, exact filename can be found without metadata.
	prefix := "agent:main:pico:direct:pico:"
	if !strings.HasPrefix(id, "weixin:") {
		legacy := prefix + id
		name := sessionFilename(legacy)
		if !seen[legacy] {
			// A metadata-backed file with a mismatched scope is NOT an
			// unscoped legacy file. Never bypass the metadata check.
			if _, e := os.Stat(filepath.Join(dir, name+".meta.json")); e == nil {
				// Leave it alone; only a positively matched meta can be removed.
			} else if !os.IsNotExist(e) {
				return e
			} else if _, e := os.Stat(filepath.Join(dir, name+".jsonl")); e == nil {
				targets = append(targets, target{key: legacy})
				seen[legacy] = true
			} else if !os.IsNotExist(e) {
				return e
			}
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || strings.HasSuffix(entry.Name(), ".meta.json") {
				continue
			}
			path := filepath.Join(dir, entry.Name())
			data, e := os.ReadFile(path)
			if e != nil {
				return e
			}
			var legacySession struct {
				Key string `json:"key"`
			}
			if json.Unmarshal(data, &legacySession) == nil && legacySession.Key == legacy && entry.Name() == name+".json" {
				if seen[legacy] {
					for i := range targets {
						if targets[i].key == legacy {
							targets[i].legacy = path
						}
					}
				} else {
					targets = append(targets, target{key: legacy, legacy: path})
					seen[legacy] = true
				}
			}
		}
	}
	if len(targets) == 0 {
		return ErrSessionDeleteNotFound
	}
	// Reserve every key before unlinking any file, including the keys seen by
	// concurrent inbound turns. Placeholder claims reject new turns until done.
	reserved := make(map[string]*turnState, len(targets))
	defer func() {
		for key, marker := range reserved {
			al.releaseSessionTurnState(key, marker)
		}
	}()
	for _, t := range targets {
		marker := &turnState{phase: TurnPhaseSetup, turnID: "__deleting__"}
		if _, loaded := al.activeTurnStates.LoadOrStore(t.key, marker); loaded {
			return ErrSessionDeleteBusy
		}
		reserved[t.key] = marker
	}
	// Confirm every configured agent can synchronize deletion before any
	// Seahorse transaction or file unlink begins.
	for _, agentID := range al.registry.ListAgentIDs() {
		member, _ := al.registry.GetAgent(agentID)
		if _, ok := member.Sessions.(interface{ DeleteSession(string) (bool, error) }); !ok {
			return fmt.Errorf("agent %s cannot synchronize session deletion", agentID)
		}
	}
	for _, t := range targets {
		// Pending steering can outlive a turn and would recreate this session.
		if al.pendingSteeringCountForScope(t.key) > 0 {
			return ErrSessionDeleteBusy
		}
	}
	for _, t := range targets {
		// SQLite first: failed DB transactions leave files intact for retry. If
		// unlinking later fails, report failure rather than claiming atomic success.
		if err := mgr.engine.DeleteSession(ctx, t.key); err != nil {
			return err
		}
		for _, agentID := range al.registry.ListAgentIDs() {
			member, _ := al.registry.GetAgent(agentID)
			deletable := member.Sessions.(interface{ DeleteSession(string) (bool, error) })
			if _, err := deletable.DeleteSession(t.key); err != nil {
				return err
			}
		}
		if t.legacy != "" {
			if err := os.Remove(t.legacy); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return nil
}

func sessionFilename(key string) string {
	return strings.NewReplacer(":", "_", "/", "_", "\\", "_").Replace(key)
}

func matchesVisibleSession(meta memory.SessionMeta, id string) bool {
	// Scheduled task runs may inherit Pico scope metadata but are not chats.
	if strings.HasPrefix(meta.Key, "agent:cron-") {
		return false
	}
	if strings.HasPrefix(id, "weixin:") {
		if meta.Key != strings.TrimPrefix(id, "weixin:") || strings.HasPrefix(meta.Key, "agent:cron-") {
			return false
		}
		var scope session.SessionScope
		return json.Unmarshal(meta.Scope, &scope) == nil && strings.EqualFold(scope.Channel, "weixin")
	}
	// The session list also exposes older opaque sk_v1 keys without scope or
	// aliases. Match those by their exact canonical key, never by chat scope.
	if len(meta.Scope) == 0 && session.IsOpaqueSessionKey(id) && meta.Key == id {
		return true
	}
	legacy := "agent:main:pico:direct:pico:" + id
	if len(meta.Scope) > 0 {
		var scope session.SessionScope
		if json.Unmarshal(meta.Scope, &scope) != nil || !strings.EqualFold(scope.Channel, "pico") {
			return false
		}
	}
	if meta.Key == legacy {
		return true
	}
	for _, alias := range meta.Aliases {
		if alias == legacy {
			return true
		}
	}
	var scope session.SessionScope
	if json.Unmarshal(meta.Scope, &scope) != nil || !strings.EqualFold(scope.Channel, "pico") {
		return false
	}
	for _, v := range []string{scope.Values["sender"], scope.Values["chat"]} {
		if v == "pico:"+id || strings.HasSuffix(v, ":pico:"+id) {
			return true
		}
	}
	return false
}
