/*
 * File: bracket.go
 * Desc: Resolves template-driven bracket state for admin controls and future OBS overlays.
 * Deps: Go fmt/math/sort/strconv/strings.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

const (
	bracketViewAll     = "all"
	bracketViewWinners = "winners"
	bracketViewLosers  = "losers"
	bracketViewFinals  = "finals"

	participantStatusPlayer  = "player"
	participantStatusTBD     = "tbd"
	participantStatusBye     = "bye"
	participantStatusPending = "pending"

	matchStatusPending  = "pending"
	matchStatusReady    = "ready"
	matchStatusComplete = "complete"
	matchStatusBye      = "bye"

	matchReasonBye = "bye"
	matchReasonDQ  = "dq"
)

// BracketProjection is the resolved bracket document shared by admin and overlays.
type BracketProjection struct {
	Event        EventInfo           `json:"event"`
	Current      string              `json:"current"`
	Format       string              `json:"format"`
	Size         int                 `json:"size"`
	View         string              `json:"view"`
	OverlayView  string              `json:"overlay_view"`
	Started      bool                `json:"started"`
	CanRandomize bool                `json:"can_randomize"`
	Views        []BracketViewOption `json:"views"`
	SeedOptions  []BracketSeedOption `json:"seed_options"`
	Sections     []BracketSection    `json:"sections"`
	MatchCount   int                 `json:"match_count"`
	PlayerCount  int                 `json:"player_count"`
	Error        string              `json:"error,omitempty"`
}

// BracketViewOption describes a selectable overlay slice.
type BracketViewOption struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

// BracketSeedOption describes one editable seed slot for admin swap controls.
type BracketSeedOption struct {
	Seed     int    `json:"seed"`
	PlayerID string `json:"player_id"`
	Name     string `json:"name"`
	Team     string `json:"team"`
	Bye      bool   `json:"bye"`
}

// BracketSection groups rounds by bracket side.
type BracketSection struct {
	Key    string         `json:"key"`
	Name   string         `json:"name"`
	Rounds []BracketRound `json:"rounds"`
}

// BracketRound groups matches that belong in the same visual column.
type BracketRound struct {
	Key     string             `json:"key"`
	Name    string             `json:"name"`
	Matches []BracketMatchView `json:"matches"`
}

// BracketMatchView is one template match resolved against live tournament state.
type BracketMatchView struct {
	ID        string              `json:"id"`
	Name      string              `json:"name"`
	Group     string              `json:"group"`
	Round     string              `json:"round"`
	Order     int                 `json:"order"`
	Current   bool                `json:"current"`
	Optional  bool                `json:"optional"`
	Reset     bool                `json:"reset"`
	WinnerTo  string              `json:"winner_to,omitempty"`
	LoserTo   string              `json:"loser_to,omitempty"`
	Player1   ResolvedParticipant `json:"player1"`
	Player2   ResolvedParticipant `json:"player2"`
	State     MatchState          `json:"state"`
	Status    string              `json:"status"`
	CanPlay   bool                `json:"can_play"`
	CanDecide bool                `json:"can_decide"`
	WinnerID  string              `json:"winner_id,omitempty"`
	LoserID   string              `json:"loser_id,omitempty"`
}

// GetBracketView resolves the current tournament into a display/overlay bracket.
func (a *App) GetBracketView(view string) BracketProjection {
	a.mu.Lock()
	state := a.loadTournamentLocked()
	a.mu.Unlock()

	template, err := loadBracketTemplate(state.Event.Format, state.Event.Size)
	if err != nil {
		template = emptyBracketTemplate(state.Event.Format, state.Event.Size, err.Error())
	}
	return buildBracketProjection(state, template, view)
}

// buildBracketProjection resolves every template match and filters by view.
func buildBracketProjection(state TournamentState, template BracketTemplate, requestedView string) BracketProjection {
	view := selectedBracketView(requestedView, state.Bracket.OverlayView, template.Type)
	overlayView := selectedBracketView("", state.Bracket.OverlayView, template.Type)
	started := hasBracketStarted(state, template)
	options := bracketViewOptions(template.Type)
	sectionsByKey := map[string]*BracketSection{}
	roundsBySection := map[string]map[string]*BracketRound{}
	sectionOrder := []string{}
	roundOrder := map[string][]string{}
	matchCount := 0

	for _, matchID := range sortedTemplateMatchIDs(template) {
		templateMatch := template.Matches[matchID]
		matchView := bracketMatchView(matchID, templateMatch, state)
		if !bracketViewAllows(view, matchView.Group) {
			continue
		}

		matchCount++
		if _, ok := sectionsByKey[matchView.Group]; !ok {
			sectionsByKey[matchView.Group] = &BracketSection{Key: matchView.Group, Name: bracketGroupName(matchView.Group)}
			roundsBySection[matchView.Group] = map[string]*BracketRound{}
			sectionOrder = append(sectionOrder, matchView.Group)
		}

		roundKey := normalizeRoundKey(matchView.Round)
		if _, ok := roundsBySection[matchView.Group][roundKey]; !ok {
			roundsBySection[matchView.Group][roundKey] = &BracketRound{Key: roundKey, Name: matchView.Round}
			roundOrder[matchView.Group] = append(roundOrder[matchView.Group], roundKey)
		}
		roundsBySection[matchView.Group][roundKey].Matches = append(roundsBySection[matchView.Group][roundKey].Matches, matchView)
	}

	sections := make([]BracketSection, 0, len(sectionOrder))
	sort.SliceStable(sectionOrder, func(i, j int) bool {
		return bracketGroupSort(sectionOrder[i]) < bracketGroupSort(sectionOrder[j])
	})
	for _, sectionKey := range sectionOrder {
		section := *sectionsByKey[sectionKey]
		keys := roundOrder[sectionKey]
		sort.SliceStable(keys, func(i, j int) bool {
			left := roundsBySection[sectionKey][keys[i]]
			right := roundsBySection[sectionKey][keys[j]]
			return roundSortOrder(left.Matches) < roundSortOrder(right.Matches)
		})
		for _, roundKey := range keys {
			round := *roundsBySection[sectionKey][roundKey]
			sort.SliceStable(round.Matches, func(i, j int) bool {
				return round.Matches[i].Order < round.Matches[j].Order
			})
			section.Rounds = append(section.Rounds, round)
		}
		sections = append(sections, section)
	}

	return BracketProjection{
		Event:        state.Event,
		Current:      state.Current,
		Format:       template.Type,
		Size:         template.Size,
		View:         view,
		OverlayView:  overlayView,
		Started:      started,
		CanRandomize: !started,
		Views:        options,
		SeedOptions:  bracketSeedOptions(state),
		Sections:     sections,
		MatchCount:   matchCount,
		PlayerCount:  activePlayerCount(state),
		Error:        template.Error,
	}
}

// bracketMatchView resolves one template match into the admin/overlay shape.
func bracketMatchView(matchID string, templateMatch TemplateMatch, state TournamentState) BracketMatchView {
	player1 := resolveParticipant(templateMatch.Player1, state)
	player2 := resolveParticipant(templateMatch.Player2, state)
	matchState := state.Matches[matchID]
	if matchState.Winner != "" && matchState.Loser == "" {
		switch matchState.Winner {
		case player1.PlayerID:
			matchState.Loser = player2.PlayerID
		case player2.PlayerID:
			matchState.Loser = player1.PlayerID
		}
	}
	if matchState.Winner != "" && matchState.Reason == "" && (player1.Status == participantStatusBye || player2.Status == participantStatusBye) {
		matchState.Reason = matchReasonBye
	}
	group := bracketMatchGroup(templateMatch)
	round := bracketMatchRound(templateMatch, group)
	status := bracketMatchStatus(player1, player2, matchState)

	return BracketMatchView{
		ID:        matchID,
		Name:      matchName(matchID, templateMatch),
		Group:     group,
		Round:     round,
		Order:     bracketMatchOrder(matchID, templateMatch),
		Current:   matchID == state.Current,
		Optional:  templateMatch.Optional,
		Reset:     templateMatch.Reset,
		WinnerTo:  templateMatch.WinnerTo,
		LoserTo:   templateMatch.LoserTo,
		Player1:   player1,
		Player2:   player2,
		State:     matchState,
		Status:    status,
		CanPlay:   status == matchStatusReady,
		CanDecide: canDecideWinner(player1) && canDecideWinner(player2),
		WinnerID:  matchState.Winner,
		LoserID:   matchState.Loser,
	}
}

// bracketMatchStatus reports whether a match is pending, playable, complete, or BYE-driven.
func bracketMatchStatus(player1 ResolvedParticipant, player2 ResolvedParticipant, state MatchState) string {
	if state.Winner != "" {
		return matchStatusComplete
	}
	if player1.Status == participantStatusBye || player2.Status == participantStatusBye {
		return matchStatusBye
	}
	if canDecideWinner(player1) && canDecideWinner(player2) {
		return matchStatusReady
	}
	return matchStatusPending
}

// canDecideWinner checks whether a participant is a real resolved player.
func canDecideWinner(participant ResolvedParticipant) bool {
	return participant.Resolved && participant.Status == participantStatusPlayer && participant.PlayerID != ""
}

// winnerLoserIDs validates a requested winner and returns the paired winner/loser IDs.
func winnerLoserIDs(winnerPlayerID string, player1 ResolvedParticipant, player2 ResolvedParticipant) (string, string, error) {
	if !canDecideWinner(player1) || !canDecideWinner(player2) {
		return "", "", fmt.Errorf("match is not ready to decide")
	}
	switch winnerPlayerID {
	case player1.PlayerID:
		return player1.PlayerID, player2.PlayerID, nil
	case player2.PlayerID:
		return player2.PlayerID, player1.PlayerID, nil
	default:
		return "", "", fmt.Errorf("winner is not a participant: %s", winnerPlayerID)
	}
}

// templateParticipantSide returns player1 or player2 from a template match by numeric side.
func templateParticipantSide(match TemplateMatch, side int) (TemplateParticipant, error) {
	switch side {
	case 1:
		return match.Player1, nil
	case 2:
		return match.Player2, nil
	default:
		return TemplateParticipant{}, fmt.Errorf("unknown participant side: %d", side)
	}
}

// applyByeAdvancement repeatedly advances non-BYE players through template winner sources.
func applyByeAdvancement(state *TournamentState, template BracketTemplate) {
	if state.Matches == nil {
		state.Matches = map[string]MatchState{}
	}

	for changed := true; changed; {
		changed = false
		for _, matchID := range sortedTemplateMatchIDs(template) {
			templateMatch := template.Matches[matchID]
			matchState := state.Matches[matchID]
			if matchState.Winner != "" {
				continue
			}

			player1 := resolveParticipant(templateMatch.Player1, *state)
			player2 := resolveParticipant(templateMatch.Player2, *state)
			winnerID := ""
			loserID := ""
			switch {
			case player1.Status == participantStatusBye && canDecideWinner(player2):
				winnerID = player2.PlayerID
				loserID = player1.PlayerID
			case player2.Status == participantStatusBye && canDecideWinner(player1):
				winnerID = player1.PlayerID
				loserID = player2.PlayerID
			default:
				continue
			}

			matchState.Winner = winnerID
			matchState.Loser = loserID
			matchState.Reason = matchReasonBye
			state.Matches[matchID] = matchState
			changed = true
		}
	}
}

// normalizeMatchReason converts UI/backend aliases into persisted result reason keys.
func normalizeMatchReason(reason string) string {
	switch strings.ToLower(strings.TrimSpace(reason)) {
	case matchReasonBye:
		return matchReasonBye
	case matchReasonDQ, "disqualification", "disqualified":
		return matchReasonDQ
	default:
		return ""
	}
}

// clearSetupMatchResults removes auto-generated BYE results before recalculating setup state.
func clearSetupMatchResults(state *TournamentState) {
	for matchID, matchState := range state.Matches {
		if matchState.Reason != matchReasonBye {
			continue
		}
		matchState.Winner = ""
		matchState.Loser = ""
		matchState.Reason = ""
		state.Matches[matchID] = matchState
	}
}

// hasBracketStarted reports whether any real score or non-BYE result has been recorded.
func hasBracketStarted(state TournamentState, template BracketTemplate) bool {
	for matchID, matchState := range state.Matches {
		if matchState.Player1Score != 0 || matchState.Player2Score != 0 {
			return true
		}
		if matchState.Winner == "" && matchState.Loser == "" {
			continue
		}

		templateMatch, ok := template.Matches[matchID]
		if !ok {
			return true
		}
		player1 := resolveParticipant(templateMatch.Player1, state)
		player2 := resolveParticipant(templateMatch.Player2, state)
		if player1.Status == participantStatusBye || player2.Status == participantStatusBye {
			continue
		}
		if matchState.Reason == matchReasonBye {
			continue
		}
		return true
	}
	return false
}

// firstTemplateMatchID returns the first playable template match in display order.
func firstTemplateMatchID(template BracketTemplate) string {
	ids := sortedTemplateMatchIDs(template)
	if len(ids) == 0 {
		return ""
	}
	return ids[0]
}

// selectedBracketView chooses the requested, stored, or default overlay/admin view.
func selectedBracketView(requested string, stored string, format string) string {
	for _, candidate := range []string{requested, stored, bracketViewAll} {
		key := normalizeBracketViewKey(candidate)
		for _, option := range bracketViewOptions(format) {
			if option.Key == key {
				return key
			}
		}
	}
	return bracketViewAll
}

// normalizeBracketViewKey accepts friendly aliases for the supported bracket view keys.
func normalizeBracketViewKey(view string) string {
	switch strings.ToLower(strings.TrimSpace(view)) {
	case bracketViewWinners, "winner", "upper":
		return bracketViewWinners
	case bracketViewLosers, "loser", "lower":
		return bracketViewLosers
	case bracketViewFinals, "final", "grand_finals", "grand":
		return bracketViewFinals
	default:
		return bracketViewAll
	}
}

// bracketViewOptions returns the views available for the selected bracket format.
func bracketViewOptions(format string) []BracketViewOption {
	normalized := strings.ToLower(strings.TrimSpace(format))
	options := []BracketViewOption{{Key: bracketViewAll, Name: "Full bracket"}}
	if strings.Contains(normalized, "double") {
		options = append(options,
			BracketViewOption{Key: bracketViewWinners, Name: "Winners bracket"},
			BracketViewOption{Key: bracketViewLosers, Name: "Losers bracket"},
		)
	}
	if strings.Contains(normalized, "single") || strings.Contains(normalized, "double") {
		options = append(options, BracketViewOption{Key: bracketViewFinals, Name: "Finals"})
	}
	return options
}

// bracketViewAllows checks whether a bracket group belongs in a requested view.
func bracketViewAllows(view string, group string) bool {
	switch view {
	case bracketViewWinners:
		return group == bracketViewWinners
	case bracketViewLosers:
		return group == bracketViewLosers
	case bracketViewFinals:
		return group == bracketViewFinals
	default:
		return true
	}
}

// bracketGroupName converts internal group keys into operator-facing labels.
func bracketGroupName(group string) string {
	switch group {
	case bracketViewWinners:
		return "Winners"
	case bracketViewLosers:
		return "Losers"
	case bracketViewFinals:
		return "Finals"
	case "robin":
		return "Round Robin"
	case "roundrobin":
		return "Round Robin"
	case "swiss":
		return "Swiss"
	default:
		return "Bracket"
	}
}

// bracketGroupSort keeps winners, losers, and finals in a stable visual order.
func bracketGroupSort(group string) int {
	switch group {
	case bracketViewWinners:
		return 10
	case bracketViewLosers:
		return 20
	case bracketViewFinals:
		return 30
	default:
		return 40
	}
}

// bracketMatchGroup resolves the visual section for a template match.
func bracketMatchGroup(match TemplateMatch) string {
	if match.Group != "" {
		switch normalizeBracketViewKey(match.Group) {
		case bracketViewWinners:
			return bracketViewWinners
		case bracketViewLosers:
			return bracketViewLosers
		case bracketViewFinals:
			return bracketViewFinals
		default:
			key := normalizeAssetName(match.Group)
			if key != "" {
				return key
			}
		}
	}
	name := strings.ToLower(match.Name)
	switch {
	case strings.Contains(name, "grand"):
		return bracketViewFinals
	case strings.Contains(name, "loser"):
		return bracketViewLosers
	case strings.Contains(name, "winner"):
		return bracketViewWinners
	case strings.Contains(name, "final"):
		return bracketViewFinals
	}
	return "bracket"
}

// bracketMatchRound resolves the visual round/column label for a template match.
func bracketMatchRound(match TemplateMatch, group string) string {
	if match.Round != "" {
		return match.Round
	}
	if match.Name == "" {
		return bracketGroupName(group)
	}
	if index := strings.Index(match.Name, " - "); index > 0 {
		return strings.TrimSpace(match.Name[:index])
	}
	return match.Name
}

// bracketMatchOrder returns explicit template order or a natural fallback from the match ID.
func bracketMatchOrder(matchID string, match TemplateMatch) int {
	if match.Order > 0 {
		return match.Order
	}
	return naturalMatchOrder(matchID)
}

// roundSortOrder sorts a visual round by the first match it contains.
func roundSortOrder(matches []BracketMatchView) int {
	if len(matches) == 0 {
		return math.MaxInt
	}
	return matches[0].Order
}

// matchName returns the template name or a readable fallback.
func matchName(matchID string, match TemplateMatch) string {
	if match.Name != "" {
		return match.Name
	}
	return "Match " + matchID
}

// normalizeRoundKey creates a stable map key for a visual round label.
func normalizeRoundKey(round string) string {
	key := normalizeAssetName(round)
	if key == "" {
		return "round"
	}
	return key
}

// sortedTemplateMatchIDs returns template match IDs in deterministic bracket order.
func sortedTemplateMatchIDs(template BracketTemplate) []string {
	ids := make([]string, 0, len(template.Matches))
	for id := range template.Matches {
		ids = append(ids, id)
	}
	sort.SliceStable(ids, func(i, j int) bool {
		left := template.Matches[ids[i]]
		right := template.Matches[ids[j]]
		leftOrder := bracketMatchOrder(ids[i], left)
		rightOrder := bracketMatchOrder(ids[j], right)
		if leftOrder == rightOrder {
			return ids[i] < ids[j]
		}
		return leftOrder < rightOrder
	})
	return ids
}

// naturalMatchOrder turns A/B/C or M12 style IDs into sortable integers.
func naturalMatchOrder(id string) int {
	if id == "" {
		return math.MaxInt
	}
	if value, err := strconv.Atoi(strings.TrimLeft(id, "M")); err == nil {
		return value
	}
	order := 0
	for _, character := range strings.ToUpper(id) {
		if character < 'A' || character > 'Z' {
			continue
		}
		order = order*26 + int(character-'A') + 1
	}
	if order == 0 {
		return math.MaxInt
	}
	return order
}

// activePlayerCount counts seeded player slots that currently have a name.
func activePlayerCount(state TournamentState) int {
	count := 0
	for seed := 1; seed <= state.Event.Size; seed++ {
		player := state.Players[strconv.Itoa(seed)]
		if strings.TrimSpace(player.Name) != "" {
			count++
		}
	}
	return count
}

// bracketSeedOptions describes every seed slot for swap/randomize admin controls.
func bracketSeedOptions(state TournamentState) []BracketSeedOption {
	options := make([]BracketSeedOption, 0, state.Event.Size)
	for seed := 1; seed <= state.Event.Size; seed++ {
		playerID := bracketSeedPlayerID(state, seed)
		player := state.Players[playerID]
		options = append(options, BracketSeedOption{
			Seed:     seed,
			PlayerID: playerID,
			Name:     strings.TrimSpace(player.Name),
			Team:     strings.TrimSpace(player.Team),
			Bye:      bracketSeedBye(state, seed),
		})
	}
	return options
}
