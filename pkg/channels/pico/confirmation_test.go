package pico

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"

	"github.com/gorilla/websocket"
	"github.com/sipeed/picoclaw/pkg/channels"
	"testing"
	"time"
)

// Exercise the response gate without relying on an unauthenticated synthetic socket.
func TestConfirmationResponseGate(t *testing.T) {
	c := &PicoChannel{confirmations: map[string]*pendingConfirmation{}}
	owner := &picoConn{id: "owner", sessionID: "s", done: make(chan struct{})}
	other := &picoConn{id: "other", sessionID: "s", done: make(chan struct{})}
	foreign := &picoConn{id: "foreign", sessionID: "other", done: make(chan struct{})}
	pending := &pendingConfirmation{conn: owner, turnID: "turn", response: make(chan bool, 1)}
	c.confirmations["random-request"] = pending
	respond := func(pc *picoConn, id string, v any) {
		c.handleConfirmationResponse(pc, PicoMessage{Type: TypeConfirmationRespond, ID: id, Payload: map[string]any{"accepted": v}})
	}
	respond(foreign, "random-request", true)
	respond(other, "random-request", true)
	respond(owner, "random-request", "true")
	respond(owner, "wrong", true)
	select {
	case <-pending.response:
		t.Fatal("wrong socket or invalid response approved")
	default:
	}
	respond(owner, "random-request", false)
	if got := <-pending.response; got {
		t.Fatal("rejected response approved")
	}
	respond(owner, "random-request", true)
	select {
	case <-pending.response:
		t.Fatal("replayed response accepted")
	default:
	}
}

func TestConfirmationConcurrentOneShot(t *testing.T) {
	c := &PicoChannel{confirmations: map[string]*pendingConfirmation{}}
	owner := &picoConn{id: "one", sessionID: "s", done: make(chan struct{})}
	for _, id := range []string{"a", "b"} {
		c.confirmations[id] = &pendingConfirmation{conn: owner, response: make(chan bool, 1)}
	}
	a := c.confirmations["a"]
	c.handleConfirmationResponse(owner, PicoMessage{ID: "a", Payload: map[string]any{"accepted": true}})
	if !<-a.response {
		t.Fatal("a rejected")
	}
	if _, ok := c.confirmations["b"]; !ok {
		t.Fatal("other pending request was consumed")
	}
}

// Test a cancellation path without waiting for a real two-minute expiry.
func TestConfirmationCanceledBeforeRequest(t *testing.T) {
	c := &PicoChannel{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	accepted, err := c.ConfirmPico(ctx, "pico:s", "conn", "turn", "action")
	if accepted || !errors.Is(err, context.Canceled) {
		t.Fatal("canceled request approved")
	}
}

func TestConfirmationDisconnectSignal(t *testing.T) {
	pc := &picoConn{done: make(chan struct{})}
	close(pc.done)
	select {
	case <-pc.done:
	case <-time.After(time.Second):
		t.Fatal("disconnect failed to signal")
	}
}

func TestConfirmationTimeoutBeforeRequest(t *testing.T) {
	c := &PicoChannel{}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	accepted, err := c.ConfirmPico(ctx, "pico:s", "conn", "turn", "action")
	if accepted || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expired confirmation = %v, %v", accepted, err)
	}
}

