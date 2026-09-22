package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sipeed/picoclaw/web/backend/deviceauth"
	"github.com/sipeed/picoclaw/web/backend/middleware"
)

type androidTestPasswordStore struct{ password string }

func (s *androidTestPasswordStore) IsInitialized(context.Context) (bool, error) { return true, nil }
func (s *androidTestPasswordStore) SetPassword(context.Context, string) error   { return nil }
func (s *androidTestPasswordStore) VerifyPassword(_ context.Context, value string) (bool, error) {
	return value == s.password, nil
}

func TestAndroidDeviceLoginBearerWebGrantAndRevoke(t *testing.T) {
	store, err := deviceauth.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	grants := deviceauth.NewGrantStore()
	mux := http.NewServeMux()
	RegisterAndroidDeviceRoutes(mux, AndroidDeviceRouteOpts{
		PasswordStore: &androidTestPasswordStore{password: "correct horse"},
		DeviceStore:   store,
		WebGrants:     grants,
	})
	mux.HandleFunc("GET /api/protected", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"device_id": middleware.LauncherDeviceID(r)})
	})
	mux.HandleFunc("GET /api/sessions", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"device_id": middleware.LauncherDeviceID(r)})
	})
	mux.HandleFunc("POST /pico/upload", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"device_id": middleware.LauncherDeviceID(r)})
	})
	handler := middleware.LauncherDashboardAuth(middleware.LauncherDashboardAuthConfig{
		ExpectedCookie: "browser-session",
		DeviceAuth:     store,
		WebGrants:      grants,
	}, mux)

	loginBody := []byte(`{"password":"correct horse","device_name":"Xiaomi 17 Pro Max"}`)
	login := httptest.NewRecorder()
	handler.ServeHTTP(login, httptest.NewRequest(http.MethodPost, "/api/android/devices/login", bytes.NewReader(loginBody)))
	if login.Code != http.StatusOK {
		t.Fatalf("login status %d: %s", login.Code, login.Body.String())
	}
	var credential struct {
		Device deviceauth.Device `json:"device"`
		Token  string            `json:"token"`
	}
	if err := json.Unmarshal(login.Body.Bytes(), &credential); err != nil {
		t.Fatal(err)
	}

	protected := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/sessions", nil)
	req.Header.Set("Authorization", "Bearer "+credential.Token)
	handler.ServeHTTP(protected, req)
	if protected.Code != http.StatusOK {
		t.Fatalf("bearer status %d: %s", protected.Code, protected.Body.String())
	}
	upload := httptest.NewRecorder()
	uploadReq := httptest.NewRequest(http.MethodPost, "/pico/upload", nil)
	uploadReq.Header.Set("Authorization", "Bearer "+credential.Token)
	handler.ServeHTTP(upload, uploadReq)
	if upload.Code != http.StatusOK {
		t.Fatalf("upload bearer status %d: %s", upload.Code, upload.Body.String())
	}
	denied := httptest.NewRecorder()
	deniedReq := httptest.NewRequest(http.MethodGet, "/api/protected", nil)
	deniedReq.Header.Set("Authorization", "Bearer "+credential.Token)
	handler.ServeHTTP(denied, deniedReq)
	if denied.Code != http.StatusUnauthorized {
		t.Fatalf("bearer reached unscoped API: %d", denied.Code)
	}

	grantRec := httptest.NewRecorder()
	grantReq := httptest.NewRequest(http.MethodPost, "/api/android/webview-grant", nil)
	grantReq.Header.Set("Authorization", "Bearer "+credential.Token)
	handler.ServeHTTP(grantRec, grantReq)
	var grant struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(grantRec.Body.Bytes(), &grant); err != nil {
		t.Fatal(err)
	}
	web := httptest.NewRecorder()
	handler.ServeHTTP(web, httptest.NewRequest(http.MethodGet, grant.Path, nil))
	if web.Code != http.StatusSeeOther || len(web.Result().Cookies()) != 1 {
		t.Fatalf("web bootstrap = %d cookies=%d", web.Code, len(web.Result().Cookies()))
	}
	if location := web.Header().Get("Location"); location != "/config" {
		t.Fatalf("web bootstrap location = %q, want /config", location)
	}
	reuse := httptest.NewRecorder()
	handler.ServeHTTP(reuse, httptest.NewRequest(http.MethodGet, grant.Path, nil))
	if reuse.Code != http.StatusFound {
		t.Fatalf("grant reuse status = %d", reuse.Code)
	}

	revoke := httptest.NewRecorder()
	revokeReq := httptest.NewRequest(http.MethodDelete, "/api/android/devices/"+credential.Device.ID, nil)
	revokeReq.Header.Set("Authorization", "Bearer "+credential.Token)
	handler.ServeHTTP(revoke, revokeReq)
	if revoke.Code != http.StatusNoContent {
		t.Fatalf("revoke status %d: %s", revoke.Code, revoke.Body.String())
	}
	after := httptest.NewRecorder()
	handler.ServeHTTP(after, req)
	if after.Code != http.StatusUnauthorized {
		t.Fatalf("revoked bearer status = %d", after.Code)
	}
}

func TestAndroidDeviceLoginRejectsWrongPassword(t *testing.T) {
	store, _ := deviceauth.New(t.TempDir())
	mux := http.NewServeMux()
	RegisterAndroidDeviceRoutes(mux, AndroidDeviceRouteOpts{PasswordStore: &androidTestPasswordStore{password: "right"}, DeviceStore: store})
	handler := middleware.LauncherDashboardAuth(middleware.LauncherDashboardAuthConfig{ExpectedCookie: "browser", DeviceAuth: store}, mux)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/android/devices/login", bytes.NewBufferString(`{"password":"wrong","device_name":"phone"}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}
}
