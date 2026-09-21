package main

import (
	"mime"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUnknownAPIPathStays404(t *testing.T) {
	mux := http.NewServeMux()
	registerEmbedRoutes(mux)

	req := httptest.NewRequest(http.MethodGet, "/api/not-found", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusNotFound)
	}
}

func TestMissingAssetStays404(t *testing.T) {
	mux := http.NewServeMux()
	registerEmbedRoutes(mux)

	req := httptest.NewRequest(http.MethodGet, "/assets/not-found.js", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusNotFound)
	}
}

func TestWebManifestUsesManifestContentType(t *testing.T) {
	mux := http.NewServeMux()
	registerEmbedRoutes(mux)

	req := httptest.NewRequest(http.MethodGet, "/site.webmanifest", nil)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)

	if got := mime.TypeByExtension(".webmanifest"); got != "application/manifest+json" {
		t.Fatalf("Content-Type = %q, want application/manifest+json", got)
	}
}
