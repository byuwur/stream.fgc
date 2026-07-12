/*
 * File: storage_test.go
 * Desc: Protects tournament JSON creation and atomic replacement behavior.
 * Deps: Go errors/os/path-filepath/testing.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// TestLoadTournamentStatePreservesInvalidFiles verifies parse failures never trigger default writes.
func TestLoadTournamentStatePreservesInvalidFiles(t *testing.T) {
	parseErr := errors.New("invalid tournament JSON")
	writeCalled := false

	_, err := loadTournamentState(
		func() (TournamentState, error) { return TournamentState{}, parseErr },
		func(TournamentState) error {
			writeCalled = true
			return nil
		},
	)

	if !errors.Is(err, parseErr) {
		t.Fatalf("expected parse error, got %v", err)
	}
	if writeCalled {
		t.Fatal("invalid tournament JSON must not be overwritten")
	}
}

// TestLoadTournamentStateCreatesOnlyMissingFiles verifies first-run initialization remains automatic.
func TestLoadTournamentStateCreatesOnlyMissingFiles(t *testing.T) {
	var written TournamentState
	state, err := loadTournamentState(
		func() (TournamentState, error) { return TournamentState{}, os.ErrNotExist },
		func(state TournamentState) error {
			written = state
			return nil
		},
	)

	if err != nil {
		t.Fatalf("create default tournament: %v", err)
	}
	if state.Event.Name != "Stream.FGC Tournament" || written.Event.Name != state.Event.Name {
		t.Fatalf("unexpected default state: %#v", state.Event)
	}
}

// TestWriteTournamentStateFile verifies atomic writes leave one complete JSON document and no temp file.
func TestWriteTournamentStateFile(t *testing.T) {
	dirPath := t.TempDir()
	filePath := filepath.Join(dirPath, tournamentJSONFile)
	want := defaultTournamentState()
	want.Event.Name = "First Write"
	if err := writeTournamentStateFile(filePath, want); err != nil {
		t.Fatalf("write initial tournament state: %v", err)
	}

	// The second write exercises replacement of an existing live file on Windows.
	want.Event.Name = "Atomic Test"
	if err := writeTournamentStateFile(filePath, want); err != nil {
		t.Fatalf("replace tournament state: %v", err)
	}
	got, err := readTournamentStateFile(filePath)
	if err != nil {
		t.Fatalf("read written tournament state: %v", err)
	}
	if got.Event.Name != want.Event.Name {
		t.Fatalf("event name = %q, want %q", got.Event.Name, want.Event.Name)
	}

	temporaryFiles, err := filepath.Glob(filepath.Join(dirPath, ".tournament-*.tmp"))
	if err != nil {
		t.Fatalf("list temporary files: %v", err)
	}
	if len(temporaryFiles) != 0 {
		t.Fatalf("temporary files were not cleaned up: %v", temporaryFiles)
	}
}
