package deviceauth

import (
	"crypto/subtle"
	"errors"
	"sync"
	"time"
)

const webGrantBytes = 32

var ErrInvalidGrant = errors.New("invalid or expired web login grant")

type webGrant struct {
	deviceID string
	expires  time.Time
}

type GrantStore struct {
	mu     sync.Mutex
	grants map[string]webGrant
	now    func() time.Time
}

func NewGrantStore() *GrantStore {
	return &GrantStore{grants: make(map[string]webGrant), now: time.Now}
}

func (s *GrantStore) Issue(deviceID string, ttl time.Duration) (string, error) {
	nonce, err := randomToken(webGrantBytes)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for key, grant := range s.grants {
		if !now.Before(grant.expires) {
			delete(s.grants, key)
		}
	}
	s.grants[nonce] = webGrant{deviceID: deviceID, expires: now.Add(ttl)}
	return nonce, nil
}

func (s *GrantStore) Consume(nonce string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, grant := range s.grants {
		if len(key) != len(nonce) || subtle.ConstantTimeCompare([]byte(key), []byte(nonce)) != 1 {
			continue
		}
		delete(s.grants, key)
		if !s.now().Before(grant.expires) {
			return "", ErrInvalidGrant
		}
		return grant.deviceID, nil
	}
	return "", ErrInvalidGrant
}
