package weixin

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/sipeed/picoclaw/pkg/bus"
	"github.com/sipeed/picoclaw/pkg/channels"
	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/identity"
	"github.com/sipeed/picoclaw/pkg/logger"
)

// WeixinChannel is the Weixin channel implementation over Tencent iLink REST API.
type WeixinChannel struct {
	*channels.BaseChannel
	api    *ApiClient
	config *config.WeixinSettings
	ctx    context.Context
	cancel context.CancelFunc
	bus    *bus.MessageBus
	// contextTokens stores the last context_token per user (from_user_id → context_token).
	// This is required by the iLink API to associate replies with the right chat session.
	contextTokens     sync.Map
	typingMu          sync.Mutex
	typingCache       map[string]typingTicketCacheEntry
	pauseMu           sync.Mutex
	pauseUntil        time.Time
	syncBufPath       string
	contextTokensPath string
	inboundStatePath  string
	inboundStateMu    sync.Mutex
	inboundState      weixinInboundStateFile
}

func init() {
	channels.RegisterFactory(
		config.ChannelWeixin,
		func(channelName, channelType string, cfg *config.Config, bus *bus.MessageBus) (channels.Channel, error) {
			bc := cfg.Channels[channelName]
			decoded, err := bc.GetDecoded()
			if err != nil {
				return nil, err
			}
			weixinCfg, ok := decoded.(*config.WeixinSettings)
			if !ok {
				return nil, channels.ErrSendFailed
			}
			ch, err := NewWeixinChannel(bc, weixinCfg, bus)
			if err != nil {
				return nil, err
			}
			if channelName != config.ChannelWeixin {
				ch.SetName(channelName)
			}
			return ch, nil
		},
	)
}

// NewWeixinChannel creates a new WeixinChannel from config.
func NewWeixinChannel(
	bc *config.Channel,
	cfg *config.WeixinSettings,
	messageBus *bus.MessageBus,
) (*WeixinChannel, error) {
	api, err := NewApiClient(cfg.BaseURL, cfg.Token.String(), cfg.Proxy)
	if err != nil {
		return nil, fmt.Errorf("weixin: failed to create API client: %w", err)
	}

	base := channels.NewBaseChannel(
		bc.Name(),
		cfg,
		messageBus,
		bc.AllowFrom,
		channels.WithMaxMessageLength(4000),
		channels.WithReasoningChannelID(bc.ReasoningChannelID),
	)

	return &WeixinChannel{
		BaseChannel:       base,
		api:               api,
		config:            cfg,
		bus:               messageBus,
		typingCache:       make(map[string]typingTicketCacheEntry),
		syncBufPath:       buildWeixinSyncBufPath(cfg),
		contextTokensPath: buildWeixinContextTokensPath(cfg),
		inboundStatePath:  buildWeixinInboundStatePath(cfg),
	}, nil
}

func (c *WeixinChannel) Start(ctx context.Context) error {
	logger.InfoC("weixin", "Starting Weixin channel")
	c.ctx, c.cancel = context.WithCancel(ctx)
	c.SetRunning(true)
	c.restoreContextTokens()
	c.restoreInboundState()
	go c.pollLoop(c.ctx)
	logger.InfoC("weixin", "Weixin channel started")
	return nil
}

// restoreContextTokens loads persisted context tokens from disk into memory.
func (c *WeixinChannel) restoreContextTokens() {
	tokens, err := loadContextTokens(c.contextTokensPath)
	if err != nil {
		logger.WarnCF("weixin", "Failed to load persisted context tokens", map[string]any{
			"path":  c.contextTokensPath,
			"error": err.Error(),
		})
		return
	}
	if len(tokens) == 0 {
		return
	}
	for userID, token := range tokens {
		c.contextTokens.Store(normalizeWeixinUserID(userID), token)
	}
	logger.InfoCF("weixin", "Restored context tokens from disk", map[string]any{
		"path":  c.contextTokensPath,
		"count": len(tokens),
	})
}

// persistContextTokens saves all in-memory context tokens to disk.
func (c *WeixinChannel) persistContextTokens() {
	tokens := make(map[string]string)
	c.contextTokens.Range(func(k, v any) bool {
		if userID, ok := k.(string); ok {
			if token, ok := v.(string); ok {
				tokens[normalizeWeixinUserID(userID)] = token
			}
		}
		return true
	})
	if err := saveContextTokens(c.contextTokensPath, tokens); err != nil {
		logger.WarnCF("weixin", "Failed to persist context tokens", map[string]any{
			"path":  c.contextTokensPath,
			"error": err.Error(),
		})
	}
}

