package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/cron"
	ppid "github.com/sipeed/picoclaw/pkg/pid"
)

func (h *Handler) registerCronRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/cron/jobs", h.handleListCronJobs)
	mux.HandleFunc("DELETE /api/cron/jobs/{id}", h.handleDeleteCronJob)
}

func (h *Handler) handleListCronJobs(w http.ResponseWriter, _ *http.Request) {
	cfg, err := config.LoadConfig(h.configPath)
	if err != nil {
		http.Error(w, "failed to load config", http.StatusInternalServerError)
		return
	}
	store := cron.CronStore{Version: 1, Jobs: []cron.CronJob{}}
	data, err := os.ReadFile(filepath.Join(cfg.WorkspacePath(), "cron", "jobs.json"))
	if err != nil && !os.IsNotExist(err) {
		http.Error(w, "failed to load scheduled tasks", http.StatusInternalServerError)
		return
	}
	if err == nil {
		if err := json.Unmarshal(data, &store); err != nil {
			http.Error(w, "failed to parse scheduled tasks", http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"jobs": store.Jobs})
}

func (h *Handler) handleDeleteCronJob(w http.ResponseWriter, r *http.Request) {
	jobID := strings.TrimSpace(r.PathValue("id"))
	if jobID == "" || strings.Contains(jobID, "/") {
		http.Error(w, "invalid task id", http.StatusBadRequest)
		return
	}

	pidData := h.sanitizeGatewayPidData(ppid.ReadPidFileWithCheck(globalConfigDir()), nil)
	if pidData == nil || pidData.Port <= 0 || pidData.Token == "" {
		http.Error(w, "gateway is not running", http.StatusServiceUnavailable)
		return
	}
	url := "http://" + net.JoinHostPort(gatewayProbeHost(pidData.Host), strconv.Itoa(pidData.Port)) +
		"/internal/cron/jobs/" + url.PathEscape(jobID)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodDelete, url, nil)
	if err != nil {
		http.Error(w, "failed to create delete request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Bearer "+pidData.Token)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		http.Error(w, "failed to reach running scheduler", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		http.Error(w, "failed to read scheduler response", http.StatusBadGateway)
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := strings.TrimSpace(string(body))
		if message == "" {
			message = fmt.Sprintf("scheduler returned status %d", resp.StatusCode)
		}
		http.Error(w, message, resp.StatusCode)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
