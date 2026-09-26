package api

import (
	"encoding/json"
	"testing"
)

func TestCodexClientMessageAllowedThreadDelete(t *testing.T) {
	cases := []struct {
		name    string
		request map[string]any
		want    bool
	}{
		{"delete", map[string]any{"id": 5, "method": "thread/delete", "params": map[string]any{"threadId": "test-thread"}}, true},
		{"missing thread ID", map[string]any{"id": 5, "method": "thread/delete", "params": map[string]any{}}, false},
		{"whitespace thread ID", map[string]any{"id": 5, "method": "thread/delete", "params": map[string]any{"threadId": "  "}}, false},
		{"notification delete", map[string]any{"method": "thread/delete", "params": map[string]any{"threadId": "test-thread"}}, false},
		{"archive remains disallowed", map[string]any{"id": 6, "method": "thread/archive", "params": map[string]any{"threadId": "test-thread"}}, false},
		{"unknown method remains disallowed", map[string]any{"id": 7, "method": "thread/erase", "params": map[string]any{}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request, err := json.Marshal(tc.request)
			if err != nil {
				t.Fatal(err)
			}
			if got := codexClientMessageAllowed(request); got != tc.want {
				t.Fatalf("codexClientMessageAllowed = %v, want %v", got, tc.want)
			}
		})
	}
}
