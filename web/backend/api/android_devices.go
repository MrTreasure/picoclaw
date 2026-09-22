package api

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
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
	ReleaseDir    string
}

type androidDeviceHandlers struct {
	passwordStore PasswordStore
	deviceStore   DeviceCredentialStore
	webGrants     *deviceauth.GrantStore
	releaseDir    string
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
		releaseDir:    opts.ReleaseDir,
		loginLimit:    newLoginRateLimiter(),
	}
	mux.HandleFunc("POST /api/android/devices/login", h.login)
	mux.HandleFunc("GET /api/android/devices", h.list)
	mux.HandleFunc("DELETE /api/android/devices/{id}", h.revoke)
	mux.HandleFunc("POST /api/android/webview-grant", h.issueWebViewGrant)
	mux.HandleFunc("GET /api/android/releases/latest", h.latestRelease)
	mux.HandleFunc("GET /api/android/releases/download", h.downloadRelease)
}

type androidRelease struct {
	VersionCode int    `json:"version_code"`
	VersionName string `json:"version_name"`
	Filename    string `json:"filename"`
	SHA256      string `json:"sha256"`
	Size        int64  `json:"size"`
	Notes       string `json:"notes,omitempty"`
	PublishedAt string `json:"published_at"`
	DownloadURL string `json:"download_url,omitempty"`
}

func (h *androidDeviceHandlers) readLatestRelease() (androidRelease, string, error) {
	var release androidRelease
	if h.releaseDir == "" {
		return release, "", os.ErrNotExist
	}
	data, err := os.ReadFile(filepath.Join(h.releaseDir, "latest.json"))
	if err != nil {
		return release, "", err
	}
	if err = json.Unmarshal(data, &release); err != nil {
		return release, "", err
	}
	if release.VersionCode < 1 || strings.TrimSpace(release.VersionName) == "" || filepath.Base(release.Filename) != release.Filename || !strings.HasSuffix(strings.ToLower(release.Filename), ".apk") {
		return release, "", errors.New("invalid release manifest")
	}
	apkPath := filepath.Join(h.releaseDir, release.Filename)
	info, err := os.Lstat(apkPath)
	if err != nil || !info.Mode().IsRegular() {
		if err == nil {
			err = errors.New("release is not a regular file")
		}
		return release, "", err
	}
	if release.Size != info.Size() {
		return release, "", errors.New("release size mismatch")
	}
	return release, apkPath, nil
}

func (h *androidDeviceHandlers) latestRelease(w http.ResponseWriter, r *http.Request) {
	release, _, err := h.readLatestRelease()
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, `{"error":"no Android release available"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"invalid Android release"}`, http.StatusInternalServerError)
		return
	}
	release.DownloadURL = "/api/android/releases/download"
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(release)
}

func (h *androidDeviceHandlers) downloadRelease(w http.ResponseWriter, r *http.Request) {
	release, apkPath, err := h.readLatestRelease()
	if err != nil {
		http.Error(w, `{"error":"Android release unavailable"}`, http.StatusNotFound)
		return
	}
	file, err := os.Open(apkPath)
	if err != nil {
		http.Error(w, `{"error":"Android release unavailable"}`, http.StatusNotFound)
		return
	}
	defer file.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil || !strings.EqualFold(fmt.Sprintf("%x", hash.Sum(nil)), release.SHA256) {
		http.Error(w, `{"error":"Android release integrity check failed"}`, http.StatusInternalServerError)
		return
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		http.Error(w, `{"error":"Android release unavailable"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, release.Filename))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", release.Size))
	_, _ = io.Copy(w, file)
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
	_ = json.NewEncoder(w).Encode(map[string]string{"path": middleware.LauncherAndroidWebLoginPath + "?nonce=" + nonce + "&next=%2Fconfig"})
}