func TestConfirmationResolvedEventAndReplay(t *testing.T) {
	socket := make(chan *websocket.Conn, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		select {
		case socket <- ws:
		case <-time.After(time.Second):
			_ = ws.Close()
		}
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	owner := &picoConn{id: "owner", sessionID: "session", done: make(chan struct{}), conn: <-socket}
	defer owner.close()
	c := &PicoChannel{confirmations: make(map[string]*pendingConfirmation)}
	pending := &pendingConfirmation{conn: owner, response: make(chan bool, 1), deadline: time.Now().Add(time.Minute)}
	c.confirmations["req"] = pending
	c.handleConfirmationResponse(owner, PicoMessage{ID: "req", SessionID: "wrong", Payload: map[string]any{"accepted": true}})
	if len(c.confirmations) != 1 {
		t.Fatal("wrong session consumed request")
	}
	c.handleConfirmationResponse(owner, PicoMessage{ID: "req", SessionID: "session", Payload: map[string]any{"accepted": true}})
	if !<-pending.response {
		t.Fatal("valid response rejected")
	}
	var msg PicoMessage
	if err := client.ReadJSON(&msg); err != nil {
		t.Fatal(err)
	}
	if msg.Type != TypeConfirmationResolved || msg.ID != "req" || msg.SessionID != "session" || msg.Payload["approved"] != true {
		t.Fatalf("bad ack: %+v", msg)
	}
	c.handleConfirmationResponse(owner, PicoMessage{ID: "req", Payload: map[string]any{"accepted": true}})
	if c.resolveConfirmation("req", pending, false) {
		t.Fatal("replayed resolution claimed")
	}
	_ = client.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
	if err := client.ReadJSON(&msg); err == nil {
		t.Fatal("duplicate ack")
	}
}

func TestConfirmationExpiredResponseRejects(t *testing.T) {
	c := &PicoChannel{confirmations: make(map[string]*pendingConfirmation)}
	owner := &picoConn{sessionID: "session"}
	pending := &pendingConfirmation{conn: owner, response: make(chan bool, 1), deadline: time.Now().Add(-time.Millisecond)}
	c.confirmations["expired"] = pending
	c.handleConfirmationResponse(owner, PicoMessage{ID: "expired", Payload: map[string]any{"accepted": true}})
	if <-pending.response {
		t.Fatal("expired approval accepted")
	}
	if _, exists := c.confirmations["expired"]; exists {
		t.Fatal("expired request not consumed")
	}
}

// Test the request/response path over a local socket, without a live gateway.
func TestConfirmPicoLocalWebSocketRoundTrip(t *testing.T) {
	socket := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err == nil {
			socket <- ws
		}
	}))
	defer server.Close()
	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	pc := &picoConn{id: "owner", sessionID: "session", done: make(chan struct{}), conn: <-socket}
	defer pc.close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	channel := &PicoChannel{
		BaseChannel:   channels.NewBaseChannel("pico", nil, nil, []string{"*"}),
		ctx:           ctx,
		connections:   map[string]*picoConn{"owner": pc},
		confirmations: make(map[string]*pendingConfirmation),
	}
	channel.SetRunning(true)
	result := make(chan struct {
		approved bool
		err      error
	}, 1)
	go func() {
		approved, err := channel.ConfirmPico(ctx, "pico:session", "owner", "turn", "Only run test action")
		result <- struct {
			approved bool
			err      error
		}{approved, err}
	}()
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	var request PicoMessage
	if err := client.ReadJSON(&request); err != nil {
		t.Fatal(err)
	}
	if request.Type != TypeConfirmationRequest || request.ID == "" || request.SessionID != "session" || request.Payload["prompt"] != "Only run test action" {
		t.Fatalf("unexpected request: %+v", request)
	}
	channel.handleConfirmationResponse(pc, PicoMessage{Type: TypeConfirmationRespond, ID: request.ID, SessionID: "session", Payload: map[string]any{"accepted": true}})
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	var resolved PicoMessage
	if err := client.ReadJSON(&resolved); err != nil {
		t.Fatal(err)
	}
	if resolved.Type != TypeConfirmationResolved || resolved.ID != request.ID || resolved.Payload["approved"] != true {
		t.Fatalf("unexpected resolution: %+v", resolved)
	}
	select {
	case got := <-result:
		if got.err != nil || !got.approved {
			t.Fatalf("approval failed: %+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("confirmation never returned")
	}
	if len(channel.confirmations) != 0 {
		t.Fatal("confirmation remained pending")
	}
}
