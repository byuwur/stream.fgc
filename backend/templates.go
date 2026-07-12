/*
 * File: templates.go
 * Desc: Loads bracket template JSON and resolves seed/winner/loser participant sources.
 * Deps: Go encoding-json/fmt/os/path-filepath/sort/strings.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// loadBracketTemplate reads templates/{format}{size}.json and fails loudly when it is missing.
func loadBracketTemplate(format string, size int) (BracketTemplate, error) {
	var data []byte
	fileName := templateFileName(format, size)
	// Templates are data, not compiled Go logic; missing files surface as operator messages.
	for _, diskPath := range externalFilePaths(templatesDirPath, fileName) {
		fileData, err := os.ReadFile(diskPath)
		if err == nil {
			data = fileData
			break
		}
	}
	if len(data) == 0 {
		return BracketTemplate{}, fmt.Errorf("%s", templateMissingMessage(fileName))
	}

	var template BracketTemplate
	if err := json.Unmarshal(data, &template); err != nil {
		return BracketTemplate{}, err
	}
	return normalizeBracketTemplate(template, format, size), nil
}

// resolveParticipant follows a template participant to its current player, if any.
func resolveParticipant(participant TemplateParticipant, state TournamentState) ResolvedParticipant {
	switch participant.Type {
	case "seed":
		playerID := bracketSeedPlayerID(state, participant.Seed)
		player, ok := state.Players[playerID]
		if bracketSeedBye(state, participant.Seed) {
			return ResolvedParticipant{PlayerID: playerID, Player: player, Source: participant, BracketSeed: participant.Seed, Resolved: true, PendingLabel: "BYE", Status: participantStatusBye}
		}
		if playerID == "" || !ok {
			return unresolvedParticipant(participant, playerID, fmt.Sprintf("Seed %d", participant.Seed))
		}
		if strings.TrimSpace(player.Name) == "" {
			return ResolvedParticipant{PlayerID: playerID, Player: player, Source: participant, BracketSeed: participant.Seed, PendingLabel: "TBD", Status: participantStatusTBD}
		}
		return ResolvedParticipant{PlayerID: playerID, Player: player, Source: participant, BracketSeed: participant.Seed, Resolved: true, Status: participantStatusPlayer}
	case "winner", "loser":
		matchState := state.Matches[participant.Match]
		playerID := matchState.Winner
		labelPrefix := "Winner"
		if participant.Type == "loser" {
			playerID = matchState.Loser
			labelPrefix = "Loser"
		}
		if playerID == "" {
			return unresolvedParticipant(participant, "", fmt.Sprintf("%s of %s", labelPrefix, participant.Match))
		}
		player, ok := state.Players[playerID]
		if !ok {
			return unresolvedParticipant(participant, playerID, fmt.Sprintf("%s of %s", labelPrefix, participant.Match))
		}
		if player.Bye {
			return ResolvedParticipant{PlayerID: playerID, Player: player, Source: participant, Resolved: true, PendingLabel: "BYE", Status: participantStatusBye}
		}
		return ResolvedParticipant{PlayerID: playerID, Player: player, Source: participant, Resolved: true, Status: participantStatusPlayer}
	default:
		return unresolvedParticipant(participant, "", "TBD")
	}
}

// unresolvedParticipant keeps pending bracket sources visible in the UI.
func unresolvedParticipant(participant TemplateParticipant, playerID string, label string) ResolvedParticipant {
	resolved := ResolvedParticipant{PlayerID: playerID, Source: participant, PendingLabel: label, Status: participantStatusPending}
	if participant.Type == "seed" {
		resolved.BracketSeed = participant.Seed
	}
	return resolved
}

// normalizeBracketTemplate fills template defaults without changing bracket logic.
func normalizeBracketTemplate(template BracketTemplate, format string, size int) BracketTemplate {
	if template.Type == "" {
		template.Type = format
	}
	if template.Size == 0 {
		template.Size = size
	}
	if template.Matches == nil {
		template.Matches = map[string]TemplateMatch{}
	}
	if template.Placements == nil {
		template.Placements = map[string]interface{}{}
	}
	return template
}

// emptyBracketTemplate keeps frontend calls predictable when a template is missing.
func emptyBracketTemplate(format string, size int, message string) BracketTemplate {
	return BracketTemplate{Type: format, Size: size, Matches: map[string]TemplateMatch{}, Placements: map[string]interface{}{}, Error: message}
}

// templateMissingMessage returns the operator-facing message for missing JSON templates.
func templateMissingMessage(fileName string) string {
	return fmt.Sprintf("[%s] template missing", fileName)
}

// templateFileName maps a canonical event format and size to its JSON template.
func templateFileName(format string, size int) string {
	normalized := normalizeTournamentFormat(format)
	name := strings.TrimSuffix(normalized, "_elimination")
	name = strings.ReplaceAll(name, "_", "")
	if name == "" {
		name = "double"
	}
	return fmt.Sprintf("%s%d.json", name, size)
}

// listISO2SVGCodes extracts country codes from a flag SVG directory.
func listISO2SVGCodes(path string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Clean(path))
	if err != nil {
		return nil, err
	}

	codes := []string{}
	seen := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() || strings.ToLower(filepath.Ext(entry.Name())) != ".svg" {
			continue
		}
		code := strings.TrimSuffix(strings.ToLower(entry.Name()), ".svg")
		if !isISO2Code(code) {
			continue
		}
		code = strings.ToUpper(code)
		if !seen[code] {
			seen[code] = true
			codes = append(codes, code)
		}
	}
	sort.Strings(codes)
	return codes, nil
}

// isISO2Code validates lowercase two-letter flag filenames.
func isISO2Code(code string) bool {
	if len(code) != 2 {
		return false
	}
	for _, character := range code {
		if character < 'a' || character > 'z' {
			return false
		}
	}
	return true
}
