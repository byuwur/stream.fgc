// Upload regressions exercise resource limits without allocating large images.
package backend

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
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

// TestReplaceFileFailureAndPermissions exercises rename failure and temporary-file cleanup on Windows too.
func TestReplaceFileFailureAndPermissions(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "credentials.json")
	if err := replaceFile(target, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := replaceFile(target, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("credential mode is not private")
	}
	if runtime.GOOS == "windows" {
		if err := os.Chmod(target, 0400); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(target, 0600) })
		if err := replaceFile(target, []byte("damaged"), 0600); err == nil {
			t.Fatal("expected read-only replacement failure")
		}
		data, err := os.ReadFile(target)
		if err != nil || string(data) != "new" {
			t.Fatal("failed replacement damaged old bytes", err)
		}
		if err := os.Chmod(target, 0600); err != nil {
			t.Fatal(err)
		}
	}
	blocked := filepath.Join(dir, "blocked")
	if err := os.Mkdir(blocked, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(blocked, "old"), []byte("preserved"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := replaceFile(blocked, []byte("new"), 0600); err == nil {
		t.Fatal("expected rename failure")
	}
	data, err := os.ReadFile(filepath.Join(blocked, "old"))
	if err != nil || string(data) != "preserved" {
		t.Fatal("failed replacement damaged prior content", err)
	}
	leftovers, err := filepath.Glob(filepath.Join(dir, ".tournament-*.tmp"))
	if err != nil || len(leftovers) != 0 {
		t.Fatal("temporary files leaked", err)
	}
}

// TestConcurrentAssetSaveRemove checks readers see complete files or deliberate absence.
func TestConcurrentAssetSaveRemove(t *testing.T) {
	app := tournamentTestApp(t)
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	payload := base64.StdEncoding.EncodeToString(buffer.Bytes())
	operationErrors := make(chan error, 100)
	var workers sync.WaitGroup
	for worker := 0; worker < 3; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for i := 0; i < 10; i++ {
				if _, err := app.SavePlayerPortrait("1", payload); err != nil {
					if !windowsSharingFailure(err) {
						operationErrors <- err
					}
				}
				data, err := os.ReadFile(filepath.Join("players", "1.png"))
				if err == nil {
					if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
						operationErrors <- err
					}
				} else if !os.IsNotExist(err) {
					operationErrors <- err
				}
				if _, err := app.RemovePlayerPortrait("1"); err != nil {
					if !windowsSharingFailure(err) {
						operationErrors <- err
					}
				}
			}
		}()
	}
	workers.Wait()
	close(operationErrors)
	for err := range operationErrors {
		t.Error(err)
	}
	if _, err := app.SavePlayerPortrait("1", payload); err != nil {
		t.Fatal(err)
	}
	if _, err := app.RemovePlayerPortrait("1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join("players", "1.png")); !os.IsNotExist(err) {
		t.Fatal("completed remove did not win", err)
	}
}

// TestCredentialReplacement checks the public credential writer and its requested file mode.
func TestCredentialReplacement(t *testing.T) {
	app := tournamentTestApp(t)
	for _, token := range []string{"first-test-token", "replacement-test-token"} {
		settings := ImportIntegrations{StartGG: ImportProviderIntegration{APIKey: token}}
		if _, err := app.SaveImportIntegrations(settings); err != nil {
			t.Fatal(err)
		}
		loaded, err := app.LoadImportIntegrations()
		if err != nil || loaded != settings {
			t.Fatal("credential replacement did not persist", err)
		}
	}
	info, err := os.Stat(filepath.Join("data", integrationsJSONFile))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatal("credential permissions changed")
	}
}

// windowsSharingFailure identifies surfaced sharing/access errors from an open Windows reader.
func windowsSharingFailure(err error) bool {
	return runtime.GOOS == "windows" && (errors.Is(err, syscall.Errno(32)) || errors.Is(err, syscall.Errno(5)))
}
