package session

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/sipeed/picoclaw/pkg/routing"
)

const (
	sessionKeyV1Prefix          = "sk_v1_"
	legacyAgentSessionKeyPrefix = "agent:"
	AgentTypeMain               = "main"
	AgentTypeSub                = "sub"
)

var semanticSessionKeyPattern = regexp.MustCompile(
	`^[a-z0-9][a-z0-9-]*_[0-9]{8}t[0-9]{9}_(main|sub)$`,
)

type ParsedLegacySessionKey struct {
	AgentID string
	Rest    string
}

// BuildOpaqueSessionKey returns a stable opaque session key derived from a
// canonical alias string. The alias remains available through metadata for
// compatibility and migration purposes.
func BuildOpaqueSessionKey(alias string) string {
	normalized := strings.TrimSpace(strings.ToLower(alias))
	if normalized == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(normalized))
	return sessionKeyV1Prefix + hex.EncodeToString(sum[:])
}

// IsOpaqueSessionKey returns true when the key matches the current opaque
// session-key format.
func IsOpaqueSessionKey(key string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(key)), sessionKeyV1Prefix)
}

// BuildSemanticSessionKey returns a human-readable session identifier in the
// form {channel}_{starttime}_{agentType}. Milliseconds keep concurrent starts
// distinct without adding a fourth, non-semantic component.
func BuildSemanticSessionKey(channel string, startedAt time.Time, agentType string) string {
	channel = normalizeSemanticSessionPart(channel, "unknown")
	agentType = strings.ToLower(strings.TrimSpace(agentType))
	if agentType != AgentTypeSub {
		agentType = AgentTypeMain
	}
	starttime := strings.Replace(startedAt.Format("20060102T150405.000"), ".", "", 1)
	return fmt.Sprintf("%s_%s_%s", channel, starttime, agentType)
}

// IsSemanticSessionKey reports whether key uses the public semantic format.
func IsSemanticSessionKey(key string) bool {
	return semanticSessionKeyPattern.MatchString(strings.ToLower(strings.TrimSpace(key)))
}

func normalizeSemanticSessionPart(value, fallback string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	lastDash := false
	for _, r := range value {
		valid := r >= 'a' && r <= 'z' || r >= '0' && r <= '9'
		if valid {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash && b.Len() > 0 {
			b.WriteByte('-')
			lastDash = true
		}
	}
	result := strings.Trim(b.String(), "-")
	if result == "" {
		return fallback
	}
	return result
}

func IsLegacyAgentSessionKey(key string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(key)), legacyAgentSessionKeyPrefix)
}

func IsExplicitSessionKey(key string) bool {
	return IsOpaqueSessionKey(key) || IsLegacyAgentSessionKey(key) || IsSemanticSessionKey(key)
}

func ParseLegacyAgentSessionKey(sessionKey string) *ParsedLegacySessionKey {
	raw := strings.TrimSpace(sessionKey)
	if raw == "" {
		return nil
	}
	parts := strings.SplitN(raw, ":", 3)
	if len(parts) < 3 || parts[0] != "agent" {
		return nil
	}
	agentID := strings.TrimSpace(parts[1])
	rest := parts[2]
	if agentID == "" || rest == "" {
		return nil
	}
	return &ParsedLegacySessionKey{AgentID: agentID, Rest: rest}
}

// ResolveAgentID returns the routed agent ID associated with a session. It
// prefers structured session scope metadata when available and falls back to
// legacy agent-scoped session keys for compatibility.
func ResolveAgentID(store any, sessionKey string) string {
	if scopeReader, ok := store.(interface {
		GetSessionScope(sessionKey string) *SessionScope
	}); ok {
		scope := scopeReader.GetSessionScope(sessionKey)
		if scope != nil && strings.TrimSpace(scope.AgentID) != "" {
			return routing.NormalizeAgentID(scope.AgentID)
		}
	}

	if parsed := ParseLegacyAgentSessionKey(sessionKey); parsed != nil {
		return routing.NormalizeAgentID(parsed.AgentID)
	}

	return ""
}

func BuildLegacyMainAlias(agentID string) string {
	return fmt.Sprintf("agent:%s:main", routing.NormalizeAgentID(agentID))
}

// BuildMainSessionKey returns the canonical opaque main-session key for an
// agent. The corresponding legacy alias remains available via
// BuildLegacyMainAlias for compatibility and migration logic.
func BuildMainSessionKey(agentID string) string {
	return BuildOpaqueSessionKey(BuildLegacyMainAlias(agentID))
}

