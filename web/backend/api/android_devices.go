package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/sipeed/picoclaw/web/backend/deviceauth"
	"github.com/sipeed/picoclaw/web/backend/middleware"
)

type DeviceCredentialStore interface {
	Create(context.Context, string) (deviceauth.Device, string, error)
	List(context.Context) ([]deviceauth.Device, error)
	Revoke(context.Context, string) error
}

type AndroidDeviceRouteOpts struct {
	PasswordStore PasswordStore
	DeviceStore   DeviceCredentialStore
	WebGrants     *deviceauth.GrantStore
}

type androidDeviceHandlers struct {
	passwordStore PasswordStore
	deviceStore   DeviceCredentialStore
	webGrants     *deviceauth.GrantStore
	loginLimit    *loginRateLimiter
}

type androidDeviceLoginBody struct {
	Password   string `json:"password"`
	DeviceName string `json:"device_name"`
}

func RegisterAndroidDeviceRoutes(mux *http.ServeMux, opts AndroidDeviceRouteOpts) {
	h := &androidDeviceHandlers{
		passwordStore: opts.PasswordStore,
		deviceStore:   opts.DeviceStore,
		webGrants:     opts.WebGrants,
		loginLimit:    newLoginRateLimiter(),
	}
	mux.HandleFunc("POST /api/android/devices/login", h.login)
	mux.HandleFunc("GET /api/android/devices", h.list)
	mux.HandleFunc("DELETE /api/android/devices/{id}", h.revoke)
	mux.HandleFunc("POST /api/android/webview-grant", h.issueWebViewGrant)
}

func (h *androidDeviceHandlers) login(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.passwordStore == nil || h.deviceStore == nil {
		http.Error(w, `{"error":"device login unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	if !h.loginLimit.allow(clientIPForLimiter(r)) {
		http.Error(w, `{"error":"too many login attempts"}`, http.StatusTooManyRequests)
		return
	}
	var body androidDeviceLoginBody
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	ok, err := h.passwordStore.VerifyPassword(r.Context(), strings.TrimSpace(body.Password))
	if err != nil {
		http.Error(w, `{"error":"password verification failed"}`, http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, `{"error":"invalid password"}`, http.StatusUnauthorized)
		return
	}
	device, token, err := h.deviceStore.Create(r.Context(), body.DeviceName)
	if errors.Is(err, deviceauth.ErrInvalidName) {
		http.Error(w, `{"error":"invalid device name"}`, http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"failed to create device credential"}`, http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"device": device, "token": token})
}

func (h *androidDeviceHandlers) list(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	devices, err := h.deviceStore.List(r.Context())
	if err != nil {
		http.Error(w, `{"error":"failed to list devices"}`, http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"devices": devices})
}

func (h *androidDeviceHandlers) revoke(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if err := h.deviceStore.Revoke(r.Context(), r.PathValue("id")); err != nil {
		if errors.Is(err, deviceauth.ErrUnknownCredential) {
			http.Error(w, `{"error":"device not found"}`, http.StatusNotFound)
			return
		}
		http.Error(w, `{"error":"failed to revoke device"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *androidDeviceHandlers) issueWebViewGrant(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	deviceID := middleware.LauncherDeviceID(r)
	if deviceID == "" || h.webGrants == nil {
		http.Error(w, `{"error":"device authorization required"}`, http.StatusUnauthorized)
		return
	}
	nonce, err := h.webGrants.Issue(deviceID, time.Minute)
	if err != nil {
		http.Error(w, `{"error":"failed to issue web login grant"}`, http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"path": middleware.LauncherAndroidWebLoginPath + "?nonce=" + nonce})
}
