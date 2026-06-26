/*
 * File: overlays.go
 * Desc: Opens the local overlays folder from the desktop controller.
 * Deps: Go os/os-exec/path-filepath/runtime.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

const (
	overlaysDirPath = "overlays"
)

// ShowOverlaysFolder ensures ./overlays exists and opens it in the OS file explorer.
func (a *App) ShowOverlaysFolder() (string, error) {
	folderPath, err := overlaysFolderPath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(folderPath, 0755); err != nil {
		return "", err
	}
	if err := openFolder(folderPath); err != nil {
		return "", err
	}
	return folderPath, nil
}

// overlaysFolderPath resolves the overlays directory from the current app working directory.
func overlaysFolderPath() (string, error) {
	return filepath.Abs(externalWriteDirPath(overlaysDirPath))
}

// openFolder launches the platform file manager without going through a shell.
func openFolder(folderPath string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("explorer.exe", folderPath).Start()
	case "darwin":
		return exec.Command("open", folderPath).Start()
	default:
		return exec.Command("xdg-open", folderPath).Start()
	}
}
