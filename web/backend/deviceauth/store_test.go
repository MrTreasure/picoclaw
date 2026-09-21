package deviceauth

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestStoreCredentialLifecycle(t *testing.T) {
	dir := t.TempDir()
	store, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	device, token, err := store.Create(context.Background(), "Xiaomi 17 Pro Max")
	if err != nil {
		t.Fatal(err)
	}
	if token == "" || device.ID == "" {
		t.Fatal("missing credential material")
	}
	raw, err := os.ReadFile(filepath.Join(dir, Filename))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(token)) {
		t.Fatal("credential was stored in plaintext")
	}
	id, ok, err := store.Authenticate(context.Background(), token)
	if err != nil || !ok || id != device.ID {
		t.Fatalf("authenticate = %q, %v, %v", id, ok, err)
	}
	if err := store.Revoke(context.Background(), device.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.Authenticate(context.Background(), token); err != nil || ok {
		t.Fatalf("revoked credential accepted: %v, %v", ok, err)
	}
}

func TestStoreRejectsInvalidNamesAndUnknownRevocation(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Create(context.Background(), "   "); !errors.Is(err, ErrInvalidName) {
		t.Fatalf("expected invalid name, got %v", err)
	}
	if err := store.Revoke(context.Background(), "missing"); !errors.Is(err, ErrUnknownCredential) {
		t.Fatalf("expected unknown credential, got %v", err)
	}
}
