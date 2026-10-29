package cron

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	pb "github.com/sipeed/picoclaw/pkg/rpc/orbitv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"path/filepath"
	"strings"
	"time"
)

func liveCronRPC(home, token, method, path string, body, result any) (bool, error) {
	c, e := grpc.NewClient("unix:"+filepath.Join(home, "cron-rpc.sock"), grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithDisableRetry(), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(100000), grpc.MaxCallSendMsgSize(100000)))
	if e != nil {
		return true, e
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+token)
	client := pb.NewMuseCronServiceClient(c)
	keyBytes := make([]byte, 16)
	if _, e = rand.Read(keyBytes); e != nil {
		return true, e
	}
	key := hex.EncodeToString(keyBytes)
	b, e := json.Marshal(body)
	if e != nil {
		return true, e
	}
	if method == "PATCH" {
		var input struct {
			Enabled    *bool   `json:"enabled"`
			Expression *string `json:"cronExpression"`
			Timezone   *string `json:"timezone"`
			Every      *int64  `json:"everyMs"`
		}
		if e = json.Unmarshal(b, &input); e == nil {
			_, e = client.UpdateJob(ctx, &pb.CronPatch{JobId: strings.TrimPrefix(path, "/internal/cron/jobs/"), Enabled: input.Enabled, CronExpression: input.Expression, Timezone: input.Timezone, EveryMs: input.Every, IdempotencyKey: key})
		}
	}
	if method == "DELETE" {
		_, e = client.DeleteJob(ctx, &pb.CronDelete{JobId: strings.TrimPrefix(path, "/internal/cron/jobs/"), IdempotencyKey: key})
	}
	if method == "POST" {
		var in struct {
			Name     string `json:"name"`
			Message  string `json:"message"`
			Channel  string `json:"channel"`
			To       string `json:"to"`
			Schedule struct {
				Kind  string `json:"kind"`
				Expr  string `json:"expr"`
				Every int64  `json:"everyMs"`
			} `json:"schedule"`
		}
		if e = json.Unmarshal(b, &in); e == nil {
			var out *pb.Result
			out, e = client.CreateJob(ctx, &pb.CronCreate{Name: in.Name, Message: in.Message, Channel: in.Channel, Recipient: in.To, Expression: in.Schedule.Expr, EveryMs: in.Schedule.Every, IdempotencyKey: key})
			if e == nil && result != nil {
				b, e = json.Marshal(out.Value.AsMap())
				if e == nil {
					e = json.Unmarshal(b, result)
				}
			}
		}
	}
	if e != nil {
		return true, fmt.Errorf("running scheduler native RPC failed; no offline replay")
	}
	return true, nil
}
