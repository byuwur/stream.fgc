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
	fileName := playerKey + ".png"
	for _, dirPath := range playerPortraitDirs() {
		if info, err := os.Stat(dirPath); err == nil && info.IsDir() {
			return filepath.Join(dirPath, fileName)
		}
	}
	return filepath.Join(playerPortraitDirPath, fileName)
}

// playerPortraitDirs lists portrait folders for dev, built exe, and portable layouts.
func playerPortraitDirs() []string {
	paths := []string{playerPortraitDirPath}

	if exePath, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exePath)
		for _, basePath := range []string{
			exeDir,
			filepath.Join(exeDir, ".."),
			filepath.Join(exeDir, "..", ".."),
		} {
			dirPath := filepath.Clean(filepath.Join(basePath, playerPortraitDirPath))
			if !stringInSlice(paths, dirPath) {
				paths = append(paths, dirPath)
			}
		}
	}

	return paths
}

// playerPortraitURL returns the asset-server URL used by the frontend preview.
func playerPortraitURL(playerKey string) string {
	return "/players/" + playerKey + ".png"
}
