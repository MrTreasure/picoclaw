package media

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/h2non/filetype"

	"github.com/sipeed/picoclaw/pkg/logger"
)

// CleanupPolicy controls how the MediaStore treats the underlying file when
// a ref is released or expires.
type CleanupPolicy string

const (
	// CleanupPolicyDeleteOnCleanup means the file is store-managed and may be
	// deleted once the final ref for that path is gone.
	CleanupPolicyDeleteOnCleanup CleanupPolicy = "delete_on_cleanup"
	// CleanupPolicyForgetOnly means the store should only drop ref mappings and
	// must never delete the underlying file.
	CleanupPolicyForgetOnly CleanupPolicy = "forget_only"
)

// MediaMeta holds metadata about a stored media file.
type MediaMeta struct {
	Filename      string
	ContentType   string
	Source        string        // "telegram", "discord", "tool:image-gen", etc.
	CleanupPolicy CleanupPolicy // defaults to CleanupPolicyDeleteOnCleanup
	PublicURL     string        // set only after an image has been published
}

// MediaStore manages the lifecycle of media files associated with processing scopes.
type MediaStore interface {
	// Store registers an existing local file under the given scope.
	// Returns a ref identifier (e.g. "media://<id>").
	// Store does not move or copy the file; it only records the mapping.
	// If meta.CleanupPolicy is empty, CleanupPolicyDeleteOnCleanup is assumed.
	Store(localPath string, meta MediaMeta, scope string) (ref string, err error)

	// Resolve returns the local file path for a given ref.
	Resolve(ref string) (localPath string, err error)

	// ResolveWithMeta returns the local file path and metadata for a given ref.
	ResolveWithMeta(ref string) (localPath string, meta MediaMeta, err error)

	// ReleaseAll deletes all files registered under the given scope
	// and removes the mapping entries. File-not-exist errors are ignored.
	ReleaseAll(scope string) error
}

// mediaEntry holds the path and metadata for a stored media file.
type mediaEntry struct {
	path      string
	meta      MediaMeta
	storedAt  time.Time
	publicKey string
}

type pathRefState struct {
	refCount       int
	deleteEligible bool
}

// MediaCleanerConfig configures the background TTL cleanup.
type MediaCleanerConfig struct {
	Enabled  bool
	MaxAge   time.Duration
	Interval time.Duration
}

// FileMediaStore is a pure in-memory implementation of MediaStore.
// Files are expected to already exist on disk (e.g. in /tmp/picoclaw_media/).
type FileMediaStore struct {
	mu             sync.RWMutex
	publicMu       sync.Mutex
	imagePublisher ImagePublisher
	refs           map[string]mediaEntry
	scopeToRefs    map[string]map[string]struct{}
	refToScope     map[string]string
	refToPath      map[string]string
	pathStates     map[string]pathRefState

	cleanerCfg MediaCleanerConfig
	stop       chan struct{}
	startOnce  sync.Once
	stopOnce   sync.Once
	nowFunc    func() time.Time // for testing
}

func (s *FileMediaStore) SetImagePublisher(p ImagePublisher) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.imagePublisher = p
}

// PublishImage uploads one registered image once and stores its public URL.
// Calls for the same store are serialized so repeated message resolution does
// not publish duplicate objects.
func (s *FileMediaStore) PublishImage(ctx context.Context, ref string) (string, error) {
	s.publicMu.Lock()
	defer s.publicMu.Unlock()
	s.mu.RLock()
	entry, ok := s.refs[ref]
	publisher := s.imagePublisher
	s.mu.RUnlock()
	if !ok {
		return "", fmt.Errorf("unknown media ref")
	}
	if entry.meta.PublicURL != "" {
		return entry.meta.PublicURL, nil
	}
	if publisher == nil {
		return "", nil
	}
	allowedTypes := map[string]string{
		"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
		"image/webp": ".webp", "image/bmp": ".bmp",
	}
	ext, allowed := allowedTypes[entry.meta.ContentType]
	if !allowed {
		return "", fmt.Errorf("media is not an image")
	}
	actual, err := filetype.MatchFile(entry.path)
	if err != nil || actual.MIME.Value != entry.meta.ContentType {
		return "", fmt.Errorf("image content does not match its type")
	}
	refID := strings.TrimPrefix(ref, "media://")
	if refID == ref || refID == "" || strings.Contains(refID, "/") {
		return "", fmt.Errorf("invalid media ref")
	}
	key := "muse-chat/" + refID + ext
	if err := publisher.Put(ctx, key, entry.path, entry.meta.ContentType); err != nil {
		return "", err
	}
	url := publisher.URL(key)
	s.mu.Lock()
	if current, exists := s.refs[ref]; exists {
		current.meta.PublicURL = url
		current.publicKey = key
		s.refs[ref] = current
	} else {
		s.mu.Unlock()
		_ = publisher.Delete(context.Background(), key)
		return "", fmt.Errorf("media ref expired during upload")
	}
	s.mu.Unlock()
	return url, nil
}

