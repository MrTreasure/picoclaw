// Package inbox owns durable Pico receipts independently of model history.
// Receipt means stored for processing, never that an AI task has completed.
package inbox

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/sipeed/picoclaw/pkg/config"
)

type Record struct {
	ID      string    `json:"id"`
	Session string    `json:"session"`
	Content string    `json:"content"`
	Media   []string  `json:"media,omitempty"`
	State   string    `json:"state"`
	Created time.Time `json:"created"`
}
type Store struct {
	mu         sync.Mutex
	dir        string
	dispatched map[string]bool
	memory     map[string]Record
	recovered  bool
}

func New(dir string) *Store {
	return &Store{dir: dir, dispatched: map[string]bool{}, memory: map[string]Record{}}
}

var once sync.Once
var shared *Store

func Default() *Store {
	once.Do(func() { shared = New(filepath.Join(config.GetHome(), "message-inbox")) })
	return shared
}
func key(session, id string) string {
	sum := sha256.Sum256([]byte(session + "\x00" + id))
	return hex.EncodeToString(sum[:])
}
func (s *Store) read(session, id string) (Record, error) {
	var r Record
	if s.dir == "" {
		r, ok := s.memory[key(session, id)]
		if !ok {
			return r, os.ErrNotExist
		}
		return r, nil
	}
	b, e := os.ReadFile(filepath.Join(s.dir, key(session, id)+".json"))
	if e == nil {
		e = json.Unmarshal(b, &r)
	}
	return r, e
}
func (s *Store) write(r Record) error {
	if s.dir == "" {
		s.memory[key(r.Session, r.ID)] = r
		return nil
	}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.dir, ".receipt-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(f.Name(), filepath.Join(s.dir, key(r.Session, r.ID)+".json")); err != nil {
		return err
	}
	dir, err := os.Open(s.dir)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func (s *Store) Accept(session, id, content string, media []string) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id == "" || len(id) > 128 || session == "" || len(session) > 256 {
		return Record{}, fmt.Errorf("invalid message identity")
	}
	old, err := s.read(session, id)
	if err == nil {
		a, _ := json.Marshal(old.Media)
		b, _ := json.Marshal(media)
		if old.Content != content || string(a) != string(b) {
			return Record{}, fmt.Errorf("message id reused with different content")
		}
		return old, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Record{}, err
	}
	r := Record{ID: id, Session: session, Content: content, Media: media, State: "queued", Created: time.Now().UTC()}
	return r, s.write(r)
}
func (s *Store) Get(session, id string) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.read(session, id)
}

// Take prevents parallel socket retries from filling the bus with duplicate work.
func (s *Store) Take(session, id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, e := s.read(session, id)
	k := key(session, id)
	if e != nil || r.State != "queued" || s.dispatched[k] {
		return false
	}
	s.dispatched[k] = true
	return true
}
func (s *Store) Release(session, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.dispatched, key(session, id))
}

// Claim is persisted before model/tool execution. A duplicate bus delivery cannot run twice.
func (s *Store) Claim(session, id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, e := s.read(session, id)
	if errors.Is(e, os.ErrNotExist) {
		return true, nil
	}
	if e != nil {
		return false, e
	}
	if r.State != "queued" {
		return false, nil
	}
	r.State = "processing"
	return true, s.write(r)
}
func (s *Store) Finish(session, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, e := s.read(session, id)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	if e != nil {
		return e
	}
	if r.State != "processing" {
		return nil
	}
	r.State = "finished"
	return s.write(r)
}

// Unstarted work resumes after a process restart. Work that may have performed
// tool side effects is explicitly interrupted, never blindly executed again.
func (s *Store) Recover() ([]Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	files, e := filepath.Glob(filepath.Join(s.dir, "*.json"))
	if e != nil {
		return nil, e
	}
	var queued []Record
	for _, p := range files {
		b, e := os.ReadFile(p)
		if e != nil {
			return nil, e
		}
		var r Record
		if e = json.Unmarshal(b, &r); e != nil {
			return nil, e
		}
		if r.State == "processing" && !s.recovered {
			r.State = "interrupted"
			if e = s.write(r); e != nil {
				return nil, e
			}
		}
		if r.State == "queued" {
			queued = append(queued, r)
		}
	}
	s.recovered = true
	sort.Slice(queued, func(i, j int) bool { return queued[i].Created.Before(queued[j].Created) })
	return queued, nil
}

// SessionState is a delivery/execution snapshot for reconnecting clients.
func (s *Store) SessionState(session string) (bool, []Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var records []Record
	if s.dir == "" {
		for _, r := range s.memory {
			records = append(records, r)
		}
	} else {
		files, e := filepath.Glob(filepath.Join(s.dir, "*.json"))
		if e != nil {
			return false, nil, e
		}
		for _, p := range files {
			b, e := os.ReadFile(p)
			if e != nil {
				return false, nil, e
			}
			var r Record
			if e = json.Unmarshal(b, &r); e != nil {
				return false, nil, e
			}
			records = append(records, r)
		}
	}
	active := false
	var interrupted []Record
	for _, r := range records {
		if r.Session != session {
			continue
		}
		if r.State == "queued" || r.State == "processing" {
			active = true
		}
		if r.State == "interrupted" {
			interrupted = append(interrupted, r)
		}
	}
	sort.Slice(interrupted, func(i, j int) bool { return interrupted[i].Created.Before(interrupted[j].Created) })
	if len(interrupted) > 20 {
		interrupted = interrupted[len(interrupted)-20:]
	}
	return active, interrupted, nil
}
