package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/fileutil"
)

const maxWorkspaceDocumentBytes = 512 << 10

func (h *Handler) registerWorkspaceDocumentRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/workspace-documents/{name}", h.handleGetWorkspaceDocument)
	mux.HandleFunc("PUT /api/workspace-documents/{name}", h.handlePutWorkspaceDocument)
}

func (h *Handler) workspaceDocumentPath(name string) (string, string, error) {
	cfg, err := config.LoadConfig(h.configPath)
	if err != nil {
		return "", "", err
	}
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "soul":
		return filepath.Join(cfg.WorkspacePath(), "SOUL.md"), "SOUL.md", nil
	case "memory":
		return filepath.Join(cfg.WorkspacePath(), "memory", "MEMORY.md"), "MEMORY.md", nil
	default:
		return "", "", os.ErrNotExist
	}
}

func (h *Handler) handleGetWorkspaceDocument(w http.ResponseWriter, r *http.Request) {
	path, filename, err := h.workspaceDocumentPath(r.PathValue("name"))
	if err != nil {
		http.Error(w, "document not found", http.StatusNotFound)
		return
	}
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			content = []byte{}
		} else {
			http.Error(w, "failed to read document", http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"name": filename, "content": string(content)})
}

func (h *Handler) handlePutWorkspaceDocument(w http.ResponseWriter, r *http.Request) {
	path, filename, err := h.workspaceDocumentPath(r.PathValue("name"))
	if err != nil {
		http.Error(w, "document not found", http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxWorkspaceDocumentBytes+1))
	if err != nil || len(body) > maxWorkspaceDocumentBytes {
		http.Error(w, "document is too large", http.StatusRequestEntityTooLarge)
		return
	}
	var input struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(body, &input); err != nil {
		http.Error(w, "invalid document payload", http.StatusBadRequest)
		return
	}
	perm := os.FileMode(0o600)
	if info, statErr := os.Stat(path); statErr == nil {
		perm = info.Mode().Perm()
	}
	if err := fileutil.WriteFileAtomic(path, []byte(input.Content), perm); err != nil {
		http.Error(w, "failed to save document", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"name": filename, "status": "saved"})
}
