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
	a.mu.Lock()
	defer a.mu.Unlock()
	a.state = a.loadTournamentLocked()
}
