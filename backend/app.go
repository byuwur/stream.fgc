/*
 * File: app.go
 * Desc: Defines the backend service container and lifecycle used by the Wails wrapper.
 * Deps: Go context/sync.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"context"
	"sync"
)

// App owns backend state and serializes access to tournament JSON.
type App struct {
	ctx   context.Context
	mu    sync.Mutex
	state TournamentState
}

// NewApp creates the backend service bound into Wails.
func NewApp() *App {
	return &App{}
}

// Startup stores the Wails context and eagerly loads the tournament state.
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	configureExternalPaths(ctx)
	ensureRuntimeFolders()

	// Prime the in-memory copy so Wails can answer immediately after startup.
	// LoadTournament still re-reads disk later so external JSON edits are visible.
	a.mu.Lock()
	defer a.mu.Unlock()
	a.state = a.loadTournamentLocked()
}
