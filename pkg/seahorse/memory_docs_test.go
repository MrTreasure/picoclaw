package seahorse

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseDocQuery(t *testing.T) {
	tests := []struct {
		name     string
		pattern  string
		branches [][]string
		excluded []string
	}{
		{
			name:     "single term",
			pattern:  "缓存",
			branches: [][]string{{"缓存"}},
		},
		{
			name:     "AND is conjunctive",
			pattern:  "缓存 AND 命中率",
			branches: [][]string{{"缓存", "命中率"}},
		},
		{
			name:     "OR splits alternatives",
			pattern:  "auth OR signin",
			branches: [][]string{{"auth"}, {"signin"}},
		},
		{
			name:     "NOT excludes",
			pattern:  "bug NOT fixed",
			branches: [][]string{{"bug"}},
			excluded: []string{"fixed"},
		},
		{
			name:     "wildcards are stripped",
			pattern:  "%cache%",
			branches: [][]string{{"cache"}},
		},
		{
			name:    "operators only yields nothing",
			pattern: "AND OR",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseDocQuery(tt.pattern)
			if len(got.branches) != len(tt.branches) {
				t.Fatalf("branches = %v, want %v", got.branches, tt.branches)
			}
			for i := range tt.branches {
				if len(got.branches[i]) != len(tt.branches[i]) {
					t.Fatalf("branch %d = %v, want %v", i, got.branches[i], tt.branches[i])
				}
				for j := range tt.branches[i] {
					if got.branches[i][j] != tt.branches[i][j] {
						t.Fatalf("branch %d term %d = %q, want %q",
							i, j, got.branches[i][j], tt.branches[i][j])
					}
				}
			}
			if len(got.excluded) != len(tt.excluded) {
				t.Fatalf("excluded = %v, want %v", got.excluded, tt.excluded)
			}
		})
	}
}

func TestDocQueryMatch(t *testing.T) {
	tests := []struct {
		name    string
		pattern string
		content string
		want    bool
	}{
		{"case insensitive", "CACHE", "the cache was cold", true},
		{"AND both present", "cache AND warm", "cache is warm now", true},
		{"AND one missing", "cache AND warm", "cache is cold", false},
		{"OR first", "alpha OR beta", "only alpha here", true},
		{"OR second", "alpha OR beta", "only beta here", true},
		{"OR neither", "alpha OR beta", "gamma", false},
		{"NOT suppresses", "bug NOT fixed", "bug is fixed", false},
		{"NOT allows", "bug NOT fixed", "bug remains", true},
		{"chinese substring", "命中率", "缓存命中率 92%", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, got := parseDocQuery(tt.pattern).match(tt.content)
			if got != tt.want {
				t.Fatalf("match(%q, %q) = %v, want %v", tt.pattern, tt.content, got, tt.want)
			}
		})
	}
}

// The whole point of this scan is reaching daily notes that the injected
// context window (3 days) and the seahorse tables both miss.
func TestSearchMemoryDocs(t *testing.T) {
	ws := t.TempDir()
	mustWrite(t, filepath.Join(ws, "memory", "202608", "20260813.md"),
		"# 2026-08-13 日报\n\n今天调了缓存命中率，发现前缀被时间戳打断。\n")
	mustWrite(t, filepath.Join(ws, "memory", "202609", "20260919.md"),
		"# 2026-09-19 日报\n\n缓存的结论写在上面那天。\n")
	mustWrite(t, filepath.Join(ws, "memory", "MEMORY.md"),
		"# 记忆索引\n\n缓存相关的东西\n")
	mustWrite(t, filepath.Join(ws, "memory", "202609", "notes.txt"), "缓存\n")

	hits := searchMemoryDocs(ws, "缓存", 10)
	if len(hits) != 2 {
		t.Fatalf("hits = %d, want 2 (MEMORY.md and non-md must be skipped): %+v", len(hits), hits)
	}
	// Newest first.
	if hits[0].Date != "2026-09-19" || hits[1].Date != "2026-08-13" {
		t.Fatalf("order = %s, %s; want 2026-09-19 first", hits[0].Date, hits[1].Date)
	}
	if hits[0].Path != filepath.Join("memory", "202609", "20260919.md") {
		t.Fatalf("path = %q", hits[0].Path)
	}
	if hits[1].Snippet == "" {
		t.Fatal("snippet should carry the matching line")
	}
}

func TestSearchMemoryDocsRespectsLimit(t *testing.T) {
	ws := t.TempDir()
	for _, day := range []string{"20260801", "20260802", "20260803"} {
		mustWrite(t, filepath.Join(ws, "memory", "202608", day+".md"), "共同关键词\n")
	}

	if got := len(searchMemoryDocs(ws, "共同关键词", 2)); got != 2 {
		t.Fatalf("limit not honoured: got %d, want 2", got)
	}
	if got := len(searchMemoryDocs(ws, "共同关键词", 0)); got != 3 {
		t.Fatalf("limit<=0 should mean unlimited: got %d, want 3", got)
	}
}

func TestSearchMemoryDocsEdgeCases(t *testing.T) {
	if got := searchMemoryDocs("", "x", 10); got != nil {
		t.Fatalf("empty workspace should yield nothing, got %+v", got)
	}
	if got := searchMemoryDocs(t.TempDir(), "x", 10); got != nil {
		t.Fatalf("missing memory dir should yield nothing, got %+v", got)
	}
	if got := searchMemoryDocs(t.TempDir(), "   ", 10); got != nil {
		t.Fatalf("blank pattern should yield nothing, got %+v", got)
	}
}

func TestDocSnippet(t *testing.T) {
	content := "line one\nline two has needle here\nline three"
	at := len("line one\nline two has ")
	if got, want := docSnippet(content, at), "line two has needle here"; got != want {
		t.Fatalf("docSnippet = %q, want %q", got, want)
	}

	long := "start " + repeatRune('x', 500)
	if got := docSnippet(long, 0); len([]rune(got)) > docSnippetWidth+1 {
		t.Fatalf("snippet not capped: %d runes", len([]rune(got)))
	}
}

func TestDocDateFromName(t *testing.T) {
	tests := map[string]string{
		"20260919.md":       "2026-09-19",
		"202608-monthly.md": "202608-monthly",
		"random.md":         "random",
	}
	for in, want := range tests {
		if got := docDateFromName(in); got != want {
			t.Fatalf("docDateFromName(%q) = %q, want %q", in, got, want)
		}
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func repeatRune(r rune, n int) string {
	out := make([]rune, n)
	for i := range out {
		out[i] = r
	}
	return string(out)
}
