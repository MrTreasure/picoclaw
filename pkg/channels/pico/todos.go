package pico

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
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
	if err = c.todos.save(session, snap); err != nil {
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

// save must be called with the store lock held. Rename makes a successful update
// visible as a complete snapshot, never a partial JSON file.
func (s *picoTodoStore) save(session string, snap todoSnapshot) error {
	if s.dir == "" {
		return errors.New("TODO storage not configured")
	}
	var err error
	if err = os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	b, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, ".todo-*")
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
	if err = os.Rename(tmp.Name(), s.path(session)); err != nil {
		return err
	}
	return nil
}

// handleTodoClear clears only the authenticated socket's own completed list.
// The expected revision is mandatory, preventing stale UI actions from erasing
// an agent update that arrived after the completion dialog was rendered.
func (c *PicoChannel) handleTodoClear(pc *picoConn, msg PicoMessage) {
	fail := func(code, detail string) {
		_ = pc.writeJSON(newErrorWithPayload(code, detail, map[string]any{"request_id": msg.ID}))
	}
	if msg.ID == "" || len(msg.Payload) != 1 || msg.SessionID != "" {
		fail("invalid_todo_clear", "request id and expected_revision are required; session override is not allowed")
		return
	}
	rev, ok := msg.Payload["expected_revision"].(float64)
	if !ok || math.IsNaN(rev) || rev < 0 || rev > 9007199254740991 || math.Trunc(rev) != rev {
		fail("invalid_todo_clear", "expected_revision must be a nonnegative safe integer")
		return
	}
	if c.todos == nil || c.ctx == nil || c.ctx.Err() != nil || !c.IsRunning() || pc.closed.Load() {
		fail("todo_unavailable", "TODO clear unavailable")
		return
	}
	c.connsMu.RLock()
	origin := c.connections[pc.id] == pc
	c.connsMu.RUnlock()
	if !origin {
		fail("todo_unavailable", "originating connection unavailable")
		return
	}
	c.todos.mu.Lock()
	snap, err := c.todos.load(pc.sessionID)
	if err != nil {
		c.todos.mu.Unlock()
		fail("todo_unavailable", "TODO snapshot unavailable")
		return
	}
	if snap.Revision != int64(rev) {
		c.todos.mu.Unlock()
		fail("todo_revision_conflict", "TODO revision changed; refresh before clearing")
		return
	}
	if len(snap.Items) == 0 {
		c.todos.mu.Unlock()
		fail("todo_not_completed", "TODO list is empty")
		return
	}
	for _, item := range snap.Items {
		if item.Status != "completed" {
			c.todos.mu.Unlock()
			fail("todo_not_completed", "all TODO items must be completed")
			return
		}
	}
	if pc.closed.Load() || c.ctx.Err() != nil {
		c.todos.mu.Unlock()
		fail("todo_unavailable", "originating connection disconnected")
		return
	}
	snap.Revision++
	snap.UpdatedAt = time.Now().UnixMilli()
	snap.Items = []tools.PicoTodoItem{}
	err = c.todos.save(pc.sessionID, snap)
	c.todos.mu.Unlock()
	if err != nil {
		fail("todo_unavailable", "TODO clear could not be persisted")
		return
	}
	updated := newMessage(TypeTodoUpdated, map[string]any{"items": snap.Items, "revision": snap.Revision, "updated_at": snap.UpdatedAt, "request_id": msg.ID})
	updated.SessionID = pc.sessionID
	for _, client := range c.sessionConnectionsSnapshot(pc.sessionID) {
		_ = client.writeJSON(updated)
	}
}
