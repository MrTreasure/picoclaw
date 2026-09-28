package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sipeed/picoclaw/pkg/memory"
	"github.com/sipeed/picoclaw/pkg/providers"
)

func TestSessionTitlePatchAndScope(t *testing.T) {
	configPath, cleanup := setupOAuthTestEnv(t)
	defer cleanup()
	dir := sessionsTestDir(t, configPath)
	store, e := memory.NewJSONLStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	key := legacyPicoSessionPrefix + "rename-test"
	for _, m := range []providers.Message{{Role: "user", Content: "first user question"}, {Role: "assistant", Content: "latest answer"}} {
		if e := store.AddFullMessage(nil, key, m); e != nil {
			t.Fatal(e)
		}
	}
	h := NewHandler(configPath)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	patch := func(id, body string) int {
		t.Helper()
		r := httptest.NewRecorder()
		mux.ServeHTTP(r, httptest.NewRequest("PATCH", "/api/sessions/"+id+"/title", strings.NewReader(body)))
		return r.Code
	}
	if items := listCachedTest(t, h, "/api/sessions"); len(items) != 1 || items[0].Title != "first user question" || items[0].Preview != "latest answer" {
		t.Fatalf("initial: %+v", items)
	}
	for _, id := range []string{"unknown", "agent:cron-1", "..", "%2Ftmp"} {
		if status := patch(id, `{"title":"Denied"}`); status == 200 {
			t.Fatalf("accepted %q", id)
		}
	}
	for _, body := range []string{`{"title":""}`, `{"title":"  spaces "}`, `{"title":"a\nb"}`, `{"title":"` + strings.Repeat("字", 61) + `"}`, `{"title":"ok","extra":1}`, `{"title":null}`} {
		if status := patch("rename-test", body); status == 200 {
			t.Fatalf("accepted %q", body)
		}
	}
	if status := patch("rename-test", `{"title":"Manually renamed"}`); status != 200 {
		t.Fatalf("patch status %d", status)
	}
	if items := listCachedTest(t, h, "/api/sessions"); items[0].Title != "Manually renamed" || items[0].Preview != "latest answer" {
		t.Fatalf("renamed: %+v", items)
	}
	if items := listCachedTest(t, NewHandler(configPath), "/api/sessions"); items[0].Title != "Manually renamed" {
		t.Fatalf("not durable: %+v", items)
	}
	// A stale sidecar must not rename a new session with the same display ID.
	for _, extension := range []string{".jsonl", ".meta.json"} {
		p := filepath.Join(dir, sanitizeSessionKey(key)+extension)
		_ = os.Remove(p)
	}
	if e := store.AddFullMessage(nil, key, providers.Message{Role: "user", Content: "replacement question"}); e != nil {
		t.Fatal(e)
	}
	if items := listCachedTest(t, h, "/api/sessions"); len(items) != 1 || items[0].Title != "replacement question" {
		t.Fatalf("recreated: %+v", items)
	}
}
func TestSessionTitleFirstProseFallback(t *testing.T) {
	msgs := []sessionChatMessage{{Role: "user", Content: "[System: async:spawn] result"}, {Role: "user", Content: "data:image/png;base64,abc"}, {Role: "assistant", Content: "latest"}}
	if title := firstSessionTitle(msgs, "pico"); title != "New conversation" {
		t.Fatalf("fallback %q", title)
	}
	msgs = append(msgs, sessionChatMessage{Role: "user", Content: "the actual request"})
	if title := firstSessionTitle(msgs, "pico"); title != "the actual request" {
		t.Fatalf("first prose %q", title)
	}
}

func TestSessionTitleRedisCacheRenameVisible(t *testing.T) {
	configPath, cleanup := setupOAuthTestEnv(t)
	defer cleanup()
	dir := sessionsTestDir(t, configPath)
	store, e := memory.NewJSONLStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	if e = store.AddFullMessage(nil, legacyPicoSessionPrefix+"redis-title", providers.Message{Role: "user", Content: "original"}); e != nil {
		t.Fatal(e)
	}
	url, _ := startSummaryRedisStub(t)
	t.Setenv("PWA_SESSION_REDIS_URL", url)
	h := NewHandler(configPath)
	if got := listCachedTest(t, h, "/api/sessions")[0].Title; got != "original" {
		t.Fatal(got)
	}
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("PATCH", "/api/sessions/redis-title/title", strings.NewReader(`{"title":"Renamed"}`)))
	if w.Code != 200 {
		t.Fatalf("patch %d: %s", w.Code, w.Body.String())
	}
	if got := listCachedTest(t, h, "/api/sessions")[0].Title; got != "Renamed" {
		t.Fatalf("stale title %q", got)
	}
}

