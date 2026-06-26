//go:build !dev && !production && !debug

/*
 * File: paths_mode_auto.go
 * Desc: Selects automatic external folder resolution outside Wails build modes.
 * Deps: None.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

// defaultExternalPathMode lets tests and direct Go runs infer the safest external folder root.
func defaultExternalPathMode() string {
	return externalPathModeAuto
}
