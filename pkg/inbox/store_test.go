package inbox

import (
	"path/filepath"
	"testing"
)

func TestReceiptRetryAndRecovery(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "inbox")
	s := New(dir)
	if _, e := s.Accept("s", "one", "hello", nil); e != nil {
		t.Fatal(e)
	}
	if !s.Take("s", "one") || s.Take("s", "one") {
		t.Fatal("duplicate dispatch")
	}
	if _, e := s.Accept("s", "one", "different", nil); e == nil {
		t.Fatal("conflicting retry accepted")
	}
	s = New(dir)
	queued, e := s.Recover()
	if e != nil || len(queued) != 1 {
		t.Fatalf("pending lost: %v %v", queued, e)
	}
	if ok, e := s.Claim("s", "one"); e != nil || !ok {
		t.Fatal(ok, e)
	}
	if ok, e := s.Claim("s", "one"); e != nil || ok {
		t.Fatal("duplicate execution", ok, e)
	}
	s = New(dir)
	queued, e = s.Recover()
	if e != nil || len(queued) != 0 {
		t.Fatal("unsafe replay", queued, e)
	}
	r, e := s.Accept("s", "one", "hello", nil)
	if e != nil || r.State != "interrupted" {
		t.Fatal("receipt lost across restart", r, e)
	}
	if _, e = s.Accept("other", "one", "different", nil); e != nil {
		t.Fatal("session isolation", e)
	}
}
