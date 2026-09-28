package pico

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

type phonePending struct {
	conn     *picoConn
	deadline time.Time
	result   chan map[string]any
}
type phoneRequests struct {
	sync.Mutex
	pending map[string]*phonePending
}

// CallPhone targets only the authenticated connection that originated this turn.
// Requests are one-shot; disconnection never causes a mutation to be replayed.
func (c *PicoChannel) CallPhone(ctx context.Context, chatID, connID, action string, args map[string]any) (map[string]any, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	c.connsMu.RLock()
	pc := c.connections[connID]
	c.connsMu.RUnlock()
	if pc == nil || pc.closed.Load() || chatID != "pico:"+pc.sessionID || !pc.phoneEnabled.Load() {
		return nil, errors.New("phone tools are not enabled on the originating connection; open Muse Native and enable phone tools")
	}
	data, err := json.Marshal(args)
	if err != nil || len(data) > 32768 {
		return nil, errors.New("phone arguments exceed 32 KiB")
	}
	var random [24]byte
	if _, err = rand.Read(random[:]); err != nil {
		return nil, err
	}
	id := hex.EncodeToString(random[:])
	pending := &phonePending{conn: pc, deadline: time.Now().Add(90 * time.Second), result: make(chan map[string]any, 1)}
	c.phone.Lock()
	if c.phone.pending == nil {
		c.phone.pending = make(map[string]*phonePending)
	}
	if len(c.phone.pending) >= 32 {
		c.phone.Unlock()
		return nil, errors.New("too many pending phone operations")
	}
	c.phone.pending[id] = pending
	c.phone.Unlock()
	defer func() { c.phone.Lock(); delete(c.phone.pending, id); c.phone.Unlock() }()
	request := newMessage("phone.request", map[string]any{"action": action, "arguments": args, "expires_at": pending.deadline.UnixMilli()})
	request.ID = id
	request.SessionID = pc.sessionID
	if err = pc.writeJSON(request); err != nil {
		return nil, err
	}
	timer := time.NewTimer(time.Until(pending.deadline))
	defer timer.Stop()
	select {
	case result := <-pending.result:
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if pc.closed.Load() || time.Now().After(pending.deadline) {
			return nil, errors.New("phone request expired or disconnected; result unconfirmed")
		}
		return result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-pc.done:
		return nil, errors.New("phone disconnected; operation result unknown, do not automatically retry")
	case <-timer.C:
		return nil, errors.New("phone operation timed out; result unknown, inspect state before retrying")
	}
}
func (c *PicoChannel) handlePhoneResult(pc *picoConn, msg PicoMessage) {
	if msg.ID == "" || (msg.SessionID != "" && msg.SessionID != pc.sessionID) {
		return
	}
	bytes, err := json.Marshal(msg.Payload)
	if err != nil || len(bytes) > 256*1024 {
		return
	}
	c.phone.Lock()
	defer c.phone.Unlock()
	p := c.phone.pending[msg.ID]
	if p == nil || p.conn != pc || pc.closed.Load() || time.Now().After(p.deadline) {
		return
	}
	delete(c.phone.pending, msg.ID)
	p.result <- msg.Payload
}
