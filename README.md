# byuwur/stream.fgc

**Set up your tourney quickly!**

~ For the FGC made easy, with love, for the FGC, with Go. ~

Stream.FGC is built on top of [byuwur/spa.js](https://github.com/byuwur/spa.js) as a static frontend shell, with a local Go backend provided by Wails.

## What's this about?

This project is a local tournament control system for fighting game streams. It is meant for events such as Street Fighter 6 brackets where an operator needs to edit event data, player data, the current match, scores, bracket results, and visual assets without using a cloud service or a database.

The saved JSON file is the source of truth for the OBS overlays. The desktop app is the controller; the static overlay pages read the same local files and render scoreboard, versus, winner, champion, intro, and bracket views.

## What does it do?

- **Local Desktop Control:** Runs as a Wails desktop app and targets a portable Windows `.exe`.
- **Plain Frontend:** Uses static HTML/CSS/JavaScript through SPA.js. No React, no Vite build, no frontend package install.
- **Go Filesystem Boundary:** The browser UI calls Wails methods; only Go reads or writes tournament JSON and uploaded assets.
- **Live Tournament JSON:** Saves the current state into `data/tournament.json`.
- **Event Editor:** Edits name, phase, first-to rule, game, format, size, logo, and overlay background.
- **Player Editor:** Edits every player slot, country flags, characters, portraits, and responsive player cards.
- **Import Page:** Previews supported external tournament links and imports event/player data into the local JSON.
- **Current Match Control:** Resolves the current match from the bracket template, edits scores, swaps display sides, and prevents score edits after a winner is locked.
- **Bracket Admin:** Shows a resolved bracket, sets current match, records wins/DQs/BYEs, swaps bracket seed assignments, randomizes before play starts, and resets bracket state.
- **Overlay View Setting:** Stores which bracket slice OBS should show without changing the admin bracket view.

## How is it done?

### Core Files [in priority order]

- **main.go:** Starts Wails, embeds `frontend/`, binds the app API, and serves external `assets/` and `players/` folders beside the executable.
- **backend/app.go:** Creates the Wails-bound app object, serializes tournament mutations with one mutex, and validates runtime folders at startup.
- **backend/models.go:** Defines the JSON, template, participant, and resolved-match shapes shared by backend files.
- **backend/storage.go:** Loads or creates `data/tournament.json` and replaces it atomically after successful writes.
- **backend/normalization.go:** Holds schema migration, defaults, score clamping, and state cleanup in one place.
- **backend/tournament.go:** Exposes the direct Wails methods that mutate event, player, match, seed, and bracket settings.
- **backend/templates.go:** Maps format/size to JSON templates and resolves seed/winner/loser participant sources.
- **backend/seeding.go:** Normalizes bracket-only seed assignments, BYEs, and randomization.
- **backend/paths.go:** Resolves external folders for dev mode and portable release builds.
- **backend/bracket.go:** Resolves template-driven brackets into admin/overlay projections.
- **backend/assets.go:** Reads game, character, rule, format, and size catalogs from `assets/`.
- **backend/integrations.go:** Reads and writes ignored local API credentials in `data/integrations.json`.
- **backend/imports.go:** Owns provider-neutral link detection, preview normalization, and local tournament import.
- **backend/imports_startgg.go:** Contains only the start.gg GraphQL adapter and response mapping.
- **backend/portraits.go:** Validates player portrait uploads and writes `players/{player}.png`.
- **backend/event_assets.go:** Validates tournament logo/background uploads and writes `players/_logo.png` and `players/_bg.jpg`.
- **backend/overlays.go:** Opens the local `overlays/` folder from the sidebar through the OS file explorer.
- **frontend/index.html:** Static SPA entry point. Deferred scripts are loaded directly; there is no bundler or package step.
- **frontend/_routes.js:** Defines SPA.js hash routes for import, event, players, and bracket pages.
- **frontend/_app.js:** Shared Wails access, status, autosave, catalog, Select2, asset URL, event, and current-match runtime.
- **frontend/app/import.js:** Import page controller.
- **frontend/app/players.js:** Player page and portrait controller.
- **frontend/app/bracket.js:** Bracket manager and preview controller.
- **frontend/import.html:** External tournament import page fragment.
- **frontend/main.html:** Event editor and Playing Now page fragment.
- **frontend/players.html:** Player editor page fragment.
- **frontend/brackets.html:** Admin bracket page fragment.

### Additional Files

- **frontend/_common.css:** Stream.FGC visual overrides on top of SPA.js, Bootstrap, Shards, and Select2.
- **frontend/_var.js:** SPA.js app-level settings.
- **frontend/sidebar.html:** Shared SPA navigation component.
- **frontend/lang/en.json**, **frontend/lang/es.json**, and **frontend/lang/ja.json:** App language dictionaries using dotted hierarchy keys.
- **frontend/lang/flags.{lang}.json:** Localized country names for flag selects.
- **templates/default.json:** Default tournament state used when `data/tournament.json` is missing or empty.
- **templates/{format}{size}.json:** Required bracket templates, such as `double8.json` or `single4.json`. When a matching file is missing, the app shows `[template] template missing`.

### Public Assets

- **assets/games.json:** Game catalog. Keys are saved into tournament JSON.
- **assets/country_aliases.json:** Provider country names mapped to ISO2 codes without hardcoding that lookup in Go.
- **assets/michroma.ttf:** Shared app font loaded by the embedded frontend through `../assets/`.
- **assets/flags/{iso2}.svg:** Country flags used by the player, import, current-match, and bracket UIs.
- **assets/nopic.png**, **assets/nobg.jpg**, and **assets/stream.fgc.png:** Shared controller fallbacks and branding images.
- **assets/{game}/_logo.png:** Game logo shown in event game selects.
- **assets/{game}/_bg.jpg:** Game background used by the admin SPA shell.
- **assets/{game}/characters.json:** Character catalog for that game. Keys are saved into player records.
- **assets/{game}/portraits/{character}.png:** Character portrait used in Select2 and bracket/current-match cards.
- **assets/rules.json:** First-to rule catalog. Rule keys are normalized to numbers.
- **assets/formats.json:** Format catalog for single elimination, double elimination, robin, and Swiss.
- **assets/sizes.json:** Allowed bracket capacities.
- **players/{player}.png:** Custom player portrait uploaded from the player page.
- **players/_logo.png:** Custom tournament logo for overlays.
- **players/_bg.jpg:** Custom tournament background for overlays only.
- **overlays/**: Local OBS overlay workspace opened from the controller sidebar.

### OBS Overlays

OBS overlays live only in `overlays/`. They are a separate static mini-site that reads `../data/tournament.json` and sibling asset folders.

- **overlays/css/bootstrap.min.css** and **overlays/css/animate.min.css:** Copied framework CSS used by every overlay.
- **overlays/css/_common.css:** Minimal overlay reset and shared Michroma font declaration.
- **overlays/css/overlay.css:** Fixed 1920x1080 stage, page components, and bracket layout.
- **overlays/js/jquery.min.js**, **overlays/js/popper.min.js**, and **overlays/js/bootstrap.min.js:** Copied framework JavaScript used by the static pages.
- **overlays/js/overlay.js:** Shared jQuery polling, template resolution, contain scaling, asset fallback, and changed-value animation runtime.
- **overlays/scoreboard.html:** Current match score overlay.
- **overlays/versus.html:** Current match versus screen.
- **overlays/winner.html:** Current match winner overlay.
- **overlays/champion.html:** Tournament champion screen using the latest completed finals winner.
- **overlays/bracket.html:** Bracket overlay that reads the stored overlay view.
- **overlays/intro.html:** Event intro/standby screen.

Overlay pages poll JSON every 1s or 2.5s depending on the page. If the JSON text changes, the shared runtime applies Animate.css `fadeOut`, swaps only changed values, and returns them with `fadeInUp`. The layout always remains a 1920x1080 canvas scaled with contain behavior for the OBS/browser viewport.

Game-specific overlay identity should use the same filenames in each game folder:

```text
overlays/{game}/
  _bg.jpg
  _logo.png
  intro.png
  scoreboard.png
  versus.png
  winner.png
  champion.png
  bracket.png
```

For example, `overlays/sf6/_bg.jpg` and `overlays/tekken8/_bg.jpg` change the visual identity while the HTML and JSON logic stay identical.

### External Imports

The Import page accepts tournament links and keeps Stream.FGC as the local source of truth after import.

- **start.gg:** Supported through the official GraphQL API. Save the API key from the Import page. The backend writes `data/integrations.json` with `{ "startgg": { "api_key": "..." } }`, and that real token file is ignored by Git. `STARTGG_TOKEN`, `START_GG_TOKEN`, and `STARTGG_API_TOKEN` still work as local overrides.
- **Challonge, Tonamel, and Parry.gg:** Links are detected and return a clear "not implemented yet" message until provider adapters are added.

Imports currently bring event metadata and player slots into `data/tournament.json`. Provider matches are previewed only; bracket control remains local and template-driven.

The import parser is covered by `backend/imports_test.go`. Its live start.gg test uses the app's real import path and stays skipped during ordinary test runs. To run it against the official Blink Respawn SF6 event, save a start.gg API key in the Import page and use:

```powershell
$env:STREAM_FGC_STARTGG_LIVE_TEST="1"; go test ./backend -run TestStartGGLivePreview -count=1 -v
```

## Data Model

`data/tournament.json` is the live document. The important top-level keys are:

- **version:** Schema version.
- **event:** Event fields such as name, phase, rule, game, format, and bracket size.
- **current:** Current match ID.
- **players:** Player records keyed by stable player slot ID.
- **matches:** Match state keyed by template match ID.
- **bracket:** Bracket-only state such as overlay view, seed assignments, and BYEs.

`event.size` is bracket capacity, not necessarily the number of real players. Reducing size trims unused player slots so the JSON does not keep unnecessary records.

`event.rule` is stored as a number. For example, `3` means FT3. Score controls clamp at zero and at the active first-to limit.

Player records intentionally do not store portrait paths. Player portraits are resolved from `players/{player}.png`, with `assets/nopic.png` as the UI fallback.

## Bracket Model

Bracket logic is template-driven. A participant can come from:

- **seed:** A bracket seed assignment, resolved through `bracket.seeds` when present.
- **winner:** The winner of another match.
- **loser:** The loser of another match.

Participant states:

- **player:** A real player is resolved.
- **tbd:** A seed slot exists but does not have a real player yet.
- **bye:** A seed slot is intentionally marked as BYE.
- **pending:** A winner/loser source has not been decided yet.

The backend does not generate bracket shapes. `event.format` and `event.size` map to a template filename, for example `double_elimination` plus `8` loads `templates/double8.json`, while `robin` plus `8` loads `templates/robin8.json`. Unsupported sizes are allowed to exist in `assets/sizes.json`, but they need matching template files before the bracket can render.

Bundled templates currently cover 2-player through 64-player single elimination, double elimination, robin, and Swiss. Robin templates include every seed pairing. Swiss templates are fixed-round seed schedules for now; dynamic Swiss re-pairing belongs in a future pairing/standings layer rather than hidden Go fallback generation.

Match results can be normal, `bye`, or `dq`. BYE results are generated during setup and do not count as bracket-started state, so randomize/reset setup tools can still work before real play begins.

## Coding Conventions

**SIMPLE IS COMPLICATED ENOUGH.** Prefer code that can be followed from top to bottom without discovering a framework inside the project.

- Keep feature flows direct and close to the page or backend file that owns them. A little readable repetition is better than a generic helper that hides business behavior.
- Use Bootstrap grid, flex, spacing, form, and button utilities before adding project CSS. Keep custom CSS for stable dimensions, media, bracket geometry, and Stream.FGC-specific visuals.
- Use jQuery when it makes selectors, plugins, or transitions shorter and clearer. Use direct browser APIs when they express a small operation more plainly.
- Route fragment setup through the shared `StreamFGC` SPA lifecycle. Reuse `byCommon.init()` and SPA.js helpers instead of adding inline fragment scripts or initializing Bootstrap plugins twice.
- Give every named Go or JavaScript function a short purpose comment. Add comments inside functions only where the reason or data flow is not obvious from the code.
- Keep filesystem access in Go, frontend state mirrored from backend results, and overlay code read-only.
- Add dependencies only when the existing Go standard library, Bootstrap, jQuery, or SPA.js cannot provide a clear solution.

## Development

Stream.FGC deliberately has no frontend install or build command. Wails serves `frontend/` directly in development and embeds the same directory in production.

```bash
git submodule update --init --recursive
go mod download
wails dev -assetdir frontend -reloaddirs frontend
```

The explicit Wails paths make file watching predictable on Windows, Linux, and macOS without PowerShell helper files. `wails dev` regenerates the ignored `frontend/wailsjs/` bindings when backend methods change.

Wails binding obfuscation is disabled. Garble does not protect local tournament data and its randomized Windows executables can trigger Defender false positives; a direct portable build is faster and easier to verify.

Build the portable executable and run the project checks with:

```bash
wails build
go test ./...
go vet ./...
node --check frontend/_app.js
node --check overlays/js/overlay.js
```

In development, writable `assets/`, `data/`, `overlays/`, `players/`, and `templates/` paths resolve from the project directory. In a production build, the same folders resolve beside the portable executable. Only the static controller frontend is embedded in the `.exe`.

For a normal browser, test overlays through the local web server, for example `http://localhost/stream.fgc/overlays/scoreboard.html`. Browsers block sibling JSON reads when the same page is opened through `file:///`; OBS Browser Source may behave differently, so HTTP is the consistent test path.

## Reading the Go Code

The backend uses one package and several files, not a framework inside a framework:

- `module stream.fgc` in `go.mod` gives local imports their full path. That is why `main.go` imports `stream.fgc/backend`.
- Every file declaring `package backend` is compiled together. Splitting storage, templates, imports, and normalization into files is organization, not a runtime layer.
- `func (a *App) UpdateEvent(...)` is a method on the one Wails-bound `App`. An uppercase method name makes it callable from JavaScript.
- A Go method returning `(value, error)` becomes a JavaScript Promise. A non-nil error rejects it, which is why frontend calls use `try/catch`.
- Struct tags such as `json:"player1_score"` are the exact keys written into tournament JSON.
- `App.mu` serializes read-modify-write operations. It does not cache a second tournament state; each mutation starts from disk.
- `storage.go` writes a temporary file and renames it only after encoding succeeds, so a partial save cannot truncate the live OBS JSON.
- A `//go:build` line opts a file into special commands. The start.gg smoke command is excluded from normal builds and tests unless its manual tag is supplied.

## Usage

1. Run the app with Wails during development.
2. Use the Import page when an external tournament link should seed the event and player list.
3. Open the Event page to set event info, selected game, format, size, rule, logo, and overlay background.
4. Open the Players page to fill player slots, countries, characters, and portraits.
5. Open the Bracket page to randomize/swap bracket seeds, set the current match, and record wins, DQs, or BYEs.
6. Let autosave write changes through Go into `data/tournament.json`.
7. Point OBS Browser Sources at the needed file in `overlays/`, such as `scoreboard.html`, `versus.html`, `winner.html`, or `bracket.html`.

> The frontend does not write files directly. Any save, upload, remove, reset, randomize, or swap operation goes through a Wails-bound Go method.

> The admin SPA background uses the selected game's `assets/{game}/_bg.jpg`. The custom tournament `players/_bg.jpg` is reserved for overlays and should not change the controller UI.

> Current-match side swap is a display override for the selected match. Bracket seed swap changes `bracket.seeds` and does not move `players["1"]`, `players["2"]`, etc.

## Documentation Notes

The code follows the same documentation idea used in SPA.js and SPA.php:

- Project-owned JavaScript files use a file header plus `/** ... */` doc blocks before bootstrappers and named functions.
- Project-owned Go files use a file header plus GoDoc comments before every function, including internal helpers.
- Complex behavior is documented where it lives: BYE advancement in `backend/bracket.go`, atomic persistence in `backend/storage.go`, provider mapping in `backend/imports_startgg.go`, page ownership in `frontend/app/`, and static rendering in `overlays/js/overlay.js`.

## License

MIT (c) Andrés Trujillo [Mateus] byUwUr
