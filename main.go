package main

import (
	"context"
	"embed"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"stream.fgc/backend"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist

var assets embed.FS

// App is the Wails-facing wrapper around the backend package.
type App struct {
	backend *backend.App
}

// NewApp wires the backend into the Wails runtime.
func NewApp() *App {
	return &App{backend: backend.NewApp()}
}

// Startup delegates Wails startup to the backend service.
func (a *App) Startup(ctx context.Context) {
	a.backend.Startup(ctx)
}

// LoadTournament exposes the live tournament state to the frontend.
func (a *App) LoadTournament() backend.TournamentState {
	return a.backend.LoadTournament()
}

// SaveTournament exposes full-state persistence to the frontend.
func (a *App) SaveTournament(state backend.TournamentState) error {
	return a.backend.SaveTournament(state)
}

// LoadTemplate exposes bracket template loading to the frontend.
func (a *App) LoadTemplate(format string, size int) backend.BracketTemplate {
	return a.backend.LoadTemplate(format, size)
}

// ResolveMatch exposes dynamic current-match resolution to the frontend.
func (a *App) ResolveMatch(matchID string) backend.ResolvedMatch {
	return a.backend.ResolveMatch(matchID)
}

// UpdateEvent persists event editor changes.
func (a *App) UpdateEvent(event backend.EventInfo) (backend.TournamentState, error) {
	return a.backend.UpdateEvent(event)
}

// UpdatePlayer persists one player card.
func (a *App) UpdatePlayer(playerID string, player backend.Player) (backend.TournamentState, error) {
	return a.backend.UpdatePlayer(playerID, player)
}

// UpdateMatchScore persists score changes for one match.
func (a *App) UpdateMatchScore(matchID string, player1Score int, player2Score int) (backend.TournamentState, error) {
	return a.backend.UpdateMatchScore(matchID, player1Score, player2Score)
}

// AdvanceWinner is reserved for future bracket advancement.
func (a *App) AdvanceWinner(matchID string) backend.TournamentState {
	return a.backend.AdvanceWinner(matchID)
}

// AdvanceLoser is reserved for future bracket advancement.
func (a *App) AdvanceLoser(matchID string) backend.TournamentState {
	return a.backend.AdvanceLoser(matchID)
}

// ComputeTop8Placements is reserved for future overlay placement output.
func (a *App) ComputeTop8Placements() []backend.ResolvedParticipant {
	return a.backend.ComputeTop8Placements()
}

// ListCountryCodes exposes available flag SVGs to player country selects.
func (a *App) ListCountryCodes() ([]string, error) {
	return a.backend.ListCountryCodes()
}

// ListRules exposes assets/rules.json to the event editor.
func (a *App) ListRules() ([]backend.CatalogOption, error) {
	return a.backend.ListRules()
}

// ListFormats exposes assets/formats.json to the event editor.
func (a *App) ListFormats() ([]backend.CatalogOption, error) {
	return a.backend.ListFormats()
}

// ListGames exposes game catalog data and logos to the event editor.
func (a *App) ListGames() ([]backend.GameAsset, error) {
	return a.backend.ListGames()
}

// ListCharacters exposes character data and portraits for the selected game.
func (a *App) ListCharacters(game string) ([]backend.CharacterAsset, error) {
	return a.backend.ListCharacters(game)
}

// SavePlayerPortrait stores a custom player image through the backend filesystem boundary.
func (a *App) SavePlayerPortrait(playerID string, imageData string) (string, error) {
	return a.backend.SavePlayerPortrait(playerID, imageData)
}

// RemovePlayerPortrait removes a custom player image through the backend filesystem boundary.
func (a *App) RemovePlayerPortrait(playerID string) (string, error) {
	return a.backend.RemovePlayerPortrait(playerID)
}

// staticLibraryHandler serves external asset folders beside the embedded SPA.
func staticLibraryHandler() http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			response.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		cleanURLPath := path.Clean(request.URL.Path)
		rootDir := ""
		filePath := ""
		switch {
		case strings.HasPrefix(cleanURLPath, "/assets/"):
			rootDir = "assets"
			filePath = strings.TrimPrefix(cleanURLPath, "/assets/")
		case strings.HasPrefix(cleanURLPath, "/players/"):
			rootDir = "players"
			filePath = strings.TrimPrefix(cleanURLPath, "/players/")
		default:
			http.NotFound(response, request)
			return
		}

		if filePath == "" || strings.HasPrefix(filePath, "../") || strings.Contains(filePath, "/../") {
			http.NotFound(response, request)
			return
		}

		for _, diskPath := range externalLibraryPaths(rootDir, filePath) {
			if info, err := os.Stat(diskPath); err == nil && !info.IsDir() {
				http.ServeFile(response, request, diskPath)
				return
			}
		}

		http.NotFound(response, request)
	})
}

// externalLibraryPaths resolves external library files for dev and portable exe layouts.
func externalLibraryPaths(rootDir string, filePath string) []string {
	rel := filepath.FromSlash(filePath)
	paths := []string{filepath.Join(rootDir, rel)}

	if exePath, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exePath)
		for _, basePath := range []string{
			exeDir,
			filepath.Join(exeDir, ".."),
			filepath.Join(exeDir, "..", ".."),
		} {
			exeFilePath := filepath.Clean(filepath.Join(basePath, rootDir, rel))
			if !stringInSlice(paths, exeFilePath) {
				paths = append(paths, exeFilePath)
			}
		}
	}

	return paths
}

// stringInSlice reports whether values already contains needle.
func stringInSlice(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

// main starts the Wails desktop shell with embedded frontend assets.
func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:  "Stream.FGC",
		Width:  1280,
		Height: 960,
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: staticLibraryHandler(),
		},
		BackgroundColour: &options.RGBA{R: 17, G: 19, B: 18, A: 1},
		OnStartup:        app.Startup,
		Bind: []interface{}{
			app,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
