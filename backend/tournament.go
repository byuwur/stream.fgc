/*
 * File: tournament.go
 * Desc: Loads, normalizes, mutates, and saves the live tournament JSON state.
 * Deps: Go encoding-json/fmt/os/path/filepath/strconv/strings, bracket and asset helpers.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	dataDirPath               = "data"
	templatesDirPath          = "templates"
	tournamentJSONFile        = "tournament.json"
	defaultTournamentJSONFile = "_default.json"
	defaultTournamentSize     = 8
)

// TournamentState is the JSON document used by the app and future OBS overlays.
type TournamentState struct {
	Version int                   `json:"version"`
	Event   EventInfo             `json:"event"`
	Current string                `json:"current"`
	Players map[string]Player     `json:"players"`
	Matches map[string]MatchState `json:"matches"`
	Bracket BracketSettings       `json:"bracket,omitempty"`
}

// EventInfo stores the tournament-level fields edited on the event page.
type EventInfo struct {
	Name   string `json:"name"`
	Phase  string `json:"phase"`
	Rule   int    `json:"rule"`
	Game   string `json:"game"`
	Format string `json:"format"`
	Size   int    `json:"size"`
}

// UnmarshalJSON accepts old "FT3"/"ft3" rule strings while the app now saves rule as a number.
func (event *EventInfo) UnmarshalJSON(data []byte) error {
	type rawEventInfo struct {
		Name   string      `json:"name"`
		Phase  string      `json:"phase"`
		Rule   interface{} `json:"rule"`
		Game   string      `json:"game"`
		Format string      `json:"format"`
		Size   int         `json:"size"`
	}

	var raw rawEventInfo
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	event.Name = raw.Name
	event.Phase = raw.Phase
	event.Rule = parseEventRule(raw.Rule)
	event.Game = raw.Game
	event.Format = raw.Format
	event.Size = raw.Size
	return nil
}

// Player stores editable player metadata persisted into tournament.json.
type Player struct {
	Name      string `json:"name"`
	Team      string `json:"team"`
	Country   string `json:"country"`
	Character string `json:"character"`
	Bye       bool   `json:"bye,omitempty"`
	Portrait  string `json:"-"` // Derived from game/character assets; never persisted.
}

// MatchState stores mutable per-match results.
type MatchState struct {
	Player1Score int    `json:"player1_score"`
	Player2Score int    `json:"player2_score"`
	Winner       string `json:"winner,omitempty"`
	Loser        string `json:"loser,omitempty"`
	Reason       string `json:"reason,omitempty"`
	SwapSides    bool   `json:"swap_sides,omitempty"`
}

// BracketTemplate describes the static bracket graph loaded from templates.
type BracketTemplate struct {
	Type       string                   `json:"type"`
	Size       int                      `json:"size"`
	Matches    map[string]TemplateMatch `json:"matches"`
	Placements map[string]interface{}   `json:"placements,omitempty"`
}

// BracketSettings stores admin choices that affect bracket overlays.
type BracketSettings struct {
	OverlayView     string                 `json:"overlay_view,omitempty"`
	Seeds           map[string]string      `json:"seeds,omitempty"`
	Byes            map[string]bool        `json:"byes,omitempty"`
	Matches         map[string]MatchState  `json:"matches,omitempty"` // Legacy location; migrated to TournamentState.Matches.
	Placements      map[string]interface{} `json:"placements,omitempty"`
	GrandFinalReset bool                   `json:"grand_final_reset,omitempty"`
}

// TemplateMatch defines one template match and where its results advance.
type TemplateMatch struct {
	Name     string              `json:"name"`
	Player1  TemplateParticipant `json:"p1"`
	Player2  TemplateParticipant `json:"p2"`
	WinnerTo string              `json:"winner_to,omitempty"`
	LoserTo  string              `json:"loser_to,omitempty"`
	Group    string              `json:"group,omitempty"`
	Round    string              `json:"round,omitempty"`
	Order    int                 `json:"order,omitempty"`
	Reset    bool                `json:"reset,omitempty"`
	Optional bool                `json:"optional,omitempty"`
}

// TemplateParticipant defines how a player slot is resolved at runtime.
type TemplateParticipant struct {
	Type     string `json:"type"`
	Seed     int    `json:"seed,omitempty"`
	Match    string `json:"match,omitempty"`
	Fallback string `json:"fallback,omitempty"`
}

// ResolvedMatch is a match ready for display in the controller UI.
type ResolvedMatch struct {
	ID      string              `json:"id"`
	Name    string              `json:"name"`
	Player1 ResolvedParticipant `json:"player1"`
	Player2 ResolvedParticipant `json:"player2"`
	State   MatchState          `json:"state"`
}

// ResolvedParticipant is either a concrete player or a pending bracket source.
type ResolvedParticipant struct {
	PlayerID     string              `json:"player_id"`
	Player       Player              `json:"player"`
	Source       TemplateParticipant `json:"source"`
	BracketSeed  int                 `json:"bracket_seed,omitempty"`
	Resolved     bool                `json:"resolved"`
	PendingLabel string              `json:"pending_label"`
	Status       string              `json:"status"`
}

// LoadTournament reloads tournament.json and returns a safe copy.
func (a *App) LoadTournament() TournamentState {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.state = a.loadTournamentLocked()
	return cloneTournamentState(a.state)
}

// SaveTournament normalizes and writes the complete tournament state.
func (a *App) SaveTournament(state TournamentState) error {
	normalized := normalizeTournamentState(state)
	if err := writeTournamentState(normalized); err != nil {
		return err
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	a.state = normalized
	return nil
}

// UpdateEvent persists event edits and clears characters when the game changes.
func (a *App) UpdateEvent(event EventInfo) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state := a.loadTournamentLocked()
	gameChanged := a.gameIdentity(state.Event.Game) != a.gameIdentity(event.Game)
	state.Event = event
	if gameChanged {
		clearPlayerCharacters(state.Players)
	}
	normalized := normalizeTournamentState(state)
	if err := writeTournamentState(normalized); err != nil {
		return cloneTournamentState(a.state), err
	}

	a.state = normalized
	return cloneTournamentState(a.state), nil
}

// UpdatePlayer persists one player's editable fields.
func (a *App) UpdatePlayer(playerID string, player Player) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state := a.loadTournamentLocked()
	player.Portrait = ""
	state.Players[playerID] = player
	normalized := normalizeTournamentState(state)
	if err := writeTournamentState(normalized); err != nil {
		return cloneTournamentState(a.state), err
	}

	a.state = normalized
	return cloneTournamentState(a.state), nil
}

// UpdateMatchScore persists scores for a match, defaulting to the current match.
func (a *App) UpdateMatchScore(matchID string, player1Score int, player2Score int) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state := a.loadTournamentLocked()
	if matchID == "" {
		matchID = state.Current
	}

	matchState := state.Matches[matchID]
	if matchState.Winner != "" {
		return cloneTournamentState(a.state), fmt.Errorf("match already has a winner; clear it before editing scores")
	}
	scoreLimit := normalizeEventRule(state.Event.Rule)
	player1Score = clampMatchScore(player1Score, scoreLimit)
	player2Score = clampMatchScore(player2Score, scoreLimit)
	if matchState.SwapSides {
		player1Score, player2Score = player2Score, player1Score
	}
	matchState.Player1Score = player1Score
	matchState.Player2Score = player2Score
	state.Matches[matchID] = matchState

	normalized := normalizeTournamentState(state)
	if err := writeTournamentState(normalized); err != nil {
		return cloneTournamentState(a.state), err
	}

	a.state = normalized
	return cloneTournamentState(a.state), nil
}

// SwapMatchSides toggles the display side override for the current-match controller.
func (a *App) SwapMatchSides(matchID string) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state := a.loadTournamentLocked()
	if matchID == "" {
		matchID = state.Current
	}

	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return cloneTournamentState(a.state), err
	}
	if _, ok := template.Matches[matchID]; !ok {
		return cloneTournamentState(a.state), fmt.Errorf("unknown match: %s", matchID)
	}

	matchState := state.Matches[matchID]
	matchState.SwapSides = !matchState.SwapSides
	state.Matches[matchID] = matchState

	normalized := normalizeTournamentState(state)
	if err := writeTournamentState(normalized); err != nil {
		return cloneTournamentState(a.state), err
	}

	a.state = normalized
	return cloneTournamentState(a.state), nil
}

// SetCurrentMatch selects the match controlled by the current-match panel.
func (a *App) SetCurrentMatch(matchID string) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state := a.loadTournamentLocked()
	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return cloneTournamentState(a.state), err
	}
	if _, ok := template.Matches[matchID]; !ok {
		return cloneTournamentState(a.state), fmt.Errorf("unknown match: %s", matchID)
	}

	state.Current = matchID
	normalized := normalizeTournamentState(state)
	if err := writeTournamentState(normalized); err != nil {
		return cloneTournamentState(a.state), err
	}

	a.state = normalized
	return cloneTournamentState(a.state), nil
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

	state := a.loadTournamentLocked()
	if matchID == "" {
		matchID = state.Current
	}

	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return cloneTournamentState(a.state), err
	}
	templateMatch, ok := template.Matches[matchID]
	if !ok {
		return cloneTournamentState(a.state), fmt.Errorf("unknown match: %s", matchID)
	}

	matchState := state.Matches[matchID]
	winnerPlayerID = strings.TrimSpace(winnerPlayerID)
	if winnerPlayerID == "" {
		matchState.Winner = ""
		matchState.Loser = ""
		matchState.Reason = ""
		state.Matches[matchID] = matchState
	} else {
		player1 := resolveParticipant(templateMatch.Player1, state)
		player2 := resolveParticipant(templateMatch.Player2, state)
		winnerID, loserID, err := winnerLoserIDs(winnerPlayerID, player1, player2)
		if err != nil {
			return cloneTournamentState(a.state), err
		}
		matchState.Winner = winnerID
		matchState.Loser = loserID
		matchState.Reason = normalizeMatchReason(reason)
		state.Matches[matchID] = matchState
	}
	applyByeAdvancement(&state, template)

	normalized := normalizeTournamentState(state)
	if err := writeTournamentState(normalized); err != nil {
		return cloneTournamentState(a.state), err
	}

	a.state = normalized
	return cloneTournamentState(a.state), nil
}

// SetMatchParticipantBye marks a seed participant as a BYE and advances the opponent when possible.
func (a *App) SetMatchParticipantBye(matchID string, side int, bye bool) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state := a.loadTournamentLocked()
	if matchID == "" {
		matchID = state.Current
	}

	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return cloneTournamentState(a.state), err
	}
	templateMatch, ok := template.Matches[matchID]
	if !ok {
		return cloneTournamentState(a.state), fmt.Errorf("unknown match: %s", matchID)
	}

	participant, err := templateParticipantSide(templateMatch, side)
	if err != nil {
		return cloneTournamentState(a.state), err
	}
	if participant.Type != "seed" || participant.Seed <= 0 {
		return cloneTournamentState(a.state), fmt.Errorf("only seeded participants can be marked as BYE")
	}

	ensureBracketSeedAssignments(&state)
	setBracketSeedBye(&state, participant.Seed, bye)

	matchState := state.Matches[matchID]
	matchState.Winner = ""
	matchState.Loser = ""
	matchState.Reason = ""
	state.Matches[matchID] = matchState
	applyByeAdvancement(&state, template)

	normalized := normalizeTournamentState(state)
	if err := writeTournamentState(normalized); err != nil {
		return cloneTournamentState(a.state), err
	}

	a.state = normalized
	return cloneTournamentState(a.state), nil
}

// SetBracketOverlayView persists which bracket slice the overlay renders.
func (a *App) SetBracketOverlayView(view string) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state := a.loadTournamentLocked()
	state.Bracket.OverlayView = normalizeBracketViewKey(view)
	normalized := normalizeTournamentState(state)
	if err := writeTournamentState(normalized); err != nil {
		return cloneTournamentState(a.state), err
	}

	a.state = normalized
	return cloneTournamentState(a.state), nil
}

// ResetBracket clears live match state and BYE flags while preserving players and overlay settings.
func (a *App) ResetBracket() (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state := a.loadTournamentLocked()
	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return cloneTournamentState(a.state), err
	}

	state.Matches = map[string]MatchState{}
	state.Current = firstTemplateMatchID(template)
	if state.Current == "" {
		state.Current = "A"
	}
	clearPlayerByes(state.Players, state.Event.Size)
	clearBracketSeeds(&state)
	clearBracketByes(&state)

	normalized := normalizeTournamentState(state)
	if err := writeTournamentState(normalized); err != nil {
		return cloneTournamentState(a.state), err
	}

	a.state = normalized
	return cloneTournamentState(a.state), nil
}

// RandomizeBracketSeeds shuffles bracket seed assignments before bracket play starts.
func (a *App) RandomizeBracketSeeds() (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state := a.loadTournamentLocked()
	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return cloneTournamentState(a.state), err
	}
	if hasBracketStarted(state, template) {
		return cloneTournamentState(a.state), fmt.Errorf("bracket has already started")
	}

	playerIDs := make([]string, 0, state.Event.Size)
	for seed := 1; seed <= state.Event.Size; seed++ {
		playerID := strconv.Itoa(seed)
		player := state.Players[playerID]
		if strings.TrimSpace(player.Name) == "" {
			continue
		}
		playerIDs = append(playerIDs, playerID)
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

	normalized := normalizeTournamentState(state)
	if err := writeTournamentState(normalized); err != nil {
		return cloneTournamentState(a.state), err
	}

	a.state = normalized
	return cloneTournamentState(a.state), nil
}

// SwapBracketSeeds swaps two bracket seed assignments as a manual correction.
func (a *App) SwapBracketSeeds(seed int, targetSeed int) (TournamentState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	state := a.loadTournamentLocked()
	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return cloneTournamentState(a.state), err
	}
	if seed < 1 || seed > state.Event.Size || targetSeed < 1 || targetSeed > state.Event.Size {
		return cloneTournamentState(a.state), fmt.Errorf("seed is outside bracket size")
	}
	if seed == targetSeed {
		return cloneTournamentState(a.state), nil
	}

	ensureBracketSeedAssignments(&state)
	leftID := strconv.Itoa(seed)
	rightID := strconv.Itoa(targetSeed)
	state.Bracket.Seeds[leftID], state.Bracket.Seeds[rightID] = state.Bracket.Seeds[rightID], state.Bracket.Seeds[leftID]
	leftBye := state.Bracket.Byes[leftID]
	rightBye := state.Bracket.Byes[rightID]
	setBracketSeedBye(&state, seed, rightBye)
	setBracketSeedBye(&state, targetSeed, leftBye)
	clearSetupMatchResults(&state)
	applyByeAdvancement(&state, template)

	normalized := normalizeTournamentState(state)
	if err := writeTournamentState(normalized); err != nil {
		return cloneTournamentState(a.state), err
	}

	a.state = normalized
	return cloneTournamentState(a.state), nil
}

// LoadTemplate returns a bracket template or an empty template fallback.
func (a *App) LoadTemplate(format string, size int) BracketTemplate {
	template, err := loadBracketTemplate(format, size)
	if err != nil {
		return emptyBracketTemplate(format, size)
	}
	return template
}

// ResolveMatch expands a template match into the players currently occupying it.
func (a *App) ResolveMatch(matchID string) ResolvedMatch {
	a.mu.Lock()
	state := a.loadTournamentLocked()
	a.mu.Unlock()

	if matchID == "" {
		matchID = state.Current
	}

	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		return ResolvedMatch{ID: matchID, Name: "Unknown match", State: state.Matches[matchID]}
	}

	templateMatch, ok := template.Matches[matchID]
	if !ok {
		return ResolvedMatch{ID: matchID, Name: "Unknown match", State: state.Matches[matchID]}
	}

	matchState := state.Matches[matchID]
	player1 := resolveParticipant(templateMatch.Player1, state)
	player2 := resolveParticipant(templateMatch.Player2, state)
	if matchState.SwapSides {
		player1, player2 = player2, player1
		matchState.Player1Score, matchState.Player2Score = matchState.Player2Score, matchState.Player1Score
	}

	return ResolvedMatch{
		ID:      matchID,
		Name:    templateMatch.Name,
		Player1: player1,
		Player2: player2,
		State:   matchState,
	}
}

// AdvanceWinner is reserved for template-driven winner advancement.
func (a *App) AdvanceWinner(matchID string) TournamentState {
	a.mu.Lock()
	defer a.mu.Unlock()

	// Future bracket advancement should use TemplateMatch.WinnerTo.
	a.state = a.loadTournamentLocked()
	return cloneTournamentState(a.state)
}

// AdvanceLoser is reserved for template-driven loser advancement.
func (a *App) AdvanceLoser(matchID string) TournamentState {
	a.mu.Lock()
	defer a.mu.Unlock()

	// Future bracket advancement should use TemplateMatch.LoserTo.
	a.state = a.loadTournamentLocked()
	return cloneTournamentState(a.state)
}

// ComputeTop8Placements is reserved for final placement resolution.
func (a *App) ComputeTop8Placements() []ResolvedParticipant {
	// Future placement logic should resolve BracketTemplate.Placements.
	return []ResolvedParticipant{}
}

// ListCountryCodes returns ISO2 codes backed by dev frontend flags or exe-local flags.
func (a *App) ListCountryCodes() ([]string, error) {
	paths := []string{}
	if !usePortableExternalPaths() {
		paths = append(paths, filepath.Join(developmentExternalBaseDir(), "frontend", "flags"))
	}
	for _, dirPath := range externalDirPaths("flags") {
		if !stringInSlice(paths, dirPath) {
			paths = append(paths, dirPath)
		}
	}

	for _, dirPath := range paths {
		codes, err := listISO2SVGCodes(dirPath)
		if err == nil {
			return codes, nil
		}
	}
	return []string{}, nil
}

// loadTournamentLocked returns cached state or initializes it from disk.
func (a *App) loadTournamentLocked() TournamentState {
	if a.state.Version != 0 {
		return normalizeTournamentState(a.state)
	}

	state, err := readTournamentState()
	if err != nil {
		state = defaultTournamentState()
		_ = writeTournamentState(state)
	}

	return normalizeTournamentState(state)
}

// readTournamentState reads the live tournament JSON used by the UI and OBS.
func readTournamentState() (TournamentState, error) {
	return readTournamentStateFileCandidates(externalFilePaths(dataDirPath, tournamentJSONFile))
}

// readDefaultTournamentState reads the editable starter state.
func readDefaultTournamentState() (TournamentState, error) {
	return readTournamentStateFileCandidates(externalFilePaths(dataDirPath, defaultTournamentJSONFile))
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

// writeTournamentState writes data/tournament.json with stable formatting.
func writeTournamentState(state TournamentState) error {
	cleanPath := externalWriteFilePath(dataDirPath, tournamentJSONFile)
	if err := os.MkdirAll(filepath.Dir(cleanPath), 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(normalizeTournamentState(state), "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	return os.WriteFile(cleanPath, data, 0644)
}

// normalizeTournamentState fills MVP defaults and strips derived fields.
func normalizeTournamentState(state TournamentState) TournamentState {
	if state.Version == 0 {
		state.Version = 1
	}
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
	clampMatchScores(state.Matches, state.Event.Rule)
	state.Bracket.OverlayView = normalizeBracketViewKey(state.Bracket.OverlayView)
	return state
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
		normalized := normalizeAssetName(typed)
		normalized = strings.TrimPrefix(normalized, "ft")
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

// ensureBracketSeedAssignments materializes the bracket seed map before setup edits.
func ensureBracketSeedAssignments(state *TournamentState) {
	if state.Bracket.Seeds == nil {
		state.Bracket.Seeds = map[string]string{}
	}
	for seed := 1; seed <= state.Event.Size; seed++ {
		key := strconv.Itoa(seed)
		if _, ok := state.Bracket.Seeds[key]; !ok {
			state.Bracket.Seeds[key] = key
		}
	}
	normalizeBracketSeedAssignments(state)
	if state.Bracket.Seeds == nil {
		state.Bracket.Seeds = map[string]string{}
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

// cloneTournamentState protects backend state from frontend-side mutation.
func cloneTournamentState(state TournamentState) TournamentState {
	cloned := state
	cloned.Players = make(map[string]Player, len(state.Players))
	for id, player := range state.Players {
		cloned.Players[id] = player
	}
	cloned.Matches = make(map[string]MatchState, len(state.Matches))
	for id, match := range state.Matches {
		cloned.Matches[id] = match
	}
	if state.Bracket.Matches != nil {
		cloned.Bracket.Matches = make(map[string]MatchState, len(state.Bracket.Matches))
		for id, match := range state.Bracket.Matches {
			cloned.Bracket.Matches[id] = match
		}
	}
	if state.Bracket.Seeds != nil {
		cloned.Bracket.Seeds = make(map[string]string, len(state.Bracket.Seeds))
		for seed, playerID := range state.Bracket.Seeds {
			cloned.Bracket.Seeds[seed] = playerID
		}
	}
	if state.Bracket.Byes != nil {
		cloned.Bracket.Byes = make(map[string]bool, len(state.Bracket.Byes))
		for seed, bye := range state.Bracket.Byes {
			cloned.Bracket.Byes[seed] = bye
		}
	}
	if state.Bracket.Placements != nil {
		cloned.Bracket.Placements = make(map[string]interface{}, len(state.Bracket.Placements))
		for id, placement := range state.Bracket.Placements {
			cloned.Bracket.Placements[id] = placement
		}
	}
	return cloned
}

// defaultTournamentState uses data/_default.json, then falls back to built-in seed data.
func defaultTournamentState() TournamentState {
	if state, err := readDefaultTournamentState(); err == nil {
		return state
	}

	players := map[string]Player{}
	for seed := 1; seed <= 8; seed++ {
		players[strconv.Itoa(seed)] = Player{
			Name:      "Player " + strconv.Itoa(seed),
			Country:   "CO",
			Character: "Ryu",
		}
	}

	return TournamentState{
		Version: 1,
		Event: EventInfo{
			Name:   "Stream.FGC Tournament",
			Phase:  "2026:25",
			Rule:   3,
			Game:   "SF6",
			Format: "double_elimination",
			Size:   defaultTournamentSize,
		},
		Current: "A",
		Players: players,
		Matches: map[string]MatchState{},
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

// configuredTournamentSizes reads assets/sizes.json and falls back to MVP sizes.
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
	return []int{2, 4, defaultTournamentSize, 16, 32}
}

// loadBracketTemplate reads templates/{format}{size}.json and normalizes it.
func loadBracketTemplate(format string, size int) (BracketTemplate, error) {
	var data []byte
	for _, diskPath := range externalFilePaths(templatesDirPath, templateFileName(format, size)) {
		fileData, err := os.ReadFile(diskPath)
		if err == nil {
			data = fileData
			break
		}
	}
	if len(data) == 0 {
		return generateBracketTemplate(format, size), nil
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
			return ResolvedParticipant{
				PlayerID:     playerID,
				Player:       player,
				Source:       participant,
				BracketSeed:  participant.Seed,
				Resolved:     true,
				PendingLabel: "BYE",
				Status:       participantStatusBye,
			}
		}
		if playerID == "" {
			return unresolvedParticipant(participant, "", fmt.Sprintf("Seed %d", participant.Seed))
		}
		if !ok {
			return unresolvedParticipant(participant, playerID, fmt.Sprintf("Seed %d", participant.Seed))
		}
		if strings.TrimSpace(player.Name) == "" {
			return ResolvedParticipant{
				PlayerID:     playerID,
				Player:       player,
				Source:       participant,
				BracketSeed:  participant.Seed,
				PendingLabel: "TBD",
				Status:       participantStatusTBD,
			}
		}
		return ResolvedParticipant{
			PlayerID:    playerID,
			Player:      player,
			Source:      participant,
			BracketSeed: participant.Seed,
			Resolved:    true,
			Status:      participantStatusPlayer,
		}
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
			return ResolvedParticipant{
				PlayerID:     playerID,
				Player:       player,
				Source:       participant,
				Resolved:     true,
				PendingLabel: "BYE",
				Status:       participantStatusBye,
			}
		}
		return ResolvedParticipant{
			PlayerID: playerID,
			Player:   player,
			Source:   participant,
			Resolved: true,
			Status:   participantStatusPlayer,
		}
	default:
		return unresolvedParticipant(participant, "", "TBD")
	}
}

// unresolvedParticipant keeps pending bracket sources visible in the UI.
func unresolvedParticipant(participant TemplateParticipant, playerID string, label string) ResolvedParticipant {
	resolved := ResolvedParticipant{
		PlayerID:     playerID,
		Source:       participant,
		PendingLabel: label,
		Resolved:     false,
		Status:       participantStatusPending,
	}
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
func emptyBracketTemplate(format string, size int) BracketTemplate {
	return BracketTemplate{
		Type:       format,
		Size:       size,
		Matches:    map[string]TemplateMatch{},
		Placements: map[string]interface{}{},
	}
}

// templateFileName maps event format/size to a JSON template filename.
func templateFileName(format string, size int) string {
	normalized := strings.ToLower(strings.TrimSpace(format))
	switch normalized {
	case "double", "double_elimination":
		return fmt.Sprintf("double%d.json", size)
	case "single", "single_elimination":
		return fmt.Sprintf("single%d.json", size)
	default:
		name := strings.ReplaceAll(normalized, "_elimination", "")
		name = strings.ReplaceAll(name, "_", "")
		if name == "" {
			name = "double"
		}
		return fmt.Sprintf("%s%d.json", name, size)
	}
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
		if seen[code] {
			continue
		}
		seen[code] = true
		codes = append(codes, code)
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
