package tools

import (
	"context"
	"fmt"
	"strings"
)

type SpawnTool struct {
	spawner        SubTurnSpawner
	manager        *SubagentManager // used for task registration so spawn_status can find spawned tasks
	defaultModel   string
	maxTokens      int
	temperature    float64
	allowlistCheck func(targetAgentID string) bool
}

// Compile-time check: SpawnTool implements AsyncExecutor.
var _ AsyncExecutor = (*SpawnTool)(nil)

func NewSpawnTool(manager *SubagentManager) *SpawnTool {
	if manager == nil {
		return &SpawnTool{}
	}
	return &SpawnTool{
		manager:      manager,
		defaultModel: manager.defaultModel,
		maxTokens:    manager.maxTokens,
		temperature:  manager.temperature,
	}
}

// SetSpawner sets the SubTurnSpawner for direct sub-turn execution.
func (t *SpawnTool) SetSpawner(spawner SubTurnSpawner) {
	t.spawner = spawner
}

func (t *SpawnTool) Name() string {
	return "spawn"
}

func (t *SpawnTool) Description() string {
	return "Spawn a subagent to handle a task in the background. Use this for complex or time-consuming tasks that can run independently. The subagent will complete the task and report back when done."
}

func (t *SpawnTool) Parameters() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"task": map[string]any{
				"type":        "string",
				"description": "The task for subagent to complete",
			},
			"label": map[string]any{
				"type":        "string",
				"description": "Optional short label for the task (for display)",
			},
			"agent_id": map[string]any{
				"type":        "string",
				"description": "Optional target agent ID to delegate the task to",
			},
		},
		"required": []string{"task"},
	}
}

func (t *SpawnTool) SetAllowlistChecker(check func(targetAgentID string) bool) {
	t.allowlistCheck = check
}

func (t *SpawnTool) Execute(ctx context.Context, args map[string]any) *ToolResult {
	return t.execute(ctx, args, nil)
}

// ExecuteAsync implements AsyncExecutor. The callback is passed through to the
// subagent manager as a call parameter — never stored on the SpawnTool instance.
func (t *SpawnTool) ExecuteAsync(
	ctx context.Context,
	args map[string]any,
	cb AsyncCallback,
) *ToolResult {
	return t.execute(ctx, args, cb)
}

func (t *SpawnTool) execute(
	ctx context.Context,
	args map[string]any,
	cb AsyncCallback,
) *ToolResult {
	task, ok := args["task"].(string)
	if !ok || strings.TrimSpace(task) == "" {
		return ErrorResult("task is required and must be a non-empty string")
	}

	label, ok := args["label"].(string)
	if !ok {
		label = ""
	}
	agentID, ok := args["agent_id"].(string)
	if !ok {
		agentID = ""
	}
	targetAgentID := strings.TrimSpace(agentID)

	// Check allowlist if targeting a specific agent
	if targetAgentID != "" && t.allowlistCheck != nil {
		if !t.allowlistCheck(targetAgentID) {
			return ErrorResult(fmt.Sprintf("not allowed to spawn agent '%s'", targetAgentID))
		}
	}

	// Build system prompt for spawned subagent
	systemPrompt := fmt.Sprintf(
		`You are a spawned subagent running in the background. Complete the given task independently and report back when done.

Task: %s`,
		task,
	)

	if label != "" {
		systemPrompt = fmt.Sprintf(
			`You are a spawned subagent labeled "%s" running in the background. Complete the given task independently and report back when done.

Task: %s`,
			label,
			task,
		)
	}

	// Use spawner if available (direct SpawnSubTurn call)
	if t.spawner != nil {
		// Launch async sub-turn in goroutine
		go func() {
			// Register task with SubagentManager so spawn_status can find it.
			// This fixes the data-flow断裂 bug where spawn tool never wrote to manager.tasks.
			var taskID string
			if t.manager != nil {
				taskID = t.manager.GenerateTaskID()
				channel := ToolChannel(ctx)
				chatID := ToolChatID(ctx)
				t.manager.RegisterSpawnTask(taskID, task, label, targetAgentID, channel, chatID)
			}

			// Defer: recover from panic and update task to failed
			var panicked bool
			defer func() {
				if r := recover(); r != nil {
					panicked = true
					if t.manager != nil && taskID != "" {
						t.manager.CompleteSpawnTask(taskID, "failed", fmt.Sprintf("Spawn panicked: %v", r))
					}
				}
			}()

			result, err := t.spawner.SpawnSubTurn(ctx, SubTurnConfig{
				Model:         t.defaultModel,
				Tools:         nil, // Will inherit from parent via context
				SystemPrompt:  systemPrompt,
				MaxTokens:     t.maxTokens,
				Temperature:   t.temperature,
				Async:         true, // Async execution
				Critical:      true, // Background spawn should survive parent turn completion
				TargetAgentID: targetAgentID,
			})
			if err != nil {
				result = ErrorResult(fmt.Sprintf("Spawn failed: %v", err)).WithError(err)
			}

			// Update task status in manager after completion
			if !panicked && t.manager != nil && taskID != "" {
				if err != nil {
					t.manager.CompleteSpawnTask(taskID, "failed", fmt.Sprintf("Spawn failed: %v", err))
				} else if result != nil && result.IsError {
					t.manager.CompleteSpawnTask(taskID, "failed", result.ForLLM)
				} else {
					t.manager.CompleteSpawnTask(taskID, "completed", result.ForLLM)
				}
			}

			// Call callback if provided
			if cb != nil {
				cb(ctx, result)
			}
		}()

		// Return immediate acknowledgment
		if label != "" {
			return AsyncResult(fmt.Sprintf("Spawned subagent '%s' for task: %s", label, task))
		}
		return AsyncResult(fmt.Sprintf("Spawned subagent for task: %s", task))
	}

	// Fallback: spawner not configured
	return ErrorResult("Subagent manager not configured")
}
