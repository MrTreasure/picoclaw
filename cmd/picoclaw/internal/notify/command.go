package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/sipeed/picoclaw/cmd/picoclaw/internal"
	"github.com/sipeed/picoclaw/pkg/pid"
)

type target struct {
	Channel string `json:"channel"`
	To      string `json:"to"`
}

type targetsFile struct {
	Default string              `json:"default"`
	Groups  map[string][]target `json:"groups"`
}

type requestBody struct {
	Channel string `json:"channel"`
	To      string `json:"to"`
	Content string `json:"content"`
}

func NewNotifyCommand() *cobra.Command {
	var (
		message       string
		messageFile   string
		channel       string
		to            string
		directTargets []string
		groups        []string
		targetsPath   string
		timeout       time.Duration
	)

	cmd := &cobra.Command{
		Use:   "notify [message]",
		Short: "Send a direct notification through running channels",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			content, err := resolveContent(message, messageFile, args, cmd.InOrStdin())
			if err != nil {
				return err
			}
			targets, err := resolveTargets(
				internal.GetPicoclawHome(), targetsPath, channel, to, directTargets, groups,
			)
			if err != nil {
				return err
			}
			return sendAll(cmd, internal.GetPicoclawHome(), content, targets, timeout)
		},
	}

	defaultTargetsPath := filepath.Join(internal.GetPicoclawHome(), "notify-targets.json")
	cmd.Flags().StringVarP(&message, "message", "m", "", "Message text")
	cmd.Flags().StringVarP(&messageFile, "file", "f", "", "Read message from file, or - for stdin")
	cmd.Flags().StringVar(&channel, "channel", "", "Single channel name (use with --to)")
	cmd.Flags().StringVar(&to, "to", "", "Single channel recipient (use with --channel)")
	cmd.Flags().StringArrayVarP(&directTargets, "target", "t", nil, "Delivery target as channel:recipient (repeatable)")
	cmd.Flags().StringArrayVarP(&groups, "group", "g", nil, "Target group from notify-targets.json (repeatable)")
	cmd.Flags().StringVar(&targetsPath, "targets-file", defaultTargetsPath, "Target group configuration file")
	cmd.Flags().DurationVar(&timeout, "timeout", 30*time.Second, "Per-target delivery timeout")
	cmd.MarkFlagsRequiredTogether("channel", "to")
	cmd.MarkFlagsMutuallyExclusive("message", "file")
	return cmd
}

func resolveContent(message, messageFile string, args []string, stdin io.Reader) (string, error) {
	if message != "" && len(args) > 0 {
		return "", fmt.Errorf("use either positional message or --message")
	}
	content := message
	if len(args) == 1 {
		content = args[0]
	}
	if messageFile != "" {
		var data []byte
		var err error
		if messageFile == "-" {
			data, err = io.ReadAll(io.LimitReader(stdin, 256*1024+1))
		} else {
			data, err = os.ReadFile(messageFile)
		}
		if err != nil {
			return "", fmt.Errorf("read notification: %w", err)
		}
		if len(data) > 256*1024 {
			return "", fmt.Errorf("notification exceeds 256 KiB")
		}
		content = string(data)
	}
	if strings.TrimSpace(content) == "" {
		return "", fmt.Errorf("message is required")
	}
	return content, nil
}

