/*
 * File: imports.go
 * Desc: Imports tournament data from external bracket providers into Stream.FGC state.
 * Deps: Go bytes/context/encoding-json/fmt/net-http/net-url/os/sort/strconv/strings/time.
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
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	startGGGraphQLEndpoint = "https://api.start.gg/gql/alpha"
	importHTTPTimeout      = 30 * time.Second
	integrationsJSONFile   = "integrations.json"
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
  }
}`
)

// ExternalTournament is a provider-neutral preview before data enters tournament.json.
type ExternalTournament struct {
	Provider     string            `json:"provider"`
	ProviderName string            `json:"provider_name"`
	URL          string            `json:"url"`
	Event        EventInfo         `json:"event"`
	Players      []ExternalPlayer  `json:"players"`
	Matches      []ExternalMatch   `json:"matches"`
	Warnings     []string          `json:"warnings,omitempty"`
	Meta         map[string]string `json:"meta,omitempty"`
}

// ExternalPlayer is one imported entrant normalized across providers.
type ExternalPlayer struct {
	ExternalID string `json:"external_id"`
	Seed       int    `json:"seed"`
	Name       string `json:"name"`
	Team       string `json:"team"`
	Country    string `json:"country"`
}

// ExternalMatch is one imported provider match kept for preview and future sync logic.
type ExternalMatch struct {
	ExternalID    string `json:"external_id"`
	Round         string `json:"round"`
	Order         int    `json:"order"`
	Player1ID     string `json:"player1_id"`
	Player2ID     string `json:"player2_id"`
	Player1Score  int    `json:"player1_score"`
	Player2Score  int    `json:"player2_score"`
	WinnerID      string `json:"winner_id"`
	ProviderState string `json:"provider_state"`
}

// ImportIntegrations stores local API keys for external tournament providers.
type ImportIntegrations struct {
	StartGG ImportProviderIntegration `json:"startgg"`
}

// ImportProviderIntegration stores one provider credential block.
type ImportProviderIntegration struct {
	APIKey string `json:"api_key"`
}

type tournamentImportProvider interface {
	key() string
	name() string
	canHandle(parsedURL *url.URL) bool
	preview(app *App, rawURL string, parsedURL *url.URL) (ExternalTournament, error)
}

type unsupportedImportProvider struct {
	providerKey  string
	providerName string
}

type startGGImportProvider struct{}

var importedCountryAliasCodes = map[string]string{
	"argentina":                "AR",
	"australia":                "AU",
	"austria":                  "AT",
	"belgium":                  "BE",
	"brazil":                   "BR",
	"canada":                   "CA",
	"chile":                    "CL",
	"china":                    "CN",
	"colombia":                 "CO",
	"costarica":                "CR",
	"denmark":                  "DK",
	"dominicanrepublic":        "DO",
	"ecuador":                  "EC",
	"elsalvador":               "SV",
	"england":                  "GB",
	"finland":                  "FI",
	"france":                   "FR",
	"germany":                  "DE",
	"greatbritain":             "GB",
	"guatemala":                "GT",
	"hongkong":                 "HK",
	"honduras":                 "HN",
	"indonesia":                "ID",
	"ireland":                  "IE",
	"italy":                    "IT",
	"japan":                    "JP",
	"korea":                    "KR",
	"malaysia":                 "MY",
	"mexico":                   "MX",
	"netherlands":              "NL",
	"newzealand":               "NZ",
	"nicaragua":                "NI",
	"norway":                   "NO",
	"panama":                   "PA",
	"peru":                     "PE",
	"philippines":              "PH",
	"poland":                   "PL",
	"portugal":                 "PT",
	"puertorico":               "PR",
	"scotland":                 "GB",
	"singapore":                "SG",
	"southkorea":               "KR",
	"spain":                    "ES",
	"sweden":                   "SE",
	"switzerland":              "CH",
	"taiwan":                   "TW",
	"thailand":                 "TH",
	"trinidadandtobago":        "TT",
	"uk":                       "GB",
	"unitedkingdom":            "GB",
	"unitedstates":             "US",
	"unitedstatesofamerica":    "US",
	"us":                       "US",
	"usa":                      "US",
	"venezuela":                "VE",
	"vietnam":                  "VN",
	"vietnamsocialistrepublic": "VN",
}

type startGGGraphQLRequest struct {
	Query     string                 `json:"query"`
	Variables map[string]interface{} `json:"variables"`
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
	raw := strings.TrimSpace(string(data))
	if raw == "" || raw == "null" {
		*id = ""
		return nil
	}

	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		*id = startGGID(strings.TrimSpace(text))
		return nil
	}

	var number json.Number
	if err := json.Unmarshal(data, &number); err == nil {
		*id = startGGID(number.String())
		return nil
	}

	return fmt.Errorf("start.gg id must be a string or number")
}

// String returns the normalized provider ID.
func (id startGGID) String() string {
	return strings.TrimSpace(string(id))
}

// UnmarshalJSON accepts numeric start.gg fields as numbers, strings, or null.
func (value *startGGInt) UnmarshalJSON(data []byte) error {
	raw := strings.TrimSpace(string(data))
	if raw == "" || raw == "null" {
		*value = 0
		return nil
	}

	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		text = strings.TrimSpace(text)
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

	var number json.Number
	if err := json.Unmarshal(data, &number); err == nil {
		integer, err := strconv.Atoi(number.String())
		if err != nil {
			return err
		}
		*value = startGGInt(integer)
		return nil
	}

	return fmt.Errorf("start.gg number must be a string or number")
}

// Int returns the parsed provider integer.
func (value startGGInt) Int() int {
	return int(value)
}

// String returns the provider integer as display-safe text.
func (value startGGInt) String() string {
	return strconv.Itoa(value.Int())
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

// PreviewTournamentImport fetches provider data and returns a safe import preview.
func (a *App) PreviewTournamentImport(rawURL string) (ExternalTournament, error) {
	normalizedURL, parsedURL, err := normalizeImportURL(rawURL)
	if err != nil {
		return ExternalTournament{}, err
	}

	// Providers are selected by URL shape so the frontend only needs one import form.
	provider, ok := detectTournamentImportProvider(parsedURL)
	if !ok {
		return ExternalTournament{}, fmt.Errorf("unsupported tournament link")
	}

	preview, err := provider.preview(a, normalizedURL, parsedURL)
	if err != nil {
		return preview, err
	}
	preview.URL = normalizedURL
	preview.Provider = provider.key()
	preview.ProviderName = provider.name()
	// Normalize after provider mapping so every preview returns a safe event shape.
	normalizeExternalTournamentPreview(&preview)
	return preview, nil
}

// ImportTournamentLink imports provider event data and player slots into tournament.json.
func (a *App) ImportTournamentLink(rawURL string) (TournamentState, error) {
	preview, err := a.PreviewTournamentImport(rawURL)
	if err != nil {
		a.mu.Lock()
		defer a.mu.Unlock()
		return cloneTournamentState(a.state), err
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	current := a.loadTournamentLocked()
	// Import currently replaces event/player setup while preserving reusable app settings.
	imported := tournamentStateFromExternal(current, preview)
	return a.saveTournamentLocked(imported)
}

// LoadImportIntegrations reads saved provider API keys for the import page.
func (a *App) LoadImportIntegrations() ImportIntegrations {
	a.mu.Lock()
	defer a.mu.Unlock()

	settings, _ := readImportIntegrations()
	return settings
}

// SaveImportIntegrations persists provider API keys through the Go filesystem boundary.
func (a *App) SaveImportIntegrations(settings ImportIntegrations) (ImportIntegrations, error) {
	settings = normalizeImportIntegrations(settings)

	a.mu.Lock()
	defer a.mu.Unlock()

	if err := writeImportIntegrations(settings); err != nil {
		return settings, err
	}
	return settings, nil
}

// normalizeImportURL trims and parses a user-provided tournament URL.
func normalizeImportURL(rawURL string) (string, *url.URL, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return "", nil, fmt.Errorf("tournament link is required")
	}
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		return "", nil, err
	}
	if parsedURL.Scheme == "" {
		// Operators often paste "start.gg/..." without a scheme; make it explicit.
		rawURL = "https://" + rawURL
		parsedURL, err = url.Parse(rawURL)
		if err != nil {
			return "", nil, err
		}
	}
	if parsedURL.Host == "" {
		return "", nil, fmt.Errorf("tournament link must include a host")
	}
	// Fragments are browser-only state and should not affect provider detection/cache keys.
	parsedURL.Fragment = ""
	return parsedURL.String(), parsedURL, nil
}

// detectTournamentImportProvider chooses the first provider that recognizes the URL.
func detectTournamentImportProvider(parsedURL *url.URL) (tournamentImportProvider, bool) {
	providers := []tournamentImportProvider{
		startGGImportProvider{},
		// Keep planned providers detectable so the UI can return useful "not implemented" errors.
		unsupportedImportProvider{providerKey: "challonge", providerName: "Challonge"},
		unsupportedImportProvider{providerKey: "tonamel", providerName: "Tonamel"},
		unsupportedImportProvider{providerKey: "parry", providerName: "Parry.gg"},
	}
	for _, provider := range providers {
		if provider.canHandle(parsedURL) {
			return provider, true
		}
	}
	return nil, false
}

// key returns the normalized provider key.
func (provider unsupportedImportProvider) key() string {
	return provider.providerKey
}

// name returns the operator-facing provider name.
func (provider unsupportedImportProvider) name() string {
	return provider.providerName
}

// canHandle recognizes providers that are planned but not implemented yet.
func (provider unsupportedImportProvider) canHandle(parsedURL *url.URL) bool {
	host := strings.ToLower(parsedURL.Hostname())
	switch provider.providerKey {
	case "challonge":
		return strings.Contains(host, "challonge.com")
	case "tonamel":
		return strings.Contains(host, "tonamel.com")
	case "parry":
		return strings.Contains(host, "parry.gg")
	default:
		return false
	}
}

// preview returns a deliberate unsupported-provider error while preserving detection.
func (provider unsupportedImportProvider) preview(_ *App, rawURL string, _ *url.URL) (ExternalTournament, error) {
	preview := ExternalTournament{
		Provider:     provider.key(),
		ProviderName: provider.name(),
		URL:          rawURL,
		Warnings:     []string{provider.name() + " import is detected but not implemented yet."},
	}
	return preview, fmt.Errorf("%s import is not implemented yet", provider.name())
}

// key returns the start.gg provider key.
func (provider startGGImportProvider) key() string {
	return "startgg"
}

// name returns the operator-facing provider name.
func (provider startGGImportProvider) name() string {
	return "start.gg"
}

// canHandle recognizes start.gg and legacy smash.gg links.
func (provider startGGImportProvider) canHandle(parsedURL *url.URL) bool {
	host := strings.ToLower(parsedURL.Hostname())
	return strings.Contains(host, "start.gg") || strings.Contains(host, "smash.gg")
}

// preview loads event metadata, entrants, seeds, and sets from the start.gg GraphQL API.
func (provider startGGImportProvider) preview(app *App, rawURL string, parsedURL *url.URL) (ExternalTournament, error) {
	slug, err := startGGEventSlug(parsedURL)
	if err != nil {
		return ExternalTournament{Provider: provider.key(), ProviderName: provider.name(), URL: rawURL}, err
	}

	// start.gg GraphQL requires a user token; we store it locally, never in tournament.json.
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
			if tournamentSlug == "" || eventSlug == "" {
				continue
			}
			return "tournament/" + tournamentSlug + "/event/" + eventSlug, nil
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

	rawParts := strings.Split(strings.Trim(rawPath, "/"), "/")
	parts := make([]string, 0, len(rawParts))
	for _, rawPart := range rawParts {
		rawPart = strings.TrimSpace(rawPart)
		if rawPart == "" {
			continue
		}
		// start.gg slugs may include escaped punctuation; decode before matching path labels.
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
			// Environment variables are convenient for CI/manual smoke tests.
			return token
		}
	}

	if app != nil {
		// App path goes through the same external folder resolver as production builds.
		settings := app.LoadImportIntegrations()
		return strings.TrimSpace(settings.StartGG.APIKey)
	}

	settings, _ := readImportIntegrations()
	return strings.TrimSpace(settings.StartGG.APIKey)
}

// readImportIntegrations loads saved provider credentials, if the file exists.
func readImportIntegrations() (ImportIntegrations, error) {
	for _, filePath := range externalFilePaths(dataDirPath, integrationsJSONFile) {
		data, err := os.ReadFile(filePath)
		if err != nil {
			continue
		}
		settings, err := decodeImportIntegrations(data)
		if err != nil {
			return ImportIntegrations{}, err
		}
		return settings, nil
	}
	return ImportIntegrations{}, nil
}

// decodeImportIntegrations supports the current provider map and the first token draft.
func decodeImportIntegrations(data []byte) (ImportIntegrations, error) {
	var settings ImportIntegrations
	if err := json.Unmarshal(data, &settings); err != nil {
		return ImportIntegrations{}, err
	}

	// Support the early single-token draft so local installs do not lose saved keys.
	var legacySettings struct {
		StartGGToken string `json:"startgg_token"`
	}
	if err := json.Unmarshal(data, &legacySettings); err == nil && settings.StartGG.APIKey == "" {
		settings.StartGG.APIKey = legacySettings.StartGGToken
	}

	return normalizeImportIntegrations(settings), nil
}

// writeImportIntegrations writes provider credentials to data/integrations.json.
func writeImportIntegrations(settings ImportIntegrations) error {
	data, err := json.MarshalIndent(normalizeImportIntegrations(settings), "", "\t")
	if err != nil {
		return err
	}

	// API keys stay local beside data/tournament.json and are intentionally Git-ignored.
	if err := os.MkdirAll(externalWriteDirPath(dataDirPath), 0755); err != nil {
		return err
	}
	return os.WriteFile(externalWriteFilePath(dataDirPath, integrationsJSONFile), append(data, '\n'), 0600)
}

// normalizeImportIntegrations trims tokens before they are returned or saved.
func normalizeImportIntegrations(settings ImportIntegrations) ImportIntegrations {
	settings.StartGG.APIKey = strings.TrimSpace(settings.StartGG.APIKey)
	return settings
}

// fetchStartGGEvent sends the GraphQL request used by the import preview.
func fetchStartGGEvent(slug string, token string) (startGGEvent, error) {
	requestPayload := startGGGraphQLRequest{
		Query:     startGGImportQuery,
		Variables: map[string]interface{}{"slug": slug},
	}
	body, err := json.Marshal(requestPayload)
	if err != nil {
		return startGGEvent{}, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), importHTTPTimeout)
	defer cancel()

	// Use GraphQL by event slug so pasted overview links and completed events resolve the same way.
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
		// Surface the first provider error; start.gg usually returns the useful message there.
		return startGGEvent{}, fmt.Errorf("start.gg: %s", graphResponse.Errors[0].Message)
	}
	if graphResponse.Data.Event == nil {
		return startGGEvent{}, fmt.Errorf("start.gg event not found")
	}
	return *graphResponse.Data.Event, nil
}

// startGGExternalTournament converts the GraphQL event into provider-neutral import data.
func startGGExternalTournament(app *App, rawURL string, slug string, event startGGEvent) ExternalTournament {
	players := make([]ExternalPlayer, 0, len(event.Entrants.Nodes))
	for index, entrant := range event.Entrants.Nodes {
		player := startGGExternalPlayer(entrant)
		if player.Seed <= 0 {
			// Entrants query does not expose seed directly, so order is the stable fallback.
			player.Seed = index + 1
		}
		players = append(players, player)
	}

	matches := make([]ExternalMatch, 0, len(event.Sets.Nodes))
	for index, set := range event.Sets.Nodes {
		matches = append(matches, startGGExternalMatch(index+1, set))
	}

	game := strings.TrimSpace(event.Videogame.DisplayName)
	if game == "" {
		game = strings.TrimSpace(event.Videogame.Name)
	}
	if app != nil && game != "" {
		if key, err := app.resolveGameKey(game); err == nil && key != "" {
			// Save the local game key when the provider display name matches our catalog.
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
		Meta: map[string]string{
			"slug":     slug,
			"event_id": event.ID.String(),
		},
	}
}

// startGGExternalPlayer converts one entrant into one player slot.
func startGGExternalPlayer(entrant startGGEntrant) ExternalPlayer {
	player := ExternalPlayer{
		ExternalID: entrant.ID.String(),
		Name:       strings.TrimSpace(entrant.Name),
	}
	if len(entrant.Participants) > 0 {
		participant := entrant.Participants[0]
		player.Name = firstNonEmpty(participant.GamerTag, entrant.Name)
		player.Team = strings.TrimSpace(participant.Prefix)
		player.Country = normalizeImportedCountry(participant.User.Location.Country)
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

// normalizeExternalTournamentPreview sorts players and clamps preview size.
func normalizeExternalTournamentPreview(preview *ExternalTournament) {
	// Stable ordering makes previews deterministic and imports predictable.
	sort.SliceStable(preview.Players, func(i int, j int) bool {
		left := preview.Players[i]
		right := preview.Players[j]
		if left.Seed == right.Seed {
			return strings.ToLower(left.Name) < strings.ToLower(right.Name)
		}
		if left.Seed <= 0 {
			return false
		}
		if right.Seed <= 0 {
			return true
		}
		return left.Seed < right.Seed
	})
	if preview.Event.Rule <= 0 {
		preview.Event.Rule = defaultEventRuleForImport()
	}
	if preview.Event.Size <= 0 {
		preview.Event.Size = bestTournamentSizeForPlayerCount(len(preview.Players))
	}
}

// tournamentStateFromExternal merges imported event/player data into the live state shape.
func tournamentStateFromExternal(current TournamentState, preview ExternalTournament) TournamentState {
	state := current
	if preview.Event.Name != "" {
		state.Event.Name = preview.Event.Name
	}
	if preview.Event.Phase != "" {
		state.Event.Phase = preview.Event.Phase
	}
	if preview.Event.Game != "" && normalizeAssetName(preview.Event.Game) != normalizeAssetName(state.Event.Game) {
		// Imported game changes invalidate character keys just like manual event edits.
		state.Event.Game = preview.Event.Game
		clearPlayerCharacters(state.Players)
	}
	if preview.Event.Rule > 0 {
		state.Event.Rule = preview.Event.Rule
	}
	if preview.Event.Size > 0 {
		state.Event.Size = preview.Event.Size
	}

	state.Players = map[string]Player{}
	limit := min(len(preview.Players), state.Event.Size)
	// Player IDs remain local seed slots; provider IDs are preview metadata for now.
	for index := 0; index < limit; index++ {
		player := preview.Players[index]
		state.Players[strconv.Itoa(index+1)] = Player{
			Name:    player.Name,
			Team:    player.Team,
			Country: player.Country,
		}
	}
	state.Matches = map[string]MatchState{}
	// Imported players start from clean natural seeding until the operator randomizes or edits.
	state.Bracket.Seeds = nil
	state.Bracket.Byes = nil
	state.Bracket.Matches = nil
	state.Current = "A"
	return normalizeTournamentState(state)
}

// bestTournamentSizeForPlayerCount chooses the smallest configured size that fits the entrants.
func bestTournamentSizeForPlayerCount(playerCount int) int {
	if playerCount <= 0 {
		return fallbackTournamentSize(configuredTournamentSizes())
	}
	for _, size := range configuredTournamentSizes() {
		if size >= playerCount {
			return size
		}
	}
	return maxConfiguredTournamentSize()
}

// maxConfiguredTournamentSize returns the largest configured tournament size.
func maxConfiguredTournamentSize() int {
	allowed := configuredTournamentSizes()
	if len(allowed) == 0 {
		return defaultTournamentSize
	}
	maxSize := allowed[0]
	for _, size := range allowed {
		if size > maxSize {
			maxSize = size
		}
	}
	return maxSize
}

// defaultEventRuleForImport preserves the app's first-to default for imported events.
func defaultEventRuleForImport() int {
	return normalizeEventRule(0)
}

// normalizeImportedCountry converts provider country values into Stream.FGC ISO2 codes.
func normalizeImportedCountry(country string) string {
	rawCountry := strings.TrimSpace(country)
	isoCountry := strings.ToUpper(rawCountry)
	if len(isoCountry) == 2 && isISO2Code(strings.ToLower(isoCountry)) {
		return isoCountry
	}

	if code, ok := importedCountryAliasCodes[normalizeImportedCountryName(rawCountry)]; ok {
		return code
	}

	return ""
}

// normalizeImportedCountryName makes provider country names comparable across spellings.
func normalizeImportedCountryName(country string) string {
	country = strings.NewReplacer("&", "and", ".", "", ",", "", "'", "").Replace(strings.ToLower(strings.TrimSpace(country)))
	var builder strings.Builder
	for _, character := range country {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
			builder.WriteRune(character)
		}
	}
	return builder.String()
}

// firstNonEmpty returns the first non-empty string from values.
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
