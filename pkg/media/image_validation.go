package media

import (
	"bytes"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"strings"
)

// ValidateImage checks that the declared image MIME matches bytes that can be
// fully decoded. Never trust file extensions or data URL headers as evidence.
func ValidateImage(data []byte, mime string) error {
	mime = strings.ToLower(strings.TrimSpace(strings.Split(mime, ";")[0]))
	expected := map[string]string{"image/jpeg": "jpeg", "image/png": "png", "image/gif": "gif"}[mime]
	if expected == "" || len(data) == 0 || len(data) > 20<<20 {
		return fmt.Errorf("unsupported or oversized image")
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || format != expected || cfg.Width < 1 || cfg.Height < 1 || int64(cfg.Width)*int64(cfg.Height) > 80_000_000 {
		return fmt.Errorf("invalid %s image", mime)
	}
	_, decodedFormat, err := image.Decode(bytes.NewReader(data))
	if err != nil || decodedFormat != expected {
		return fmt.Errorf("corrupt %s image", mime)
	}
	return nil
}
