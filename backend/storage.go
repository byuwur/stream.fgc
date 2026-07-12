/*
 * File: storage.go
 * Desc: Loads, creates, and atomically writes the live tournament JSON document.
 * Deps: Go encoding-json/errors/fmt/os/path-filepath.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const (
	dataDirPath                   = "data"
	templatesDirPath              = "templates"
	tournamentJSONFile            = "tournament.json"
	defaultTournamentTemplateFile = "default.json"
)

// loadTournamentLocked reads tournament.json from disk and initializes it only when missing.
func (a *App) loadTournamentLocked() (TournamentState, error) {
	return loadTournamentState(readTournamentState, writeTournamentState)
}

// loadTournamentState separates missing-file initialization from real read failures.
func loadTournamentState(readState func() (TournamentState, error), writeState func(TournamentState) error) (TournamentState, error) {
	state, err := readState()
	if err == nil {
		return normalizeTournamentState(state), nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return TournamentState{}, fmt.Errorf("read tournament state: %w", err)
	}

	state = defaultTournamentState()
	if err := writeState(state); err != nil {
		return TournamentState{}, fmt.Errorf("create default tournament state: %w", err)
	}
	return normalizeTournamentState(state), nil
}

// readTournamentState reads the live tournament JSON used by the UI and OBS.
func readTournamentState() (TournamentState, error) {
	return readTournamentStateFileCandidates(externalFilePaths(dataDirPath, tournamentJSONFile))
}

// readDefaultTournamentState reads the editable starter state from templates/default.json.
func readDefaultTournamentState() (TournamentState, error) {
	return readTournamentStateFileCandidates(externalFilePaths(templatesDirPath, defaultTournamentTemplateFile))
}

// readTournamentStateFileCandidates loads the first available state file from lookup paths.
func readTournamentStateFileCandidates(paths []string) (TournamentState, error) {
	var lastErr error
	for _, path := range paths {
		state, err := readTournamentStateFile(path)
		if err == nil {
			return state, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return TournamentState{}, lastErr
	}
	return TournamentState{}, fmt.Errorf("no tournament state paths configured")
}

// readTournamentStateFile loads and normalizes a tournament state file.
func readTournamentStateFile(path string) (TournamentState, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return TournamentState{}, err
	}

	var state TournamentState
	if err := json.Unmarshal(data, &state); err != nil {
		return TournamentState{}, err
	}

	return normalizeTournamentState(state), nil
}

// writeTournamentState atomically replaces data/tournament.json with stable formatting.
func writeTournamentState(state TournamentState) error {
	return writeTournamentStateFile(externalWriteFilePath(dataDirPath, tournamentJSONFile), state)
}

// writeTournamentStateFile writes a complete temporary file before replacing the live JSON.
func writeTournamentStateFile(cleanPath string, state TournamentState) error {
	dirPath := filepath.Dir(cleanPath)
	if err := os.MkdirAll(dirPath, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(normalizeTournamentState(state), "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	temporary, err := os.CreateTemp(dirPath, ".tournament-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)

	if err := temporary.Chmod(0644); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, cleanPath)
}

// defaultTournamentState uses templates/default.json, then a minimal missing-template state.
func defaultTournamentState() TournamentState {
	if state, err := readDefaultTournamentState(); err == nil {
		return state
	}

	return TournamentState{
		Version: 1,
		Event: EventInfo{
			Name: templateMissingMessage(defaultTournamentTemplateFile),
		},
		Current: "A",
		Players: map[string]Player{},
		Matches: map[string]MatchState{},
	}
}
