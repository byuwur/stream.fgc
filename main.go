/*
 * File: main.go
 * Desc: Starts the Wails desktop shell, embeds the SPA frontend, and exposes local asset folders.
 * Deps: Go embed/io-fs/net-http/os/path/strings, Wails v2, backend package.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package main

import (
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

// App exposes backend.App methods to Wails through embedding.
type App struct {
	*backend.App
}

// NewApp wires the backend service into the Wails runtime.
func NewApp() *App {
	return &App{App: backend.NewApp()}
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
