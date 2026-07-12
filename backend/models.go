/*
 * File: models.go
 * Desc: Defines the tournament, player, match, template, and resolved-view JSON shapes.
 * Deps: Go encoding-json.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import "encoding/json"

// TournamentState is the JSON document used by the app and OBS overlays.
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
	Error      string                   `json:"error,omitempty"`
}

// BracketSettings stores admin choices that affect bracket overlays.
type BracketSettings struct {
	OverlayView     string                 `json:"overlay_view,omitempty"`
	ManagerView     string                 `json:"manager_view,omitempty"`
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
