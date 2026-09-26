package health

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
)

var ErrSessionDeleteBusy = errors.New("session has an active turn")
var ErrSessionDeleteNotFound = errors.New("session not found")

func (s *Server) sessionDeleteHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.RLock()
	token, fn := s.authToken, s.sessionDeleteFunc
	s.mu.RUnlock()
	if token == "" || fn == nil {
		http.Error(w, "deletion unavailable", http.StatusServiceUnavailable)
		return
	}
	provided := extractBearerToken(r.Header.Get("Authorization"))
	if provided == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/internal/sessions/")
	if id == "" || strings.ContainsAny(id, "/\\") || id == "." || id == ".." {
		http.Error(w, "invalid session id", http.StatusBadRequest)
		return
	}
	if err := fn(r.Context(), id); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, ErrSessionDeleteBusy) {
			status = http.StatusConflict
		}
		if errors.Is(err, ErrSessionDeleteNotFound) {
			status = http.StatusNotFound
		}
		http.Error(w, "session deletion failed", status)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
