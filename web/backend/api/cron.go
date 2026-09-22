package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/cron"
)

func (h *Handler) registerCronRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/cron/jobs", h.handleListCronJobs)
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