// NewFileMediaStore creates a new FileMediaStore without background cleanup.
func NewFileMediaStore() *FileMediaStore {
	return &FileMediaStore{
		refs:        make(map[string]mediaEntry),
		scopeToRefs: make(map[string]map[string]struct{}),
		refToScope:  make(map[string]string),
		refToPath:   make(map[string]string),
		pathStates:  make(map[string]pathRefState),
		nowFunc:     time.Now,
	}
}

// NewFileMediaStoreWithCleanup creates a FileMediaStore with TTL-based background cleanup.
func NewFileMediaStoreWithCleanup(cfg MediaCleanerConfig) *FileMediaStore {
	return &FileMediaStore{
		refs:        make(map[string]mediaEntry),
		scopeToRefs: make(map[string]map[string]struct{}),
		refToScope:  make(map[string]string),
		refToPath:   make(map[string]string),
		pathStates:  make(map[string]pathRefState),
		cleanerCfg:  cfg,
		stop:        make(chan struct{}),
		nowFunc:     time.Now,
	}
}

// Store registers a local file under the given scope. The file must exist.
func (s *FileMediaStore) Store(localPath string, meta MediaMeta, scope string) (string, error) {
	if _, err := os.Stat(localPath); err != nil {
		return "", fmt.Errorf("media store: %s: %w", localPath, err)
	}

	ref := "media://" + uuid.New().String()
	meta.CleanupPolicy = normalizeCleanupPolicy(meta.CleanupPolicy)

	s.mu.Lock()
	defer s.mu.Unlock()

	s.refs[ref] = mediaEntry{path: localPath, meta: meta, storedAt: s.nowFunc()}
	if s.scopeToRefs[scope] == nil {
		s.scopeToRefs[scope] = make(map[string]struct{})
	}
	s.scopeToRefs[scope][ref] = struct{}{}
	s.refToScope[ref] = scope
	s.refToPath[ref] = localPath

	pathState := s.pathStates[localPath]
	if pathState.refCount == 0 {
		pathState.deleteEligible = meta.CleanupPolicy == CleanupPolicyDeleteOnCleanup
	} else if meta.CleanupPolicy == CleanupPolicyForgetOnly {
		// Be conservative: once a path is borrowed externally, never let this
		// lifecycle auto-delete it even if store-managed refs also exist.
		pathState.deleteEligible = false
	}
	pathState.refCount++
	s.pathStates[localPath] = pathState

	return ref, nil
}

// Resolve returns the local path for the given ref.
func (s *FileMediaStore) Resolve(ref string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	entry, ok := s.refs[ref]
	if !ok {
		return "", fmt.Errorf("media store: unknown ref: %s", ref)
	}
	return entry.path, nil
}

// ResolveWithMeta returns the local path and metadata for the given ref.
func (s *FileMediaStore) ResolveWithMeta(ref string) (string, MediaMeta, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	entry, ok := s.refs[ref]
	if !ok {
		return "", MediaMeta{}, fmt.Errorf("media store: unknown ref: %s", ref)
	}
	return entry.path, entry.meta, nil
}

// ReleaseAll removes all files under the given scope and cleans up mappings.
// Phase 1 (under lock): remove entries from maps.
// Phase 2 (no lock): delete store-managed files from disk once their final
// path ref is gone.
func (s *FileMediaStore) ReleaseAll(scope string) error {
	// Phase 1: collect paths and remove from maps under lock
	var paths []string
	var publicKeys []string

	s.mu.Lock()
	publisher := s.imagePublisher
	refs, ok := s.scopeToRefs[scope]
	if !ok {
		s.mu.Unlock()
		return nil
	}

	for ref := range refs {
		fallbackPath := ""
		if entry, exists := s.refs[ref]; exists {
			fallbackPath = entry.path
			if entry.publicKey != "" {
				publicKeys = append(publicKeys, entry.publicKey)
			}
		}
		if removablePath, shouldDelete := s.releaseRefLocked(ref, fallbackPath); shouldDelete {
			paths = append(paths, removablePath)
		}
	}
	delete(s.scopeToRefs, scope)
	s.mu.Unlock()

	// Phase 2: delete files without holding the lock
	for _, p := range paths {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			logger.WarnCF("media", "release: failed to remove file", map[string]any{
				"path":  p,
				"error": err.Error(),
			})
		}
	}
	s.deletePublicImages(publisher, publicKeys)

	return nil
}

