package health

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

var ErrCronJobNotFound = errors.New("cron job not found")

func (s *Server) cronJobHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodDelete && r.Method != http.MethodPatch && r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "method not allowed, use DELETE or PATCH"})
		return
	}

	s.mu.RLock()
	requiredToken := s.authToken
	deleteFunc := s.cronDeleteFunc
	updateFunc := s.cronUpdateFunc
	createFunc := s.cronCreateFunc
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
	if (r.Method == http.MethodDelete && deleteFunc == nil) || (r.Method == http.MethodPatch && updateFunc == nil) || (r.Method == http.MethodPost && createFunc == nil) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "cron management unavailable"})
		return
	}

	if r.Method == http.MethodPost {
		if r.URL.Path != "/internal/cron/jobs" {
			w.WriteHeader(404)
			return
		}
		var input CronCreate
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			w.WriteHeader(400)
			return
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			w.WriteHeader(400)
			return
		}
		result, err := createFunc(input)
		if err != nil {
			w.WriteHeader(400)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "cron creation rejected"})
			return
		}
		_ = json.NewEncoder(w).Encode(result)
		return
	}
	jobID := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/internal/cron/jobs/"))
	if jobID == "" || strings.Contains(jobID, "/") {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid job id"})
		return
	}
	if r.Method == http.MethodPatch {
		var patch CronPatch
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&patch); err != nil {
			w.WriteHeader(400)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid cron patch"})
			return
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			w.WriteHeader(400)
			return
		}
		if err := updateFunc(jobID, patch); err != nil {
			code := 400
			if errors.Is(err, ErrCronJobNotFound) {
				code = 404
			}
			w.WriteHeader(code)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "cron update rejected"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
		return
	}
	if err := deleteFunc(jobID); err != nil {
		if errors.Is(err, ErrCronJobNotFound) {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "scheduled task not found"})
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}
