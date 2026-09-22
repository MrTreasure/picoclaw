package health

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
)

const maxNotifyBodyBytes = 256 * 1024

type notifyRequest struct {
	Channel string `json:"channel"`
	To      string `json:"to"`
	Content string `json:"content"`
}

func (s *Server) notifyHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "method not allowed, use POST"})
		return
	}

	s.mu.RLock()
	requiredToken := s.authToken
	notifyFunc := s.notifyFunc
	s.mu.RUnlock()
	if requiredToken == "" {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "gateway authentication unavailable"})
		return
	}
	given := extractBearerToken(r.Header.Get("Authorization"))
	if given == "" || subtle.ConstantTimeCompare([]byte(given), []byte(requiredToken)) != 1 {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
		return
	}
	if notifyFunc == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "notification delivery unavailable"})
		return
	}

	var request notifyRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxNotifyBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid request"})
		return
	}
	request.Channel = strings.TrimSpace(request.Channel)
	request.To = strings.TrimSpace(request.To)
	if request.Channel == "" || request.To == "" || strings.TrimSpace(request.Content) == "" {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "channel, to and content are required"})
		return
	}

	if err := notifyFunc(r.Context(), request.Channel, request.To, request.Content); err != nil {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "sent"})
}