func normalizeWeixinUserID(userID string) string {
	// iLink user IDs are opaque and case-sensitive. Only trim transport
	// whitespace; lower-casing turns a valid recipient into a different ID.
	return strings.TrimSpace(userID)
}

func legacyWeixinUserIDKey(userID string) string {
	return strings.ToLower(normalizeWeixinUserID(userID))
}

func (c *WeixinChannel) loadContextToken(userID string) string {
	userID = normalizeWeixinUserID(userID)
	if value, ok := c.contextTokens.Load(userID); ok {
		if token, ok := value.(string); ok && token != "" {
			return token
		}
	}

	// Versions that briefly normalized IDs to lower case persisted tokens
	// under that key. Keep a read-only compatibility lookup so upgrading does
	// not require a fresh inbound message; all new writes preserve the ID.
	legacyKey := legacyWeixinUserIDKey(userID)
	if legacyKey != userID {
		if value, ok := c.contextTokens.Load(legacyKey); ok {
			token, _ := value.(string)
			return token
		}
	}
	return ""
}

func (c *WeixinChannel) restoreInboundState() {
	state, err := loadWeixinInboundState(c.inboundStatePath)
	if err != nil {
		logger.WarnCF("weixin", "Failed to load inbound state", map[string]any{"error": err.Error()})
		state = weixinInboundStateFile{Seen: make(map[string]int64), Quotes: make(map[string]weixinQuoteState)}
	}
	c.inboundStateMu.Lock()
	c.inboundState = state
	c.pruneInboundStateLocked(time.Now())
	c.inboundStateMu.Unlock()
}

func (c *WeixinChannel) pruneInboundStateLocked(now time.Time) {
	cutoff := now.Add(-30 * 24 * time.Hour).UnixMilli()
	for id, seenAt := range c.inboundState.Seen {
		if seenAt < cutoff {
			delete(c.inboundState.Seen, id)
		}
	}
	for id, quote := range c.inboundState.Quotes {
		if quote.UpdatedAt < cutoff {
			delete(c.inboundState.Quotes, id)
		}
	}
}

func (c *WeixinChannel) hasSeenInbound(id string) bool {
	c.inboundStateMu.Lock()
	defer c.inboundStateMu.Unlock()
	if c.inboundState.Seen == nil {
		c.inboundState.Seen = make(map[string]int64)
	}
	_, ok := c.inboundState.Seen[id]
	return ok
}

func (c *WeixinChannel) rememberInbound(id, text string, aliases ...string) {
	c.inboundStateMu.Lock()
	defer c.inboundStateMu.Unlock()
	now := time.Now()
	if c.inboundState.Seen == nil {
		c.inboundState.Seen = make(map[string]int64)
	}
	if c.inboundState.Quotes == nil {
		c.inboundState.Quotes = make(map[string]weixinQuoteState)
	}
	c.pruneInboundStateLocked(now)
	c.inboundState.Seen[id] = now.UnixMilli()
	if strings.TrimSpace(text) != "" {
		quote := weixinQuoteState{Text: text, UpdatedAt: now.UnixMilli()}
		for _, alias := range aliases {
			if alias = strings.TrimSpace(alias); alias != "" {
				c.inboundState.Quotes[alias] = quote
			}
		}
	}
	if c.inboundStatePath != "" {
		if err := saveWeixinInboundState(c.inboundStatePath, c.inboundState); err != nil {
			logger.WarnCF("weixin", "Failed to persist inbound state", map[string]any{"error": err.Error()})
		}
	}
}

func (c *WeixinChannel) rememberQuote(id, text string) {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(text) == "" {
		return
	}
	c.inboundStateMu.Lock()
	defer c.inboundStateMu.Unlock()
	if c.inboundState.Quotes == nil {
		c.inboundState.Quotes = make(map[string]weixinQuoteState)
	}
	c.inboundState.Quotes[id] = weixinQuoteState{Text: text, UpdatedAt: time.Now().UnixMilli()}
	if c.inboundStatePath != "" {
		_ = saveWeixinInboundState(c.inboundStatePath, c.inboundState)
	}
}

func (c *WeixinChannel) quoteText(id string) string {
	c.inboundStateMu.Lock()
	defer c.inboundStateMu.Unlock()
	if c.inboundState.Quotes == nil {
		return ""
	}
	return c.inboundState.Quotes[strings.TrimSpace(id)].Text
}

