/*
 * File: main.go
 * Desc: Starts the Wails desktop shell, embeds the SPA frontend, and exposes local asset folders.
 * Deps: Go embed/io-fs/net-http/os/path/strings, Wails v2, backend package.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package main

import (
	"context"
	"embed"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"

	"stream.fgc/backend"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend

var assets embed.FS

// embeddedFrontend returns frontend/ as the asset-server root.
func embeddedFrontend() fs.FS {
	frontend, err := fs.Sub(assets, "frontend")
	if err != nil {
		// Falling back keeps Wails bootable even if the embed path changes during development.
		return assets
	}
	return frontend
}

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

// PreviewTournamentImport exposes external tournament link previews to the frontend.
func (a *App) PreviewTournamentImport(rawURL string) (backend.ExternalTournament, error) {
	return a.backend.PreviewTournamentImport(rawURL)
}

// ImportTournamentLink imports external tournament event and player data.
func (a *App) ImportTournamentLink(rawURL string) (backend.TournamentState, error) {
	return a.backend.ImportTournamentLink(rawURL)
}

// LoadImportIntegrations exposes saved provider API keys to the import page.
func (a *App) LoadImportIntegrations() backend.ImportIntegrations {
	return a.backend.LoadImportIntegrations()
}

// SaveImportIntegrations persists provider API keys from the import page.
func (a *App) SaveImportIntegrations(settings backend.ImportIntegrations) (backend.ImportIntegrations, error) {
	return a.backend.SaveImportIntegrations(settings)
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

// SwapMatchSides toggles the display side override for one match.
func (a *App) SwapMatchSides(matchID string) (backend.TournamentState, error) {
	return a.backend.SwapMatchSides(matchID)
}

// SetCurrentMatch selects the match shown in the current-match controller.
func (a *App) SetCurrentMatch(matchID string) (backend.TournamentState, error) {
	return a.backend.SetCurrentMatch(matchID)
}

// SetMatchWinner persists the selected winner/loser for bracket advancement.
func (a *App) SetMatchWinner(matchID string, winnerPlayerID string) (backend.TournamentState, error) {
	return a.backend.SetMatchWinner(matchID, winnerPlayerID)
}

// SetMatchResult persists a winner/loser with a result reason.
func (a *App) SetMatchResult(matchID string, winnerPlayerID string, reason string) (backend.TournamentState, error) {
	return a.backend.SetMatchResult(matchID, winnerPlayerID, reason)
}

// SetMatchParticipantBye marks one seed participant as a BYE.
func (a *App) SetMatchParticipantBye(matchID string, side int, bye bool) (backend.TournamentState, error) {
	return a.backend.SetMatchParticipantBye(matchID, side, bye)
}

// SetBracketOverlayView chooses which bracket slice OBS renders.
func (a *App) SetBracketOverlayView(view string) (backend.TournamentState, error) {
	return a.backend.SetBracketOverlayView(view)
}

// GetBracketView resolves the bracket for admin previews and OBS overlays.
func (a *App) GetBracketView(view string) backend.BracketProjection {
	return a.backend.GetBracketView(view)
}

// ResetBracket clears match state and seed BYEs.
func (a *App) ResetBracket() (backend.TournamentState, error) {
	return a.backend.ResetBracket()
}

// RandomizeBracketSeeds shuffles bracket assignments before play starts.
func (a *App) RandomizeBracketSeeds() (backend.TournamentState, error) {
	return a.backend.RandomizeBracketSeeds()
}

// SwapBracketSeeds swaps two bracket seed assignments without moving player records.
func (a *App) SwapBracketSeeds(seed int, targetSeed int) (backend.TournamentState, error) {
	return a.backend.SwapBracketSeeds(seed, targetSeed)
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

// ListSizes exposes assets/sizes.json to the event editor.
func (a *App) ListSizes() ([]backend.CatalogOption, error) {
	return a.backend.ListSizes()
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

// SaveEventLogo stores a custom tournament logo through the backend filesystem boundary.
func (a *App) SaveEventLogo(imageData string) (string, error) {
	return a.backend.SaveEventLogo(imageData)
}

// RemoveEventLogo removes the custom tournament logo through the backend filesystem boundary.
func (a *App) RemoveEventLogo() (string, error) {
	return a.backend.RemoveEventLogo()
}

// SaveEventBackground stores a custom tournament background through the backend filesystem boundary.
func (a *App) SaveEventBackground(imageData string) (string, error) {
	return a.backend.SaveEventBackground(imageData)
}

// RemoveEventBackground removes the custom tournament background through the backend filesystem boundary.
func (a *App) RemoveEventBackground() (string, error) {
	return a.backend.RemoveEventBackground()
}

// ShowOverlaysFolder opens the local overlays folder through the backend filesystem boundary.
func (a *App) ShowOverlaysFolder() (string, error) {
	return a.backend.ShowOverlaysFolder()
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
		// Only expose the external folders that the frontend/overlays intentionally reference.
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
			// Keep the static bridge from becoming an arbitrary filesystem reader.
			http.NotFound(response, request)
			return
		}

		// Backend.ExternalFilePaths handles dev vs portable folder lookup.
		for _, diskPath := range backend.ExternalFilePaths(rootDir, filePath) {
			if info, err := os.Stat(diskPath); err == nil && !info.IsDir() {
				http.ServeFile(response, request, diskPath)
				return
			}
		}

		http.NotFound(response, request)
	})
}

// main starts the Wails desktop shell with embedded frontend assets.
func main() {
	app := NewApp()

	// The frontend is embedded in the exe; data/assets/templates remain external and portable.
	err := wails.Run(&options.App{
		Title:  "Stream.FGC",
		Width:  1280,
		Height: 960,
		AssetServer: &assetserver.Options{
			Assets:  embeddedFrontend(),
			Handler: staticLibraryHandler(),
		},
		BackgroundColour: &options.RGBA{R: 0, G: 0, B: 0, A: 1},
		OnStartup:        app.Startup,
		Bind: []interface{}{
			app,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