func BuildLegacyDirectAliases(agentID, channel, account, peerID string) []string {
	agentID = routing.NormalizeAgentID(agentID)
	channel = normalizeLegacyChannel(channel)
	account = routing.NormalizeAccountID(account)
	peerID = strings.ToLower(strings.TrimSpace(peerID))
	if peerID == "" {
		return nil
	}
	return []string{
		fmt.Sprintf("agent:%s:direct:%s", agentID, peerID),
		fmt.Sprintf("agent:%s:%s:direct:%s", agentID, channel, peerID),
		fmt.Sprintf("agent:%s:%s:%s:direct:%s", agentID, channel, account, peerID),
	}
}

func BuildLegacyPeerAlias(agentID, channel, peerKind, peerID string) string {
	agentID = routing.NormalizeAgentID(agentID)
	channel = normalizeLegacyChannel(channel)
	peerKind = strings.ToLower(strings.TrimSpace(peerKind))
	if peerKind == "" {
		peerKind = "unknown"
	}
	peerID = strings.ToLower(strings.TrimSpace(peerID))
	if peerID == "" {
		peerID = "unknown"
	}
	return fmt.Sprintf("agent:%s:%s:%s:%s", agentID, channel, peerKind, peerID)
}

// CanonicalSessionIdentityID collapses an identity using identity_links when
// possible, then returns a normalized lowercase identifier.
func CanonicalSessionIdentityID(channel, rawID string, identityLinks map[string][]string) string {
	normalizedID := strings.TrimSpace(rawID)
	if normalizedID == "" {
		return ""
	}
	if linked := resolveLinkedPeerID(identityLinks, channel, normalizedID); linked != "" {
		normalizedID = linked
	}
	return strings.ToLower(normalizedID)
}

func normalizeLegacyChannel(channel string) string {
	channel = strings.ToLower(strings.TrimSpace(channel))
	if channel == "" {
		return "unknown"
	}
	return channel
}

func resolveLinkedPeerID(identityLinks map[string][]string, channel, peerID string) string {
	if len(identityLinks) == 0 {
		return ""
	}
	peerID = strings.TrimSpace(peerID)
	if peerID == "" {
		return ""
	}

	candidates := make(map[string]bool)
	rawCandidate := strings.ToLower(peerID)
	if rawCandidate != "" {
		candidates[rawCandidate] = true
	}
	channel = strings.ToLower(strings.TrimSpace(channel))
	if channel != "" {
		candidates[fmt.Sprintf("%s:%s", channel, rawCandidate)] = true
	}
	if idx := strings.Index(rawCandidate, ":"); idx > 0 && idx < len(rawCandidate)-1 {
		candidates[rawCandidate[idx+1:]] = true
	}

	for canonical, ids := range identityLinks {
		canonicalName := strings.TrimSpace(canonical)
		if canonicalName == "" {
			continue
		}
		for _, id := range ids {
			normalized := strings.ToLower(strings.TrimSpace(id))
			if normalized != "" && candidates[normalized] {
				return canonicalName
			}
		}
	}
	return ""
}

// CanonicalScopeSignature returns a stable serialized representation of scope.
func CanonicalScopeSignature(scope SessionScope) string {
	parts := []string{
		fmt.Sprintf("v=%d", scope.Version),
		fmt.Sprintf("agent=%s", strings.TrimSpace(strings.ToLower(scope.AgentID))),
		fmt.Sprintf("channel=%s", strings.TrimSpace(strings.ToLower(scope.Channel))),
		fmt.Sprintf("account=%s", strings.TrimSpace(strings.ToLower(scope.Account))),
	}
	for _, dimension := range scope.Dimensions {
		dimension = strings.TrimSpace(strings.ToLower(dimension))
		if dimension == "" {
			continue
		}
		value := strings.TrimSpace(strings.ToLower(scope.Values[dimension]))
		parts = append(parts, fmt.Sprintf("%s=%s", dimension, value))
	}
	return strings.Join(parts, "|")
}

// BuildSessionKey returns the current opaque key for a structured session scope.
func BuildSessionKey(scope SessionScope) string {
	for _, value := range scope.Values {
		if idx := strings.LastIndex(value, ":"); idx >= 0 {
			value = value[idx+1:]
		}
		if IsSemanticSessionKey(value) && strings.HasPrefix(value, normalizeSemanticSessionPart(scope.Channel, "unknown")+"_") {
			return value
		}
	}
	return BuildOpaqueSessionKey(CanonicalScopeSignature(scope))
}
