package middleware

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrCreateLauncherDashboardSessionCookiePersists(t *testing.T) {
	dir := t.TempDir()
	first, err := LoadOrCreateLauncherDashboardSessionCookie(dir)
	if err != nil {
		t.Fatalf("first load: %v", err)
	}
	second, err := LoadOrCreateLauncherDashboardSessionCookie(dir)
	if err != nil {
		t.Fatalf("second load: %v", err)
	}
	if first == "" || first != second {
		t.Fatalf("session key did not persist")
	}

	info, err := os.Stat(filepath.Join(dir, launcherDashboardSessionFilename))
	if err != nil {
		t.Fatalf("stat session key: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode = %o, want 600", got)
	}
}

func TestLoadOrCreateLauncherDashboardSessionCookieRejectsCorruption(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, launcherDashboardSessionFilename)
	if err := os.WriteFile(path, []byte("not-a-session-key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateLauncherDashboardSessionCookie(dir); err == nil {
		t.Fatal("expected corrupt session key to fail closed")
	}
}
