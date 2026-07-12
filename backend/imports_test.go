/*
 * File: imports_test.go
 * Desc: Tests start.gg URL parsing, payload normalization, and the opt-in live preview.
 * Deps: Go encoding-json/net-url/os/strings/testing.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"encoding/json"
	"net/url"
	"os"
	"strings"
	"testing"
)

const blinkRespawnStartGGURL = "https://www.start.gg/tournament/blink-respawn-2026/event/street-fighter-6-capcom-pro-tour-offline-premier-event/overview"

// TestStartGGEventSlug verifies overview URLs resolve to the GraphQL event slug.
func TestStartGGEventSlug(t *testing.T) {
	parsed, err := url.Parse(blinkRespawnStartGGURL)
	if err != nil {
		t.Fatal(err)
	}
	want := "tournament/blink-respawn-2026/event/street-fighter-6-capcom-pro-tour-offline-premier-event"
	got, err := startGGEventSlug(parsed)
	if err != nil {
		t.Fatalf("extract slug: %v", err)
	}
	if got != want {
		t.Fatalf("slug = %q, want %q", got, want)
	}
}

// TestStartGGLivePreview checks the real import path against the official Blink Respawn SF6 event.
func TestStartGGLivePreview(t *testing.T) {
	if os.Getenv("STREAM_FGC_STARTGG_LIVE_TEST") == "" {
		t.Skip("set STREAM_FGC_STARTGG_LIVE_TEST=1 to run the live start.gg import test")
	}

	preview, err := NewApp().PreviewTournamentImport(blinkRespawnStartGGURL)
	if err != nil {
		t.Fatalf("preview official start.gg event: %v", err)
	}
	if preview.Provider != "startgg" {
		t.Errorf("provider = %q, want startgg", preview.Provider)
	}
	if strings.TrimSpace(preview.Event.Name) == "" {
		t.Error("imported event name is empty")
	}
	if strings.TrimSpace(preview.Event.Game) == "" {
		t.Error("imported game is empty")
	}
	if len(preview.Players) == 0 {
		t.Error("start.gg returned no players")
	}
}

// TestStartGGScalars verifies provider IDs and integers accept string, number, and null payloads.
func TestStartGGScalars(t *testing.T) {
	for _, test := range []struct {
		json string
		want string
	}{
		{json: `"123"`, want: "123"},
		{json: `456`, want: "456"},
		{json: `null`, want: ""},
	} {
		var id startGGID
		if err := json.Unmarshal([]byte(test.json), &id); err != nil {
			t.Fatalf("unmarshal ID %s: %v", test.json, err)
		}
		if id.String() != test.want {
			t.Errorf("ID from %s = %q, want %q", test.json, id.String(), test.want)
		}
	}
}

// TestImportedCountryAliases verifies provider names are data-driven and resolve to available ISO2 flags.
func TestImportedCountryAliases(t *testing.T) {
	aliases := readImportedCountryAliases(NewApp())
	for country, want := range map[string]string{
		"Colombia":           "CO",
		"Dominican Republic": "DO",
		"United States":      "US",
		"Puerto Rico":        "PR",
	} {
		if got := normalizeImportedCountry(country, aliases); got != want {
			t.Errorf("country %q = %q, want %q", country, got, want)
		}
	}
}