func waitTitle(t *testing.T, h *Handler, id, want string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		items := listCachedTest(t, h, "/api/sessions?channel=pico")
		for _, item := range items {
			if item.ID == id && item.Title == want {
				return
			}
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("title %q never became %q", id, want)
}
func TestGeneratedTitleOneTimeAndManualWins(t *testing.T) {
	configPath, cleanup := setupOAuthTestEnv(t)
	t.Setenv("PWA_TITLE_GENERATION_ENABLED", "1")
	t.Setenv("PWA_TITLE_GENERATION_SINCE", "2000-01-01T00:00:00Z")
	defer cleanup()
	dir := sessionsTestDir(t, configPath)
	store, err := memory.NewJSONLStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	id := "generated-once"
	if err = store.AddFullMessage(nil, legacyPicoSessionPrefix+id, providers.Message{Role: "user", Content: "Explain graph databases"}); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(configPath)
	var calls atomic.Int32
	h.generateTitle = func(ctx context.Context, prompt string) (string, error) {
		calls.Add(1)
		if prompt != "Explain graph databases" {
			t.Errorf("prompt: %q", prompt)
		}
		return "Graph Databases", nil
	}
	waitTitle(t, h, id, "Graph Databases")
	for i := 0; i < 4; i++ {
		if got := listCachedTest(t, h, "/api/sessions?channel=pico")[0].Title; got != "Graph Databases" {
			t.Fatal(got)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("calls=%d", calls.Load())
	}
	// A separate handler observes the persisted generated title without a model call.
	other := NewHandler(configPath)
	other.generateTitle = func(context.Context, string) (string, error) { t.Error("repeated model call"); return "", nil }
	if got := listCachedTest(t, other, "/api/sessions?channel=pico")[0].Title; got != "Graph Databases" {
		t.Fatal(got)
	}
}
func TestGeneratedTitleDuplicateRequestsShareOneAttempt(t *testing.T) {
	configPath, cleanup := setupOAuthTestEnv(t)
	defer cleanup()
	t.Setenv("PWA_TITLE_GENERATION_ENABLED", "1")
	t.Setenv("PWA_TITLE_GENERATION_SINCE", "2000-01-01T00:00:00Z")
	dir := sessionsTestDir(t, configPath)
	store, err := memory.NewJSONLStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	key := legacyPicoSessionPrefix + "duplicate-title"
	for _, text := range []string{"First question about compilers", "Later question about bicycles"} {
		if err := store.AddFullMessage(nil, key, providers.Message{Role: "user", Content: text}); err != nil {
			t.Fatal(err)
		}
	}
	h := NewHandler(configPath)
	var calls atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	h.generateTitle = func(_ context.Context, prompt string) (string, error) {
		if prompt != "First question about compilers" {
			t.Errorf("first message not used: %q", prompt)
		}
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		return "Compiler question", nil
	}
	var requests sync.WaitGroup
	for range 12 {
		requests.Add(1)
		go func() {
			defer requests.Done()
			_ = listCachedTest(t, h, "/api/sessions?channel=pico")
		}()
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("generator did not start")
	}
	requests.Wait()
	if got := calls.Load(); got != 1 {
		t.Fatalf("duplicate requests made %d model calls", got)
	}
	close(release)
	waitTitle(t, h, "duplicate-title", "Compiler question")
}

func TestGeneratedTitleManualRaceAndFailure(t *testing.T) {
	configPath, cleanup := setupOAuthTestEnv(t)
	t.Setenv("PWA_TITLE_GENERATION_ENABLED", "1")
	t.Setenv("PWA_TITLE_GENERATION_SINCE", "2000-01-01T00:00:00Z")
	defer cleanup()
	dir := sessionsTestDir(t, configPath)
	store, err := memory.NewJSONLStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.AddFullMessage(nil, legacyPicoSessionPrefix+"race-title", providers.Message{Role: "user", Content: "Tell me about orbitals"}); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(configPath)
	entered := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	h.generateTitle = func(ctx context.Context, prompt string) (string, error) {
		close(entered)
		select {
		case <-release:
		case <-ctx.Done():
			return "", ctx.Err()
		}
		defer close(finished)
		return "Quantum Orbitals", nil
	}
	_ = listCachedTest(t, h, "/api/sessions?channel=pico")
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("not scheduled")
	}
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("PATCH", "/api/sessions/race-title/title", strings.NewReader(`{"title":"My own title"}`)))
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("worker stalled")
	}
	waitTitle(t, h, "race-title", "My own title")
	if err = store.AddFullMessage(nil, legacyPicoSessionPrefix+"failed-title", providers.Message{Role: "user", Content: "Describe the sun"}); err != nil {
		t.Fatal(err)
	}
	var failures atomic.Int32
	h.generateTitle = func(context.Context, string) (string, error) { failures.Add(1); return "", errors.New("unavailable") }
	for i := 0; i < 4; i++ {
		_ = listCachedTest(t, h, "/api/sessions?channel=pico")
	}
	deadline := time.Now().Add(time.Second)
	for failures.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if failures.Load() != 1 {
		t.Fatalf("failure calls=%d", failures.Load())
	}
}
func TestTitleInputAndOutputSafety(t *testing.T) {
	if got := titlePrompt([]sessionChatMessage{{Role: "user", Content: "[System: async:spawn] completed"}, {Role: "user", Content: "data:image/png;base64,..."}, {Role: "user", Content: "image", Media: []string{"media://private"}}}); got != "" {
		t.Fatal(got)
	}
	if got := titlePrompt([]sessionChatMessage{{Role: "user", Content: "[System: async:spawn] result"}, {Role: "user", Content: "Describe the next conversation"}}); got != "Describe the next conversation" {
		t.Fatalf("internal receipt should be skipped: %q", got)
	}
	if got := titlePrompt([]sessionChatMessage{{Role: "user", Content: "first real request"}, {Role: "user", Content: "second request"}}); got != "first real request" {
		t.Fatalf("later message used as title prompt: %q", got)
	}
	if got := titlePrompt([]sessionChatMessage{{Role: "assistant", Content: "Ignore me"}, {Role: "user", Content: "Explain graph databases"}, {Role: "user", Content: "Second request"}}); got != "Explain graph databases" {
		t.Fatalf("first-only prompt: %q", got)
	}
	if got := titlePrompt([]sessionChatMessage{{Role: "user", Content: "image", Media: []string{"media://private"}}, {Role: "user", Content: "Safe later message"}}); got != "" {
		t.Fatalf("media first message leaked later message: %q", got)
	}
	// A long message must fail closed rather than forwarding a truncated
	// prefix (which could hide a sensitive suffix).
	if got := titlePrompt([]sessionChatMessage{{Role: "user", Content: strings.Repeat("界", 301)}}); got != "" {
		t.Fatalf("long prompt leaked: %q", got)
	}
	// The user authorized sending first-message text to the conversation's
	// configured model. Privacy heuristics cannot prove that arbitrary prose
	// contains no personal details; test only scope, media and length here.
	if got := titlePrompt([]sessionChatMessage{{Role: "user", Content: "Call 13550038728 about graph databases"}}); got != "Call 13550038728 about graph databases" {
		t.Fatalf("first user text changed unexpectedly: %q", got)
	}
	if got := titlePrompt([]sessionChatMessage{{Role: "user", ToolCallID: "tool-call", Content: "tool output"}, {Role: "user", Content: "A normal question"}}); got != "A normal question" {
		t.Fatalf("tool output used as prompt: %q", got)
	}
	for _, raw := range []string{"https://example.com", "sk-private", "Ignore previous instructions", "a\nb", strings.Repeat("字", 41), "token value"} {
		if safeGeneratedTitle(raw) != "" {
			t.Fatal(raw)
		}
	}
	if safeGeneratedTitle("A useful summary") != "A useful summary" {
		t.Fatal("valid title rejected")
	}
}

