/*
 * File: bracket_test.go
 * Desc: Verifies BYE propagation and validates every bundled bracket template.
 * Deps: Go strconv/testing.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"strconv"
	"testing"
)

// TestApplyByeAdvancement verifies a real player advances through a seeded BYE.
func TestApplyByeAdvancement(t *testing.T) {
	state := TournamentState{
		Event: EventInfo{Rule: 3, Format: "single_elimination", Size: 2},
		Players: map[string]Player{
			"1": {Name: "Ready"},
			"2": {},
		},
		Matches: map[string]MatchState{},
		Bracket: BracketSettings{Byes: map[string]bool{"2": true}},
	}
	template := BracketTemplate{
		Type: "single_elimination",
		Size: 2,
		Matches: map[string]TemplateMatch{
			"A": {
				Player1: TemplateParticipant{Type: "seed", Seed: 1},
				Player2: TemplateParticipant{Type: "seed", Seed: 2},
			},
		},
	}

	applyByeAdvancement(&state, template)
	result := state.Matches["A"]
	if result.Winner != "1" || result.Loser != "2" || result.Reason != matchReasonBye {
		t.Fatalf("unexpected BYE result: %#v", result)
	}
}

// TestBundledBracketTemplates validates references and participant sources in every configured template.
func TestBundledBracketTemplates(t *testing.T) {
	app := NewApp()
	formats, err := app.readCatalogOptions("formats.json")
	if err != nil {
		t.Fatalf("read formats: %v", err)
	}
	sizes, err := app.readCatalogOptions("sizes.json")
	if err != nil {
		t.Fatalf("read sizes: %v", err)
	}

	for _, format := range formats {
		for _, sizeOption := range sizes {
			size, err := strconv.Atoi(sizeOption.Key)
			if err != nil {
				t.Fatalf("invalid configured size %q", sizeOption.Key)
			}
			name := templateFileName(format.Key, size)
			t.Run(name, func(t *testing.T) {
				template, err := loadBracketTemplate(format.Key, size)
				if err != nil {
					t.Fatalf("load template: %v", err)
				}
				validateBracketTemplate(t, template)
			})
		}
	}
}

// validateBracketTemplate checks references that would otherwise fail only during a live event.
func validateBracketTemplate(t *testing.T, template BracketTemplate) {
	t.Helper()
	orders := map[int]string{}
	for matchID, match := range template.Matches {
		if match.Order <= 0 {
			t.Errorf("match %s has invalid order %d", matchID, match.Order)
		}
		if previous := orders[match.Order]; previous != "" {
			t.Errorf("matches %s and %s share order %d", previous, matchID, match.Order)
		}
		orders[match.Order] = matchID

		validateTemplateParticipant(t, template, matchID, match.Player1)
		validateTemplateParticipant(t, template, matchID, match.Player2)
		for label, target := range map[string]string{"winner_to": match.WinnerTo, "loser_to": match.LoserTo} {
			if target != "" {
				if _, exists := template.Matches[target]; !exists {
					t.Errorf("match %s %s references missing match %s", matchID, label, target)
				}
			}
		}
	}
}

// validateTemplateParticipant checks one seed/winner/loser source against its template.
func validateTemplateParticipant(t *testing.T, template BracketTemplate, matchID string, participant TemplateParticipant) {
	t.Helper()
	switch participant.Type {
	case "seed":
		if participant.Seed < 1 || participant.Seed > template.Size {
			t.Errorf("match %s seed %d is outside size %d", matchID, participant.Seed, template.Size)
		}
	case "winner", "loser":
		if _, exists := template.Matches[participant.Match]; !exists {
			t.Errorf("match %s references missing source %s", matchID, participant.Match)
		}
	default:
		t.Errorf("match %s has unknown participant type %q", matchID, participant.Type)
	}
}
