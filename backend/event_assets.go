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

func saveTournamentAsset(key string, imageData string) (string, error) {
	fileName, err := tournamentAssetFileName(key)
	if err != nil {
		return "", err
	}

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
		err = jpeg.Encode(&output, imageValue, &jpeg.Options{Quality: 92})
	} else {
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

func removeTournamentAsset(key string) (string, error) {
	fileName, err := tournamentAssetFileName(key)
	if err != nil {
		return "", err
	}

	for _, dirPath := range playerPortraitDirs() {
		targetPath := filepath.Join(dirPath, fileName)
		if err := os.Remove(targetPath); err != nil && !os.IsNotExist(err) {
			return "", err
		}
	}

	return tournamentAssetURL(fileName), nil
}

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

func tournamentAssetWritePath(fileName string) string {
	for _, dirPath := range playerPortraitDirs() {
		if info, err := os.Stat(dirPath); err == nil && info.IsDir() {
			return filepath.Join(dirPath, fileName)
		}
	}
	return filepath.Join(playerPortraitDirPath, fileName)
}

func tournamentAssetURL(fileName string) string {
	return "/players/" + fileName
}
