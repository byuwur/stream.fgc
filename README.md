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
- **Import Page:** Previews supported external tournament links and imports event/player data into the local JSON.
- **Current Match Control:** Resolves the current match from the bracket template, edits scores, swaps display sides, and prevents score edits after a winner is locked.
- **Bracket Admin:** Shows a resolved bracket, sets current match, records wins/DQs/BYEs, swaps bracket seed assignments, randomizes before play starts, and resets bracket state.
- **Overlay View Setting:** Stores which bracket slice OBS should show without changing the admin bracket view.

## How is it done?

### Core Files [in priority order]

- **main.go:** Starts Wails, embeds `frontend/`, binds the app API, and serves external `assets/` and `players/` folders beside the executable.
- **backend/app.go:** Owns backend state and the mutex used to serialize tournament JSON access.
- **backend/tournament.go:** Loads, normalizes, mutates, and saves `data/tournament.json`.
- **backend/paths.go:** Resolves external folders for dev mode and portable release builds.
- **backend/bracket.go:** Resolves template-driven brackets into admin/overlay projections.
- **backend/assets.go:** Reads game, character, rule, format, and size catalogs from `assets/`.
- **backend/imports.go:** Detects external tournament links, previews provider data, and imports supported providers into local state.
- **backend/portraits.go:** Validates player portrait uploads and writes `players/{player}.png`.
- **backend/event_assets.go:** Validates tournament logo/background uploads and writes `players/_logo.png` and `players/_bg.jpg`.
- **backend/overlays.go:** Opens the local `overlays/` folder from the sidebar through the OS file explorer.
- **frontend/index.html:** Static SPA entry point that loads SPA.js, Bootstrap, Select2, Dropzone, Shards, Font Awesome, and Stream.FGC scripts.
- **frontend/_routes.js:** Defines SPA.js hash routes for event, players, and bracket pages.
- **frontend/_app.js:** Main controller for Wails calls, autosave, catalogs, Select2 rendering, Dropzone uploads, current match, player cards, and bracket controls.
- **frontend/import.html:** External tournament import page fragment.
- **frontend/main.html:** Event editor and Playing Now page fragment.
- **frontend/players.html:** Player editor page fragment.
- **frontend/brackets.html:** Admin bracket page fragment.

### Additional Files

- **frontend/_common.css:** Stream.FGC visual overrides on top of SPA.js, Bootstrap, Shards, and Select2.
- **frontend/_var.js:** SPA.js app-level settings.
- **frontend/sidebar.html:** Shared SPA navigation component.
- **frontend/lang/en.json** and **frontend/lang/es.json:** App language dictionaries.
- **frontend/lang/flags.en.json** and **frontend/lang/flags.es.json:** Localized country names for flag selects.
- **templates/default.json:** Default tournament state used when `data/tournament.json` is missing or empty.
- **templates/{format}{size}.json:** Required bracket templates, such as `double8.json` or `single4.json`. When a matching file is missing, the app shows `[template] template missing`.

### Public Assets

- **assets/games.json:** Game catalog. Keys are saved into tournament JSON.
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

- **overlays/css/bootstrap.min.css**, **overlays/css/shards.css:** Copied framework CSS from SPA.js.
- **overlays/css/overlay.css:** Shared overlay layout, transitions, and visual primitives.
- **overlays/js/jquery.min.js**, **overlays/js/popper.min.js**, **overlays/js/bootstrap.min.js**, **overlays/js/shards.min.js:** Copied framework JS from SPA.js.
- **overlays/js/overlay.js:** Shared JSON polling, current-match resolution, image helpers, and fade-swap updates.
- **overlays/scoreboard.html:** Current match score overlay.
- **overlays/versus.html:** Current match versus screen.
- **overlays/winner.html:** Current match winner overlay.
- **overlays/champion.html:** Tournament champion screen placeholder using the current winner until placement logic exists.
- **overlays/bracket.html:** Bracket overlay that reads the stored overlay view.
- **overlays/bracket_top8.html:** Compatibility redirect to `bracket.html?view=top8`.
- **overlays/intro.html:** Event intro/standby screen.

Overlay pages poll JSON every 1s or 2.5s depending on the page. If the JSON text changes, the shared runtime fades affected fields out, swaps values, and fades them back in instead of hard-replacing the whole page.

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

## Usage

1. Run the app with Wails during development.
2. Use the Import page when an external tournament link should seed the event and player list.
3. Open the Event page to set event info, selected game, format, size, rule, logo, and overlay background.
4. Open the Players page to fill player slots, countries, characters, and portraits.
5. Open the Bracket page to randomize/swap bracket seeds, set the current match, and record wins, DQs, or BYEs.
6. Let autosave write changes through Go into `data/tournament.json`.
7. Point OBS Browser Sources at the needed file in `overlays/`, such as `scoreboard.html`, `versus.html`, `winner.html`, or `bracket.html`.

For regular browser testing, open overlays through HTTP instead of double-clicking them as `file:///` pages. Chrome/Brave block `fetch("../data/tournament.json")` from local files.

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
