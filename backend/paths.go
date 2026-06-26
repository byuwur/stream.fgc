/*
 * File: paths.go
 * Desc: Resolves external project folders for dev mode and portable release builds.
 * Deps: Go os/path-filepath.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"os"
	"path/filepath"
)

// ensureRuntimeFolders creates writable folders that must exist beside portable releases.
func ensureRuntimeFolders() {
	for _, dirPath := range []string{dataDirPath, playerPortraitDirPath, overlaysDirPath} {
		_ = os.MkdirAll(externalWriteDirPath(dirPath), 0755)
	}
}

// externalDirPaths lists lookup locations for an external project folder.
func externalDirPaths(rootDir string) []string {
	paths := []string{}
	for _, basePath := range externalBaseDirs() {
		dirPath := filepath.Clean(filepath.Join(basePath, rootDir))
		if !stringInSlice(paths, dirPath) {
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
		if !stringInSlice(paths, diskPath) {
			paths = append(paths, diskPath)
		}
	}
	return paths
}

// externalWriteDirPath chooses an existing external folder or creates one beside the executable.
func externalWriteDirPath(rootDir string) string {
	for _, dirPath := range externalDirPaths(rootDir) {
		if info, err := os.Stat(dirPath); err == nil && info.IsDir() {
			return dirPath
		}
	}
	return filepath.Join(preferredExternalBaseDir(), rootDir)
}

// externalWriteFilePath chooses where a file inside an external folder should be written.
func externalWriteFilePath(rootDir string, filePath string) string {
	return filepath.Clean(filepath.Join(externalWriteDirPath(rootDir), filepath.FromSlash(filePath)))
}

// externalBaseDirs returns dev and release base paths in lookup order.
func externalBaseDirs() []string {
	paths := []string{"."}
	if exePath, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exePath)
		for _, basePath := range []string{
			exeDir,
			filepath.Join(exeDir, ".."),
			filepath.Join(exeDir, "..", ".."),
		} {
			cleanBasePath := filepath.Clean(basePath)
			if !stringInSlice(paths, cleanBasePath) {
				paths = append(paths, cleanBasePath)
			}
		}
	}
	return paths
}

// preferredExternalBaseDir returns the folder where new release data should be created.
func preferredExternalBaseDir() string {
	if exePath, err := os.Executable(); err == nil {
		return filepath.Dir(exePath)
	}
	return "."
}