func stableWeixinMessageID(msg WeixinMessage) string {
	for _, candidate := range []string{msg.ClientID, string(msg.MessageID)} {
		if candidate = strings.TrimSpace(candidate); candidate != "" {
			return candidate
		}
	}
	for _, item := range msg.ItemList {
		if id := strings.TrimSpace(string(item.MsgID)); id != "" {
			return id
		}
	}
	raw, _ := json.Marshal(msg)
	sum := sha256.Sum256(raw)
	return "weixin-" + hex.EncodeToString(sum[:12])
}

func (c *WeixinChannel) Stop(ctx context.Context) error {
	logger.InfoC("weixin", "Stopping Weixin channel")
	c.SetRunning(false)
	if c.cancel != nil {
		c.cancel()
	}
	return nil
}

// pollLoop is the long-poll receive loop. It runs until ctx is canceled.
func (c *WeixinChannel) pollLoop(ctx context.Context) {
	const (
		defaultPollTimeoutMs = 35_000
		retryDelay           = 2 * time.Second
		backoffDelay         = 30 * time.Second
		maxConsecutiveFails  = 3
	)

	consecutiveFails := 0
	getUpdatesBuf, err := loadGetUpdatesBuf(c.syncBufPath)
	if err != nil {
		logger.WarnCF("weixin", "Failed to load persisted get_updates_buf", map[string]any{
			"path":  c.syncBufPath,
			"error": err.Error(),
		})
		getUpdatesBuf = ""
	} else if getUpdatesBuf != "" {
		logger.InfoCF("weixin", "Resuming persisted get_updates_buf", map[string]any{
			"path":   c.syncBufPath,
			"bytes":  len(getUpdatesBuf),
			"source": "disk",
		})
	}
	nextTimeoutMs := defaultPollTimeoutMs

	for {
		select {
		case <-ctx.Done():
			logger.InfoC("weixin", "Weixin poll loop stopped")
			return
		default:
		}

		if err := c.waitWhileSessionPaused(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			continue
		}

		// Build a context with timeout slightly longer than the long-poll
		pollCtx, pollCancel := context.WithTimeout(ctx, time.Duration(nextTimeoutMs+5000)*time.Millisecond)

		resp, err := c.api.GetUpdates(pollCtx, GetUpdatesReq{
			GetUpdatesBuf: getUpdatesBuf,
		})
		pollCancel()

		if err != nil {
			// Check if we're shutting down
			if ctx.Err() != nil {
				return
			}

			consecutiveFails++
			logger.WarnCF("weixin", "getUpdates failed", map[string]any{
				"error":   err.Error(),
				"attempt": consecutiveFails,
			})

			if consecutiveFails >= maxConsecutiveFails {
				logger.ErrorCF("weixin", "Too many consecutive failures, backing off", map[string]any{
					"duration": backoffDelay,
				})
				consecutiveFails = 0
				select {
				case <-ctx.Done():
					return
				case <-time.After(backoffDelay):
				}
			} else {
				select {
				case <-ctx.Done():
					return
				case <-time.After(retryDelay):
				}
			}
			continue
		}

		if isSessionExpiredStatus(resp.Ret, resp.Errcode) {
			remaining := c.pauseSession("getupdates", resp.Ret, resp.Errcode, resp.Errmsg)
			select {
			case <-ctx.Done():
				return
			case <-time.After(remaining):
			}
			continue
		}

		if resp.Errcode != 0 || resp.Ret != 0 {
			consecutiveFails++
			logger.ErrorCF("weixin", "getUpdates API error", map[string]any{
				"ret":     resp.Ret,
				"errcode": resp.Errcode,
				"errmsg":  resp.Errmsg,
			})
			select {
			case <-ctx.Done():
				return
			case <-time.After(retryDelay):
			}
			continue
		}

		consecutiveFails = 0

		// Update the long-poll timeout from server hint
		if resp.LongpollingTimeoutMs > 0 {
			nextTimeoutMs = resp.LongpollingTimeoutMs
		}

		// Advance cursor
		if resp.GetUpdatesBuf != "" {
			getUpdatesBuf = resp.GetUpdatesBuf
			if err := saveGetUpdatesBuf(c.syncBufPath, getUpdatesBuf); err != nil {
				logger.WarnCF("weixin", "Failed to persist get_updates_buf", map[string]any{
					"path":  c.syncBufPath,
					"error": err.Error(),
				})
			}
		}

		// Dispatch messages
		for _, msg := range resp.Msgs {
			c.handleInboundMessage(ctx, msg)
		}
	}
}

