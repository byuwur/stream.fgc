// Upload regressions exercise resource limits without allocating large images.
package backend

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// pngHeader creates only an IHDR chunk to test preflight without allocating large images.
func pngHeader(width, height uint32) []byte {
	data := make([]byte, 33)
	copy(data, "\x89PNG\r\n\x1a\n")
	binary.BigEndian.PutUint32(data[8:12], 13)
	copy(data[12:16], "IHDR")
	binary.BigEndian.PutUint32(data[16:20], width)
	binary.BigEndian.PutUint32(data[20:24], height)
	data[24], data[25] = 8, 2
	binary.BigEndian.PutUint32(data[29:33], crc32.ChecksumIEEE(data[12:29]))
	return data
}

// TestImagePreflight rejects large dimensions before the decoder reaches missing pixel data.
func TestImagePreflight(t *testing.T) {
	for _, size := range [][2]uint32{{8193, 1}, {8192, 8192}, {8000, 4001}} {
		data := base64.StdEncoding.EncodeToString(pngHeader(size[0], size[1]))
		app := NewApp()
		for _, save := range []func(string) (string, error){func(data string) (string, error) { return app.SavePlayerPortrait("1", data) }, app.SaveEventLogo, app.SaveEventBackground} {
			if _, err := save(data); err == nil || !strings.Contains(err.Error(), "exceeds") {
				t.Fatalf("preflight failed: %v", err)
			}
		}
	}
	for _, size := range [][2]uint32{{8192, 1}, {8000, 4000}} {
		_, err := decodeBoundedImage(pngHeader(size[0], size[1]))
		if err == nil || strings.Contains(err.Error(), "exceeds") {
			t.Fatalf("within-budget header should reach full decoder: %v", err)
		}
	}
	for _, data := range []string{"!!!", "data:image/png,abc", strings.Repeat("A", base64.StdEncoding.EncodedLen(playerPortraitMaxBytes)+257)} {
		if _, err := decodePlayerPortraitData(data); err == nil {
			t.Fatal("accepted malformed or excessive base64")
		}
	}
}

// TestAcceptedUploadFormats exercises accepted formats and output encoding through public upload methods.
func TestAcceptedUploadFormats(t *testing.T) {
	app := tournamentTestApp(t)
	for _, encode := range []func(*bytes.Buffer) error{
		func(b *bytes.Buffer) error { return png.Encode(b, image.NewRGBA(image.Rect(0, 0, 2, 2))) },
		func(b *bytes.Buffer) error { return jpeg.Encode(b, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil) },
	} {
		var data bytes.Buffer
		if err := encode(&data); err != nil {
			t.Fatal(err)
		}
		payload := base64.StdEncoding.EncodeToString(data.Bytes())
		for _, save := range []func(string) (string, error){func(s string) (string, error) { return app.SavePlayerPortrait("1", s) }, app.SaveEventLogo, app.SaveEventBackground} {
			if _, err := save(payload); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, name := range []string{"1.png", "_logo.png", "_bg.jpg"} {
		data, err := os.ReadFile(filepath.Join("players", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
			t.Fatal(err)
		}
	}
}
