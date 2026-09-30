package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/sipeed/picoclaw/pkg/config"
)

func (h *Handler) dailyReportRoot() (string, error) {
	cfg, err := config.LoadConfig(h.configPath)
	if err != nil {
		return "", err
	}
	return filepath.Join(cfg.WorkspacePath(), "memory"), nil
}

// Only dated Markdown reports inside the memory directory can be read.
func dailyReportPath(root, date string) (string, error) {
	if _, err := time.Parse("20060102", date); err != nil {
		return "", os.ErrNotExist
	}
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	path, err := filepath.EvalSymlinks(filepath.Join(base, date[:6], date+".md"))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(base, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", os.ErrPermission
	}
	return path, nil
}

func (h *Handler) handleListDailyReports(w http.ResponseWriter, r *http.Request) {
	root, err := h.dailyReportRoot()
	if err != nil {
		http.Error(w, "failed to load workspace", 500)
		return
	}
	files, err := filepath.Glob(filepath.Join(root, "??????", "????????.md"))
	if err != nil {
		http.Error(w, "failed to list reports", 500)
		return
	}
	reports := make([]map[string]string, 0, len(files))
	for _, file := range files {
		date := strings.TrimSuffix(filepath.Base(file), ".md")
		if filepath.Base(filepath.Dir(file)) != date[:6] {
			continue
		}
		path, err := dailyReportPath(root, date)
		if err != nil {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		day, _ := time.Parse("20060102", date)
		reports = append(reports, map[string]string{"date": date, "title": day.Format("2006-01-02") + " 日报", "updated_at": info.ModTime().UTC().Format(time.RFC3339)})
	}
	sort.Slice(reports, func(i, j int) bool { return reports[i]["date"] > reports[j]["date"] })
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"reports": reports})
}

func (h *Handler) handleGetDailyReport(w http.ResponseWriter, r *http.Request) {
	root, err := h.dailyReportRoot()
	if err != nil {
		http.Error(w, "failed to load workspace", 500)
		return
	}
	path, err := dailyReportPath(root, r.PathValue("date"))
	if err != nil {
		http.Error(w, "report not found", 404)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "report not found", 404)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "report not found", 404)
		return
	}
	content, err := io.ReadAll(io.LimitReader(f, maxWorkspaceDocumentBytes+1))
	if err != nil {
		http.Error(w, "failed to read report", 500)
		return
	}
	if len(content) > maxWorkspaceDocumentBytes {
		http.Error(w, "report is too large", 413)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]string{"date": r.PathValue("date"), "content": string(content)})
}
