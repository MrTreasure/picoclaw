package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gorilla/websocket"
)

const codexAppServerURL = "ws://127.0.0.1:18802/"
const codexProjectRoot = "/vol1/1000/deploy/data/MrTreasure"

type codexWorkspace struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func (h *Handler) registerCodexRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/codex/workspaces", h.handleCodexWorkspaces)
	mux.HandleFunc("GET /api/codex/app-server/ws", h.handleCodexAppServerWebSocket)
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
			Cwd string `json:"cwd"`
		} `json:"params"`
	}
	if json.Unmarshal(data, &request) != nil {
		return false
	}
	if request.Method == "" {
		return len(request.ID) > 0
	}
	switch request.Method {
	case "initialize", "initialized", "thread/list", "thread/read", "thread/loaded/list", "thread/resume", "thread/unsubscribe", "turn/interrupt":
		return true
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
