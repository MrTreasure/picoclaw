package asr

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/utils"
)

const qwenASRMaxBytes = 10 << 20

// QwenASRTranscriber uses Qwen3-ASR-Flash's OpenAI-compatible request shape.
// Qwen expects a complete data URI in input_audio.data, which differs from the
// data/format object used by OpenAI audio chat models.
type QwenASRTranscriber struct {
	apiBase       string
	apiKey        string
	modelID       string
	customHeaders map[string]string
	client        *http.Client
}

func NewQwenASRTranscriber(modelCfg *config.ModelConfig) *QwenASRTranscriber {
	if modelCfg == nil || modelCfg.APIKey() == "" || strings.TrimSpace(modelCfg.APIBase) == "" {
		return nil
	}
	timeout := 120 * time.Second
	if modelCfg.RequestTimeout > 0 {
		timeout = time.Duration(modelCfg.RequestTimeout) * time.Second
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if proxy := strings.TrimSpace(modelCfg.Proxy); proxy != "" {
		if parsed, err := url.Parse(proxy); err == nil {
			transport.Proxy = http.ProxyURL(parsed)
		}
	}
	return &QwenASRTranscriber{
		apiBase: strings.TrimRight(modelCfg.APIBase, "/"), apiKey: modelCfg.APIKey(), modelID: modelCfg.Model,
		customHeaders: modelCfg.CustomHeaders, client: &http.Client{Timeout: timeout, Transport: transport},
	}
}

func (t *QwenASRTranscriber) Name() string { return "qwen-asr" }

func (t *QwenASRTranscriber) Transcribe(ctx context.Context, audioFilePath string) (*TranscriptionResponse, error) {
	audio, err := os.ReadFile(audioFilePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read audio file: %w", err)
	}
	if len(audio) == 0 || len(audio) > qwenASRMaxBytes {
		return nil, fmt.Errorf("audio must be between 1 byte and 10 MB")
	}
	format, err := utils.AudioFormat(audioFilePath)
	if err != nil {
		return nil, err
	}
	dataURI := "data:audio/" + format + ";base64," + base64.StdEncoding.EncodeToString(audio)
	payload := map[string]any{
		"model": t.modelID,
		"messages": []any{map[string]any{
			"role":    "user",
			"content": []any{map[string]any{"type": "input_audio", "input_audio": map[string]any{"data": dataURI}}},
		}},
		"stream":      false,
		"asr_options": map[string]any{"enable_itn": true},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode transcription request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.apiBase+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create transcription request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+t.apiKey)
	req.Header.Set("Content-Type", "application/json")
	for key, value := range t.customHeaders {
		req.Header.Set(key, value)
	}
	resp, err := t.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("transcription request failed: %w", err)
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, fmt.Errorf("read transcription response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("transcription request failed with HTTP %d", resp.StatusCode)
	}
	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(responseBody, &result); err != nil {
		return nil, fmt.Errorf("decode transcription response: %w", err)
	}
	if len(result.Choices) == 0 || strings.TrimSpace(result.Choices[0].Message.Content) == "" {
		return nil, fmt.Errorf("transcription response contained no text")
	}
	return &TranscriptionResponse{Text: strings.TrimSpace(result.Choices[0].Message.Content)}, nil
}
