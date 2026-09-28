// PicoClaw - Ultra-lightweight personal AI agent

package agent

import (
	"github.com/sipeed/picoclaw/pkg/audio/asr"
	"github.com/sipeed/picoclaw/pkg/channels"
	"github.com/sipeed/picoclaw/pkg/config"
	"github.com/sipeed/picoclaw/pkg/media"
	"github.com/sipeed/picoclaw/pkg/tools"
	"path/filepath"
)

func (al *AgentLoop) RegisterTool(tool tools.Tool) {
	registry := al.GetRegistry()
	for _, agentID := range registry.ListAgentIDs() {
		if agent, ok := registry.GetAgent(agentID); ok {
			agent.Tools.Register(tool)
		}
	}
}

func (al *AgentLoop) SetChannelManager(cm *channels.Manager) {
	al.channelManager = cm
	al.planConfirmation = nil
	if cm == nil {
		return
	}
	ch, ok := cm.GetChannel("pico")
	if !ok {
		return
	}
	bridge, ok := ch.(tools.PicoConfirmationBridge)
	if !ok {
		return
	}
	al.planConfirmation = bridge
	al.RegisterTool(tools.NewAskUserConfirmationTool(bridge))
	if phoneBridge, ok := ch.(tools.PicoPhoneBridge); ok {
		al.RegisterTool(tools.NewPhoneTool(phoneBridge))
	}
	if todoBridge, ok := ch.(tools.PicoTodoBridge); ok {
		if store, ok := ch.(interface{ SetTodoStorage(string) }); ok {
			store.SetTodoStorage(filepath.Join(al.cfg.WorkspacePath(), "pico-todos"))
		}
		al.RegisterTool(tools.NewUpdateTodoListTool(todoBridge))
	}
}

func (al *AgentLoop) GetRegistry() *AgentRegistry {
	al.mu.RLock()
	defer al.mu.RUnlock()
	return al.registry
}

func (al *AgentLoop) GetConfig() *config.Config {
	al.mu.RLock()
	defer al.mu.RUnlock()
	return al.cfg
}

func (al *AgentLoop) SetMediaStore(s media.MediaStore) {
	al.mediaStore = s

	// Propagate store to all registered tools that can emit media.
	registry := al.GetRegistry()
	for _, agentID := range registry.ListAgentIDs() {
		if agent, ok := registry.GetAgent(agentID); ok {
			agent.Tools.SetMediaStore(s)
		}
	}
	registry.ForEachTool("send_tts", func(t tools.Tool) {
		if st, ok := t.(*tools.SendTTSTool); ok {
			st.SetMediaStore(s)
		}
	})
}

func (al *AgentLoop) SetTranscriber(t asr.Transcriber) {
	al.transcriber = t
}

func (al *AgentLoop) SetReloadFunc(fn func() error) {
	al.reloadFunc = fn
}

func (al *AgentLoop) RecordLastChannel(channel string) error {
	if al.state == nil {
		return nil
	}
	return al.state.SetLastChannel(channel)
}

func (al *AgentLoop) RecordLastChatID(chatID string) error {
	if al.state == nil {
		return nil
	}
	return al.state.SetLastChatID(chatID)
}

func (al *AgentLoop) GetStartupInfo() map[string]any {
	info := make(map[string]any)

	registry := al.GetRegistry()
	agent := registry.GetDefaultAgent()
	if agent == nil {
		return info
	}

	// Tools info
	toolsList := agent.Tools.List()
	info["tools"] = map[string]any{
		"count": len(toolsList),
		"names": toolsList,
	}

	// Skills info
	info["skills"] = agent.ContextBuilder.GetSkillsInfo()

	// Agents info
	info["agents"] = map[string]any{
		"count": len(registry.ListAgentIDs()),
		"ids":   registry.ListAgentIDs(),
	}

	return info
}
