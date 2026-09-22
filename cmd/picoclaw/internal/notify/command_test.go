package notify

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveContent(t *testing.T) {
	got, err := resolveContent("", "-", nil, strings.NewReader("from stdin\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got != "from stdin\n" {
		t.Fatalf("content = %q", got)
	}
}

func TestResolveTargetsCombinesAndDeduplicatesGroups(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "targets.json")
	data := `{
  "default": "owner",
  "groups": {
    "owner": [
      {"channel": "weixin", "to": "wx-user"},
      {"channel": "pico", "to": "pico-session"}
    ]
  }
}`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}

	targets, err := resolveTargets(dir, path, "", "", []string{"weixin:wx-user"}, []string{"owner"})
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 2 {
		t.Fatalf("target count = %d, want 2", len(targets))
	}
	if targets[0].Channel != "weixin" || targets[1].Channel != "pico" {
		t.Fatalf("targets = %#v", targets)
	}
}

func TestResolveTargetsUsesDefaultGroup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "targets.json")
	if err := os.WriteFile(path, []byte(`{
  "default": "owner",
  "groups": {"owner": [{"channel": "weixin", "to": "wx-user"}]}
}`), 0o600); err != nil {
		t.Fatal(err)
	}

	targets, err := resolveTargets(dir, path, "", "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 1 || targets[0].To != "wx-user" {
		t.Fatalf("targets = %#v", targets)
	}
}

func TestResolveTargetsDiscoversSingleWeixinRecipient(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "channels", "weixin", "context-tokens")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(dir, "account.json"),
		[]byte(`{"tokens":{"wx-owner":"opaque-context-token"}}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	targets, err := resolveTargets(home, filepath.Join(home, "missing.json"), "", "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 1 || targets[0].Channel != "weixin" || targets[0].To != "wx-owner" {
		t.Fatalf("targets = %#v", targets)
	}
}
