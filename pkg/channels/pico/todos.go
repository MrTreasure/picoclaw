package pico

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/sipeed/picoclaw/pkg/tools"
)

type todoSnapshot struct {
	Items     []tools.PicoTodoItem `json:"items"`
	Revision  int64                `json:"revision"`
	UpdatedAt int64                `json:"updated_at"`
}
type picoTodoStore struct {
	mu  sync.Mutex
	dir string
}

func newPicoTodoStore() *picoTodoStore { return &picoTodoStore{} }
func (c *PicoChannel) SetTodoStorage(dir string) {
	c.todos.mu.Lock()
	defer c.todos.mu.Unlock()
	c.todos.dir = dir
}
func (s *picoTodoStore) path(session string) string {
	hash := sha256.Sum256([]byte(session))
	return filepath.Join(s.dir, hex.EncodeToString(hash[:])+".json")
}
func (s *picoTodoStore) load(session string) (todoSnapshot, error) {
	snap := todoSnapshot{Items: []tools.PicoTodoItem{}}
	if s.dir == "" {
		return snap, errors.New("TODO storage not configured")
	}
	b, err := os.ReadFile(s.path(session))
	if os.IsNotExist(err) {
		return snap, nil
	}
	if err != nil {
		return snap, err
	}
	if err = json.Unmarshal(b, &snap); err != nil {
		return snap, err
	}
	if snap.Items == nil {
		snap.Items = []tools.PicoTodoItem{}
	}
	return snap, nil
}
func (c *PicoChannel) sendTodoSnapshot(pc *picoConn) {
	if c.todos == nil {
		return
	}
	c.todos.mu.Lock()
	snap, err := c.todos.load(pc.sessionID)
	c.todos.mu.Unlock()
	if err != nil {
		_ = pc.writeJSON(newError("todo_unavailable", "TODO snapshot unavailable"))
		return
	}
	msg := newMessage(TypeTodoSnapshot, map[string]any{"items": snap.Items, "revision": snap.Revision, "updated_at": snap.UpdatedAt})
	msg.SessionID = pc.sessionID
	_ = pc.writeJSON(msg)
}

// UpdatePicoTodos verifies the originating socket and uses its server-side session.
// File persistence is serialized; on-wire snapshots/updates can race, so
// consumers must ignore revisions older than their current revision.
func (c *PicoChannel) UpdatePicoTodos(ctx context.Context, chatID, connID, turnID string, items []tools.PicoTodoItem) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if c.todos == nil || c.BaseChannel == nil || !c.IsRunning() || c.ctx == nil || connID == "" || turnID == "" || len(items) > 50 {
		return errors.New("TODO update unavailable")
	}
	for _, item := range items {
		if strings.TrimSpace(item.Content) == "" || len(item.Content) > 500 || strings.TrimSpace(item.Short) == "" || len(item.Short) > 80 || (item.Status != "pending" && item.Status != "in_progress" && item.Status != "completed") {
			return errors.New("invalid TODO item")
		}
	}
	c.connsMu.RLock()
	pc := c.connections[connID]
	if pc == nil || pc.closed.Load() || chatID != "pico:"+pc.sessionID {
		c.connsMu.RUnlock()
		return errors.New("originating connection mismatch")
	}
	session := pc.sessionID
	c.connsMu.RUnlock()
	c.todos.mu.Lock()
	defer c.todos.mu.Unlock()
	if ctx.Err() != nil || pc.closed.Load() || c.ctx.Err() != nil {
		return errors.New("originating turn disconnected")
	}
	snap, err := c.todos.load(session)
	if err != nil {
		return err
	}
	if snap.Revision == int64(^uint64(0)>>1) {
		return errors.New("TODO revision exhausted")
	}
	snap.Revision++
	snap.UpdatedAt = time.Now().UnixMilli()
	snap.Items = append([]tools.PicoTodoItem{}, items...)
	if err = os.MkdirAll(c.todos.dir, 0700); err != nil {
		return err
	}
	b, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(c.todos.dir, ".todo-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err = tmp.Chmod(0600); err == nil {
		_, err = tmp.Write(b)
	}
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(tmp.Name(), c.todos.path(session)); err != nil {
		return err
	}
	msg := newMessage(TypeTodoUpdated, map[string]any{"items": snap.Items, "revision": snap.Revision, "updated_at": snap.UpdatedAt, "turn_id": turnID})
	msg.SessionID = session
	for _, client := range c.sessionConnectionsSnapshot(session) {
		if err := client.writeJSON(msg); err != nil { /* reconnect receives the persisted snapshot */
		}
	}
	return nil
}

var _ tools.PicoTodoBridge = (*PicoChannel)(nil)
