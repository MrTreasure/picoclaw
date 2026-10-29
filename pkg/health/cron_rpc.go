package health

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	pb "github.com/sipeed/picoclaw/pkg/rpc/orbitv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	hp "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/structpb"
)

type cronOutcome struct {
	Digest   string         `json:"digest"`
	Complete bool           `json:"complete"`
	Result   map[string]any `json:"result,omitempty"`
	At       int64          `json:"at"`
}
type cronNative struct {
	pb.UnimplementedMuseCronServiceServer
	owner    *Server
	mu       sync.Mutex
	file     string
	outcomes map[string]cronOutcome
}

func (n *cronNative) persist() error {
	b, e := json.Marshal(n.outcomes)
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(n.file), ".cron-rpc-*")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	return os.Rename(name, n.file)
}
func (n *cronNative) apply(ctx context.Context, key, method string, r proto.Message, fn func() (map[string]any, error)) (map[string]any, error) {
	if len(key) < 10 || len(key) > 150 {
		return nil, status.Error(codes.InvalidArgument, "IDEMPOTENCY_KEY_REQUIRED")
	}
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(r)
	sum := sha256.Sum256(append([]byte(method), b...))
	digest := hex.EncodeToString(sum[:])
	n.mu.Lock()
	defer n.mu.Unlock()
	if old, ok := n.outcomes[key]; ok {
		if old.Digest != digest {
			return nil, status.Error(codes.AlreadyExists, "IDEMPOTENCY_CONFLICT")
		}
		if !old.Complete {
			return nil, status.Error(codes.FailedPrecondition, "PREVIOUS_OUTCOME_UNCONFIRMED")
		}
		return old.Result, nil
	}
	if e := ctx.Err(); e != nil {
		return nil, status.FromContextError(e).Err()
	}
	if len(n.outcomes) > 10000 {
		return nil, status.Error(codes.ResourceExhausted, "CRON_OPERATION_HISTORY_FULL")
	}
	n.outcomes[key] = cronOutcome{Digest: digest, At: time.Now().Unix()}
	if e := n.persist(); e != nil {
		return nil, status.Error(codes.Unavailable, "CRON_INTENT_SAVE_FAILED")
	}
	out, e := fn()
	if e != nil {
		if errors.Is(e, ErrCronJobNotFound) {
			return nil, status.Error(codes.NotFound, "CRON_JOB_NOT_FOUND")
		}
		return nil, status.Error(codes.FailedPrecondition, "CRON_UPDATE_REJECTED")
	}
	entry := n.outcomes[key]
	entry.Complete = true
	entry.Result = out
	n.outcomes[key] = entry
	if e = n.persist(); e != nil {
		return nil, status.Error(codes.Unavailable, "CRON_OUTCOME_SAVE_FAILED")
	}
	return out, nil
}
func (n *cronNative) UpdateJob(ctx context.Context, r *pb.CronPatch) (*pb.Empty, error) {
	if r.JobId == "" || len(r.JobId) > 80 || strings.Contains(r.JobId, "/") {
		return nil, status.Error(codes.InvalidArgument, "INVALID_JOB")
	}
	n.owner.mu.RLock()
	fn := n.owner.cronUpdateFunc
	n.owner.mu.RUnlock()
	if fn == nil {
		return nil, status.Error(codes.Unavailable, "CRON_NOT_READY")
	}
	_, e := n.apply(ctx, r.IdempotencyKey, "UpdateJob", r, func() (map[string]any, error) {
		return map[string]any{}, fn(r.JobId, CronPatch{Enabled: r.Enabled, CronExpression: r.CronExpression, EveryMS: r.EveryMs, Timezone: r.Timezone})
	})
	return &pb.Empty{}, e
}
func (n *cronNative) DeleteJob(ctx context.Context, r *pb.CronDelete) (*pb.Empty, error) {
	if r.JobId == "" || len(r.JobId) > 80 || strings.Contains(r.JobId, "/") {
		return nil, status.Error(codes.InvalidArgument, "INVALID_JOB")
	}
	n.owner.mu.RLock()
	fn := n.owner.cronDeleteFunc
	n.owner.mu.RUnlock()
	if fn == nil {
		return nil, status.Error(codes.Unavailable, "CRON_NOT_READY")
	}
	_, e := n.apply(ctx, r.IdempotencyKey, "DeleteJob", r, func() (map[string]any, error) { return map[string]any{}, fn(r.JobId) })
	return &pb.Empty{}, e
}
func (n *cronNative) CreateJob(ctx context.Context, r *pb.CronCreate) (*pb.Result, error) {
	if r.Deliver {
		return nil, status.Error(codes.InvalidArgument, "DELIVER_FLAG_UNSUPPORTED")
	}
	if r.Timezone != "" {
		if _, e := time.LoadLocation(r.Timezone); e != nil {
			return nil, status.Error(codes.InvalidArgument, "INVALID_TIMEZONE")
		}
	}
	n.owner.mu.RLock()
	fn := n.owner.cronCreateFunc
	n.owner.mu.RUnlock()
	if fn == nil {
		return nil, status.Error(codes.Unavailable, "CRON_NOT_READY")
	}
	v, e := n.apply(ctx, r.IdempotencyKey, "CreateJob", r, func() (map[string]any, error) {
		in := CronCreate{Name: r.Name, Message: r.Message, Channel: r.Channel, To: r.Recipient}
		if r.EveryMs > 0 {
			in.Schedule.Kind = "every"
			in.Schedule.EveryMS = &r.EveryMs
		} else {
			in.Schedule.Kind = "cron"
			in.Schedule.Expr = r.Expression
			in.Schedule.TZ = r.Timezone
		}
		out, e := fn(in)
		if e != nil {
			return nil, e
		}
		b, e := json.Marshal(out)
		if e != nil {
			return nil, e
		}
		var job map[string]any
		if e = json.Unmarshal(b, &job); e != nil {
			return nil, e
		}
		return map[string]any{"id": job["id"], "name": job["name"]}, nil
	})
	if e != nil {
		return nil, e
	}
	out, e := structpb.NewStruct(v)
	return &pb.Result{Value: out}, e
}
func (s *Server) StartCronRPC() error {
	path := os.Getenv("PICOCLAW_CRON_RPC_SOCKET")
	if path == "" {
		return nil
	}
	clients := map[string]string{}
	if json.Unmarshal([]byte(os.Getenv("PICOCLAW_CRON_RPC_CLIENTS_JSON")), &clients) != nil || len(clients) == 0 {
		return errors.New("cron RPC callers missing")
	}
	clients["cli"] = s.authToken
	native := &cronNative{owner: s, file: filepath.Join(filepath.Dir(path), "cron-rpc-operations.json"), outcomes: map[string]cronOutcome{}}
	if b, e := os.ReadFile(native.file); e == nil {
		if len(b) > 2*1024*1024 || json.Unmarshal(b, &native.outcomes) != nil {
			return errors.New("invalid cron outcome store")
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	server := grpc.NewServer(grpc.MaxRecvMsgSize(100000), grpc.MaxSendMsgSize(100000), grpc.MaxConcurrentStreams(16), grpc.UnaryInterceptor(func(ctx context.Context, req any, info *grpc.UnaryServerInfo, next grpc.UnaryHandler) (any, error) {
		started := time.Now()
		md, _ := metadata.FromIncomingContext(ctx)
		raw := md.Get("authorization")
		role := ""
		if len(raw) == 1 && strings.HasPrefix(raw[0], "Bearer ") {
			given := sha256.Sum256([]byte(raw[0][7:]))
			for name, token := range clients {
				expected := sha256.Sum256([]byte(token))
				if len(token) >= 32 && subtle.ConstantTimeCompare(given[:], expected[:]) == 1 {
					role = name
				}
			}
		}
		if role == "" {
			return nil, status.Error(codes.Unauthenticated, "SERVICE_CREDENTIAL_REQUIRED")
		}
		if role != "cli" && role != "registry" {
			return nil, status.Error(codes.PermissionDenied, "CALLER_SCOPE_DENIED")
		}
		if role == "registry" && !strings.HasSuffix(info.FullMethod, "/UpdateJob") && !strings.HasPrefix(info.FullMethod, "/grpc.health.") {
			return nil, status.Error(codes.PermissionDenied, "CALLER_SCOPE_DENIED")
		}
		if _, ok := ctx.Deadline(); !ok {
			return nil, status.Error(codes.InvalidArgument, "DEADLINE_REQUIRED")
		}
		bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		out, e := next(bounded, req)
		log.Printf("rpc=%s status=%s elapsed_ms=%d", info.FullMethod, status.Code(e), time.Since(started).Milliseconds())
		return out, e
	}))
	pb.RegisterMuseCronServiceServer(server, native)
	ready := health.NewServer()
	ready.SetServingStatus("", hp.HealthCheckResponse_SERVING)
	hp.RegisterHealthServer(server, ready)
	if f, e := os.Lstat(path); e == nil {
		if f.Mode()&os.ModeSocket == 0 {
			return errors.New("cron RPC path is not a socket")
		}
		if e = os.Remove(path); e != nil {
			return e
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	listener, e := net.Listen("unix", path)
	if e != nil {
		return e
	}
	if e = os.Chmod(path, 0600); e != nil {
		listener.Close()
		return e
	}
	s.mu.Lock()
	s.cronRPCStop = func() { ready.Shutdown(); server.Stop(); os.Remove(path) }
	s.mu.Unlock()
	go func() {
		if e := server.Serve(listener); e != nil {
			log.Print("Cron RPC listener stopped")
		}
	}()
	return nil
}
func (s *Server) StopCronRPC() {
	s.mu.Lock()
	stop := s.cronRPCStop
	s.cronRPCStop = nil
	s.mu.Unlock()
	if stop != nil {
		stop()
	}
}
