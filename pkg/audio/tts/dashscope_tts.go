package tts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/sipeed/picoclaw/pkg/logger"
)

// DashScopeTTSProvider synthesizes speech using Alibaba Cloud's DashScope API
// (Bailian / 百炼). Uses the Qwen-Audio-TTS models (e.g., qwen3-tts-flash).
type DashScopeTTSProvider struct {
	apiKey     string
	model      string
	voice      string
	language   string
	httpClient *http.Client
}

type dashScopeTTSResult struct {
	StatusCode int `json:"status_code"`
	Output     struct {
		Audio struct {
			URL       string `json:"url"`
			ID        string `json:"id"`
			ExpiresAt int64  `json:"expires_at"`
		} `json:"audio"`
	} `json:"output"`
	Usage struct {
		Characters int `json:"characters"`
	} `json:"usage"`
}

const (
	dashScopeTTSEndpoint = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
	defaultDashScopeTTModel = "qwen3-tts-flash"
	defaultDashScopeVoice   = "Cherry"
	defaultDashScopeLang    = "Chinese"
)

func NewDashScopeTTSProvider(apiKey string, model string, voice string, language string) *DashScopeTTSProvider {
	model = strings.TrimSpace(model)
	if model == "" {
		model = defaultDashScopeTTModel
	}

	voice = strings.TrimSpace(voice)
	if voice == "" {
		voice = defaultDashScopeVoice
	}

	language = strings.TrimSpace(language)
	if language == "" {
		language = defaultDashScopeLang
	}

	return &DashScopeTTSProvider{
		apiKey:     apiKey,
		model:      model,
		voice:      voice,
		language:   language,
		httpClient: &http.Client{Timeout: 60 * time.Second},
	}
}

func (t *DashScopeTTSProvider) Name() string {
	return "dashscope-tts"
}

func (t *DashScopeTTSProvider) Synthesize(ctx context.Context, text string) (io.ReadCloser, error) {
	logger.DebugCF("voice-tts", "Starting DashScope TTS synthesis",
		map[string]any{"text_len": len(text), "model": t.model, "voice": t.voice})

	reqBody := map[string]any{
		"model": t.model,
		"input": map[string]any{
			"text":          text,
			"voice":         t.voice,
			"language_type": t.language,
		},
		"stream": false,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", dashScopeTTSEndpoint, bytes.NewReader(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+t.apiKey)

	resp, err := t.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("DashScope API error (status %d): %s", resp.StatusCode, string(body))
	}

	var result dashScopeTTSResult
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	if result.StatusCode != 200 {
		return nil, fmt.Errorf("DashScope API error (code %d): %s", result.StatusCode, string(body))
	}

	audioURL := result.Output.Audio.URL
	if audioURL == "" {
		return nil, fmt.Errorf("DashScope TTS response missing audio URL")
	}

	logger.DebugCF("voice-tts", "DashScope TTS audio URL obtained",
		map[string]any{"audio_url": audioURL, "expires_at": result.Output.Audio.ExpiresAt})

	// Download the audio file from the URL
	audioResp, err := t.httpClient.Get(audioURL)
	if err != nil {
		return nil, fmt.Errorf("failed to download audio: %w", err)
	}

	if audioResp.StatusCode != http.StatusOK {
		audioResp.Body.Close()
		return nil, fmt.Errorf("failed to download audio (status %d)", audioResp.StatusCode)
	}

	return audioResp.Body, nil
}
