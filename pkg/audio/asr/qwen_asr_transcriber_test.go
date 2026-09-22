package asr

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sipeed/picoclaw/pkg/config"
)

func TestQwenASRTranscriberUsesQwenDataURIShape(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer secret" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		messages := body["messages"].([]any)
		content := messages[0].(map[string]any)["content"].([]any)
		input := content[0].(map[string]any)["input_audio"].(map[string]any)["data"].(string)
		if !strings.HasPrefix(input, "data:audio/aac;base64,") {
			t.Fatalf("input_audio.data = %q", input)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"  你好，Muse。  "}}]}`))
	}))
	defer server.Close()

	audioPath := filepath.Join(t.TempDir(), "voice.aac")
	if err := os.WriteFile(audioPath, []byte("aac-data"), 0o600); err != nil {
		t.Fatal(err)
	}
	transcriber := NewQwenASRTranscriber(&config.ModelConfig{
		Model: "qwen3-asr-flash", APIBase: server.URL + "/v1", APIKeys: config.SimpleSecureStrings("secret"),
	})
	result, err := transcriber.Transcribe(context.Background(), audioPath)
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "你好，Muse。" {
		t.Fatalf("text = %q", result.Text)
	}
}

func TestQwenASRTranscriberRejectsOversizeAudio(t *testing.T) {
	path := filepath.Join(t.TempDir(), "too-large.aac")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(qwenASRMaxBytes + 1); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	transcriber := &QwenASRTranscriber{client: http.DefaultClient}
	if _, err := transcriber.Transcribe(context.Background(), path); err == nil {
		t.Fatal("expected oversize audio to be rejected")
	}
}
