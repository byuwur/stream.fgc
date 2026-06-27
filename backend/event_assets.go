/*
 * File: event_assets.go
 * Desc: Validates and stores tournament logo/background uploads used by overlays.
 * Deps: Go bytes/fmt/image/jpeg/png/os/path/filepath, portrait image decoder helpers.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
)

const (
	tournamentAssetMaxBytes = 20 * 1024 * 1024
)

// SaveEventLogo validates and stores the tournament logo preview as players/_logo.png.
func (a *App) SaveEventLogo(imageData string) (string, error) {
	return saveTournamentAsset("logo", imageData)
}

// RemoveEventLogo deletes players/_logo.png from all portable lookup folders.
func (a *App) RemoveEventLogo() (string, error) {
	return removeTournamentAsset("logo")
}

// SaveEventBackground validates and stores the tournament background as players/_bg.jpg.
func (a *App) SaveEventBackground(imageData string) (string, error) {
	return saveTournamentAsset("background", imageData)
}

// RemoveEventBackground deletes players/_bg.jpg from all portable lookup folders.
func (a *App) RemoveEventBackground() (string, error) {
	return removeTournamentAsset("background")
}

// saveTournamentAsset validates browser image data and writes the normalized overlay asset.
func saveTournamentAsset(key string, imageData string) (string, error) {
	fileName, err := tournamentAssetFileName(key)
	if err != nil {
		return "", err
	}

	// Reuse the browser data-URL decoder used by player portraits; validation follows here.
	rawImage, err := decodePlayerPortraitData(imageData)
	if err != nil {
		return "", err
	}
	if len(rawImage) > tournamentAssetMaxBytes {
		return "", fmt.Errorf("tournament asset is too large")
	}

	imageValue, _, err := image.Decode(bytes.NewReader(rawImage))
	if err != nil {
		return "", fmt.Errorf("tournament asset must be a PNG, JPEG, or GIF image: %w", err)
	}

	var output bytes.Buffer
	if key == "background" {
		// Backgrounds are JPEG so overlays get predictable file names and smaller files.
		err = jpeg.Encode(&output, imageValue, &jpeg.Options{Quality: 92})
	} else {
		// Logos stay PNG to preserve transparency for OBS overlays.
		err = png.Encode(&output, imageValue)
	}
	if err != nil {
		return "", err
	}

	targetPath := tournamentAssetWritePath(fileName)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return "", err
	}
	if err := os.WriteFile(targetPath, output.Bytes(), 0644); err != nil {
		return "", err
	}

	return tournamentAssetURL(fileName), nil
}

// removeTournamentAsset deletes the named overlay asset from every portable lookup folder.
func removeTournamentAsset(key string) (string, error) {
	fileName, err := tournamentAssetFileName(key)
	if err != nil {
		return "", err
	}

	// Delete across all lookup folders so stale dev/release copies cannot shadow the fallback.
	for _, dirPath := range playerPortraitDirs() {
		targetPath := filepath.Join(dirPath, fileName)
		if err := os.Remove(targetPath); err != nil && !os.IsNotExist(err) {
			return "", err
		}
	}

	return tournamentAssetURL(fileName), nil
}

// tournamentAssetFileName maps logical upload keys to their fixed player-folder names.
func tournamentAssetFileName(key string) (string, error) {
	switch key {
	case "logo":
		return "_logo.png", nil
	case "background":
		return "_bg.jpg", nil
	default:
		return "", fmt.Errorf("unknown tournament asset: %s", key)
	}
}

// tournamentAssetWritePath chooses where a tournament asset should be written.
func tournamentAssetWritePath(fileName string) string {
	return externalWriteFilePath(playerPortraitDirPath, fileName)
}

// tournamentAssetURL returns the Wails/Apache URL used by previews and overlays.
func tournamentAssetURL(fileName string) string {
	return "/players/" + fileName
}
