/*
 * File: seeding.go
 * Desc: Owns bracket-only seed assignments, BYE flags, and randomized setup slots.
 * Deps: Go math-rand/strconv/strings/time.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"math/rand"
	"strconv"
	"strings"
	"time"
)

// randomizedBracketSlots returns shuffled player IDs plus empty BYE slots up to bracket size.
func randomizedBracketSlots(state TournamentState) []string {
	playerIDs := make([]string, 0, state.Event.Size)
	for seed := 1; seed <= state.Event.Size; seed++ {
		playerID := strconv.Itoa(seed)
		player := state.Players[playerID]
		if strings.TrimSpace(player.Name) != "" {
			playerIDs = append(playerIDs, playerID)
		}
	}

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	rng.Shuffle(len(playerIDs), func(i int, j int) {
		playerIDs[i], playerIDs[j] = playerIDs[j], playerIDs[i]
	})

	slots := make([]string, 0, state.Event.Size)
	slots = append(slots, playerIDs...)
	for len(slots) < state.Event.Size {
		slots = append(slots, "")
	}
	rng.Shuffle(len(slots), func(i int, j int) {
		slots[i], slots[j] = slots[j], slots[i]
	})
	return slots
}

// ensureBracketSeedAssignments materializes the bracket seed map before setup edits.
func ensureBracketSeedAssignments(state *TournamentState) {
	if state.Bracket.Seeds == nil {
		state.Bracket.Seeds = map[string]string{}
	}
	// Identity mapping is materialized only while an edit needs concrete seed slots.
	for seed := 1; seed <= state.Event.Size; seed++ {
		key := strconv.Itoa(seed)
		if _, ok := state.Bracket.Seeds[key]; !ok {
			state.Bracket.Seeds[key] = key
		}
	}
	normalizeBracketSeedAssignments(state)
	if state.Bracket.Seeds == nil {
		state.Bracket.Seeds = map[string]string{}
		// Normalization compresses identity mappings, so materialize them again for editing.
		for seed := 1; seed <= state.Event.Size; seed++ {
			key := strconv.Itoa(seed)
			state.Bracket.Seeds[key] = key
		}
	}
}

// normalizeBracketSeedAssignments keeps bracket-only seeding inside event size.
func normalizeBracketSeedAssignments(state *TournamentState) {
	if state.Bracket.Byes != nil {
		for key, bye := range state.Bracket.Byes {
			seed, err := strconv.Atoi(key)
			if err != nil || seed < 1 || seed > state.Event.Size || !bye {
				delete(state.Bracket.Byes, key)
			}
		}
		if len(state.Bracket.Byes) == 0 {
			state.Bracket.Byes = nil
		}
	}
	if state.Bracket.Seeds == nil {
		return
	}

	for key := range state.Bracket.Seeds {
		seed, err := strconv.Atoi(key)
		if err != nil || seed < 1 || seed > state.Event.Size {
			delete(state.Bracket.Seeds, key)
		}
	}

	used := map[string]bool{}
	for seed := 1; seed <= state.Event.Size; seed++ {
		key := strconv.Itoa(seed)
		playerID, ok := state.Bracket.Seeds[key]
		if !ok {
			playerID = key
		}
		playerID = strings.TrimSpace(playerID)
		if playerID == "" {
			state.Bracket.Seeds[key] = ""
			continue
		}
		if _, ok := state.Players[playerID]; !ok || used[playerID] {
			state.Bracket.Seeds[key] = ""
			continue
		}
		used[playerID] = true
		state.Bracket.Seeds[key] = playerID
	}

	for seed := 1; seed <= state.Event.Size; seed++ {
		key := strconv.Itoa(seed)
		if state.Bracket.Seeds[key] != "" || state.Bracket.Byes[key] {
			continue
		}
		for candidate := 1; candidate <= state.Event.Size; candidate++ {
			playerID := strconv.Itoa(candidate)
			if used[playerID] {
				continue
			}
			state.Bracket.Seeds[key] = playerID
			used[playerID] = true
			break
		}
	}

	identity := true
	for seed := 1; seed <= state.Event.Size; seed++ {
		key := strconv.Itoa(seed)
		if state.Bracket.Seeds[key] != key {
			identity = false
			break
		}
	}
	if identity && len(state.Bracket.Byes) == 0 {
		// A nil seed map means natural playerID == bracket seed, keeping JSON compact.
		state.Bracket.Seeds = nil
	}
}

// bracketSeedPlayerID returns the player currently assigned to one bracket seed slot.
func bracketSeedPlayerID(state TournamentState, seed int) string {
	if seed <= 0 {
		return ""
	}
	key := strconv.Itoa(seed)
	if state.Bracket.Seeds != nil {
		if playerID, ok := state.Bracket.Seeds[key]; ok {
			return strings.TrimSpace(playerID)
		}
	}
	return key
}

// bracketSeedBye reports whether a bracket seed slot is intentionally a BYE.
func bracketSeedBye(state TournamentState, seed int) bool {
	if seed <= 0 {
		return false
	}
	key := strconv.Itoa(seed)
	if state.Bracket.Byes != nil && state.Bracket.Byes[key] {
		return true
	}
	playerID := bracketSeedPlayerID(state, seed)
	if playerID == "" {
		return false
	}
	return state.Players[playerID].Bye
}

// setBracketSeedBye toggles setup-only BYE state on a bracket seed slot.
func setBracketSeedBye(state *TournamentState, seed int, bye bool) {
	if seed <= 0 {
		return
	}
	if state.Bracket.Byes == nil {
		state.Bracket.Byes = map[string]bool{}
	}
	key := strconv.Itoa(seed)
	if bye {
		state.Bracket.Byes[key] = true
		return
	}
	delete(state.Bracket.Byes, key)
	if len(state.Bracket.Byes) == 0 {
		state.Bracket.Byes = nil
	}
}

// clearBracketByes removes setup BYEs without touching player records.
func clearBracketByes(state *TournamentState) {
	state.Bracket.Byes = nil
}

// clearBracketSeeds returns the bracket to natural seed order without moving players.
func clearBracketSeeds(state *TournamentState) {
	state.Bracket.Seeds = nil
}
