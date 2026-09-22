package pico

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"github.com/sipeed/picoclaw/pkg/channels"
	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/logger"
)

const maxPushRequestBytes = 64 << 10

type picoPushService struct {
	mu            sync.RWMutex
	path          string
	publicKey     string
	privateKey    string
	subscriber    string
	subscriptions map[string]webpush.Subscription
	client        *http.Client
}

type picoPushPayload struct {
	Title     string `json:"title"`
	Body      string `json:"body"`
	SessionID string `json:"session_id"`
	URL       string `json:"url"`
}

func newPicoPushService(settings config.PicoWebPushSettings) *picoPushService {
	if !settings.Enabled || strings.TrimSpace(settings.PublicKey) == "" || settings.PrivateKey.String() == "" {
		return nil
	}
	subscriber := strings.TrimSpace(settings.Subscriber)
	subscriber = strings.TrimPrefix(subscriber, "mailto:")
	if subscriber == "" {
		subscriber = "webpush@mrtreasure.cc"
	}
	s := &picoPushService{
		path:          filepath.Join(config.GetHome(), "pico-web-push-subscriptions.json"),
		publicKey:     strings.TrimSpace(settings.PublicKey),
		privateKey:    settings.PrivateKey.String(),
		subscriber:    subscriber,
		subscriptions: make(map[string]webpush.Subscription),
		client:        &http.Client{Timeout: 8 * time.Second},
	}
	if err := s.load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		logger.WarnC("pico", "Could not load Web Push subscriptions; starting with an empty store")
	}
	return s
}

func (s *picoPushService) load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	var subscriptions []webpush.Subscription
	if err := json.Unmarshal(data, &subscriptions); err != nil {
		return err
	}
	for _, subscription := range subscriptions {
		if validWebPushSubscription(subscription) {
			s.subscriptions[subscription.Endpoint] = subscription
		}
	}
	return nil
}

func (s *picoPushService) saveLocked() error {
	subscriptions := make([]webpush.Subscription, 0, len(s.subscriptions))
	for _, subscription := range s.subscriptions {
		subscriptions = append(subscriptions, subscription)
	}
	data, err := json.MarshalIndent(subscriptions, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".pico-web-push-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, s.path)
}

func validWebPushSubscription(subscription webpush.Subscription) bool {
	u, err := url.Parse(subscription.Endpoint)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Hostname() == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	allowedHost := host == "fcm.googleapis.com" ||
		host == "updates.push.services.mozilla.com" ||
		host == "web.push.apple.com" ||
		host == "notify.windows.com" ||
		strings.HasSuffix(host, ".notify.windows.com")
	return allowedHost && strings.TrimSpace(subscription.Keys.Auth) != "" &&
		strings.TrimSpace(subscription.Keys.P256dh) != ""
}

func (s *picoPushService) hasSubscriptions() bool {
	if s == nil {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.subscriptions) > 0
}

func (s *picoPushService) upsert(subscription webpush.Subscription) error {
	if !validWebPushSubscription(subscription) {
		return fmt.Errorf("unsupported Web Push subscription endpoint")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subscriptions[subscription.Endpoint] = subscription
	return s.saveLocked()
}

func (s *picoPushService) remove(endpoint string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.subscriptions, strings.TrimSpace(endpoint))
	return s.saveLocked()
}

func (s *picoPushService) notify(ctx context.Context, payload picoPushPayload) (bool, error) {
	if s == nil {
		return false, nil
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return false, err
	}
	s.mu.RLock()
	subscriptions := make([]webpush.Subscription, 0, len(s.subscriptions))
	for _, subscription := range s.subscriptions {
		subscriptions = append(subscriptions, subscription)
	}
	s.mu.RUnlock()

	var sent bool
	var lastErr error
	var expired []string
	for i := range subscriptions {
		response, sendErr := webpush.SendNotificationWithContext(ctx, data, &subscriptions[i], &webpush.Options{
			HTTPClient:      s.client,
			Subscriber:      s.subscriber,
			TTL:             3600,
			Urgency:         webpush.UrgencyHigh,
			VAPIDPublicKey:  s.publicKey,
			VAPIDPrivateKey: s.privateKey,
		})
		if sendErr != nil {
			lastErr = sendErr
			continue
		}
		response.Body.Close()
		if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone {
			expired = append(expired, subscriptions[i].Endpoint)
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			lastErr = fmt.Errorf("push service returned status %d", response.StatusCode)
			continue
		}
		sent = true
	}
	if len(expired) > 0 {
		s.mu.Lock()
		for _, endpoint := range expired {
			delete(s.subscriptions, endpoint)
		}
		if err := s.saveLocked(); err != nil {
			logger.WarnC("pico", "Could not persist expired Web Push subscription cleanup")
		}
		s.mu.Unlock()
	}
	return sent, lastErr
}

func (c *PicoChannel) handlePushConfig(w http.ResponseWriter, r *http.Request) {
	if !c.authenticate(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	response := map[string]any{"enabled": c.webPush != nil}
	if c.webPush != nil {
		response["public_key"] = c.webPush.publicKey
	}
	_ = json.NewEncoder(w).Encode(response)
}

func (c *PicoChannel) handlePushSubscriptions(w http.ResponseWriter, r *http.Request) {
	if !c.authenticate(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if c.webPush == nil {
		http.Error(w, "push is not configured", http.StatusServiceUnavailable)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxPushRequestBytes)
	defer r.Body.Close()
	switch r.Method {
	case http.MethodPost:
		var subscription webpush.Subscription
		if err := json.NewDecoder(r.Body).Decode(&subscription); err != nil {
			http.Error(w, "invalid subscription", http.StatusBadRequest)
			return
		}
		if err := c.webPush.upsert(subscription); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		var body struct {
			Endpoint string `json:"endpoint"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Endpoint) == "" {
			http.Error(w, "invalid endpoint", http.StatusBadRequest)
			return
		}
		if err := c.webPush.remove(body.Endpoint); err != nil {
			http.Error(w, "failed to save subscription", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "POST, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func pushPayload(chatID, body string) picoPushPayload {
	sessionID := strings.TrimPrefix(chatID, "pico:")
	body = strings.TrimSpace(body)
	runes := []rune(body)
	if len(runes) > 220 {
		body = string(runes[:220]) + "…"
	}
	if body == "" {
		body = "收到一个新附件"
	}
	return picoPushPayload{
		Title:     "MuseC137",
		Body:      body,
		SessionID: sessionID,
		URL:       "/?session_id=" + url.QueryEscape(sessionID),
	}
}

func (c *PicoChannel) notifyFinal(ctx context.Context, chatID, body string) error {
	if c.webPush == nil {
		return nil
	}
	sessionID := strings.TrimPrefix(chatID, "pico:")
	// A live WebSocket already received the final message. Avoid blocking that
	// foreground delivery on an obsolete or unreachable push subscription.
	if len(c.sessionConnectionsSnapshot(sessionID)) > 0 {
		return nil
	}
	sent, err := c.webPush.notify(ctx, pushPayload(chatID, body))
	if sent {
		return nil
	}
	if err != nil {
		return fmt.Errorf("web push delivery failed: %w", err)
	}
	return fmt.Errorf("no active Chrome push subscription: %w", channels.ErrSendFailed)
}