// handleInboundMessage converts a WeixinMessage to a bus.InboundMessage.
func (c *WeixinChannel) handleInboundMessage(ctx context.Context, msg WeixinMessage) {
	fromUserID := normalizeWeixinUserID(msg.FromUserID)
	if fromUserID == "" {
		return
	}

	messageID := stableWeixinMessageID(msg)
	dedupeID := fromUserID + "\x00" + messageID
	if c.hasSeenInbound(dedupeID) {
		logger.DebugCF("weixin", "Ignoring replayed inbound message", map[string]any{
			"from_user_id": fromUserID,
			"message_id":   messageID,
		})
		return
	}

	// Build text content from item_list
	var parts []string
	for _, item := range msg.ItemList {
		switch item.Type {
		case MessageItemTypeText:
			if item.TextItem != nil && item.TextItem.Text != "" {
				parts = append(parts, item.TextItem.Text)
			}
		case MessageItemTypeVoice:
			if item.VoiceItem != nil && item.VoiceItem.Text != "" {
				// Use voice → text transcription from server
				parts = append(parts, item.VoiceItem.Text)
			} else {
				parts = append(parts, "[audio]")
			}
		case MessageItemTypeImage:
			parts = append(parts, "[image]")
		case MessageItemTypeFile:
			if item.FileItem != nil && item.FileItem.FileName != "" {
				parts = append(parts, fmt.Sprintf("[file: %s]", item.FileItem.FileName))
			} else {
				parts = append(parts, "[file]")
			}
		case MessageItemTypeVideo:
			parts = append(parts, "[video]")
		}
	}

	var mediaRefs []string
	if mediaItem := selectInboundMediaItem(msg); mediaItem != nil {
		ref, err := c.downloadMediaFromItem(ctx, fromUserID, messageID, mediaItem)
		if err != nil {
			logger.ErrorCF("weixin", "Failed to download inbound media", map[string]any{
				"from_user_id": fromUserID,
				"message_id":   messageID,
				"type":         mediaItem.Type,
				"error":        err.Error(),
			})
		} else if ref != "" {
			mediaRefs = append(mediaRefs, ref)
		}
	}

	content := strings.Join(parts, "\n")
	if quoted := c.resolveQuotedText(msg); quoted != "" {
		content = fmt.Sprintf("[引用消息]\n%s\n\n[当前消息]\n%s", quoted, content)
	}
	if content == "" && len(mediaRefs) == 0 {
		return
	}

	sender := bus.SenderInfo{
		Platform:    "weixin",
		PlatformID:  fromUserID,
		CanonicalID: identity.BuildCanonicalID("weixin", fromUserID),
		Username:    fromUserID,
		DisplayName: fromUserID,
	}

	if !c.IsAllowedSender(sender) {
		logger.DebugCF("weixin", "Message rejected by allowlist", map[string]any{
			"from_user_id": fromUserID,
		})
		return
	}

	metadata := map[string]string{
		"from_user_id":  fromUserID,
		"context_token": msg.ContextToken,
		"session_id":    msg.SessionID,
	}

	logger.DebugCF("weixin", "Received message", map[string]any{
		"from_user_id": fromUserID,
		"content_len":  len(content),
		"media_count":  len(mediaRefs),
	})

	// Store context_token for outbound reply association
	if msg.ContextToken != "" {
		c.contextTokens.Store(fromUserID, msg.ContextToken)
		c.persistContextTokens()
	}

	inboundCtx := bus.InboundContext{
		Channel:   "weixin",
		ChatID:    fromUserID,
		ChatType:  "direct",
		SenderID:  fromUserID,
		MessageID: messageID,
		Raw:       metadata,
	}
	if msg.ContextToken != "" {
		inboundCtx.ReplyHandles = map[string]string{
			"context_token": msg.ContextToken,
		}
	}

	if err := c.HandleInboundContext(ctx, fromUserID, content, mediaRefs, inboundCtx, sender); err != nil {
		logger.ErrorCF("weixin", "Failed to publish inbound message", map[string]any{
			"from_user_id": fromUserID,
			"message_id":   messageID,
			"error":        err.Error(),
		})
		return
	}
	aliases := []string{messageID, string(msg.MessageID), msg.ClientID}
	for _, item := range msg.ItemList {
		aliases = append(aliases, string(item.MsgID))
	}
	c.rememberInbound(dedupeID, strings.Join(parts, "\n"), aliases...)
}

