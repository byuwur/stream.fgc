/*
 * File: imports_startgg.go
 * Desc: Implements start.gg URL parsing, GraphQL transport, and provider-to-local mapping.
 * Deps: Go bytes/context/encoding-json/fmt/net-http/net-url/os/strconv/strings/time.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	startGGGraphQLEndpoint = "https://api.start.gg/gql/alpha"
	importHTTPTimeout      = 30 * time.Second
	startGGImportQuery     = `
query StreamFGCImport($slug: String!) {
  event(slug: $slug) {
    id
    name
    numEntrants
    tournament { name }
    videogame { name displayName }
    entrants(query: { page: 1, perPage: 512 }) {
      nodes {
        id
        name
        participants {
          gamerTag
          prefix
          user { location { country } }
        }
      }
    }
    sets(page: 1, perPage: 256, sortType: STANDARD) {
      nodes {
        id
        fullRoundText
        state
        winnerId
        slots {
          entrant { id name }
          standing { stats { score { value } } }
        }
      }
    }
  }
}`
)

type startGGImportProvider struct{}

type startGGGraphQLRequest struct {
	Query     string            `json:"query"`
	Variables map[string]string `json:"variables"`
}

type startGGGraphQLResponse struct {
	Data   startGGGraphQLData    `json:"data"`
	Errors []startGGGraphQLError `json:"errors"`
}

type startGGGraphQLData struct {
	Event *startGGEvent `json:"event"`
}

type startGGGraphQLError struct {
	Message string `json:"message"`
}

type startGGID string
type startGGInt int

// UnmarshalJSON accepts GraphQL ID values as strings or numbers.
func (id *startGGID) UnmarshalJSON(data []byte) error {
	value, ok := decodeStartGGScalar(data)
	if !ok {
		return fmt.Errorf("start.gg id must be a string or number")
	}
	*id = startGGID(value)
	return nil
}

// String returns the normalized provider ID.
func (id startGGID) String() string {
	return strings.TrimSpace(string(id))
}

// UnmarshalJSON accepts numeric start.gg fields as numbers, strings, or null.
func (value *startGGInt) UnmarshalJSON(data []byte) error {
	text, ok := decodeStartGGScalar(data)
	if !ok {
		return fmt.Errorf("start.gg number must be a string or number")
	}
	if text == "" {
		*value = 0
		return nil
	}
	number, err := strconv.Atoi(text)
	if err != nil {
		return err
	}
	*value = startGGInt(number)
	return nil
}

// Int returns the parsed provider integer.
func (value startGGInt) Int() int {
	return int(value)
}

// String returns the provider integer as display-safe text.
func (value startGGInt) String() string {
	return strconv.Itoa(value.Int())
}

// decodeStartGGScalar accepts null, string, and number GraphQL scalar values.
func decodeStartGGScalar(data []byte) (string, bool) {
	raw := strings.TrimSpace(string(data))
	if raw == "" || raw == "null" {
		return "", true
	}
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		return strings.TrimSpace(text), true
	}
	var number json.Number
	if err := json.Unmarshal(data, &number); err == nil {
		return number.String(), true
	}
	return "", false
}

type startGGEvent struct {
	ID          startGGID            `json:"id"`
	Name        string               `json:"name"`
	NumEntrants startGGInt           `json:"numEntrants"`
	Tournament  startGGTournament    `json:"tournament"`
	Videogame   startGGVideogame     `json:"videogame"`
	Entrants    startGGEntrantPage   `json:"entrants"`
	Sets        startGGSetConnection `json:"sets"`
}

type startGGTournament struct {
	Name string `json:"name"`
}
type startGGVideogame struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
}
type startGGEntrantPage struct {
	Nodes []startGGEntrant `json:"nodes"`
}
type startGGEntrant struct {
	ID           startGGID            `json:"id"`
	Name         string               `json:"name"`
	Participants []startGGParticipant `json:"participants"`
}
type startGGParticipant struct {
	GamerTag string      `json:"gamerTag"`
	Prefix   string      `json:"prefix"`
	User     startGGUser `json:"user"`
}
type startGGUser struct {
	Location startGGLocation `json:"location"`
}
type startGGLocation struct {
	Country string `json:"country"`
}
type startGGSetConnection struct {
	Nodes []startGGSet `json:"nodes"`
}
type startGGSet struct {
	ID            startGGID     `json:"id"`
	FullRoundText string        `json:"fullRoundText"`
	State         startGGInt    `json:"state"`
	WinnerID      startGGID     `json:"winnerId"`
	Slots         []startGGSlot `json:"slots"`
}
type startGGSlot struct {
	Entrant  startGGEntrant  `json:"entrant"`
	Standing startGGStanding `json:"standing"`
}
type startGGStanding struct {
	Stats startGGStats `json:"stats"`
}
type startGGStats struct {
	Score startGGScore `json:"score"`
}
type startGGScore struct {
	Value startGGInt `json:"value"`
}

// key returns the start.gg provider key.
func (provider startGGImportProvider) key() string { return "startgg" }

// name returns the operator-facing provider name.
func (provider startGGImportProvider) name() string { return "start.gg" }

// canHandle recognizes start.gg and legacy smash.gg links.
func (provider startGGImportProvider) canHandle(parsedURL *url.URL) bool {
	host := strings.ToLower(parsedURL.Hostname())
	return strings.Contains(host, "start.gg") || strings.Contains(host, "smash.gg")
}

// preview loads event metadata, entrants, and sets from the start.gg GraphQL API.
func (provider startGGImportProvider) preview(app *App, rawURL string, parsedURL *url.URL) (ExternalTournament, error) {
	slug, err := startGGEventSlug(parsedURL)
	if err != nil {
		return ExternalTournament{Provider: provider.key(), ProviderName: provider.name(), URL: rawURL}, err
	}
	token := startGGAPIToken(app)
	if token == "" {
		return ExternalTournament{Provider: provider.key(), ProviderName: provider.name(), URL: rawURL}, fmt.Errorf("start.gg API key missing; save it on the Import page")
	}
	event, err := fetchStartGGEvent(slug, token)
	if err != nil {
		return ExternalTournament{Provider: provider.key(), ProviderName: provider.name(), URL: rawURL}, err
	}
	return startGGExternalTournament(app, rawURL, slug, event), nil
}

// startGGEventSlug extracts tournament/.../event/... from a start.gg URL.
func startGGEventSlug(parsedURL *url.URL) (string, error) {
	parts := startGGPathSegments(parsedURL)
	for index := 0; index+3 < len(parts); index++ {
		if strings.EqualFold(parts[index], "tournament") && strings.EqualFold(parts[index+2], "event") {
			tournamentSlug := strings.TrimSpace(parts[index+1])
			eventSlug := strings.TrimSpace(parts[index+3])
			if tournamentSlug != "" && eventSlug != "" {
				return "tournament/" + tournamentSlug + "/event/" + eventSlug, nil
			}
		}
	}
	return "", fmt.Errorf("start.gg event links must include /tournament/{tournament}/event/{event}; received path %q", parsedURL.EscapedPath())
}

// startGGPathSegments returns decoded, non-empty URL path segments for slug matching.
func startGGPathSegments(parsedURL *url.URL) []string {
	rawPath := parsedURL.EscapedPath()
	if rawPath == "" {
		rawPath = parsedURL.Path
	}
	parts := []string{}
	for _, rawPart := range strings.Split(strings.Trim(rawPath, "/"), "/") {
		if rawPart = strings.TrimSpace(rawPart); rawPart == "" {
			continue
		}
		part, err := url.PathUnescape(rawPart)
		if err != nil {
			part = rawPart
		}
		if part = strings.TrimSpace(part); part != "" {
			parts = append(parts, part)
		}
	}
	return parts
}

// startGGAPIToken reads a local API token from environment or saved Import page settings.
func startGGAPIToken(app *App) string {
	for _, key := range []string{"STARTGG_TOKEN", "START_GG_TOKEN", "STARTGG_API_TOKEN"} {
		if token := strings.TrimSpace(os.Getenv(key)); token != "" {
			return token
		}
	}
	if app != nil {
		settings, err := app.LoadImportIntegrations()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(settings.StartGG.APIKey)
	}
	settings, _ := readImportIntegrations()
	return strings.TrimSpace(settings.StartGG.APIKey)
}

// fetchStartGGEvent sends the GraphQL request used by the import preview.
func fetchStartGGEvent(slug string, token string) (startGGEvent, error) {
	body, err := json.Marshal(startGGGraphQLRequest{
		Query:     startGGImportQuery,
		Variables: map[string]string{"slug": slug},
	})
	if err != nil {
		return startGGEvent{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), importHTTPTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, startGGGraphQLEndpoint, bytes.NewReader(body))
	if err != nil {
		return startGGEvent{}, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "Stream.FGC")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return startGGEvent{}, err
	}
	defer response.Body.Close()

	var graphResponse startGGGraphQLResponse
	if err := json.NewDecoder(response.Body).Decode(&graphResponse); err != nil {
		return startGGEvent{}, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return startGGEvent{}, fmt.Errorf("start.gg returned HTTP %d", response.StatusCode)
	}
	if len(graphResponse.Errors) > 0 {
		return startGGEvent{}, fmt.Errorf("start.gg: %s", graphResponse.Errors[0].Message)
	}
	if graphResponse.Data.Event == nil {
		return startGGEvent{}, fmt.Errorf("start.gg event not found")
	}
	return *graphResponse.Data.Event, nil
}

// startGGExternalTournament converts the GraphQL event into provider-neutral import data.
func startGGExternalTournament(app *App, rawURL string, slug string, event startGGEvent) ExternalTournament {
	countryAliases := readImportedCountryAliases(app)
	players := make([]ExternalPlayer, 0, len(event.Entrants.Nodes))
	for index, entrant := range event.Entrants.Nodes {
		player := startGGExternalPlayer(entrant, countryAliases)
		if player.Seed <= 0 {
			player.Seed = index + 1
		}
		players = append(players, player)
	}
	matches := make([]ExternalMatch, 0, len(event.Sets.Nodes))
	for index, set := range event.Sets.Nodes {
		matches = append(matches, startGGExternalMatch(index+1, set))
	}

	game := firstNonEmpty(event.Videogame.DisplayName, event.Videogame.Name)
	if app != nil && game != "" {
		if key, err := app.resolveGameKey(game); err == nil && key != "" {
			game = key
		}
	}
	return ExternalTournament{
		Provider:     "startgg",
		ProviderName: "start.gg",
		URL:          rawURL,
		Event: EventInfo{
			Name:  firstNonEmpty(event.Tournament.Name, event.Name, "Imported Tournament"),
			Phase: event.Name,
			Rule:  defaultEventRuleForImport(),
			Game:  game,
			Size:  bestTournamentSizeForPlayerCount(len(players)),
		},
		Players:  players,
		Matches:  matches,
		Warnings: startGGImportWarnings(event, len(players)),
		Meta:     map[string]string{"slug": slug, "event_id": event.ID.String()},
	}
}

// startGGExternalPlayer converts one entrant into one player slot.
func startGGExternalPlayer(entrant startGGEntrant, countryAliases map[string]string) ExternalPlayer {
	player := ExternalPlayer{
		ExternalID: entrant.ID.String(),
		Name:       strings.TrimSpace(entrant.Name),
	}
	if len(entrant.Participants) > 0 {
		participant := entrant.Participants[0]
		player.Name = firstNonEmpty(participant.GamerTag, entrant.Name)
		player.Team = strings.TrimSpace(participant.Prefix)
		player.Country = normalizeImportedCountry(participant.User.Location.Country, countryAliases)
	}
	return player
}

// startGGExternalMatch converts one start.gg set into one provider-neutral match preview.
func startGGExternalMatch(order int, set startGGSet) ExternalMatch {
	match := ExternalMatch{
		ExternalID:    set.ID.String(),
		Round:         strings.TrimSpace(set.FullRoundText),
		Order:         order,
		WinnerID:      set.WinnerID.String(),
		ProviderState: set.State.String(),
	}
	if len(set.Slots) > 0 {
		match.Player1ID = set.Slots[0].Entrant.ID.String()
		match.Player1Score = set.Slots[0].Standing.Stats.Score.Value.Int()
	}
	if len(set.Slots) > 1 {
		match.Player2ID = set.Slots[1].Entrant.ID.String()
		match.Player2Score = set.Slots[1].Standing.Stats.Score.Value.Int()
	}
	return match
}

// startGGImportWarnings returns operator-facing warnings for partial provider data.
func startGGImportWarnings(event startGGEvent, playerCount int) []string {
	warnings := []string{}
	if event.NumEntrants.Int() > playerCount {
		warnings = append(warnings, fmt.Sprintf("start.gg returned %d of %d entrants on the first page.", playerCount, event.NumEntrants.Int()))
	}
	if playerCount > maxConfiguredTournamentSize() {
		warnings = append(warnings, fmt.Sprintf("Only the first %d players can be imported with the current size catalog.", maxConfiguredTournamentSize()))
	}
	if len(event.Sets.Nodes) > 0 {
		warnings = append(warnings, "Provider matches are shown for preview only; Stream.FGC imports event and player slots for now.")
	}
	return warnings
}
