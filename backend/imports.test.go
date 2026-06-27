//go:build manual_startgg_import_test

/*
 * File: imports.test.go
 * Desc: Standalone start.gg import smoke test for the official Blink Respawn SF6 event.
 * Deps: Go bytes/encoding-json/fmt/io/net-http/net-url/os/strings/time.
 * Usage: go run -tags manual_startgg_import_test backend/imports.test.go
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	blinkRespawnSF6URL     = "https://www.start.gg/tournament/blink-respawn-2026/event/street-fighter-6-capcom-pro-tour-offline-premier-event/overview"
	startGGGraphQLEndpoint = "https://api.start.gg/gql/alpha"
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

type graphQLRequest struct {
	Query     string         `json:"query"`
	Variables graphQLSlugArg `json:"variables"`
}

type graphQLSlugArg struct {
	Slug string `json:"slug"`
}

type graphQLResponse struct {
	Data   graphQLData    `json:"data"`
	Errors []graphQLError `json:"errors"`
}

type graphQLData struct {
	Event *startGGEvent `json:"event"`
}

type graphQLError struct {
	Message string `json:"message"`
}

type startGGEvent struct {
	Name        string             `json:"name"`
	NumEntrants int                `json:"numEntrants"`
	Tournament  startGGTournament  `json:"tournament"`
	Entrants    startGGEntrantPage `json:"entrants"`
}

type startGGTournament struct {
	Name string `json:"name"`
}

type startGGEntrantPage struct {
	Nodes []startGGEntrant `json:"nodes"`
}

type startGGEntrant struct {
	Name string `json:"name"`
}

type integrationSettings struct {
	StartGG struct {
		APIKey string `json:"api_key"`
	} `json:"startgg"`
	StartGGToken string `json:"startgg_token"`
}

// main runs the official Blink Respawn SF6 import smoke test.
func main() {
	token := startGGAPIToken()
	if token == "" {
		fail("missing start.gg API key; save it in data/integrations.json or set STARTGG_TOKEN")
	}

	slug, err := startGGEventSlug(blinkRespawnSF6URL)
	if err != nil {
		fail(err.Error())
	}

	event, err := fetchStartGGEvent(slug, token)
	if err != nil {
		fail(err.Error())
	}
	if strings.TrimSpace(event.Name) == "" {
		fail("start.gg returned an empty event name")
	}
	if len(event.Entrants.Nodes) == 0 {
		fail("start.gg returned no players")
	}

	// Keep output short so this can run as a manual smoke test during provider changes.
	fmt.Printf("start.gg import smoke test ok: event=%q tournament=%q players=%d numEntrants=%d\n", event.Name, event.Tournament.Name, len(event.Entrants.Nodes), event.NumEntrants)
}

// startGGAPIToken reads the token without importing Stream.FGC backend code.
func startGGAPIToken() string {
	for _, key := range []string{"STARTGG_TOKEN", "START_GG_TOKEN", "STARTGG_API_TOKEN"} {
		if token := strings.TrimSpace(os.Getenv(key)); token != "" {
			// Environment variables let CI or one-off local runs avoid touching data files.
			return token
		}
	}

	for _, filePath := range []string{"data/integrations.json", "../data/integrations.json"} {
		// This standalone file intentionally avoids importing backend path helpers.
		data, err := os.ReadFile(filePath)
		if err != nil {
			continue
		}
		var settings integrationSettings
		if err := json.Unmarshal(data, &settings); err == nil {
			if token := strings.TrimSpace(settings.StartGG.APIKey); token != "" {
				return token
			}
			if token := strings.TrimSpace(settings.StartGGToken); token != "" {
				return token
			}
		}
	}
	return ""
}

// startGGEventSlug extracts the event slug from the official smoke-test URL.
func startGGEventSlug(rawURL string) (string, error) {
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}

	parts := strings.Split(strings.Trim(parsedURL.EscapedPath(), "/"), "/")
	for index := 0; index+3 < len(parts); index++ {
		if strings.EqualFold(parts[index], "tournament") && strings.EqualFold(parts[index+2], "event") {
			tournamentSlug, err := url.PathUnescape(parts[index+1])
			if err != nil {
				return "", err
			}
			eventSlug, err := url.PathUnescape(parts[index+3])
			if err != nil {
				return "", err
			}
			return "tournament/" + tournamentSlug + "/event/" + eventSlug, nil
		}
	}
	return "", fmt.Errorf("start.gg event URL must include /tournament/{tournament}/event/{event}")
}

// fetchStartGGEvent calls the same lightweight import shape used by the app.
func fetchStartGGEvent(slug string, token string) (startGGEvent, error) {
	requestPayload := graphQLRequest{
		Query:     startGGImportQuery,
		Variables: graphQLSlugArg{Slug: slug},
	}
	body, err := json.Marshal(requestPayload)
	if err != nil {
		return startGGEvent{}, err
	}

	client := http.Client{Timeout: 20 * time.Second}
	request, err := http.NewRequest(http.MethodPost, startGGGraphQLEndpoint, bytes.NewReader(body))
	if err != nil {
		return startGGEvent{}, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "Stream.FGC smoke test")

	// Keep the smoke test honest by hitting the same provider endpoint as the app.
	response, err := client.Do(request)
	if err != nil {
		return startGGEvent{}, err
	}
	defer response.Body.Close()

	data, err := io.ReadAll(response.Body)
	if err != nil {
		return startGGEvent{}, err
	}

	var graphResponse graphQLResponse
	if err := json.Unmarshal(data, &graphResponse); err != nil {
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

// fail prints a fatal smoke-test error and exits with a non-zero code.
func fail(message string) {
	fmt.Fprintln(os.Stderr, "start.gg import smoke test failed:", message)
	os.Exit(1)
}
