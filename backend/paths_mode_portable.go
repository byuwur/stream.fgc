//go:build production || debug

/*
 * File: paths_mode_portable.go
 * Desc: Selects executable-local folders as the default for built Wails apps.
 * Deps: None.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

// defaultExternalPathMode keeps release and debug binaries portable by default.
func defaultExternalPathMode() string {
	return externalPathModePortable
}
