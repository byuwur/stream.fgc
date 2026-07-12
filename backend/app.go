/*
 * File: app.go
 * Desc: Defines the backend service container and lifecycle used by the Wails wrapper.
 * Deps: Go context/log/sync.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"context"
	"log"
	"sync"
)

// App serializes access to tournament JSON and external runtime folders.
type App struct {
	mu sync.Mutex
}

// NewApp creates the backend service bound into Wails.
func NewApp() *App {
	return &App{}
}

// Startup configures portable paths, creates runtime folders, and validates tournament JSON.
func (a *App) Startup(ctx context.Context) {
	configureExternalPaths(ctx)
	ensureRuntimeFolders()

	// Validate once at startup, but keep disk as the only tournament source of truth.
	a.mu.Lock()
	defer a.mu.Unlock()
	_, err := a.loadTournamentLocked()
	if err != nil {
		log.Printf("Stream.FGC startup could not load tournament data: %v", err)
	}
}
