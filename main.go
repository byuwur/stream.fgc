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

		rootDir, filePath, ok := externalStaticTarget(request.URL.Path)
		if !ok {
			http.NotFound(response, request)
			return
		}

		for _, diskPath := range backend.ExternalFilePaths(rootDir, filePath) {
			if info, err := os.Stat(diskPath); err == nil && !info.IsDir() {
				http.ServeFile(response, request, diskPath)
				return
			}
		}

		http.NotFound(response, request)
	})
}

// externalStaticTarget maps browser URLs to the small set of public runtime folders.
func externalStaticTarget(rawURLPath string) (string, string, bool) {
	cleanURLPath := path.Clean(rawURLPath)
	for _, route := range []struct {
		prefix string
		root   string
	}{
		{prefix: "/assets/", root: "assets"},
		{prefix: "/players/", root: "players"},
	} {
		if strings.HasPrefix(cleanURLPath, route.prefix) {
			filePath := strings.TrimPrefix(cleanURLPath, route.prefix)
			return route.root, filePath, safeStaticFilePath(filePath)
		}
	}
	return "", "", false
}

// safeStaticFilePath keeps the bridge from becoming an arbitrary filesystem reader.
func safeStaticFilePath(filePath string) bool {
	return filePath != "" && !strings.HasPrefix(filePath, "../") && !strings.Contains(filePath, "/../")
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
