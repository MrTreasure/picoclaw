package commands

import "context"

func compactCommand() Definition {
	return Definition{
		Name:        "compact",
		Description: "Compact the current conversation context",
		Usage:       "/compact",
		Handler: func(_ context.Context, req Request, rt *Runtime) error {
			if rt == nil || rt.CompactContext == nil {
				return req.Reply(unavailableMsg)
			}
			if err := rt.CompactContext(); err != nil {
				return req.Reply("Failed to compact context: " + err.Error())
			}
			return req.Reply("Context compaction started.")
		},
	}
}
