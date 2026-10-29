package cron

import (
	"fmt"
	"path/filepath"

	"github.com/sipeed/picoclaw/cmd/picoclaw/internal"
	"github.com/sipeed/picoclaw/pkg/pid"
)

// A running gateway is authoritative. Never fall back to file writes on a
// timeout or rejected update, which could duplicate or resurrect a task.
func liveCronRequest(storePath, method, path string, body any, result any) (bool, error) {
	process := pid.ReadPidFileWithCheck(internal.GetPicoclawHome())
	cfg, err := internal.LoadConfig()
	if err != nil {
		if process != nil {
			return true, fmt.Errorf("running gateway configuration unavailable; no offline write")
		}
		return false, nil
	}
	if filepath.Clean(storePath) != filepath.Join(cfg.WorkspacePath(), "cron", "jobs.json") {
		return false, nil
	}
	if process == nil {
		return false, nil
	}
	if process.Token == "" || process.Port <= 0 {
		return true, fmt.Errorf("running gateway not ready; no offline write")
	}
	return liveCronRPC(internal.GetPicoclawHome(), process.Token, method, path, body, result)
}
