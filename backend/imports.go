/*
 * File: imports.go
 * Desc: Selects import providers and merges provider-neutral previews into local tournament state.
 * Deps: Go fmt/net-url/sort/strconv/strings.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package backend

import (
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
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
		return TournamentState{}, err
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	current, err := a.loadTournamentLocked()
	if err != nil {
		return TournamentState{}, err
	}
	// Import currently replaces event/player setup while preserving reusable app settings.
	imported := tournamentStateFromExternal(current, preview)
	return a.saveTournamentLocked(imported)
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

// readImportedCountryAliases loads provider-name to ISO2 mappings from assets/country_aliases.json.
func readImportedCountryAliases(app *App) map[string]string {
	if app == nil {
		app = &App{}
	}
	entries, err := app.readAssetMap("country_aliases.json")
	if err != nil {
		return map[string]string{}
	}
	aliases := make(map[string]string, len(entries))
	for _, entry := range entries {
		code := strings.ToUpper(strings.TrimSpace(entry.Value))
		if len(code) == 2 && isISO2Code(strings.ToLower(code)) {
			aliases[normalizeImportedCountryName(entry.Key)] = code
		}
	}
	return aliases
}

// normalizeImportedCountry converts provider country values into Stream.FGC ISO2 codes.
func normalizeImportedCountry(country string, aliases map[string]string) string {
	rawCountry := strings.TrimSpace(country)
	isoCountry := strings.ToUpper(rawCountry)
	if len(isoCountry) == 2 && isISO2Code(strings.ToLower(isoCountry)) {
		return isoCountry
	}

	if code, ok := aliases[normalizeImportedCountryName(rawCountry)]; ok {
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
