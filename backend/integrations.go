/*
 * File: integrations.go
 * Desc: Reads and writes local provider credentials without exposing them to tournament JSON.
 * Deps: Go encoding-json/os/strings.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"encoding/json"
	"os"
	"strings"
)

const integrationsJSONFile = "integrations.json"

// ImportIntegrations stores local API keys for external tournament providers.
type ImportIntegrations struct {
	StartGG ImportProviderIntegration `json:"startgg"`
}

// ImportProviderIntegration stores one provider credential block.
type ImportProviderIntegration struct {
	APIKey string `json:"api_key"`
}

// LoadImportIntegrations reads saved provider API keys for the import page.
func (a *App) LoadImportIntegrations() (ImportIntegrations, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return readImportIntegrations()
}

// SaveImportIntegrations persists provider API keys through the Go filesystem boundary.
func (a *App) SaveImportIntegrations(settings ImportIntegrations) (ImportIntegrations, error) {
	settings = normalizeImportIntegrations(settings)

	a.mu.Lock()
	defer a.mu.Unlock()

	if err := writeImportIntegrations(settings); err != nil {
		return settings, err
	}
	return settings, nil
}

// readImportIntegrations loads saved provider credentials, if the file exists.
func readImportIntegrations() (ImportIntegrations, error) {
	for _, filePath := range externalFilePaths(dataDirPath, integrationsJSONFile) {
		data, err := os.ReadFile(filePath)
		if err != nil {
			continue
		}
		settings, err := decodeImportIntegrations(data)
		if err != nil {
			return ImportIntegrations{}, err
		}
		return settings, nil
	}
	return ImportIntegrations{}, nil
}

// decodeImportIntegrations supports the current provider map and the first token draft.
func decodeImportIntegrations(data []byte) (ImportIntegrations, error) {
	var settings ImportIntegrations
	if err := json.Unmarshal(data, &settings); err != nil {
		return ImportIntegrations{}, err
	}

	var legacySettings struct {
		StartGGToken string `json:"startgg_token"`
	}
	if err := json.Unmarshal(data, &legacySettings); err == nil && settings.StartGG.APIKey == "" {
		settings.StartGG.APIKey = legacySettings.StartGGToken
	}
	return normalizeImportIntegrations(settings), nil
}

// writeImportIntegrations writes provider credentials to data/integrations.json.
func writeImportIntegrations(settings ImportIntegrations) error {
	data, err := json.MarshalIndent(normalizeImportIntegrations(settings), "", "\t")
	if err != nil {
		return err
	}

	if err := os.MkdirAll(externalWriteDirPath(dataDirPath), 0755); err != nil {
		return err
	}
	return os.WriteFile(externalWriteFilePath(dataDirPath, integrationsJSONFile), append(data, '\n'), 0600)
}

// normalizeImportIntegrations trims tokens before they are returned or saved.
func normalizeImportIntegrations(settings ImportIntegrations) ImportIntegrations {
	settings.StartGG.APIKey = strings.TrimSpace(settings.StartGG.APIKey)
	return settings
}
