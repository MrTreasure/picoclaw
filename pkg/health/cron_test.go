package health

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCronJobHandlerDeletesAuthenticatedJob(t *testing.T) {
	server := NewServer("127.0.0.1", 0, "secret")
	var deleted string
	server.SetCronDeleteFunc(func(jobID string) error {
		deleted = jobID
		return nil
	})
	req := httptest.NewRequest(http.MethodDelete, "/internal/cron/jobs/job-1", nil)
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()

	server.cronJobHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", w.Code, http.StatusOK, w.Body.String())
	}
	if deleted != "job-1" {
		t.Fatalf("deleted id = %q, want job-1", deleted)
	}
}

func TestCronJobHandlerRequiresAuthentication(t *testing.T) {
	server := NewServer("127.0.0.1", 0, "secret")
	server.SetCronDeleteFunc(func(string) error { return nil })
	req := httptest.NewRequest(http.MethodDelete, "/internal/cron/jobs/job-1", nil)
	w := httptest.NewRecorder()

	server.cronJobHandler(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestCronJobHandlerMapsNotFound(t *testing.T) {
	server := NewServer("127.0.0.1", 0, "secret")
	server.SetCronDeleteFunc(func(string) error { return ErrCronJobNotFound })
	req := httptest.NewRequest(http.MethodDelete, "/internal/cron/jobs/missing", nil)
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()

	server.cronJobHandler(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusNotFound)
	}
}

func TestCronJobHandlerMapsDeleteFailure(t *testing.T) {
	server := NewServer("127.0.0.1", 0, "secret")
	server.SetCronDeleteFunc(func(string) error { return errors.New("disk full") })
	req := httptest.NewRequest(http.MethodDelete, "/internal/cron/jobs/job-1", nil)
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()

	server.cronJobHandler(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusInternalServerError)
	}
}
