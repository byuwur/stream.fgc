/*
 * File: tournament.go
 * Desc: Exposes direct tournament, match, and bracket mutations to the Wails frontend.
 * Deps: Go fmt/strconv/strings, storage, seeding, template, and bracket helpers.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"fmt"
	"strconv"
	"strings"
)

// LoadTournament reloads and returns the normalized tournament JSON document.
func (a *App) LoadTournament() (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	// Reload from disk on demand so manual JSON edits are picked up immediately.
	state, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	return state, nil
}

// SaveTournament normalizes and writes the complete tournament state.
func (a *App) SaveTournament(state TournamentState) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	_, err := a.saveTournamentLocked(state)
	return err
}

// saveTournamentLocked normalizes and atomically writes state for mutation methods.
func (a *App) saveTournamentLocked(state TournamentState) (TournamentState, error) {
	normalized := normalizeTournamentState(state)
	if err := writeTournamentState(normalized); err != nil {
		return TournamentState{}, err
	}
	return normalized, nil
}

// UpdateEvent persists event edits and clears characters when the game changes.
func (a *App) UpdateEvent(event EventInfo) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	gameChanged := a.gameIdentity(state.Event.Game) != a.gameIdentity(event.Game)
	state.Event = event
	if gameChanged {
		// Characters are game-specific keys, so changing games invalidates all choices.
		clearPlayerCharacters(state.Players)
	}
	return a.saveTournamentLocked(state)
}

// UpdatePlayer persists one player's editable fields.
func (a *App) UpdatePlayer(playerID string, player Player) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	player.Portrait = ""
	state.Players[playerID] = player
	return a.saveTournamentLocked(state)
}

// UpdateMatchScore persists scores for a match, defaulting to the current match.
func (a *App) UpdateMatchScore(matchID string, player1Score int, player2Score int) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	if matchID == "" {
		matchID = state.Current
	}

	matchState := state.Matches[matchID]
	if matchState.Winner != "" {
		return TournamentState{}, fmt.Errorf("match already has a winner; clear it before editing scores")
	}
	scoreLimit := normalizeEventRule(state.Event.Rule)
	player1Score = clampMatchScore(player1Score, scoreLimit)
	player2Score = clampMatchScore(player2Score, scoreLimit)
	if matchState.SwapSides {
		// The current-match UI can swap display sides without altering bracket participants.
		player1Score, player2Score = player2Score, player1Score
	}
	matchState.Player1Score = player1Score
	matchState.Player2Score = player2Score
	state.Matches[matchID] = matchState
	return a.saveTournamentLocked(state)
}

// SwapMatchSides toggles the display side override for the current-match controller.
func (a *App) SwapMatchSides(matchID string) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	if matchID == "" {
		matchID = state.Current
	}

	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return TournamentState{}, err
	}
	if _, ok := template.Matches[matchID]; !ok {
		return TournamentState{}, fmt.Errorf("unknown match: %s", matchID)
	}

	matchState := state.Matches[matchID]
	matchState.SwapSides = !matchState.SwapSides
	state.Matches[matchID] = matchState
	return a.saveTournamentLocked(state)
}

// SetCurrentMatch selects the match controlled by the current-match panel.
func (a *App) SetCurrentMatch(matchID string) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return TournamentState{}, err
	}
	if _, ok := template.Matches[matchID]; !ok {
		return TournamentState{}, fmt.Errorf("unknown match: %s", matchID)
	}
	state.Current = matchID
	return a.saveTournamentLocked(state)
}

// SetMatchWinner stores the winner/loser selected by the bracket admin page.
func (a *App) SetMatchWinner(matchID string, winnerPlayerID string) (TournamentState, error) {
	return a.setMatchWinner(matchID, winnerPlayerID, "")
}

// SetMatchResult stores a winner/loser with a result reason such as DQ.
func (a *App) SetMatchResult(matchID string, winnerPlayerID string, reason string) (TournamentState, error) {
	return a.setMatchWinner(matchID, winnerPlayerID, reason)
}

// setMatchWinner validates a winner against the resolved match participants and persists the result.
func (a *App) setMatchWinner(matchID string, winnerPlayerID string, reason string) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	if matchID == "" {
		matchID = state.Current
	}

	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return TournamentState{}, err
	}
	templateMatch, ok := template.Matches[matchID]
	if !ok {
		return TournamentState{}, fmt.Errorf("unknown match: %s", matchID)
	}

	matchState := state.Matches[matchID]
	winnerPlayerID = strings.TrimSpace(winnerPlayerID)
	if winnerPlayerID == "" {
		// Empty winner is the clear action used when an operator fixes a bracket mistake.
		matchState.Winner = ""
		matchState.Loser = ""
		matchState.Reason = ""
		state.Matches[matchID] = matchState
		applyByeAdvancement(&state, template)
		return a.saveTournamentLocked(state)
	}

	// Resolve through the template so winners/losers sources and bracket seed swaps work.
	player1 := resolveParticipant(templateMatch.Player1, state)
	player2 := resolveParticipant(templateMatch.Player2, state)
	winnerID, loserID, err := winnerLoserIDs(winnerPlayerID, player1, player2)
	if err != nil {
		return TournamentState{}, err
	}
	matchState.Winner = winnerID
	matchState.Loser = loserID
	matchState.Reason = normalizeMatchReason(reason)
	state.Matches[matchID] = matchState
	applyByeAdvancement(&state, template)
	return a.saveTournamentLocked(state)
}

// SetMatchParticipantBye marks a seed participant as a BYE and advances the opponent when possible.
func (a *App) SetMatchParticipantBye(matchID string, side int, bye bool) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	if matchID == "" {
		matchID = state.Current
	}

	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return TournamentState{}, err
	}
	templateMatch, ok := template.Matches[matchID]
	if !ok {
		return TournamentState{}, fmt.Errorf("unknown match: %s", matchID)
	}

	participant, err := templateParticipantSide(templateMatch, side)
	if err != nil {
		return TournamentState{}, err
	}
	if participant.Type != "seed" || participant.Seed <= 0 {
		return TournamentState{}, fmt.Errorf("only seeded participants can be marked as BYE")
	}

	ensureBracketSeedAssignments(&state)
	setBracketSeedBye(&state, participant.Seed, bye)

	matchState := state.Matches[matchID]
	matchState.Winner = ""
	matchState.Loser = ""
	matchState.Reason = ""
	state.Matches[matchID] = matchState
	// Recalculate generated BYE results after toggling the seed-level flag.
	applyByeAdvancement(&state, template)
	return a.saveTournamentLocked(state)
}

// SetBracketOverlayView persists which bracket slice the overlay renders.
func (a *App) SetBracketOverlayView(view string) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	state.Bracket.OverlayView = normalizeBracketViewKey(view)
	return a.saveTournamentLocked(state)
}

// SetBracketManagerView persists which bracket slice the admin page renders.
func (a *App) SetBracketManagerView(view string) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	state.Bracket.ManagerView = normalizeBracketViewKey(view)
	return a.saveTournamentLocked(state)
}

// ResetBracket clears live match state and BYE flags while preserving players and overlay settings.
func (a *App) ResetBracket() (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return TournamentState{}, err
	}

	state.Matches = map[string]MatchState{}
	state.Current = firstTemplateMatchID(template)
	if state.Current == "" {
		state.Current = "A"
	}
	// Reset returns the setup state to natural order without deleting player records.
	clearPlayerByes(state.Players, state.Event.Size)
	clearBracketSeeds(&state)
	clearBracketByes(&state)
	return a.saveTournamentLocked(state)
}

// RandomizeBracketSeeds shuffles bracket seed assignments before bracket play starts.
func (a *App) RandomizeBracketSeeds() (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return TournamentState{}, err
	}
	if hasBracketStarted(state, template) {
		return TournamentState{}, fmt.Errorf("bracket has already started")
	}

	// Shuffle only bracket seed assignments. Player records and their numeric keys stay stable.
	slots := randomizedBracketSlots(state)
	state.Bracket.Seeds = map[string]string{}
	state.Bracket.Byes = map[string]bool{}
	for seed := 1; seed <= state.Event.Size; seed++ {
		key := strconv.Itoa(seed)
		state.Bracket.Seeds[key] = slots[seed-1]
		if slots[seed-1] == "" {
			state.Bracket.Byes[key] = true
		}
	}
	clearPlayerByes(state.Players, state.Event.Size)
	state.Matches = map[string]MatchState{}
	state.Current = firstTemplateMatchID(template)
	if state.Current == "" {
		state.Current = "A"
	}
	applyByeAdvancement(&state, template)
	return a.saveTournamentLocked(state)
}

// SwapBracketSeeds swaps two bracket seed assignments as a manual correction.
func (a *App) SwapBracketSeeds(seed int, targetSeed int) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return TournamentState{}, err
	}
	if seed < 1 || seed > state.Event.Size || targetSeed < 1 || targetSeed > state.Event.Size {
		return TournamentState{}, fmt.Errorf("seed is outside bracket size")
	}
	if seed == targetSeed {
		return state, nil
	}

	ensureBracketSeedAssignments(&state)
	leftID := strconv.Itoa(seed)
	rightID := strconv.Itoa(targetSeed)
	// Swap the bracket mapping only; players keep their original JSON keys and card order.
	state.Bracket.Seeds[leftID], state.Bracket.Seeds[rightID] = state.Bracket.Seeds[rightID], state.Bracket.Seeds[leftID]
	leftBye := state.Bracket.Byes[leftID]
	rightBye := state.Bracket.Byes[rightID]
	setBracketSeedBye(&state, seed, rightBye)
	setBracketSeedBye(&state, targetSeed, leftBye)
	clearSetupMatchResults(&state)
	applyByeAdvancement(&state, template)
	return a.saveTournamentLocked(state)
}

// LoadTemplate returns a bracket template or an empty template with a missing-template message.
func (a *App) LoadTemplate(format string, size int) BracketTemplate {
	template, err := loadBracketTemplate(format, size)
	if err != nil {
		return emptyBracketTemplate(format, size, err.Error())
	}
	return template
}

// ResolveMatch expands a template match into the players currently occupying it.
func (a *App) ResolveMatch(matchID string) (ResolvedMatch, error) {
	a.mu.Lock()
	state, loadErr := a.loadTournamentLocked()
	a.mu.Unlock()
	if loadErr != nil {
		return ResolvedMatch{ID: matchID}, loadErr
	}

	if matchID == "" {
		matchID = state.Current
	}

	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return ResolvedMatch{ID: matchID, Name: err.Error(), State: state.Matches[matchID]}, nil
	}

	templateMatch, ok := template.Matches[matchID]
	if !ok {
		return ResolvedMatch{ID: matchID, Name: "Unknown match", State: state.Matches[matchID]}, nil
	}

	matchState := state.Matches[matchID]
	player1 := resolveParticipant(templateMatch.Player1, state)
	player2 := resolveParticipant(templateMatch.Player2, state)
	if matchState.SwapSides {
		// Presentational side swaps invert both participants and scores for the controller only.
		player1, player2 = player2, player1
		matchState.Player1Score, matchState.Player2Score = matchState.Player2Score, matchState.Player1Score
	}

	return ResolvedMatch{
		ID:      matchID,
		Name:    templateMatch.Name,
		Player1: player1,
		Player2: player2,
		State:   matchState,
	}, nil
}

// ListCountryCodes returns ISO2 codes backed by assets/flags.
func (a *App) ListCountryCodes() ([]string, error) {
	for _, dirPath := range externalFilePaths(assetDirPath, "flags") {
		codes, err := listISO2SVGCodes(dirPath)
		if err == nil {
			return codes, nil
		}
	}
	return []string{}, nil
}
