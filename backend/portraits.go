/*
 * File: portraits.go
 * Desc: Validates player portrait uploads and stores them in the external players folder.
 * Deps: Go bytes/base64/fmt/image/png/os/path/filepath/strings.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
)

const (
	playerPortraitDirPath  = "players"
	playerPortraitMaxBytes = 10 * 1024 * 1024
)

// SavePlayerPortrait validates an uploaded image and stores it as players/{id}.png.
func (a *App) SavePlayerPortrait(playerID string, imageData string) (string, error) {
	playerKey, err := cleanPlayerPortraitKey(playerID)
	if err != nil {
		return "", err
	}

	// The frontend sends image data only; all filesystem decisions stay in Go.
	rawImage, err := decodePlayerPortraitData(imageData)
	if err != nil {
		return "", err
	}
	if len(rawImage) > playerPortraitMaxBytes {
		return "", fmt.Errorf("player portrait is too large")
	}

	imageValue, _, err := image.Decode(bytes.NewReader(rawImage))
	if err != nil {
		return "", fmt.Errorf("player portrait must be a PNG, JPEG, or GIF image: %w", err)
	}

	// Normalize every upload to PNG so overlays can reference /players/{id}.png reliably.
	var pngBuffer bytes.Buffer
	if err := png.Encode(&pngBuffer, imageValue); err != nil {
		return "", err
	}

	targetPath := playerPortraitWritePath(playerKey)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return "", err
	}
	if err := os.WriteFile(targetPath, pngBuffer.Bytes(), 0644); err != nil {
		return "", err
	}

	return playerPortraitURL(playerKey), nil
}

// RemovePlayerPortrait deletes players/{id}.png from every allowed lookup path.
func (a *App) RemovePlayerPortrait(playerID string) (string, error) {
	playerKey, err := cleanPlayerPortraitKey(playerID)
	if err != nil {
		return "", err
	}

	fileName := playerKey + ".png"
	// Remove from every lookup path so a release copy cannot be masked by an old dev copy.
	for _, dirPath := range playerPortraitDirs() {
		targetPath := filepath.Join(dirPath, fileName)
		if err := os.Remove(targetPath); err != nil && !os.IsNotExist(err) {
			return "", err
		}
	}

	return playerPortraitURL(playerKey), nil
}

// decodePlayerPortraitData accepts plain base64 or a browser data URL.
func decodePlayerPortraitData(imageData string) ([]byte, error) {
	payload := strings.TrimSpace(imageData)
	if payload == "" {
		return nil, fmt.Errorf("empty player portrait")
	}

	if strings.HasPrefix(strings.ToLower(payload), "data:") {
		// Dropzone/FileReader produces data URLs; manual tests may send raw base64.
		commaIndex := strings.Index(payload, ",")
		if commaIndex < 0 {
			return nil, fmt.Errorf("invalid image data URL")
		}

		header := strings.ToLower(payload[:commaIndex])
		if !strings.HasPrefix(header, "data:image/") || !strings.Contains(header, ";base64") {
			return nil, fmt.Errorf("player portrait must be a base64 image data URL")
		}
		payload = payload[commaIndex+1:]
	}

	rawImage, err := base64.StdEncoding.DecodeString(strings.TrimSpace(payload))
	if err != nil {
		return nil, err
	}
	return rawImage, nil
}

// cleanPlayerPortraitKey limits portrait names to safe filesystem keys.
func cleanPlayerPortraitKey(playerID string) (string, error) {
	var builder strings.Builder
	for _, character := range strings.TrimSpace(playerID) {
		// Portrait filenames are derived from player IDs, so strip anything path-like.
		switch {
		case character >= 'a' && character <= 'z':
			builder.WriteRune(character)
		case character >= 'A' && character <= 'Z':
			builder.WriteRune(character)
		case character >= '0' && character <= '9':
			builder.WriteRune(character)
		case character == '_' || character == '-':
			builder.WriteRune(character)
		}
	}

	key := builder.String()
	if key == "" {
		return "", fmt.Errorf("invalid player key")
	}
	return key, nil
}

// playerPortraitWritePath chooses the first existing portrait directory.
func playerPortraitWritePath(playerKey string) string {
	return externalWriteFilePath(playerPortraitDirPath, playerKey+".png")
}

// playerPortraitDirs lists portrait folders for dev, built exe, and portable layouts.
func playerPortraitDirs() []string {
	return externalDirPaths(playerPortraitDirPath)
}

// playerPortraitURL returns the asset-server URL used by the frontend preview.
func playerPortraitURL(playerKey string) string {
	return "/players/" + playerKey + ".png"
}
