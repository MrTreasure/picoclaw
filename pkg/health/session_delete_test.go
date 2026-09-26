package health

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSessionDeleteAuthenticationAndStatus(t *testing.T) {
	s := NewServer("127.0.0.1", 0, "secret")
	called := 0
	s.SetSessionDeleteFunc(func(_ context.Context, id string) error {
		called++
		if id != "valid-id" {
			t.Fatalf("unexpected ID %q", id)
		}
		return ErrSessionDeleteBusy
	})
	for _, tc := range []struct {
		path, token string
		want        int
	}{
		{"/internal/sessions/valid-id", "", 401},
		{"/internal/sessions/valid-id", "wrong", 401},
		{"/internal/sessions/valid-id/extra", "secret", 400},
		{"/internal/sessions/valid-id", "secret", 409},
	} {
		r := httptest.NewRequest(http.MethodDelete, tc.path, nil)
		if tc.token != "" {
			r.Header.Set("Authorization", "Bearer "+tc.token)
		}
		w := httptest.NewRecorder()
		s.server.Handler.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("%s %q: got %d want %d", tc.path, tc.token, w.Code, tc.want)
		}
	}
	if called != 1 {
		t.Fatalf("handler called %d times", called)
	}
	s.SetSessionDeleteFunc(func(context.Context, string) error { return ErrSessionDeleteNotFound })
	r := httptest.NewRequest(http.MethodDelete, "/internal/sessions/valid-id", nil)
	r.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	s.server.Handler.ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatalf("got %d want 404", w.Code)
	}
	s.SetSessionDeleteFunc(func(context.Context, string) error { return errors.New("disk error") })
	w = httptest.NewRecorder()
	s.server.Handler.ServeHTTP(w, r)
	if w.Code != 500 {
		t.Fatalf("got %d want 500", w.Code)
	}
}
