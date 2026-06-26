# byuwur/stream.fgc

**Set up your tourney quickly!**

~ For the FGC made easy, with love, for the FGC, with Go. ~

Stream.FGC is built on top of [byuwur/spa.js](https://github.com/byuwur/spa.js) as a static frontend shell, with a local Go backend provided by Wails.

## What's this about?

This project is a local tournament control system for fighting game streams. It is meant for events such as Street Fighter 6 brackets where an operator needs to edit event data, player data, the current match, scores, bracket results, and visual assets without using a cloud service or a database.

The saved JSON file is the source of truth for future OBS overlays. The desktop app is the controller; OBS-facing pages can read the same local files and render scoreboard, winner, and bracket views.

## What does it do?

- **Local Desktop Control:** Runs as a Wails desktop app and targets a portable Windows `.exe`.
- **Plain Frontend:** Uses static HTML/CSS/JavaScript through SPA.js. No React, no Vite build, no frontend package install.
- **Go Filesystem Boundary:** The browser UI calls Wails methods; only Go reads or writes tournament JSON and uploaded assets.
- **Live Tournament JSON:** Saves the current state into `data/tournament.json`.
- **Event Editor:** Edits name, phase, first-to rule, game, format, size, logo, and overlay background.
- **Player Editor:** Edits every player slot, country flags, characters, portraits, and responsive player cards.
- **Current Match Control:** Resolves the current match from the bracket template, edits scores, swaps display sides, and prevents score edits after a winner is locked.
- **Bracket Admin:** Shows a resolved bracket, sets current match, records wins/DQs/BYEs, swaps bracket seed assignments, randomizes before play starts, and resets bracket state.
- **Overlay View Setting:** Stores which bracket slice OBS should show without changing the admin bracket view.

## How is it done?

### Core Files [in priority order]

- **main.go:** Starts Wails, embeds `frontend/`, binds the app API, and serves external `assets/` and `players/` folders beside the executable.
- **backend/app.go:** Owns backend state and the mutex used to serialize tournament JSON access.
- **backend/tournament.go:** Loads, normalizes, mutates, and saves `data/tournament.json`.
- **backend/paths.go:** Resolves external folders for dev mode and portable release builds.
- **backend/bracket.go:** Resolves template-driven brackets into admin/overlay projections and generates fallback bracket graphs.
- **backend/assets.go:** Reads game, character, rule, format, and size catalogs from `assets/`.
- **backend/portraits.go:** Validates player portrait uploads and writes `players/{player}.png`.
- **backend/event_assets.go:** Validates tournament logo/background uploads and writes `players/_logo.png` and `players/_bg.jpg`.
- **backend/overlays.go:** Opens the local `overlays/` folder from the sidebar through the OS file explorer.
- **frontend/index.html:** Static SPA entry point that loads SPA.js, Bootstrap, Select2, Dropzone, Shards, Font Awesome, and Stream.FGC scripts.
- **frontend/_routes.js:** Defines SPA.js hash routes for event, players, and bracket pages.
- **frontend/_app.js:** Main controller for Wails calls, autosave, catalogs, Select2 rendering, Dropzone uploads, current match, player cards, and bracket controls.
- **frontend/main.html:** Event editor and Playing Now page fragment.
- **frontend/players.html:** Player editor page fragment.
- **frontend/brackets.html:** Admin bracket page fragment.

### Additional Files

- **frontend/_common.css:** Stream.FGC visual overrides on top of SPA.js, Bootstrap, Shards, and Select2.
- **frontend/_var.js:** SPA.js app-level settings.
- **frontend/sidebar.html:** Shared SPA navigation component.
- **frontend/lang/en.json** and **frontend/lang/es.json:** App language dictionaries.
- **frontend/lang/flags.en.json** and **frontend/lang/flags.es.json:** Localized country names for flag selects.
- **data/_default.json:** Default tournament state used when `data/tournament.json` is missing or empty.
- **templates/**: Optional bracket templates. When a matching file is missing, Go can generate a template from the selected format and size.

### Public Assets

- **assets/games.json:** Game catalog. Keys are saved into tournament JSON.
- **assets/{game}/_logo.png:** Game logo shown in event game selects.
- **assets/{game}/_bg.jpg:** Game background used by the admin SPA shell.
- **assets/{game}/characters.json:** Character catalog for that game. Keys are saved into player records.
- **assets/{game}/portraits/{character}.png:** Character portrait used in Select2 and bracket/current-match cards.
- **assets/rules.json:** First-to rule catalog. Rule keys are normalized to numbers.
- **assets/formats.json:** Bracket format catalog.
- **assets/sizes.json:** Allowed bracket capacities.
- **players/{player}.png:** Custom player portrait uploaded from the player page.
- **players/_logo.png:** Custom tournament logo for overlays.
- **players/_bg.jpg:** Custom tournament background for overlays only.
- **overlays/**: Local OBS overlay workspace opened from the controller sidebar.

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

Player records intentionally do not store portrait paths. Player portraits are resolved from `players/{player}.png`, with `frontend/assets/nopic.png` as the UI fallback.

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

Match results can be normal, `bye`, or `dq`. BYE results are generated during setup and do not count as bracket-started state, so randomize/reset setup tools can still work before real play begins.

## Usage

1. Run the app with Wails during development.
2. Open the Event page to set event info, selected game, format, size, rule, logo, and overlay background.
3. Open the Players page to fill player slots, countries, characters, and portraits.
4. Open the Bracket page to randomize/swap bracket seeds, set the current match, and record wins, DQs, or BYEs.
5. Let autosave write changes through Go into `data/tournament.json`.
6. Point OBS overlays at the local JSON/assets when those overlay pages are added.

> The frontend does not write files directly. Any save, upload, remove, reset, randomize, or swap operation goes through a Wails-bound Go method.

> The admin SPA background uses the selected game's `assets/{game}/_bg.jpg`. The custom tournament `players/_bg.jpg` is reserved for overlays and should not change the controller UI.

> Current-match side swap is a display override for the selected match. Bracket seed swap changes `bracket.seeds` and does not move `players["1"]`, `players["2"]`, etc.

## Documentation Notes

The code follows the same documentation idea used in SPA.js and SPA.php:

- Project-owned JavaScript files use a file header plus `/** ... */` doc blocks before bootstrappers and named functions.
- Project-owned Go files use a file header plus GoDoc comments before every function, including internal helpers.
- Complex behavior is documented where it lives: BYE advancement in `backend/bracket.go`, filesystem writes in backend upload helpers, and UI/backend boundaries in `frontend/_app.js`.

## License

MIT (c) Andrés Trujillo [Mateus] byUwUr
