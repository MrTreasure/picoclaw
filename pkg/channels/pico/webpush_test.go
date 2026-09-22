package pico

import (
	"context"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
)

func TestValidWebPushSubscription(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		endpoint string
		want     bool
	}{
		{name: "Chrome", endpoint: "https://fcm.googleapis.com/fcm/send/example", want: true},
		{name: "Firefox", endpoint: "https://updates.push.services.mozilla.com/wpush/v2/example", want: true},
		{name: "Safari", endpoint: "https://web.push.apple.com/example", want: true},
		{name: "Edge", endpoint: "https://wns2-bl2p.notify.windows.com/w/?token=example", want: true},
		{name: "HTTP", endpoint: "http://fcm.googleapis.com/fcm/send/example", want: false},
		{name: "Lookalike", endpoint: "https://fcm.googleapis.com.attacker.example/push", want: false},
		{name: "Unknown", endpoint: "https://push.example.com/example", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			subscription := webpush.Subscription{
				Endpoint: tt.endpoint,
				Keys: webpush.Keys{
					Auth:   "auth-key",
					P256dh: "p256dh-key",
				},
			}
			if got := validWebPushSubscription(subscription); got != tt.want {
				t.Fatalf("validWebPushSubscription() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestNotifyFinalSkipsWebPushForLiveSession(t *testing.T) {
	t.Parallel()

	ch := &PicoChannel{
		webPush: &picoPushService{
			subscriptions: make(map[string]webpush.Subscription),
		},
		sessionConnections: map[string]map[string]*picoConn{
			"live-session": {
				"connection-1": {id: "connection-1", sessionID: "live-session"},
			},
		},
	}

	if err := ch.notifyFinal(context.Background(), "pico:live-session", "final answer"); err != nil {
		t.Fatalf("notifyFinal() error = %v, want live WebSocket to bypass Web Push", err)
	}
}

func TestValidWebPushSubscriptionRequiresKeys(t *testing.T) {
	t.Parallel()

	subscription := webpush.Subscription{
		Endpoint: "https://fcm.googleapis.com/fcm/send/example",
	}
	if validWebPushSubscription(subscription) {
		t.Fatal("validWebPushSubscription() accepted a subscription without keys")
	}
}
