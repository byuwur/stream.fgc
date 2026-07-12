/*
 * File: tournament_test.go
 * Desc: Documents tournament normalization and backwards-compatible event rules.
 * Deps: Go encoding-json/testing.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"encoding/json"
	"testing"
)

// TestEventInfoUnmarshalLegacyRules verifies old FT labels still migrate to numeric rules.
func TestEventInfoUnmarshalLegacyRules(t *testing.T) {
	for _, test := range []struct {
		json string
		want int
	}{
		{json: `{"rule":"FT3"}`, want: 3},
		{json: `{"rule":"ft5"}`, want: 5},
		{json: `{"rule":2}`, want: 2},
		{json: `{"rule":"invalid"}`, want: 3},
	} {
		var event EventInfo
		if err := json.Unmarshal([]byte(test.json), &event); err != nil {
			t.Fatalf("unmarshal %s: %v", test.json, err)
		}
		if event.Rule != test.want {
			t.Errorf("rule from %s = %d, want %d", test.json, event.Rule, test.want)
		}
	}
}

// TestNormalizeTournamentStateKeepsTheConfiguredShape verifies size, scores, and derived fields stay clean.
func TestNormalizeTournamentStateKeepsTheConfiguredShape(t *testing.T) {
	state := TournamentState{
		Event: EventInfo{Rule: 2, Format: "double_elimination", Size: 2},
		Players: map[string]Player{
			"1": {Name: "One", Portrait: "legacy.png"},
			"3": {Name: "Outside"},
		},
		Matches: map[string]MatchState{"A": {Player1Score: -1, Player2Score: 8}},
	}

	got := normalizeTournamentState(state)
	if len(got.Players) != 2 {
		t.Fatalf("player slots = %d, want 2", len(got.Players))
	}
	if _, exists := got.Players["3"]; exists {
		t.Fatal("player outside event size was not removed")
	}
	if got.Players["1"].Portrait != "" {
		t.Fatal("derived portrait path remained in tournament state")
	}
	if got.Matches["A"].Player1Score != 0 || got.Matches["A"].Player2Score != 2 {
		t.Fatalf("scores were not clamped: %#v", got.Matches["A"])
	}
}

// TestMigrateTournamentState centralizes legacy format and match-map compatibility.
func TestMigrateTournamentState(t *testing.T) {
	state := migrateTournamentState(TournamentState{
		Event:   EventInfo{Format: "round_robin"},
		Bracket: BracketSettings{Matches: map[string]MatchState{"A": {Winner: "1"}}},
	})
	if state.Version != currentTournamentVersion || state.Event.Format != "robin" {
		t.Fatalf("migration did not normalize version/format: %#v", state)
	}
	if state.Matches["A"].Winner != "1" || state.Bracket.Matches != nil {
		t.Fatalf("migration did not move legacy matches: %#v", state.Bracket)
	}
}
