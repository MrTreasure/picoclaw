package pico

import (
	"context"
	"github.com/sipeed/picoclaw/pkg/bus"
	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/inbox"
	"path/filepath"
	"testing"
	"time"
)

func TestDurableDoubleSubmit(t *testing.T) {
	b := bus.NewMessageBus()
	cfg := &config.PicoSettings{}
	cfg.SetToken("test-only")
	c, e := NewPicoChannel(&config.Channel{Type: config.ChannelPico, Enabled: true}, cfg, b)
	if e != nil {
		t.Fatal(e)
	}
	c.ctx = context.Background()
	c.receipts = inbox.New(filepath.Join(t.TempDir(), "receipts"))
	pc := &picoConn{id: "connection", sessionID: "session"}
	msg := PicoMessage{Type: TypeMessageSend, ID: "same-id", Payload: map[string]any{"content": "one task"}}
	c.handleMessageSend(pc, msg)
	c.handleMessageSend(pc, msg)
	select {
	case got := <-b.InboundChan():
		if got.MessageID != "same-id" {
			t.Fatal(got.MessageID)
		}
	case <-time.After(time.Second):
		t.Fatal("missing message")
	}
	select {
	case <-b.InboundChan():
		t.Fatal("retry executed twice")
	default:
	}
	r, e := c.receipts.Get("session", "same-id")
	if e != nil || r.State != "queued" {
		t.Fatal(r, e)
	}
}

func TestOfflineTypingLifecycle(t *testing.T) {
	c := newTestPicoChannel(t)
	stop, err := c.StartTyping(context.Background(), "pico:offline")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := c.typingActive.Load("pico:offline"); !ok {
		t.Fatal("running work missing on reconnect")
	}
	stop()
	stop()
	if _, ok := c.typingActive.Load("pico:offline"); ok {
		t.Fatal("completed work remains running")
	}
}
