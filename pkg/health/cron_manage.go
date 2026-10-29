package health

// CronPatch intentionally excludes task prompts, commands and delivery targets.
type CronPatch struct {
	Enabled        *bool   `json:"enabled,omitempty"`
	CronExpression *string `json:"cronExpression,omitempty"`
	EveryMS        *int64  `json:"everyMs,omitempty"`
	Timezone       *string `json:"timezone,omitempty"`
}

func (s *Server) SetCronUpdateFunc(fn func(string, CronPatch) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cronUpdateFunc = fn
}

type CronCreate struct {
	Name     string `json:"name"`
	Message  string `json:"message"`
	Channel  string `json:"channel"`
	To       string `json:"to"`
	Schedule struct {
		Kind    string `json:"kind"`
		Expr    string `json:"expr,omitempty"`
		EveryMS *int64 `json:"everyMs,omitempty"`
		TZ      string `json:"tz,omitempty"`
	} `json:"schedule"`
}

func (s *Server) SetCronCreateFunc(fn func(CronCreate) (any, error)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cronCreateFunc = fn
}
