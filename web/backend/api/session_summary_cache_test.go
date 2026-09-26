package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sipeed/picoclaw/pkg/memory"
	"github.com/sipeed/picoclaw/pkg/providers"
)

// An isolated in-process RESP stub ensures tests cannot mutate a real Redis.
type summaryRedisStub struct {
	mu         sync.Mutex
	values     map[string][]byte
	gets, sets int
	lastArgs   []string
}

func startSummaryRedisStub(t *testing.T) (string, *summaryRedisStub) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	stub := &summaryRedisStub{values: map[string][]byte{}}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				rd := bufio.NewReader(conn)
				line, err := rd.ReadString('\n')
				if err != nil {
					return
				}
				count, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "*")))
				if err != nil {
					return
				}
				parts := make([]string, count)
				for i := range parts {
					l, e := rd.ReadString('\n')
					if e != nil {
						return
					}
					n, e := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(l, "$")))
					if e != nil || n < 0 || n > 32<<20 {
						return
					}
					b := make([]byte, n+2)
					if _, e = io.ReadFull(rd, b); e != nil {
						return
					}
					parts[i] = string(b[:n])
				}
				stub.mu.Lock()
				defer stub.mu.Unlock()
				if len(parts) < 2 {
					return
				}
				switch parts[0] {
				case "GET":
					stub.gets++
					if v, ok := stub.values[parts[1]]; ok {
						fmt.Fprintf(conn, "$%d\r\n", len(v))
						_, _ = conn.Write(v)
						_, _ = conn.Write([]byte("\r\n"))
					} else {
						_, _ = conn.Write([]byte("$-1\r\n"))
					}
				case "SET":
					if len(parts) != 5 {
						return
					}
					stub.sets++
					stub.lastArgs = append([]string(nil), parts...)
					stub.values[parts[1]] = []byte(parts[2])
					_, _ = conn.Write([]byte("+OK\r\n"))
				}
			}()
		}
	}()
	return "redis://" + ln.Addr().String(), stub
}
func listCachedTest(t *testing.T, h *Handler, path string) []sessionListItem {
	t.Helper()
	rec := httptest.NewRecorder()
	h.handleListSessions(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != 200 {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var items []sessionListItem
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
		t.Fatal(err)
	}
	return items
}
func TestSessionSummaryRedisCache_ManifestAndFullList(t *testing.T) {
	configPath, cleanup := setupOAuthTestEnv(t)
	defer cleanup()
	dir := sessionsTestDir(t, configPath)
	store, err := memory.NewJSONLStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	key := legacyPicoSessionPrefix + "history-cache-test" // legacy scope-compatible filename
	for _, k := range []string{key, legacyPicoSessionPrefix + "history-cache-other"} {
		if err := store.AddFullMessage(nil, k, providers.Message{Role: "user", Content: "first"}); err != nil {
			t.Fatal(err)
		}
	}
	redisURL, stub := startSummaryRedisStub(t)
	t.Setenv("PWA_SESSION_REDIS_URL", redisURL)
	h := NewHandler(configPath)
	first := listCachedTest(t, h, "/api/sessions?limit=1")
	all := listCachedTest(t, h, "/api/sessions?limit=50")
	if len(first) != 1 || len(all) != 2 {
		t.Fatalf("pagination: %d %d", len(first), len(all))
	}
	if len(listCachedTest(t, h, "/api/sessions?channel=weixin")) != 0 || len(listCachedTest(t, h, "/api/sessions?offset=1&limit=1")) != 1 {
		t.Fatal("filter or offset")
	}
	stub.mu.Lock()
	sets := stub.sets
	args := append([]string(nil), stub.lastArgs...)
	stub.mu.Unlock()
	if sets != 1 || len(args) != 5 || args[3] != "EX" || args[4] != "30" {
		t.Fatalf("expected one full-list SET EX 30: %v, sets=%d", args, sets)
	}
	var env summaryCacheEnvelope
	if err := json.Unmarshal([]byte(args[2]), &env); err != nil || env.Version != summaryCacheVersion || len(env.Items) != 2 || env.Fingerprint == "" {
		t.Fatalf("invalid cache envelope: %+v %v", env, err)
	}
	// Modify an existing transcript without changing its size; mtime still invalidates.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var target string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".jsonl") {
			target = filepath.Join(dir, e.Name())
			break
		}
	}
	if target == "" {
		t.Fatal("missing jsonl")
	}
	original, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	modified := strings.Replace(string(original), "first", "other", 1)
	if len(modified) != len(original) || modified == string(original) {
		t.Fatal("bad fixture")
	}
	if err := os.WriteFile(target, []byte(modified), 0600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(target, now, now); err != nil {
		t.Fatal(err)
	}
	refreshed := listCachedTest(t, h, "/api/sessions")
	found := false
	for _, it := range refreshed {
		if it.Title == "other" {
			found = true
		}
	}
	if !found {
		t.Fatalf("stale listing after equal-size write: %+v", refreshed)
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	afterDelete := listCachedTest(t, h, "/api/sessions")
	if len(afterDelete) >= len(all) {
		t.Fatalf("stale listing after delete: %+v", afterDelete)
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if stub.sets != 3 || stub.gets < 5 {
		t.Fatalf("sets=%d gets=%d", stub.sets, stub.gets)
	}
}
func TestSessionSummaryRedisCache_UnavailableFallsBack(t *testing.T) {
	configPath, cleanup := setupOAuthTestEnv(t)
	defer cleanup()
	dir := sessionsTestDir(t, configPath)
	store, err := memory.NewJSONLStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AddFullMessage(nil, legacyPicoSessionPrefix+"history-fallback", providers.Message{Role: "user", Content: "fallback"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PWA_SESSION_REDIS_URL", "redis://127.0.0.1:1")
	items := listCachedTest(t, NewHandler(configPath), "/api/sessions")
	if len(items) != 1 || items[0].Title != "fallback" {
		t.Fatalf("fallback failed: %+v", items)
	}
}