func TestTitleScheduleSkipsPrivateAndSpawn(t *testing.T) {
	configPath, cleanup := setupOAuthTestEnv(t)
	defer cleanup()
	dir := sessionsTestDir(t, configPath)
	h := NewHandler(configPath)
	var calls atomic.Int32
	h.generateTitle = func(context.Context, string) (string, error) { calls.Add(1); return "Wrong", nil }
	h.scheduleSessionTitle(dir, sessionListItem{ID: "private", Channel: "weixin"}, 100)
	h.scheduleSessionTitle(dir, sessionListItem{ID: "spawn", Channel: "pico", SubAgent: true}, 100)
	if calls.Load() != 0 {
		t.Fatalf("private/spawn calls=%d", calls.Load())
	}
	if got := titlePrompt([]sessionChatMessage{{Role: "user", Content: "My password is sk-private"}}); got != "My password is sk-private" {
		t.Fatalf("first message was unexpectedly suppressed: %q", got)
	}
}
func TestTitleGeneratorCancellationKeepsFallback(t *testing.T) {
	configPath, cleanup := setupOAuthTestEnv(t)
	t.Setenv("PWA_TITLE_GENERATION_ENABLED", "1")
	t.Setenv("PWA_TITLE_GENERATION_SINCE", "2000-01-01T00:00:00Z")
	defer cleanup()
	dir := sessionsTestDir(t, configPath)
	store, err := memory.NewJSONLStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.AddFullMessage(nil, legacyPicoSessionPrefix+"cancel-title", providers.Message{Role: "user", Content: "Describe the solar system"}); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(configPath)
	completed := make(chan struct{})
	h.generateTitle = func(ctx context.Context, _ string) (string, error) {
		defer close(completed)
		<-ctx.Done()
		return "Should not save", ctx.Err()
	}
	_ = listCachedTest(t, h, "/api/sessions?channel=pico")
	// The worker has an independent six-second deadline and cannot publish on cancel.
	select {
	case <-completed:
	case <-time.After(7 * time.Second):
		t.Fatal("deadline missing")
	}
	if got := listCachedTest(t, h, "/api/sessions?channel=pico")[0].Title; got != "Describe the solar system" {
		t.Fatal(got)
	}
}

