package agent

import "time"

// TurnEndStatus describes the terminal state of a turn.
type TurnEndStatus string

const (
	// TurnEndStatusCompleted indicates the turn finished normally.
	TurnEndStatusCompleted TurnEndStatus = "completed"
	// TurnEndStatusError indicates the turn ended because of an error.
	TurnEndStatusError TurnEndStatus = "error"
	// TurnEndStatusAborted indicates the turn was hard-aborted and rolled back.
	TurnEndStatusAborted TurnEndStatus = "aborted"
)

// TurnStartPayload describes the start of a turn.
type TurnStartPayload struct {
	UserMessage string
	MediaCount  int
}

const (
	skillContextTriggerInitialBuild        = "initial_build"
	skillContextTriggerContextRetryRebuild = "context_retry_rebuild"
)

type SkillContextSnapshot struct {
	Sequence   int      `json:"sequence"`
	Trigger    string   `json:"trigger"`
	SkillNames []string `json:"skill_names,omitempty"`
}

type ToolExecutionRecord struct {
	Name         string   `json:"name"`
	Success      bool     `json:"success"`
	ErrorSummary string   `json:"error_summary,omitempty"`
	SkillNames   []string `json:"skill_names,omitempty"`
}

// TurnEndPayload describes the completion of a turn.
type TurnEndPayload struct {
	Status                TurnEndStatus
	Workspace             string
	Iterations            int
	Duration              time.Duration
	FinalContentLen       int
	UserMessage           string
	FinalContent          string
	ActiveSkills          []string
	AttemptedSkills       []string
	FinalSuccessfulPath   []string
	SkillContextSnapshots []SkillContextSnapshot
	ToolKinds             []string
	ToolExecutions        []ToolExecutionRecord
}

// LLMRequestPayload describes an outbound LLM request.
type LLMRequestPayload struct {
	Model         string
	MessagesCount int
	ToolsCount    int
	MaxTokens     int
	Temperature   float64
}

// LLMResponsePayload describes an inbound LLM response.
type LLMResponsePayload struct {
	Model            string
	ContentLen       int
	ToolCalls        int
	HasReasoning     bool
	PromptTokens     int
	CompletionTokens int

	// CachedTokens is the subset of PromptTokens the provider served from its
	// prefix cache. The observer and the downstream ingest API read this key
	// by name (alongside cached_tokens / cacheReadTokens), so it must stay
	// spelled exactly like this.
	CachedTokens int
}

// LLMDeltaPayload describes a streamed LLM delta.
type LLMDeltaPayload struct {
	ContentDeltaLen   int
	ReasoningDeltaLen int
}

// LLMRetryPayload describes a retry of an LLM request.
type LLMRetryPayload struct {
	Attempt    int
	MaxRetries int
	Reason     string
	Error      string
	Backoff    time.Duration
}

// ContextCompressReason identifies why emergency compression ran.
type ContextCompressReason string

const (
	// ContextCompressReasonProactive indicates compression before the first LLM call.
	ContextCompressReasonProactive ContextCompressReason = "proactive_budget"
	// ContextCompressReasonRetry indicates compression during context-error retry handling.
	ContextCompressReasonRetry ContextCompressReason = "llm_retry"
	// ContextCompressReasonSummarize indicates post-turn async summarization.
	ContextCompressReasonSummarize ContextCompressReason = "summarize"
	// ContextCompressReasonTurnThreshold indicates configured turn-count summarization.
	ContextCompressReasonTurnThreshold ContextCompressReason = "turn_threshold"
)

// ContextCompressPayload describes a forced history compression.
type ContextCompressPayload struct {
	Reason            ContextCompressReason
	DroppedMessages   int
	RemainingMessages int

	// The seahorse engine reports its work as summary counts and reclaimed
	// tokens rather than message counts, so the two halves of the struct are
	// filled by different context managers. Whichever fields a manager cannot
	// report stay zero rather than being guessed at.
	SummaryCount       int
	TokensSaved        int
	LeafSummaries      int
	CondensedSummaries int
	Error              string
}

// SessionSummarizePayload describes a completed async session summarization.
type SessionSummarizePayload struct {
	SummarizedMessages int
	KeptMessages       int
	SummaryLen         int
	OmittedOversized   bool

	// seahorse creates summaries in batches and reports the count directly.
	SummariesCreated int
}

// ToolExecStartPayload describes a tool execution request.
type ToolExecStartPayload struct {
	Tool      string
	Arguments map[string]any
}

// ToolExecEndPayload describes the outcome of a tool execution.
type ToolExecEndPayload struct {
	Tool       string
	Duration   time.Duration
	ForLLMLen  int
	ForUserLen int
	IsError    bool
	Async      bool
}

// ToolExecSkippedPayload describes a skipped tool call.
type ToolExecSkippedPayload struct {
	Tool   string
	Reason string
}

// SteeringInjectedPayload describes steering messages appended before the next LLM call.
type SteeringInjectedPayload struct {
	Count           int
	TotalContentLen int
}

// FollowUpQueuedPayload describes an async follow-up queued back into the inbound bus.
type FollowUpQueuedPayload struct {
	SourceTool string
	ContentLen int
}

type InterruptKind string

const (
	InterruptKindSteering InterruptKind = "steering"
	InterruptKindGraceful InterruptKind = "graceful"
	InterruptKindHard     InterruptKind = "hard_abort"
)

// InterruptReceivedPayload describes accepted turn-control input.
type InterruptReceivedPayload struct {
	Kind       InterruptKind
	Role       string
	ContentLen int
	QueueDepth int
	HintLen    int
}

// SubTurnSpawnPayload describes the creation of a child turn.
type SubTurnSpawnPayload struct {
	AgentID      string
	Label        string
	ParentTurnID string
}

// SubTurnEndPayload describes the completion of a child turn.
type SubTurnEndPayload struct {
	AgentID string
	Status  string
}

// SubTurnResultDeliveredPayload describes delivery of a sub-turn result.
type SubTurnResultDeliveredPayload struct {
	TargetChannel string
	TargetChatID  string
	ContentLen    int
}

// SubTurnOrphanPayload describes a sub-turn result that could not be delivered.
type SubTurnOrphanPayload struct {
	ParentTurnID string
	ChildTurnID  string
	Reason       string
}

// ErrorPayload describes an execution error inside the agent loop.
type ErrorPayload struct {
	Stage   string
	Message string
}
