package backend

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const (
	assetDirPath       = "assets"
	assetFallbackImage = "nopic.png"
)

// GameAsset describes one game option shown in the event editor.
type GameAsset struct {
	Key        string `json:"key"`
	Name       string `json:"name"`
	Logo       string `json:"logo"`
	Background string `json:"background"`
}

// CharacterAsset describes one character option shown in player cards.
type CharacterAsset struct {
	Key      string `json:"key"`
	Name     string `json:"name"`
	Portrait string `json:"portrait"`
}

// CatalogOption is a normalized key/name pair for simple selects.
type CatalogOption struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

type assetTextEntry struct {
	Key   string
	Value string
}

// ListRules returns rule options from assets/rules.json.
func (a *App) ListRules() ([]CatalogOption, error) {
	options, err := a.readCatalogOptions("rules.json")
	if err != nil {
		return []CatalogOption{}, nil
	}
	return options, nil
}

// ListFormats returns bracket format options from assets/formats.json.
func (a *App) ListFormats() ([]CatalogOption, error) {
	options, err := a.readCatalogOptions("formats.json")
	if err != nil {
		return []CatalogOption{}, nil
	}
	return options, nil
}

// ListGames returns all configured games with display logo and background URLs.
func (a *App) ListGames() ([]GameAsset, error) {
	entries, err := a.readAssetMap("games.json")
	if err != nil {
		return []GameAsset{}, nil
	}

	games := make([]GameAsset, 0, len(entries))
	for _, entry := range entries {
		logo := path.Join(entry.Key, "_logo.png")
		if !a.assetFileExists(logo) {
			logo = assetFallbackImage
		}

		background := path.Join(entry.Key, "_bg.jpg")
		if !a.assetFileExists(background) {
			background = ""
		} else {
			background = assetURL(background)
		}

		games = append(games, GameAsset{
			Key:        entry.Key,
			Name:       entry.Value,
			Logo:       assetURL(logo),
			Background: background,
		})
	}

	return games, nil
}

// ListCharacters returns character options for the selected game.
func (a *App) ListCharacters(game string) ([]CharacterAsset, error) {
	gameKey, err := a.resolveGameKey(game)
	if err != nil || gameKey == "" {
		return []CharacterAsset{}, err
	}

	entries, err := a.readAssetMap(path.Join(gameKey, "characters.json"))
	if err != nil {
		return []CharacterAsset{}, nil
	}

	characters := make([]CharacterAsset, 0, len(entries))
	for _, entry := range entries {
		portrait := path.Join(gameKey, "portraits", entry.Key+".png")
		if !a.assetFileExists(portrait) {
			portrait = assetFallbackImage
		}

		characters = append(characters, CharacterAsset{
			Key:      entry.Key,
			Name:     entry.Value,
			Portrait: assetURL(portrait),
		})
	}

	return characters, nil
}

// readCatalogOptions converts a key/value JSON catalog into frontend options.
func (a *App) readCatalogOptions(rel string) ([]CatalogOption, error) {
	entries, err := a.readAssetMap(rel)
	if err != nil {
		return []CatalogOption{}, err
	}

	options := make([]CatalogOption, 0, len(entries))
	for _, entry := range entries {
		options = append(options, CatalogOption{
			Key:  entry.Key,
			Name: entry.Value,
		})
	}

	return options, nil
}

// resolveGameKey accepts either a stored game key or a display name.
func (a *App) resolveGameKey(game string) (string, error) {
	game = strings.TrimSpace(game)
	if game == "" {
		return "", nil
	}

	entries, err := a.readAssetMap("games.json")
	if err != nil {
		return "", err
	}

	needle := strings.ToLower(game)
	normalizedNeedle := normalizeAssetName(game)
	for _, entry := range entries {
		if strings.ToLower(entry.Key) == needle || strings.ToLower(entry.Value) == needle {
			return entry.Key, nil
		}
		if normalizeAssetName(entry.Key) == normalizedNeedle || normalizeAssetName(entry.Value) == normalizedNeedle {
			return entry.Key, nil
		}
	}

	candidate := strings.ToLower(game)
	if isSafeAssetPath(candidate) && a.assetFileExists(path.Join(candidate, "characters.json")) {
		return candidate, nil
	}

	return "", nil
}

