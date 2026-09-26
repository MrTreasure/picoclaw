package api

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const summaryCacheVersion = "pwa-session-summaries-v1"
const summaryCacheTTL = 30

type summaryCacheEnvelope struct {
	Version     string            `json:"version"`
	Fingerprint string            `json:"fingerprint"`
	Items       []sessionListItem `json:"items"`
}

// The manifest includes every regular file that can affect session discovery or
// transcript summaries. Metadata is sampled on every request; only JSON decoding
// and transcript scans are skipped on a hit. Concurrent changes trigger a direct
// scan (which, like the uncached endpoint, is not an atomic filesystem snapshot).
func sessionSummaryFingerprint(dir string, maxArgs int) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	fmt.Fprintf(hash, "%s\x00%d\x00", summaryCacheVersion, maxArgs)
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".meta.json") && !strings.HasSuffix(name, ".jsonl") && !strings.HasSuffix(name, ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return "", err
		}
		if !info.Mode().IsRegular() {
			continue
		}
		fmt.Fprintf(hash, "%d:%s:%d:%d\n", len(name), name, info.Size(), info.ModTime().UnixNano())
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// Reject malformed/untrusted cache payloads rather than serving invented sessions.
func validSummaryListing(items []sessionListItem) bool {
	if items == nil {
		return false
	}
	for _, item := range items {
		if item.ID == "" || (item.Channel != "pico" && item.Channel != "weixin") || item.MessageCount < 0 {
			return false
		}
	}
	return true
}

func (h *Handler) cachedSessionSummaries(dir string, maxArgs int) []sessionListItem {
	rawURL := os.Getenv("PWA_SESSION_REDIS_URL")
	if rawURL == "" {
		return h.scanSessionSummaries(dir, maxArgs)
	}
	before, err := sessionSummaryFingerprint(dir, maxArgs)
	if err != nil {
		return h.scanSessionSummaries(dir, maxArgs)
	}
	keyHash := sha256.Sum256([]byte(filepath.Clean(dir) + "\x00" + strconv.Itoa(maxArgs)))
	key := summaryCacheVersion + ":" + hex.EncodeToString(keyHash[:])
	if payload, err := redisSummaryCommand(rawURL, "GET", key); err == nil && len(payload) > 0 {
		var envelope summaryCacheEnvelope
		if json.Unmarshal(payload, &envelope) == nil && envelope.Version == summaryCacheVersion && envelope.Fingerprint == before && validSummaryListing(envelope.Items) {
			if after, err := sessionSummaryFingerprint(dir, maxArgs); err == nil && after == before {
				return envelope.Items
			}
		}
	} else if err != nil {
		return h.scanSessionSummaries(dir, maxArgs)
	}
	items := h.scanSessionSummaries(dir, maxArgs)
	after, err := sessionSummaryFingerprint(dir, maxArgs)
	if err == nil && before == after {
		payload, err := json.Marshal(summaryCacheEnvelope{Version: summaryCacheVersion, Fingerprint: before, Items: items})
		if err == nil {
			_, _ = redisSummaryCommand(rawURL, "SET", key, string(payload), "EX", strconv.Itoa(summaryCacheTTL))
		}
	}
	return items
}

// Small bounded RESP client: avoids introducing a dependency solely for this
// optional endpoint. A new connection per operation prevents shared-state races.
// Never include the URL, server errors, or credentials in diagnostics.
func redisSummaryCommand(rawURL string, args ...string) ([]byte, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "redis" && u.Scheme != "rediss") || u.Hostname() == "" {
		return nil, errors.New("invalid Redis URL")
	}
	port := u.Port()
	if port == "" {
		port = "6379"
	}
	addr := net.JoinHostPort(u.Hostname(), port)
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	dialer := &net.Dialer{Timeout: 350 * time.Millisecond}
	var conn net.Conn
	if u.Scheme == "rediss" {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: &tls.Config{ServerName: u.Hostname()}}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return nil, errors.New("Redis unavailable")
	}
	defer conn.Close()
	reader := bufio.NewReader(conn)
	run := func(parts ...string) ([]byte, error) {
		if err := conn.SetDeadline(time.Now().Add(400 * time.Millisecond)); err != nil {
			return nil, err
		}
		var b strings.Builder
		fmt.Fprintf(&b, "*%d\r\n", len(parts))
		for _, part := range parts {
			fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(part), part)
		}
		if _, err := io.WriteString(conn, b.String()); err != nil {
			return nil, err
		}
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		if len(line) < 3 || !strings.HasSuffix(line, "\r\n") {
			return nil, errors.New("bad Redis response")
		}
		switch line[0] {
		case '+':
			return []byte(line[1 : len(line)-2]), nil
		case '-':
			return nil, errors.New("Redis command failed")
		case '$':
			n, err := strconv.Atoi(strings.TrimSpace(line[1:]))
			if err != nil || n < -1 || n > 32<<20 {
				return nil, errors.New("bad Redis bulk length")
			}
			if n == -1 {
				return nil, nil
			}
			value := make([]byte, n+2)
			if _, err := io.ReadFull(reader, value); err != nil {
				return nil, err
			}
			if value[n] != '\r' || value[n+1] != '\n' {
				return nil, errors.New("bad Redis bulk response")
			}
			return value[:n], nil
		default:
			return nil, errors.New("unexpected Redis response")
		}
	}
	if u.User != nil {
		password, ok := u.User.Password()
		if ok {
			auth := []string{"AUTH"}
			if name := u.User.Username(); name != "" {
				auth = append(auth, name)
			}
			auth = append(auth, password)
			if _, err := run(auth...); err != nil {
				return nil, err
			}
		}
	}
	if db := strings.TrimPrefix(u.Path, "/"); db != "" && db != "0" {
		number, err := strconv.Atoi(db)
		if err != nil || number < 0 {
			return nil, errors.New("invalid Redis DB")
		}
		if _, err := run("SELECT", db); err != nil {
			return nil, err
		}
	}
	return run(args...)
}
