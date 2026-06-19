package backend

import (
	"context"
	"sync"
)

type App struct {
	ctx   context.Context
	mu    sync.Mutex
}

func NewApp() *App {
	return &App{}
}

func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	a.mu.Lock()
	defer a.mu.Unlock()
}
