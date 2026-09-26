package api

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gorilla/websocket"
)

const codexAppServerURL = "ws://127.0.0.1:18802/"
const codexProjectRoot = "/vol1/1000/deploy/data/MrTreasure"
const codexImageLimit = 10 << 20

type codexWorkspace struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func (h *Handler) registerCodexRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/codex/workspaces", h.handleCodexWorkspaces)
	mux.HandleFunc("GET /api/codex/app-server/ws", h.handleCodexAppServerWebSocket)
	mux.HandleFunc("POST /api/codex/images", h.handleCodexImageUpload)
	mux.HandleFunc("GET /api/codex/images/{name}", h.handleCodexImageRead)
}

func (h *Handler) codexImageDir() string {
	return filepath.Join(filepath.Dir(h.configPath), "codex-images")
}

func (h *Handler) handleCodexImageUpload(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin == "" || !sameLauncherRequestOrigin(r, origin) {
		http.Error(w, "invalid origin", http.StatusForbidden)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, codexImageLimit+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		http.Error(w, "invalid or oversized image", http.StatusBadRequest)
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("image")
	if err != nil || header.Size > codexImageLimit || header.Size <= 0 {
		http.Error(w, "image must be 10 MB or smaller", http.StatusBadRequest)
		return
	}
	defer file.Close()
	magic := make([]byte, 512)
	n, err := io.ReadFull(file, magic)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		http.Error(w, "invalid image", http.StatusBadRequest)
		return
	}
	mime := http.DetectContentType(magic[:n])
	ext := map[string]string{
		"image/jpeg": ".jpg", "image/png": ".png",
		"image/gif": ".gif", "image/webp": ".webp",
	}[mime]
	if ext == "" {
		http.Error(w, "unsupported image format", http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(h.codexImageDir(), 0700); err != nil {
		http.Error(w, "image storage unavailable", http.StatusInternalServerError)
		return
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		http.Error(w, "image storage unavailable", http.StatusInternalServerError)
		return
	}
	name := hex.EncodeToString(id[:]) + ext
	path := filepath.Join(h.codexImageDir(), name)
	out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		http.Error(w, "image storage unavailable", http.StatusInternalServerError)
		return
	}
	written, copyErr := io.Copy(out, io.LimitReader(io.MultiReader(bytes.NewReader(magic[:n]), file), codexImageLimit+1))
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil || written > codexImageLimit {
		_ = os.Remove(path)
		http.Error(w, "image upload failed or too large", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"path": path, "url": "/api/codex/images/" + name})
}

func (h *Handler) handleCodexImageRead(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	if len(stem) != 32 || strings.ContainsAny(name, "/\\") {
		http.NotFound(w, r)
		return
	}
	for _, ch := range stem {
		if !strings.ContainsRune("0123456789abcdef", ch) {
			http.NotFound(w, r)
			return
		}
	}
	switch filepath.Ext(name) {
	case ".jpg", ".png", ".gif", ".webp":
	default:
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, filepath.Join(h.codexImageDir(), name))
}

func (h *Handler) handleCodexWorkspaces(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(codexProjectRoot)
	if err != nil {
		http.Error(w, "workspace directory unavailable", http.StatusServiceUnavailable)
		return
	}
	workspaces := make([]codexWorkspace, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") || entry.Name() == "node_modules" {
			continue
		}
		path := filepath.Join(codexProjectRoot, entry.Name())
		if _, err := os.Stat(filepath.Join(path, ".git")); err != nil {
			continue
		}
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil || filepath.Dir(resolved) != codexProjectRoot {
			continue
		}
		workspaces = append(workspaces, codexWorkspace{Name: entry.Name(), Path: resolved})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(workspaces)
}

func codexWebSocketOriginAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	return origin != "" && sameLauncherRequestOrigin(r, origin)
}

var codexWebSocketUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     codexWebSocketOriginAllowed,
}

func (h *Handler) handleCodexAppServerWebSocket(w http.ResponseWriter, r *http.Request) {
	if !codexWebSocketOriginAllowed(r) {
		http.Error(w, "invalid origin", http.StatusForbidden)
		return
	}
	upstream, _, err := websocket.DefaultDialer.DialContext(r.Context(), codexAppServerURL, nil)
	if err != nil {
		http.Error(w, "Codex service unavailable", http.StatusServiceUnavailable)
		return
	}
	defer upstream.Close()
	client, err := codexWebSocketUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer client.Close()
	done := make(chan struct{}, 2)
	copyFrames := func(dst, src *websocket.Conn) {
		for {
			typ, data, err := src.ReadMessage()
			if err != nil {
				break
			}
			if src == client && !codexClientMessageAllowed(data) {
				break
			}
			if dst.WriteMessage(typ, data) != nil {
				break
			}
		}
		done <- struct{}{}
	}
	go copyFrames(upstream, client)
	go copyFrames(client, upstream)
	<-done
}

func codexClientMessageAllowed(data []byte) bool {
	var request struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Cwd            string `json:"cwd"`
			ThreadID       string `json:"threadId"`
			ExpectedTurnID string `json:"expectedTurnId"`
		} `json:"params"`
	}
	if json.Unmarshal(data, &request) != nil {
		return false
	}
	if request.Method == "" {
		return len(request.ID) > 0
	}
	switch request.Method {
	case "initialize", "initialized", "model/list", "thread/list", "thread/read", "thread/loaded/list", "thread/resume", "thread/unsubscribe", "turn/interrupt":
		return true
	case "turn/steer":
		return len(request.ID) > 0 && strings.TrimSpace(request.Params.ThreadID) != "" && strings.TrimSpace(request.Params.ExpectedTurnID) != ""
	case "thread/delete":
		return len(request.ID) > 0 && strings.TrimSpace(request.Params.ThreadID) != ""
	case "thread/start", "turn/start":
		return codexWorkspaceAllowed(request.Params.Cwd)
	default:
		return false
	}
}

func codexWorkspaceAllowed(path string) bool {
	if path == "" {
		return false
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || filepath.Dir(resolved) != codexProjectRoot {
		return false
	}
	if _, err := os.Stat(filepath.Join(resolved, ".git")); err != nil {
		return false
	}
	return true
}
