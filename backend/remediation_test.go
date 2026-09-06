// Tournament transition regressions use isolated files and shared overlay fixtures.
package backend

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
)

// TestParticipantResolutionFixtures shares BYE provenance cases with the overlay runtime.
func TestParticipantResolutionFixtures(t *testing.T) {
	data, err := os.ReadFile("testdata/participant-resolution.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string
		Source   TemplateParticipant
		State    TournamentState
		Status   string
		PlayerID string `json:"player_id"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			got := resolveParticipant(tc.Source, tc.State)
			if got.Status != tc.Status || got.PlayerID != tc.PlayerID {
				t.Fatalf("got %#v", got)
			}
		})
	}
}

// tournamentTestApp isolates public mutation tests from the operator's saved tournament.
func tournamentTestApp(t *testing.T) *App {
	t.Helper()
	template, err := loadBracketTemplate("double_elimination", 4)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	sizes, err := os.ReadFile(externalFilePaths(assetDirPath, "sizes.json")[0])
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	if err := os.MkdirAll("assets", 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("assets/sizes.json", sizes, 0644); err != nil {
		t.Fatal(err)
	}
	oldMode := externalPathMode
	externalPathMode = externalPathModeDev
	t.Cleanup(func() { externalPathMode = oldMode })
	if err := os.MkdirAll("templates", 0755); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(template)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join("templates", "double4.json"), data, 0644); err != nil {
		t.Fatal(err)
	}
	state := defaultTournamentState()
	state.Event.Format = "double_elimination"
	state.Event.Size = 4
	state.Matches = map[string]MatchState{}
	for i := 1; i <= 4; i++ {
		state.Players[strconv.Itoa(i)] = Player{Name: strconv.Itoa(i)}
	}
	app := NewApp()
	if _, err := app.saveTournamentLocked(state); err != nil {
		t.Fatal(err)
	}
	return app
}

// TestPublicByeLoserPropagation checks each opening side and undo through the disk-backed API.
func TestPublicByeLoserPropagation(t *testing.T) {
	for _, side := range []int{1, 2} {
		t.Run(strconv.Itoa(side), func(t *testing.T) {
			app := tournamentTestApp(t)
			if _, err := app.SetMatchWinner("B", "3"); err != nil {
				t.Fatal(err)
			}
			state, err := app.SetMatchParticipantBye("A", side, true)
			if err != nil {
				t.Fatal(err)
			}
			if state.Matches["D"].Winner != "4" || state.Matches["D"].Reason != "bye" {
				t.Fatalf("losers match: %#v", state.Matches["D"])
			}
			if state.Players[strconv.Itoa(side)].Bye {
				t.Fatal("slot BYE changed player")
			}
			state, err = app.SetMatchParticipantBye("A", side, false)
			if err != nil {
				t.Fatal(err)
			}
			if state.Matches["D"].Winner != "" || state.Matches["B"].Winner != "3" {
				t.Fatal("undo left generated history or erased real result")
			}
		})
	}
}

// TestCorrectionsPreserveHistory verifies rejected edits leave the saved document unchanged.
func TestCorrectionsPreserveHistory(t *testing.T) {
	app := tournamentTestApp(t)
	for id, winner := range map[string]string{"A": "1", "B": "3"} {
		if _, err := app.SetMatchWinner(id, winner); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := app.UpdateMatchScore("C", 1, 0); err != nil {
		t.Fatal(err)
	}
	before, err := app.SetMatchWinner("C", "1")
	if err != nil {
		t.Fatal(err)
	}
	for _, winner := range []string{"2", ""} {
		if _, err := app.SetMatchWinner("A", winner); err == nil {
			t.Fatal("accepted incompatible correction")
		}
		got, err := app.LoadTournament()
		if err != nil || !reflect.DeepEqual(before, got) {
			t.Fatal("rejection mutated state", err)
		}
	}
	if _, err := app.SetMatchWinner("C", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := app.SetMatchWinner("A", "2"); err == nil {
		t.Fatal("retained dependent score")
	}
	if _, err := app.UpdateMatchScore("C", 0, 0); err != nil {
		t.Fatal(err)
	}
	state, err := app.SetMatchWinner("A", "2")
	if err != nil || state.Matches["B"].Winner != "3" {
		t.Fatal("correction damaged unrelated branch", err)
	}
}

// TestCorrectionLoserDescendants guards scores reached through immediate and later loser edges.
func TestCorrectionLoserDescendants(t *testing.T) {
	for _, descendant := range []string{"D", "E"} {
		t.Run(descendant, func(t *testing.T) {
			app := tournamentTestApp(t)
			if _, err := app.SetMatchWinner("A", "1"); err != nil {
				t.Fatal(err)
			}
			before, err := app.UpdateMatchScore(descendant, 1, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := app.SetMatchWinner("A", "2"); err == nil {
				t.Fatal("accepted correction with dependent score")
			}
			after, err := app.LoadTournament()
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatal("rejection mutated state", err)
			}
		})
	}
}

// TestWinnerAfterByeAndRepeatedToggle protects correction recalculation's upstream dependencies.
func TestWinnerAfterByeAndRepeatedToggle(t *testing.T) {
	app := tournamentTestApp(t)
	if _, err := app.SetMatchParticipantBye("A", 2, true); err != nil {
		t.Fatal(err)
	}
	if _, err := app.SetMatchWinner("B", "3"); err != nil {
		t.Fatal(err)
	}
	before, err := app.SetMatchWinner("C", "1")
	if err != nil {
		t.Fatal("BYE upstream became pending", err)
	}
	if _, err := app.SetMatchParticipantBye("B", 1, false); err != nil {
		t.Fatal(err)
	}
	after, err := app.LoadTournament()
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("no-op BYE toggle erased real history", err)
	}
}

// TestReconfigurationHistory verifies setup changes reject history while display swaps remain allowed.
func TestReconfigurationHistory(t *testing.T) {
	app := tournamentTestApp(t)
	for _, event := range []EventInfo{{Format: "single_elimination", Size: 4}, {Format: "double_elimination", Size: 4}} {
		if _, err := app.UpdateEvent(event); err != nil {
			t.Fatal("unplayed reconfiguration rejected", err)
		}
	}
	if _, err := app.SwapBracketSeeds(1, 2); err != nil {
		t.Fatal(err)
	}
	before, err := app.SetMatchWinner("A", "1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.SwapBracketSeeds(1, 2); err == nil {
		t.Fatal("accepted seed swap with history")
	}
	for _, event := range []EventInfo{{Format: "single_elimination", Size: 4}, {Format: "double_elimination", Size: 8}} {
		if _, err := app.UpdateEvent(event); err == nil {
			t.Fatal("accepted topology change with history")
		}
	}
	got, err := app.LoadTournament()
	if err != nil || !reflect.DeepEqual(before, got) {
		t.Fatal("reconfiguration rejection mutated state", err)
	}
	got, err = app.SwapMatchSides("A")
	if err != nil || got.Matches["A"].Winner != "1" {
		t.Fatal("display swap changed result", err)
	}
}
