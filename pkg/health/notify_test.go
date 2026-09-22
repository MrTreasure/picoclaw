package health

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNotifyHandlerRequiresAuthentication(t *testing.T) {
	server := newTestServer()
	server.SetNotifyFunc(func(context.Context, string, string, string) error { return nil })
	req := httptest.NewRequest(http.MethodPost, "/internal/notify", bytes.NewBufferString(
		`{"channel":"weixin","to":"owner","content":"done"}`,
	))
	w := httptest.NewRecorder()

	server.notifyHandler(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestNotifyHandlerDeliversThroughCallback(t *testing.T) {
	server := newTestServer()
	var channel, to, content string
	server.SetNotifyFunc(func(_ context.Context, gotChannel, gotTo, gotContent string) error {
		channel, to, content = gotChannel, gotTo, gotContent
		return nil
	})
	req := httptest.NewRequest(http.MethodPost, "/internal/notify", bytes.NewBufferString(
		`{"channel":"weixin","to":"owner","content":"done"}`,
	))
	req.Header.Set("Authorization", "Bearer test")
	w := httptest.NewRecorder()

	server.notifyHandler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}
	if channel != "weixin" || to != "owner" || content != "done" {
		t.Fatalf("callback = (%q, %q, %q)", channel, to, content)
	}
}

func TestNotifyHandlerReportsDeliveryFailure(t *testing.T) {
	server := newTestServer()
	server.SetNotifyFunc(func(context.Context, string, string, string) error {
		return errors.New("send failed")
	})
	req := httptest.NewRequest(http.MethodPost, "/internal/notify", bytes.NewBufferString(
		`{"channel":"weixin","to":"owner","content":"done"}`,
	))
	req.Header.Set("Authorization", "Bearer test")
	w := httptest.NewRecorder()

	server.notifyHandler(w, req)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusBadGateway)
	}
}
