package pico

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

type pendingConfirmation struct {
	conn     *picoConn
	turnID   string
	response chan bool
	deadline time.Time
	ctx      context.Context
}

// ConfirmPico sends a one-shot request to the originating authenticated socket.
// It never broadcasts to other sockets sharing the session identifier.
func (c *PicoChannel) ConfirmPico(ctx context.Context, chatID, connID, turnID, prompt string) (bool, error) {
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	if c.BaseChannel == nil || !c.IsRunning() || c.ctx == nil || connID == "" || turnID == "" || strings.TrimSpace(prompt) == "" {
		return false, errors.New("confirmation unavailable")
	}
	c.connsMu.RLock()
	pc := c.connections[connID]
	if pc == nil || pc.closed.Load() || chatID != "pico:"+pc.sessionID {
		c.connsMu.RUnlock()
		return false, errors.New("connection mismatch")
	}
	c.connsMu.RUnlock()
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return false, err
	}
	id := hex.EncodeToString(random[:])
	deadline := time.Now().Add(2 * time.Minute)
	pending := &pendingConfirmation{conn: pc, turnID: turnID, response: make(chan bool, 1), deadline: deadline, ctx: ctx}
	c.confirmationMu.Lock()
	if c.confirmations == nil {
		c.confirmations = make(map[string]*pendingConfirmation)
	}
	c.confirmations[id] = pending
	c.confirmationMu.Unlock()
	request := newMessage(TypeConfirmationRequest, map[string]any{"prompt": prompt, "expires_at": deadline.UnixMilli()})
	request.ID = id
	request.SessionID = pc.sessionID
	if err := pc.writeJSON(request); err != nil {
		c.resolveConfirmation(id, pending, false)
		return false, err
	}
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case accepted := <-pending.response:
		if ctx.Err() != nil || pc.closed.Load() || c.ctx.Err() != nil || !time.Now().Before(deadline) {
			return false, errors.New("confirmation canceled")
		}
		return accepted, nil
	case <-ctx.Done():
		c.resolveConfirmation(id, pending, false)
		return false, ctx.Err()
	case <-pc.done:
		c.resolveConfirmation(id, pending, false)
		return false, errors.New("connection closed")
	case <-c.ctx.Done():
		c.resolveConfirmation(id, pending, false)
		return false, errors.New("channel stopped")
	case <-timer.C:
		c.resolveConfirmation(id, pending, false)
		return false, errors.New("confirmation expired")
	}
}

// resolveConfirmation claims an outstanding request once and clears stale UI if the
// originating socket is still writable. Never hold confirmationMu across network I/O.
func (c *PicoChannel) resolveConfirmation(id string, pending *pendingConfirmation, approved bool) bool {
	c.confirmationMu.Lock()
	if c.confirmations[id] != pending {
		c.confirmationMu.Unlock()
		return false
	}
	delete(c.confirmations, id)
	c.confirmationMu.Unlock()
	if !pending.conn.closed.Load() && pending.conn.conn != nil {
		resolved := newMessage(TypeConfirmationResolved, map[string]any{"approved": approved})
		resolved.ID = id
		resolved.SessionID = pending.conn.sessionID
		_ = pending.conn.writeJSON(resolved)
	}
	return true
}

func (c *PicoChannel) handleConfirmationResponse(pc *picoConn, msg PicoMessage) {
	// Require explicit boolean. Missing or non-boolean payload is never approval.
	accepted, ok := msg.Payload["accepted"].(bool)
	if !ok || msg.ID == "" || (msg.SessionID != "" && msg.SessionID != pc.sessionID) {
		return
	}
	c.confirmationMu.Lock()
	pending := c.confirmations[msg.ID]
	if pending == nil || pending.conn != pc || pc.closed.Load() {
		c.confirmationMu.Unlock()
		return
	}
	// The decision's deadline is checked here, not only after the waiter wakes.
	// A late approval is consumed as a rejection so it cannot be replayed.
	valid := (pending.deadline.IsZero() || time.Now().Before(pending.deadline)) &&
		(pending.ctx == nil || pending.ctx.Err() == nil) &&
		(c.ctx == nil || c.ctx.Err() == nil)
	if pc.done != nil {
		select {
		case <-pc.done:
			valid = false
		default:
		}
	}
	delete(c.confirmations, msg.ID)
	select {
	case pending.response <- accepted && valid:
	default:
	}
	c.confirmationMu.Unlock()
	if !pc.closed.Load() && pc.conn != nil {
		resolved := newMessage(TypeConfirmationResolved, map[string]any{"approved": accepted && valid})
		resolved.ID = msg.ID
		resolved.SessionID = pc.sessionID
		_ = pc.writeJSON(resolved)
	}
}
