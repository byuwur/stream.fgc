/*
 * File: imports_test.go
 * Desc: Documents URL, scalar, and country normalization used by tournament imports.
 * Deps: Go encoding-json/net-url/testing.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"encoding/json"
	"net/url"
	"testing"
)

// TestStartGGEventSlug verifies overview URLs resolve to the GraphQL event slug.
func TestStartGGEventSlug(t *testing.T) {
	parsed, err := url.Parse("https://www.start.gg/tournament/blink-respawn-2026/event/street-fighter-6-capcom-pro-tour-offline-premier-event/overview")
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
