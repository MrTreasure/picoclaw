package api

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var thumbnailSource = regexp.MustCompile(`^(/api/codex/images/[0-9a-f]{32}\.(jpg|png|gif|webp)|/pico/media/[a-zA-Z0-9_-]+)$`)
var thumbnailSlots = make(chan struct{}, 2)
var thumbnailCache = struct {
	sync.Mutex
	values map[string][]byte
	order  []string
	bytes  int
}{values: make(map[string][]byte)}

func (h *Handler) handleImageThumbnail(w http.ResponseWriter, r *http.Request) {
	source := r.URL.Query().Get("src")
	if !thumbnailSource.MatchString(source) {
		http.Error(w, "unsupported image source", http.StatusBadRequest)
		return
	}
	select {
	case thumbnailSlots <- struct{}{}:
		defer func() { <-thumbnailSlots }()
	default:
		http.Error(w, "thumbnail service busy", http.StatusServiceUnavailable)
		return
	}
	var body io.ReadCloser
	if strings.HasPrefix(source, "/api/codex/images/") {
		file, err := os.Open(filepath.Join(h.codexImageDir(), filepath.Base(source)))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		body = file
	} else {
		if !h.gatewayAvailableForProxy() {
			http.Error(w, "gateway unavailable", 503)
			return
		}
		gateway.mu.Lock()
		token := gateway.picoToken
		gateway.mu.Unlock()
		if token == "" {
			http.Error(w, "media unavailable", 503)
			return
		}
		target := *h.gatewayProxyURL()
		target.Path = source
		target.RawQuery = ""
		target.Fragment = ""
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
		if err != nil {
			http.Error(w, "media unavailable", 503)
			return
		}
		req.Header.Set("Authorization", "Bearer "+token)
		client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		res, err := client.Do(req)
		if err != nil {
			http.Error(w, "media unavailable", 502)
			return
		}
		if res.StatusCode != http.StatusOK {
			res.Body.Close()
			http.Error(w, "media unavailable", res.StatusCode)
			return
		}
		body = res.Body
	}
	defer body.Close()
	const maxBytes = 12 << 20
	data, err := io.ReadAll(io.LimitReader(body, maxBytes+1))
	if err != nil || len(data) > maxBytes {
		http.Error(w, "image exceeds preview limit", 413)
		return
	}
	sum := sha256.Sum256(data)
	key := fmt.Sprintf("%x", sum)
	etag := `"thumb-v1-` + key + `"`
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("ETag", etag)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(304)
		return
	}
	thumbnailCache.Lock()
	cached := thumbnailCache.values[key]
	thumbnailCache.Unlock()
	if cached == nil {
		config, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 16000000 {
			http.Error(w, "preview format or dimensions unsupported", 415)
			return
		}
		src, _, err := image.Decode(bytes.NewReader(data))
		if err != nil {
			http.Error(w, "invalid image", 415)
			return
		}
		if r.Context().Err() != nil {
			return
		}
		scale := math.Min(1, 480.0/float64(max(config.Width, config.Height)))
		width, height := max(1, int(float64(config.Width)*scale)), max(1, int(float64(config.Height)*scale))
		dst := image.NewRGBA(image.Rect(0, 0, width, height))
		bounds := src.Bounds()
		for y := 0; y < height; y++ {
			sy := (float64(y)+0.5)*float64(config.Height)/float64(height) - 0.5
			y0 := max(0, int(sy))
			y1 := min(config.Height-1, y0+1)
			fy := math.Max(0, sy-float64(y0))
			for x := 0; x < width; x++ {
				sx := (float64(x)+0.5)*float64(config.Width)/float64(width) - 0.5
				x0 := max(0, int(sx))
				x1 := min(config.Width-1, x0+1)
				fx := math.Max(0, sx-float64(x0))
				var red, green, blue float64
				for i, p := range [4]image.Point{{x0, y0}, {x1, y0}, {x0, y1}, {x1, y1}} {
					weight := [4]float64{(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy}[i]
					rr, gg, bb, aa := src.At(bounds.Min.X+p.X, bounds.Min.Y+p.Y).RGBA()
					red += float64(rr+65535-aa) * weight
					green += float64(gg+65535-aa) * weight
					blue += float64(bb+65535-aa) * weight
				}
				dst.SetRGBA(x, y, color.RGBA{uint8(red / 257), uint8(green / 257), uint8(blue / 257), 255})
			}
		}
		var output bytes.Buffer
		if jpeg.Encode(&output, dst, &jpeg.Options{Quality: 82}) != nil {
			http.Error(w, "preview failed", 500)
			return
		}
		cached = output.Bytes()
		thumbnailCache.Lock()
		if _, exists := thumbnailCache.values[key]; !exists {
			for len(thumbnailCache.order) > 0 && (len(thumbnailCache.order) >= 64 || thumbnailCache.bytes+len(cached) > 8<<20) {
				old := thumbnailCache.order[0]
				thumbnailCache.order = thumbnailCache.order[1:]
				thumbnailCache.bytes -= len(thumbnailCache.values[old])
				delete(thumbnailCache.values, old)
			}
			thumbnailCache.values[key] = cached
			thumbnailCache.order = append(thumbnailCache.order, key)
			thumbnailCache.bytes += len(cached)
		}
		thumbnailCache.Unlock()
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Write(cached)
}
