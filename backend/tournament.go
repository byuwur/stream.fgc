package backend

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	dataDirPath               = "data"
	templatesDirPath          = "templates"
	tournamentJSONFile        = "tournament.json"
	defaultTournamentJSONFile = "_default.json"
)

// TournamentState is the JSON document used by the app and future OBS overlays.
type TournamentState struct {
	Version int                   `json:"version"`
	Event   EventInfo             `json:"event"`
	Current string                `json:"current"`
	Players map[string]Player     `json:"players"`
	Matches map[string]MatchState `json:"matches"`
}

// EventInfo stores the tournament-level fields edited on the event page.
type EventInfo struct {
	Name   string `json:"name"`
	Phase  string `json:"phase"`
	Rule   string `json:"rule"`
	Game   string `json:"game"`
	Format string `json:"format"`
	Size   int    `json:"size"`
}

// Player stores editable player metadata persisted into tournament.json.
type Player struct {
	Name      string `json:"name"`
	Team      string `json:"team"`
	Country   string `json:"country"`
	Character string `json:"character"`
	Portrait  string `json:"-"` // Derived from game/character assets; never persisted.
}

// MatchState stores mutable per-match results.
type MatchState struct {
	Player1Score int    `json:"player1_score"`
	Player2Score int    `json:"player2_score"`
	Winner       string `json:"winner,omitempty"`
	Loser        string `json:"loser,omitempty"`
}

// BracketTemplate describes the static bracket graph loaded from templates.
type BracketTemplate struct {
	Type       string                   `json:"type"`
	Size       int                      `json:"size"`
	Matches    map[string]TemplateMatch `json:"matches"`
	Placements map[string]interface{}   `json:"placements,omitempty"`
}

// TemplateMatch defines one template match and where its results advance.
type TemplateMatch struct {
	Name     string              `json:"name"`
	Player1  TemplateParticipant `json:"p1"`
	Player2  TemplateParticipant `json:"p2"`
	WinnerTo string              `json:"winner_to,omitempty"`
	LoserTo  string              `json:"loser_to,omitempty"`
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
	Resolved     bool                `json:"resolved"`
	PendingLabel string              `json:"pending_label"`
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
	matchState.Player1Score = max(0, player1Score)
	matchState.Player2Score = max(0, player2Score)
	state.Matches[matchID] = matchState

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

	return ResolvedMatch{
		ID:      matchID,
		Name:    templateMatch.Name,
		Player1: resolveParticipant(templateMatch.Player1, state),
		Player2: resolveParticipant(templateMatch.Player2, state),
		State:   state.Matches[matchID],
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

// ListCountryCodes returns ISO2 codes backed by frontend/dist/flags SVGs.
func (a *App) ListCountryCodes() ([]string, error) {
	paths := []string{
		filepath.Join("frontend", "dist", "flags"),
		"flags",
	}

	for _, path := range paths {
		codes, err := listISO2SVGCodes(path)
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
	return readTournamentStateFile(filepath.Join(dataDirPath, tournamentJSONFile))
}

// readDefaultTournamentState reads the editable starter state.
func readDefaultTournamentState() (TournamentState, error) {
	return readTournamentStateFile(filepath.Join(dataDirPath, defaultTournamentJSONFile))
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
	cleanPath := filepath.Clean(filepath.Join(dataDirPath, tournamentJSONFile))
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
	if state.Event.Format == "" {
		state.Event.Format = "double_elimination"
	}
	if state.Event.Size == 0 {
		state.Event.Size = 8
	}
	if state.Current == "" {
		state.Current = "A"
	}
	if state.Players == nil {
		state.Players = map[string]Player{}
	}
	stripPlayerPortraits(state.Players)
	if state.Matches == nil {
		state.Matches = map[string]MatchState{}
	}
	return state
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
			Name:   "Chimbacaneria",
			Phase:  "2026:25",
			Rule:   "FT3",
			Game:   "SF6",
			Format: "double_elimination",
			Size:   8,
		},
		Current: "A",
		Players: players,
		Matches: map[string]MatchState{},
	}
}

// loadBracketTemplate reads templates/{format}{size}.json and normalizes it.
func loadBracketTemplate(format string, size int) (BracketTemplate, error) {
	data, err := os.ReadFile(filepath.Join(templatesDirPath, templateFileName(format, size)))
	if err != nil {
		return BracketTemplate{}, err
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
		playerID := strconv.Itoa(participant.Seed)
		player, ok := state.Players[playerID]
		if !ok {
			return unresolvedParticipant(participant, fmt.Sprintf("Seed %d", participant.Seed))
		}
		return ResolvedParticipant{
			PlayerID: playerID,
			Player:   player,
			Source:   participant,
			Resolved: true,
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
			return unresolvedParticipant(participant, fmt.Sprintf("%s of %s", labelPrefix, participant.Match))
		}
		player, ok := state.Players[playerID]
		if !ok {
			return unresolvedParticipant(participant, fmt.Sprintf("%s of %s", labelPrefix, participant.Match))
		}
		return ResolvedParticipant{
			PlayerID: playerID,
			Player:   player,
			Source:   participant,
			Resolved: true,
		}
	default:
		return unresolvedParticipant(participant, "TBD")
	}
}

// unresolvedParticipant keeps pending bracket sources visible in the UI.
func unresolvedParticipant(participant TemplateParticipant, label string) ResolvedParticipant {
	return ResolvedParticipant{
		Source:       participant,
		PendingLabel: label,
		Resolved:     false,
	}
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
