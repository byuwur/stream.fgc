/*
 * File: normalization.go
 * Desc: Migrates legacy tournament fields and keeps persisted state inside configured limits.
 * Deps: Go os/strconv/strings.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"os"
	"strconv"
	"strings"
)

const (
	currentTournamentVersion = 1
	defaultTournamentSize    = 8
)

// normalizeTournamentState fills defaults, runs migrations, and strips derived fields.
func normalizeTournamentState(state TournamentState) TournamentState {
	state = migrateTournamentState(state)
	state.Event.Rule = normalizeEventRule(state.Event.Rule)
	if state.Event.Format == "" {
		state.Event.Format = "double_elimination"
	}
	state.Event.Size = normalizeTournamentSize(state.Event.Size)
	if state.Current == "" {
		state.Current = "A"
	}
	if state.Players == nil {
		state.Players = map[string]Player{}
	}
	trimPlayerSlots(state.Players, state.Event.Size)
	ensurePlayerSlots(state.Players, state.Event.Size)
	stripPlayerPortraits(state.Players)
	normalizeBracketSeedAssignments(&state)
	clampMatchScores(state.Matches, state.Event.Rule)
	state.Bracket.OverlayView = normalizeBracketViewKey(state.Bracket.OverlayView)
	state.Bracket.ManagerView = normalizeBracketViewKey(state.Bracket.ManagerView)
	return state
}

// migrateTournamentState contains backwards compatibility before normal code sees the state.
func migrateTournamentState(state TournamentState) TournamentState {
	state.Event.Format = normalizeTournamentFormat(state.Event.Format)
	if state.Matches == nil {
		state.Matches = map[string]MatchState{}
	}
	if state.Bracket.Matches != nil {
		for id, match := range state.Bracket.Matches {
			if _, ok := state.Matches[id]; !ok {
				state.Matches[id] = match
			}
		}
		state.Bracket.Matches = nil
	}
	state.Version = currentTournamentVersion
	return state
}

// normalizeTournamentFormat maps old labels to the canonical keys stored in assets/formats.json.
func normalizeTournamentFormat(format string) string {
	normalized := strings.ToLower(strings.TrimSpace(format))
	switch normalized {
	case "double", "double_elimination":
		return "double_elimination"
	case "single", "single_elimination":
		return "single_elimination"
	case "round", "round_robin", "robin":
		return "robin"
	case "swiss_system", "swiss":
		return "swiss"
	default:
		return normalized
	}
}

// parseEventRule converts legacy FT labels and JSON numbers into the stored first-to value.
func parseEventRule(value interface{}) int {
	return normalizeEventRule(parseEventRuleNumber(value))
}

// parseEventRuleNumber extracts the rule number without applying defaults.
func parseEventRuleNumber(value interface{}) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case string:
		normalized := strings.TrimPrefix(normalizeAssetName(typed), "ft")
		rule, err := strconv.Atoi(normalized)
		if err != nil {
			return 0
		}
		return rule
	default:
		return 0
	}
}

// normalizeEventRule defaults invalid first-to values to the MVP rule.
func normalizeEventRule(rule int) int {
	if rule > 0 {
		return rule
	}
	return 3
}

// clampMatchScore keeps score mutations inside the active first-to rule.
func clampMatchScore(score int, limit int) int {
	score = max(0, score)
	if limit > 0 {
		return min(score, limit)
	}
	return score
}

// clampMatchScores keeps existing JSON scores inside the current first-to rule after event edits.
func clampMatchScores(matches map[string]MatchState, limit int) {
	for id, match := range matches {
		match.Player1Score = clampMatchScore(match.Player1Score, limit)
		match.Player2Score = clampMatchScore(match.Player2Score, limit)
		matches[id] = match
	}
}

// gameIdentity returns a stable comparison key for game-change detection.
func (a *App) gameIdentity(game string) string {
	key, err := a.resolveGameKey(game)
	if err == nil && key != "" {
		return strings.ToLower(strings.TrimSpace(key))
	}
	return normalizeAssetName(game)
}

// clearPlayerCharacters clears game-specific choices after the event game changes.
func clearPlayerCharacters(players map[string]Player) {
	for id, player := range players {
		player.Character = ""
		player.Portrait = ""
		players[id] = player
	}
}

// stripPlayerPortraits prevents deprecated portrait JSON fields from persisting.
func stripPlayerPortraits(players map[string]Player) {
	for id, player := range players {
		player.Portrait = ""
		players[id] = player
	}
}

// clearPlayerByes removes setup-only BYE markers from visible seed slots.
func clearPlayerByes(players map[string]Player, size int) {
	for seed := 1; seed <= size; seed++ {
		id := strconv.Itoa(seed)
		player := players[id]
		player.Bye = false
		players[id] = player
	}
}

// trimPlayerSlots removes numeric slots above the configured tournament size.
func trimPlayerSlots(players map[string]Player, size int) {
	for id := range players {
		seed, err := strconv.Atoi(id)
		if err != nil || seed <= size {
			continue
		}
		delete(players, id)
	}
}

// ensurePlayerSlots keeps seed slots 1..size present for the configured tournament.
func ensurePlayerSlots(players map[string]Player, size int) {
	for seed := 1; seed <= size; seed++ {
		id := strconv.Itoa(seed)
		if _, ok := players[id]; !ok {
			players[id] = Player{}
		}
	}
}

// normalizeTournamentSize constrains event size to the configured catalog.
func normalizeTournamentSize(size int) int {
	allowed := configuredTournamentSizes()
	for _, allowedSize := range allowed {
		if size == allowedSize {
			return size
		}
	}
	return fallbackTournamentSize(allowed)
}

// fallbackTournamentSize prefers 8, then the first configured size.
func fallbackTournamentSize(allowed []int) int {
	for _, size := range allowed {
		if size == defaultTournamentSize {
			return defaultTournamentSize
		}
	}
	if len(allowed) > 0 {
		return allowed[0]
	}
	return defaultTournamentSize
}

// configuredTournamentSizes reads assets/sizes.json and leaves the select empty when missing.
func configuredTournamentSizes() []int {
	for _, diskPath := range assetDiskPaths("sizes.json") {
		data, err := os.ReadFile(diskPath)
		if err != nil {
			continue
		}

		entries, err := decodeOrderedStringMap(data)
		if err != nil {
			continue
		}

		sizes := make([]int, 0, len(entries))
		seen := map[int]bool{}
		for _, entry := range entries {
			// Size keys drive template names, so ignore labels and invalid numeric keys.
			size, err := strconv.Atoi(entry.Key)
			if err != nil || size <= 0 || seen[size] {
				continue
			}
			seen[size] = true
			sizes = append(sizes, size)
		}
		if len(sizes) > 0 {
			return sizes
		}
	}
	return []int{}
}
