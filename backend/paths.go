/*
 * File: paths.go
 * Desc: Resolves external project folders for dev mode and portable release builds.
 * Deps: Go context/os/path-filepath.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"context"
	"os"
	"path/filepath"
	"slices"
)

const (
	externalPathModeAuto     = ""
	externalPathModeDev      = "dev"
	externalPathModePortable = "portable"
)

var externalPathMode = defaultExternalPathMode()

// configureExternalPaths chooses repo-local folders for Wails dev and exe-local folders for builds.
func configureExternalPaths(ctx context.Context) {
	buildType, _ := ctx.Value("buildtype").(string)
	// Wails sets buildtype; direct Go runs fall back to auto-detection.
	switch buildType {
	case "production", "debug":
		externalPathMode = externalPathModePortable
	case "dev":
		externalPathMode = externalPathModeDev
	default:
		externalPathMode = externalPathModeAuto
	}
}

// ensureRuntimeFolders creates writable folders required by the controller and overlays.
func ensureRuntimeFolders() {
	for _, dirPath := range []string{dataDirPath, playerPortraitDirPath, assetDirPath, templatesDirPath, overlaysDirPath} {
		// Folder creation is best-effort; individual reads/writes surface actionable errors later.
		_ = os.MkdirAll(externalWriteDirPath(dirPath), 0755)
	}
}

// ExternalFilePaths lists lookup locations for a file in an external folder.
func ExternalFilePaths(rootDir string, filePath string) []string {
	return externalFilePaths(rootDir, filePath)
}

// externalDirPaths lists lookup locations for an external project folder.
func externalDirPaths(rootDir string) []string {
	paths := []string{}
	for _, basePath := range externalBaseDirs() {
		dirPath := filepath.Clean(filepath.Join(basePath, rootDir))
		// Keep paths unique so delete loops and lookup loops cannot double-hit the same folder.
		if !slices.Contains(paths, dirPath) {
			paths = append(paths, dirPath)
		}
	}
	return paths
}

// externalFilePaths lists lookup locations for a file inside an external project folder.
func externalFilePaths(rootDir string, filePath string) []string {
	rel := filepath.FromSlash(filePath)
	paths := []string{}
	for _, dirPath := range externalDirPaths(rootDir) {
		diskPath := filepath.Clean(filepath.Join(dirPath, rel))
		if !slices.Contains(paths, diskPath) {
			paths = append(paths, diskPath)
		}
	}
	return paths
}

// externalWriteDirPath chooses the active external folder for writes.
func externalWriteDirPath(rootDir string) string {
	for _, dirPath := range externalDirPaths(rootDir) {
		if info, err := os.Stat(dirPath); err == nil && info.IsDir() {
			// Prefer an existing folder so dev/release data keeps living where the operator expects.
			return dirPath
		}
	}
	return filepath.Join(preferredExternalBaseDir(), rootDir)
}

// externalWriteFilePath chooses where a file inside an external folder should be written.
func externalWriteFilePath(rootDir string, filePath string) string {
	return filepath.Clean(filepath.Join(externalWriteDirPath(rootDir), filepath.FromSlash(filePath)))
}

// externalBaseDirs returns exactly one active root so production never leaks into the repo.
func externalBaseDirs() []string {
	if usePortableExternalPaths() {
		return []string{preferredExternalBaseDir()}
	}
	return []string{developmentExternalBaseDir()}
}

// usePortableExternalPaths reports whether external files should live beside the executable.
func usePortableExternalPaths() bool {
	switch externalPathMode {
	case externalPathModePortable:
		return true
	case externalPathModeDev:
		return false
	default:
		// Auto mode protects packaged exes from writing back into a source checkout.
		return !projectRootAvailable()
	}
}

// preferredExternalBaseDir returns the folder where new runtime data should be created.
func preferredExternalBaseDir() string {
	if usePortableExternalPaths() {
		return executableDirPath()
	}
	return developmentExternalBaseDir()
}

// developmentExternalBaseDir returns the repository root used by Wails dev.
func developmentExternalBaseDir() string {
	if cwd, err := os.Getwd(); err == nil {
		if rootPath, ok := findProjectRoot(cwd); ok {
			return rootPath
		}
		return filepath.Clean(cwd)
	}
	return "."
}

// executableDirPath returns the folder containing the running binary.
func executableDirPath() string {
	if exePath, err := os.Executable(); err == nil {
		return filepath.Clean(filepath.Dir(exePath))
	}
	return developmentExternalBaseDir()
}

// projectRootAvailable reports whether the process is currently inside this repo.
func projectRootAvailable() bool {
	_, ok := findProjectRoot(".")
	return ok
}

// findProjectRoot walks up from startPath until it finds the Wails project root.
func findProjectRoot(startPath string) (string, bool) {
	currentPath, err := filepath.Abs(startPath)
	if err != nil {
		currentPath = filepath.Clean(startPath)
	}

	for {
		// go.mod + wails.json is a strong enough signature for this project root.
		if fileExists(filepath.Join(currentPath, "go.mod")) && fileExists(filepath.Join(currentPath, "wails.json")) {
			return currentPath, true
		}

		parentPath := filepath.Dir(currentPath)
		if parentPath == currentPath {
			break
		}
		currentPath = parentPath
	}

	return "", false
}

// fileExists reports whether a regular file exists at path.
func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
