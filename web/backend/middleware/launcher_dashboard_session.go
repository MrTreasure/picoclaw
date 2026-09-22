package middleware

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/sipeed/picoclaw/pkg/fileutil"
)

const launcherDashboardSessionFilename = "launcher-auth-session.key"

// LoadOrCreateLauncherDashboardSessionCookie keeps the opaque dashboard
// session value stable across launcher restarts. The browser still stores only
// an HttpOnly cookie; the dashboard password remains bcrypt-only in SQLite.
func LoadOrCreateLauncherDashboardSessionCookie(dir string) (string, error) {
	path := filepath.Join(dir, launcherDashboardSessionFilename)
	data, err := os.ReadFile(path)
	if err == nil {
		value := strings.TrimSpace(string(data))
		decoded, decodeErr := base64.RawURLEncoding.DecodeString(value)
		if decodeErr != nil || len(decoded) != launcherSessionCookieBytes {
			return "", fmt.Errorf("invalid persisted dashboard session key %q", path)
		}
		if chmodErr := os.Chmod(path, 0o600); chmodErr != nil {
			return "", fmt.Errorf("secure dashboard session key %q: %w", path, chmodErr)
		}
		return value, nil
	}
	if !os.IsNotExist(err) {
		return "", fmt.Errorf("read dashboard session key %q: %w", path, err)
	}

	value, err := NewLauncherDashboardSessionCookie()
	if err != nil {
		return "", err
	}
	if err := fileutil.WriteFileAtomic(path, []byte(value+"\n"), 0o600); err != nil {
		return "", fmt.Errorf("persist dashboard session key %q: %w", path, err)
	}
	return value, nil
}