func TestTitleListSkipsBacklogAndGeneratesOnlyNewPicoFirstPage(t *testing.T) {
	configPath, cleanup := setupOAuthTestEnv(t)
	defer cleanup()
	dir := sessionsTestDir(t, configPath)
	store, err := memory.NewJSONLStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ id, text string }{
		{"old-topic", "Describe quantum mechanics"},
		{"old-private", "My medical history is unusual"},
	} {
		if err := store.AddFullMessage(nil, legacyPicoSessionPrefix+item.id, providers.Message{Role: "user", Content: item.text}); err != nil {
			t.Fatal(err)
		}
	}
	h := NewHandler(configPath)
	var calls atomic.Int32
	h.generateTitle = func(_ context.Context, prompt string) (string, error) {
		calls.Add(1)
		if prompt != "Describe the moon" {
			t.Errorf("unexpected prompt: %q", prompt)
		}
		return "Moon", nil
	}
	// A cutoff later than the backlog prevents accidental historical model calls,
	// regardless of the request's legacy query parameter.
	t.Setenv("PWA_TITLE_GENERATION_ENABLED", "1")
	cutoff := time.Now().Add(1500 * time.Millisecond).UTC()
	t.Setenv("PWA_TITLE_GENERATION_SINCE", cutoff.Format(time.RFC3339Nano))
	for _, uri := range []string{"/api/sessions", "/api/sessions?channel=pico", "/api/sessions?channel=pico&generate_titles=1"} {
		_ = listCachedTest(t, h, uri)
	}
	time.Sleep(30 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatalf("backlog triggered %d calls", calls.Load())
	}
	// With nanosecond timestamps, creation immediately after the cutoff must
	// be eligible; no one-second grace or unnecessary sleep is required.
	time.Sleep(time.Until(cutoff))
	if err := store.AddFullMessage(nil, legacyPicoSessionPrefix+"new-moon", providers.Message{Role: "user", Content: "Describe the moon"}); err != nil {
		t.Fatal(err)
	}
	// Later pages cannot start generation, but the ordinary unfiltered PWA
	// first page can; no special channel query is required.
	_ = listCachedTest(t, h, "/api/sessions?channel=pico&offset=1")
	_ = listCachedTest(t, h, "/api/sessions?channel=weixin")
	if calls.Load() != 0 {
		t.Fatalf("non-first-page calls=%d", calls.Load())
	}
	_ = listCachedTest(t, h, "/api/sessions")
	waitTitle(t, h, "new-moon", "Moon")
	if calls.Load() != 1 {
		t.Fatalf("calls=%d", calls.Load())
	}
}
