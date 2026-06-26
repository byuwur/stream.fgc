//go:build dev

/*
 * File: paths_mode_dev.go
 * Desc: Selects repository folders as the default for Wails dev builds.
 * Deps: None.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

// defaultExternalPathMode keeps hot-reload development using the project folders.
func defaultExternalPathMode() string {
	return externalPathModeDev
}