// CleanExpired removes all entries older than MaxAge.
// Phase 1 (under lock): identify expired entries and remove from maps.
// Phase 2 (no lock): delete store-managed files from disk to minimize lock contention.
func (s *FileMediaStore) CleanExpired() int {
	if s.cleanerCfg.MaxAge <= 0 {
		return 0
	}

	// Phase 1: collect expired entries under lock
	type expiredEntry struct {
		ref        string
		deletePath string
		publicKey  string
	}

	s.mu.Lock()
	publisher := s.imagePublisher
	cutoff := s.nowFunc().Add(-s.cleanerCfg.MaxAge)
	var expired []expiredEntry

	for ref, entry := range s.refs {
		if entry.storedAt.Before(cutoff) {
			if scope, ok := s.refToScope[ref]; ok {
				if scopeRefs, ok := s.scopeToRefs[scope]; ok {
					delete(scopeRefs, ref)
					if len(scopeRefs) == 0 {
						delete(s.scopeToRefs, scope)
					}
				}
			}

			expiredItem := expiredEntry{ref: ref, publicKey: entry.publicKey}
			if deletePath, shouldDelete := s.releaseRefLocked(ref, entry.path); shouldDelete {
				expiredItem.deletePath = deletePath
			}
			expired = append(expired, expiredItem)
		}
	}
	s.mu.Unlock()

	// Phase 2: delete files without holding the lock
	for _, e := range expired {
		if e.deletePath == "" {
			continue
		}
		if err := os.Remove(e.deletePath); err != nil && !os.IsNotExist(err) {
			logger.WarnCF("media", "cleanup: failed to remove file", map[string]any{
				"path":  e.deletePath,
				"error": err.Error(),
			})
		}
	}
	var publicKeys []string
	for _, e := range expired {
		if e.publicKey != "" {
			publicKeys = append(publicKeys, e.publicKey)
		}
	}
	s.deletePublicImages(publisher, publicKeys)

	return len(expired)
}

func (s *FileMediaStore) deletePublicImages(publisher ImagePublisher, keys []string) {
	if publisher == nil {
		return
	}
	for _, key := range keys {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := publisher.Delete(ctx, key)
		cancel()
		if err != nil {
			logger.WarnCF("media", "failed to delete public image", map[string]any{"key": key, "error": err.Error()})
		}
	}
}

func normalizeCleanupPolicy(policy CleanupPolicy) CleanupPolicy {
	switch policy {
	case "", CleanupPolicyDeleteOnCleanup:
		return CleanupPolicyDeleteOnCleanup
	case CleanupPolicyForgetOnly:
		return CleanupPolicyForgetOnly
	default:
		return CleanupPolicyDeleteOnCleanup
	}
}

func (s *FileMediaStore) releaseRefLocked(ref, fallbackPath string) (string, bool) {
	path := fallbackPath
	if storedPath, ok := s.refToPath[ref]; ok {
		path = storedPath
		delete(s.refToPath, ref)
	}

	delete(s.refs, ref)
	delete(s.refToScope, ref)

	if path == "" {
		return "", false
	}

	pathState, ok := s.pathStates[path]
	if !ok {
		return "", false
	}
	if pathState.refCount <= 1 {
		delete(s.pathStates, path)
		return path, pathState.deleteEligible
	}

	pathState.refCount--
	s.pathStates[path] = pathState
	return "", false
}

// Start begins the background cleanup goroutine if cleanup is enabled.
// Safe to call multiple times; only the first call starts the goroutine.
func (s *FileMediaStore) Start() {
	if !s.cleanerCfg.Enabled || s.stop == nil {
		return
	}
	if s.cleanerCfg.Interval <= 0 || s.cleanerCfg.MaxAge <= 0 {
		logger.WarnCF("media", "cleanup: skipped due to invalid config", map[string]any{
			"interval": s.cleanerCfg.Interval.String(),
			"max_age":  s.cleanerCfg.MaxAge.String(),
		})
		return
	}

	s.startOnce.Do(func() {
		logger.InfoCF("media", "cleanup enabled", map[string]any{
			"interval": s.cleanerCfg.Interval.String(),
			"max_age":  s.cleanerCfg.MaxAge.String(),
		})

		go func() {
			ticker := time.NewTicker(s.cleanerCfg.Interval)
			defer ticker.Stop()

			for {
				select {
				case <-ticker.C:
					if n := s.CleanExpired(); n > 0 {
						logger.InfoCF("media", "cleanup: removed expired entries", map[string]any{
							"count": n,
						})
					}
					s.sweepPublicImages()
				case <-s.stop:
					return
				}
			}
		}()
	})
}

func (s *FileMediaStore) sweepPublicImages() {
	s.mu.RLock()
	publisher := s.imagePublisher
	s.mu.RUnlock()
	sweeper, ok := publisher.(interface {
		Sweep(context.Context, time.Time) error
	})
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := sweeper.Sweep(ctx, time.Now().Add(-s.cleanerCfg.MaxAge)); err != nil {
		logger.WarnCF("media", "failed to sweep expired public images", map[string]any{"error": err.Error()})
	}
}

// Stop terminates the background cleanup goroutine.
// Safe to call multiple times; only the first call closes the channel.
func (s *FileMediaStore) Stop() {
	if s.stop == nil {
		return
	}
	s.stopOnce.Do(func() {
		close(s.stop)
	})
}
