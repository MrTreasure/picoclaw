package deviceauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	Filename          = "launcher-device-auth.json"
	credentialBytes   = 32
	deviceIDBytes     = 16
	maxDeviceNameRune = 80
	lastSeenWriteGap  = 24 * time.Hour
)

var (
	ErrInvalidName       = errors.New("device name must contain between 1 and 80 characters")
	ErrUnknownCredential = errors.New("unknown device credential")
)

type Device struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	LastSeen  time.Time `json:"last_seen"`
}

type persistedDevice struct {
	Device
	TokenHash string `json:"token_hash"`
}

type persistedStore struct {
	Version int               `json:"version"`
	Devices []persistedDevice `json:"devices"`
}

type Store struct {
	mu   sync.Mutex
	path string
	now  func() time.Time
}

func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create device credential directory: %w", err)
	}
	s := &Store{path: filepath.Join(dir, Filename), now: time.Now}
	if _, err := s.loadLocked(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Create(ctx context.Context, name string) (Device, string, error) {
	if err := ctx.Err(); err != nil {
		return Device{}, "", err
	}
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxDeviceNameRune {
		return Device{}, "", ErrInvalidName
	}
	id, err := randomToken(deviceIDBytes)
	if err != nil {
		return Device{}, "", err
	}
	token, err := randomToken(credentialBytes)
	if err != nil {
		return Device{}, "", err
	}
	now := s.now().UTC()
	device := Device{ID: id, Name: name, CreatedAt: now, LastSeen: now}
	record := persistedDevice{Device: device, TokenHash: hashToken(token)}

	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := s.loadLocked()
	if err != nil {
		return Device{}, "", err
	}
	data.Devices = append(data.Devices, record)
	if err := s.saveLocked(data); err != nil {
		return Device{}, "", err
	}
	return device, token, nil
}

func (s *Store) Authenticate(ctx context.Context, token string) (string, bool, error) {
	if err := ctx.Err(); err != nil {
		return "", false, err
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return "", false, nil
	}
	want, err := hex.DecodeString(hashToken(token))
	if err != nil {
		return "", false, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := s.loadLocked()
	if err != nil {
		return "", false, err
	}
	for i := range data.Devices {
		got, decodeErr := hex.DecodeString(data.Devices[i].TokenHash)
		if decodeErr != nil || len(got) != len(want) || subtle.ConstantTimeCompare(got, want) != 1 {
			continue
		}
		now := s.now().UTC()
		if now.Sub(data.Devices[i].LastSeen) >= lastSeenWriteGap {
			data.Devices[i].LastSeen = now
			if err := s.saveLocked(data); err != nil {
				return "", false, err
			}
		}
		return data.Devices[i].ID, true, nil
	}
	return "", false, nil
}

func (s *Store) List(ctx context.Context) ([]Device, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	devices := make([]Device, 0, len(data.Devices))
	for _, item := range data.Devices {
		devices = append(devices, item.Device)
	}
	sort.Slice(devices, func(i, j int) bool { return devices[i].LastSeen.After(devices[j].LastSeen) })
	return devices, nil
}

func (s *Store) Revoke(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := s.loadLocked()
	if err != nil {
		return err
	}
	kept := data.Devices[:0]
	found := false
	for _, item := range data.Devices {
		if item.ID == id {
			found = true
			continue
		}
		kept = append(kept, item)
	}
	if !found {
		return ErrUnknownCredential
	}
	data.Devices = kept
	return s.saveLocked(data)
}

func (s *Store) loadLocked() (persistedStore, error) {
	data := persistedStore{Version: 1, Devices: []persistedDevice{}}
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return data, nil
	}
	if err != nil {
		return data, fmt.Errorf("read device credentials: %w", err)
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return data, fmt.Errorf("decode device credentials: %w", err)
	}
	if data.Version != 1 {
		return data, fmt.Errorf("unsupported device credential version %d", data.Version)
	}
	return data, nil
}

func (s *Store) saveLocked(data persistedStore) error {
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".launcher-device-auth-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, s.path)
}

func randomToken(size int) (string, error) {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