func resolveTargets(home, path, channel, to string, direct, groups []string) ([]target, error) {
	targets := make([]target, 0, len(direct)+1)
	if channel != "" && to != "" {
		targets = append(targets, target{Channel: strings.TrimSpace(channel), To: strings.TrimSpace(to)})
	}
	for _, value := range direct {
		channelName, recipient, ok := strings.Cut(value, ":")
		if !ok || strings.TrimSpace(channelName) == "" || strings.TrimSpace(recipient) == "" {
			return nil, fmt.Errorf("invalid target %q; expected channel:recipient", value)
		}
		targets = append(targets, target{Channel: strings.TrimSpace(channelName), To: strings.TrimSpace(recipient)})
	}

	if len(groups) > 0 || len(targets) == 0 {
		data, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) && len(groups) == 0 && len(targets) == 0 {
				discovered, discoverErr := discoverWeixinTarget(home)
				if discoverErr != nil {
					return nil, discoverErr
				}
				targets = append(targets, discovered)
			} else {
				return nil, fmt.Errorf("read targets file: %w", err)
			}
		} else {
			var saved targetsFile
			if err := json.Unmarshal(data, &saved); err != nil {
				return nil, fmt.Errorf("parse targets file: %w", err)
			}
			if len(groups) == 0 {
				if strings.TrimSpace(saved.Default) == "" {
					return nil, fmt.Errorf("targets file has no default group")
				}
				groups = []string{saved.Default}
			}
			for _, group := range groups {
				groupTargets, ok := saved.Groups[group]
				if !ok {
					return nil, fmt.Errorf("target group %q not found", group)
				}
				targets = append(targets, groupTargets...)
			}
		}
	}

	seen := make(map[string]struct{}, len(targets))
	unique := targets[:0]
	for _, item := range targets {
		item.Channel = strings.TrimSpace(item.Channel)
		item.To = strings.TrimSpace(item.To)
		if item.Channel == "" || item.To == "" {
			return nil, fmt.Errorf("target channel and recipient are required")
		}
		key := item.Channel + "\x00" + item.To
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, item)
	}
	if len(unique) == 0 {
		return nil, fmt.Errorf("at least one target is required")
	}
	return unique, nil
}

func discoverWeixinTarget(home string) (target, error) {
	paths, err := filepath.Glob(filepath.Join(home, "channels", "weixin", "context-tokens", "*.json"))
	if err != nil {
		return target{}, fmt.Errorf("discover Weixin recipient: %w", err)
	}
	recipients := make(map[string]struct{})
	for _, path := range paths {
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			continue
		}
		var saved struct {
			Tokens map[string]string `json:"tokens"`
		}
		if json.Unmarshal(data, &saved) != nil {
			continue
		}
		for recipient, contextToken := range saved.Tokens {
			if strings.TrimSpace(recipient) != "" && strings.TrimSpace(contextToken) != "" {
				recipients[strings.TrimSpace(recipient)] = struct{}{}
			}
		}
	}
	if len(recipients) != 1 {
		return target{}, fmt.Errorf(
			"no default target configured and discovered %d Weixin recipients; use --target or notify-targets.json",
			len(recipients),
		)
	}
	for recipient := range recipients {
		return target{Channel: "weixin", To: recipient}, nil
	}
	panic("unreachable")
}

func sendAll(cmd *cobra.Command, home, content string, targets []target, timeout time.Duration) error {
	pidData := pid.ReadPidFileWithCheck(home)
	if pidData == nil || pidData.Token == "" || pidData.Port <= 0 {
		return fmt.Errorf("gateway is not running")
	}
	host := strings.TrimSpace(pidData.Host)
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	endpoint := "http://" + net.JoinHostPort(host, fmt.Sprintf("%d", pidData.Port)) + "/internal/notify"

	failed := make([]string, 0)
	for _, item := range targets {
		body, err := json.Marshal(requestBody{Channel: item.Channel, To: item.To, Content: content})
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(cmd.Context(), timeout)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err == nil {
			req.Header.Set("Authorization", "Bearer "+pidData.Token)
			req.Header.Set("Content-Type", "application/json")
			var response *http.Response
			response, err = http.DefaultClient.Do(req)
			if response != nil {
				responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
				_ = response.Body.Close()
				if response.StatusCode != http.StatusOK {
					var payload struct {
						Error string `json:"error"`
					}
					_ = json.Unmarshal(responseBody, &payload)
					if payload.Error == "" {
						payload.Error = response.Status
					}
					err = fmt.Errorf("%s", payload.Error)
				}
			}
		}
		cancel()
		if err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v", item.Channel, err))
			continue
		}
		fmt.Fprintf(cmd.OutOrStdout(), "✓ Sent via %s\n", item.Channel)
	}
	if len(failed) > 0 {
		return fmt.Errorf("%d delivery target(s) failed: %s", len(failed), strings.Join(failed, "; "))
	}
	return nil
}
