package pico

import (
	"context"
	"github.com/gorilla/websocket"
	"github.com/sipeed/picoclaw/pkg/tools"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPicoTodoStorePersistenceIsolationAndClear(t *testing.T) {
	store := newPicoTodoStore()
	store.dir = t.TempDir()
	first, err := store.load("session-a")
	if err != nil || first.Revision != 0 || len(first.Items) != 0 {
		t.Fatalf("empty: %+v %v", first, err)
	}
	if store.path("session-a") == store.path("session-b") || filepath.Dir(store.path("../escape")) != store.dir {
		t.Fatal("unsafe session path")
	}
	snap := todoSnapshot{Revision: 1, Items: []tools.PicoTodoItem{{Content: "task", Short: "task", Status: "pending"}}}
	data := []byte(`{"items":[{"content":"task","short":"task","status":"pending"}],"revision":1,"updated_at":42}`)
	if err = os.WriteFile(store.path("session-a"), data, 0600); err != nil {
		t.Fatal(err)
	}
	got, err := store.load("session-a")
	if err != nil || got.Revision != snap.Revision || got.Items[0] != snap.Items[0] {
		t.Fatalf("restore: %+v %v", got, err)
	}
	other, err := store.load("session-b")
	if err != nil || other.Revision != 0 {
		t.Fatal("cross-session leak", err)
	}
}
func TestUpdatePicoTodosRejectsForeignOrClosedOrigin(t *testing.T) {
	c := newTestPicoChannel(t)
	c.SetTodoStorage(t.TempDir())
	c.SetRunning(true)
	c.connections["source"] = &picoConn{id: "source", sessionID: "session-a", done: make(chan struct{})}
	item := []tools.PicoTodoItem{{Content: "task", Short: "task", Status: "pending"}}
	for _, chat := range []string{"pico:session-b", "telegram:session-a"} {
		if err := c.UpdatePicoTodos(context.Background(), chat, "source", "turn", item); err == nil {
			t.Fatal("accepted foreign origin")
		}
	}
	if _, err := os.Stat(c.todos.path("session-a")); !os.IsNotExist(err) {
		t.Fatal("unexpected persistence", err)
	}
	c.connections["source"].closed.Store(true)
	if err := c.UpdatePicoTodos(context.Background(), "pico:session-a", "source", "turn", item); err == nil {
		t.Fatal("accepted closed origin")
	}
}

func TestPicoTodoWebSocketUpdateAndReconnectSnapshot(t *testing.T) {
	c := newTestPicoChannel(t)
	c.SetTodoStorage(t.TempDir())
	c.SetRunning(true)
	server := httptest.NewServer(http.HandlerFunc(c.handleWebSocket))
	defer server.Close()
	dial := func(session string) *websocket.Conn {
		t.Helper()
		u := "ws" + strings.TrimPrefix(server.URL, "http") + "?session_id=" + session
		conn, _, err := websocket.DefaultDialer.Dial(u, http.Header{"Authorization": []string{"Bearer test-token"}})
		if err != nil {
			t.Fatal(err)
		}
		return conn
	}
	first := dial("session-a")
	defer first.Close()
	var initial PicoMessage
	if err := first.ReadJSON(&initial); err != nil {
		t.Fatal(err)
	}
	if initial.Type != TypeTodoSnapshot || initial.SessionID != "session-a" || initial.Payload["revision"] != float64(0) {
		t.Fatalf("initial: %+v", initial)
	}
	c.connsMu.RLock()
	var connID string
	for id, pc := range c.connections {
		if pc.sessionID == "session-a" {
			connID = id
		}
	}
	c.connsMu.RUnlock()
	if connID == "" {
		t.Fatal("missing origin")
	}
	items := []tools.PicoTodoItem{{Content: "first", Short: "first", Status: "in_progress"}}
	if err := c.UpdatePicoTodos(context.Background(), "pico:session-a", connID, "turn-1", items); err != nil {
		t.Fatal(err)
	}
	var updated PicoMessage
	if err := first.ReadJSON(&updated); err != nil {
		t.Fatal(err)
	}
	if updated.Type != TypeTodoUpdated || updated.SessionID != "session-a" || updated.Payload["revision"] != float64(1) || updated.Payload["turn_id"] != "turn-1" {
		t.Fatalf("update: %+v", updated)
	}
	reconnect := dial("session-a")
	defer reconnect.Close()
	var restored PicoMessage
	if err := reconnect.ReadJSON(&restored); err != nil {
		t.Fatal(err)
	}
	if restored.Type != TypeTodoSnapshot || restored.Payload["revision"] != float64(1) {
		t.Fatalf("recovery: %+v", restored)
	}
	other := dial("session-b")
	defer other.Close()
	var isolated PicoMessage
	if err := other.ReadJSON(&isolated); err != nil {
		t.Fatal(err)
	}
	if isolated.Type != TypeTodoSnapshot || isolated.Payload["revision"] != float64(0) {
		t.Fatalf("leak: %+v", isolated)
	}
}

func TestPicoPlanModeWireGateRejectsBeforeDispatch(t *testing.T) {
	c := newTestPicoChannel(t)
	c.SetTodoStorage(t.TempDir())
	c.SetRunning(true)
	server := httptest.NewServer(http.HandlerFunc(c.handleWebSocket))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "?session_id=plan-test"
	conn, _, err := websocket.DefaultDialer.Dial(url, http.Header{"Authorization": []string{"Bearer test-token"}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var snapshot PicoMessage
	if err := conn.ReadJSON(&snapshot); err != nil || snapshot.Type != TypeTodoSnapshot {
		t.Fatalf("initial snapshot: %+v %v", snapshot, err)
	}
	request := PicoMessage{Type: TypeMessageSend, ID: "plan-request", Payload: map[string]any{
		"mode": "plan", "content": "make changes", "media": "invalid inline media",
	}}
	if err := conn.WriteJSON(request); err != nil {
		t.Fatal(err)
	}
	var reply PicoMessage
	if err := conn.ReadJSON(&reply); err != nil {
		t.Fatal(err)
	}
	if reply.Type != TypeError || reply.Payload["code"] != "plan_unavailable" || reply.Payload["request_id"] != request.ID {
		t.Fatalf("mode was not rejected before media handling: %+v", reply)
	}
}