func messageItemText(item *MessageItem) string {
	if item == nil {
		return ""
	}
	if item.TextItem != nil {
		return strings.TrimSpace(item.TextItem.Text)
	}
	if item.VoiceItem != nil {
		return strings.TrimSpace(item.VoiceItem.Text)
	}
	return ""
}

func (c *WeixinChannel) resolveQuotedText(msg WeixinMessage) string {
	for i := range msg.ItemList {
		ref := msg.ItemList[i].RefMsg
		if ref == nil {
			continue
		}
		if text := messageItemText(ref.MessageItem); text != "" {
			return text
		}
		if text := strings.TrimSpace(ref.Title); text != "" {
			return text
		}
		ids := []string{string(ref.SvrID)}
		if ref.MessageItem != nil {
			ids = append(ids, string(ref.MessageItem.MsgID))
		}
		for _, id := range ids {
			if text := c.quoteText(id); text != "" {
				if ref.PartialText != nil {
					if partial := resolveWeixinPartialQuote(text, ref.PartialText); partial != "" {
						return partial
					}
				}
				return text
			}
		}
	}
	return ""
}

func nthStringIndex(text, value string, occurrence, from int) int {
	if value == "" || occurrence < 0 {
		return -1
	}
	position := from
	for current := 0; current <= occurrence; current++ {
		relative := strings.Index(text[position:], value)
		if relative < 0 {
			return -1
		}
		position += relative
		if current < occurrence {
			position += len(value)
		}
	}
	return position
}

func resolveWeixinPartialQuote(fullText string, partial *PartialText) string {
	if partial == nil || fullText == "" || partial.Start == "" || partial.End == "" {
		return ""
	}
	start := nthStringIndex(fullText, partial.Start, partial.StartIndex, 0)
	if start < 0 {
		return ""
	}
	endCandidates := []int{
		nthStringIndex(fullText, partial.End, partial.EndIndex, 0),
		nthStringIndex(fullText, partial.End, partial.EndIndex, start+len(partial.Start)),
	}
	for _, end := range endCandidates {
		if end < start {
			continue
		}
		candidate := fullText[start : end+len(partial.End)]
		if partial.QuoteMD5 == "" {
			return candidate
		}
		sum := md5.Sum([]byte(candidate))
		if strings.EqualFold(hex.EncodeToString(sum[:]), partial.QuoteMD5) {
			return candidate
		}
	}
	return ""
}

// Send implements channels.Channel by sending a text message to the WeChat user.
func (c *WeixinChannel) Send(ctx context.Context, msg bus.OutboundMessage) ([]string, error) {
	if !c.IsRunning() {
		return nil, channels.ErrNotRunning
	}
	if err := c.ensureSessionActive(); err != nil {
		return nil, err
	}

	if msg.Content == "" {
		return nil, nil
	}

	// We need a context_token to send a reply. It should be stored in the conversation metadata.
	// The chat_id is the weixin user_id (from_user_id).
	toUserID := normalizeWeixinUserID(msg.ChatID)

	// Retrieve context_token from our per-user map (stored on last inbound)
	contextToken := c.loadContextToken(toUserID)

	// If we don't have a context token for this user, we cannot send a valid reply.
	// Treat this as a non-temporary error so the manager doesn't keep retrying.
	if contextToken == "" {
		logger.ErrorCF("weixin", "Missing context token, cannot send message", map[string]any{
			"to_user_id": toUserID,
		})
		return nil, fmt.Errorf("weixin send: %w: missing context token for chat %s", channels.ErrSendFailed, toUserID)
	}

	if err := c.sendTextMessage(ctx, toUserID, contextToken, msg.Content); err != nil {
		logger.ErrorCF("weixin", "Failed to send message", map[string]any{
			"to_user_id": toUserID,
			"error":      err.Error(),
		})
		if c.remainingPause() > 0 {
			return nil, fmt.Errorf("weixin send: %w", channels.ErrSendFailed)
		}
		if isContextTokenRejected(err) {
			return nil, fmt.Errorf(
				"weixin send: stale context token; ask the recipient to send the bot a new message first: %w",
				channels.ErrSendFailed,
			)
		}
		return nil, fmt.Errorf("weixin send: %w", channels.ErrTemporary)
	}

	return nil, nil
}

func isContextTokenRejected(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "ret=-2") &&
		strings.Contains(message, "prepare failed")
}

// VoiceCapabilities returns the voice capabilities of the channel.
func (c *WeixinChannel) VoiceCapabilities() channels.VoiceCapabilities {
	return channels.VoiceCapabilities{ASR: true, TTS: true}
}