// readAssetMap reads a JSON object while preserving key order.
func (a *App) readAssetMap(rel string) ([]assetTextEntry, error) {
	data, err := a.readAssetFile(rel)
	if err != nil {
		return nil, err
	}
	return decodeOrderedStringMap(data)
}

// readAssetFile loads an asset from the workspace or next to the portable exe.
func (a *App) readAssetFile(rel string) ([]byte, error) {
	cleanRel, err := cleanAssetRel(rel)
	if err != nil {
		return nil, err
	}

	for _, diskPath := range assetDiskPaths(cleanRel) {
		if data, err := os.ReadFile(diskPath); err == nil {
			return data, nil
		}
	}

	return nil, fmt.Errorf("asset file not found: %s", cleanRel)
}

// assetFileExists checks external assets without exposing arbitrary paths.
func (a *App) assetFileExists(rel string) bool {
	cleanRel, err := cleanAssetRel(rel)
	if err != nil {
		return false
	}

	for _, diskPath := range assetDiskPaths(cleanRel) {
		if info, err := os.Stat(diskPath); err == nil && !info.IsDir() {
			return true
		}
	}

	return false
}

// assetDiskPaths lists the allowed asset lookup locations for dev and release.
func assetDiskPaths(cleanRel string) []string {
	rel := filepath.FromSlash(cleanRel)
	paths := []string{filepath.Join(assetDirPath, rel)}

	if exePath, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exePath)
		for _, basePath := range []string{
			exeDir,
			filepath.Join(exeDir, ".."),
			filepath.Join(exeDir, "..", ".."),
		} {
			exeAssetPath := filepath.Clean(filepath.Join(basePath, assetDirPath, rel))
			if !stringInSlice(paths, exeAssetPath) {
				paths = append(paths, exeAssetPath)
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

// decodeOrderedStringMap preserves JSON object order for select option lists.
func decodeOrderedStringMap(data []byte) ([]assetTextEntry, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))

	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}

	delim, ok := token.(json.Delim)
	if !ok || delim != '{' {
		return nil, fmt.Errorf("expected JSON object")
	}

	entries := []assetTextEntry{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}

		key, ok := keyToken.(string)
		if !ok {
			return nil, fmt.Errorf("expected string key")
		}

		var value string
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}

		entries = append(entries, assetTextEntry{Key: key, Value: value})
	}

	if token, err = decoder.Token(); err != nil {
		return nil, err
	}

	delim, ok = token.(json.Delim)
	if !ok || delim != '}' {
		return nil, fmt.Errorf("expected JSON object end")
	}

	return entries, nil
}

// cleanAssetRel normalizes a relative asset path and rejects traversal.
func cleanAssetRel(rel string) (string, error) {
	cleanRel := path.Clean(strings.TrimPrefix(rel, "/"))
	if cleanRel == "." || !isSafeAssetPath(cleanRel) {
		return "", fmt.Errorf("invalid asset path: %s", rel)
	}
	return cleanRel, nil
}

// isSafeAssetPath accepts only relative paths inside the asset library.
func isSafeAssetPath(rel string) bool {
	return rel != "" && rel != "." && !strings.HasPrefix(rel, "../") && !strings.Contains(rel, "/../")
}

// normalizeAssetName creates a loose comparison key for catalog names.
func normalizeAssetName(value string) string {
	var builder strings.Builder
	for _, character := range strings.ToLower(value) {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
			builder.WriteRune(character)
		}
	}
	return builder.String()
}

// assetURL converts an asset-relative path into the Wails-served URL.
func assetURL(rel string) string {
	cleanRel, err := cleanAssetRel(rel)
	if err != nil {
		cleanRel = assetFallbackImage
	}
	return "/assets/" + cleanRel
}
