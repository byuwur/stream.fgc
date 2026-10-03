# byuwur/stream.fgc

**Set up your tourney quickly!**

A local fighting-game tournament controller built with Go, Wails, and [SPA.js](https://github.com/byuwur/spa.js). Edit players, matches, scores, brackets, and visual assets, then show them in OBS. No cloud service or database.

The desktop app writes `data/tournament.json`. Static overlays read that file and render the stream views.

## What does it do?

- Edits event details, game, first-to rule, format, capacity, logo, and background.
- Manages players, countries, characters, and portraits.
- Previews and imports start.gg event/player data.
- Controls the current match, scores, display sides, wins, DQs, and BYEs.
- Swaps/randomizes bracket seeds before play and stores a separate OBS bracket view.
- Provides scoreboard, versus, winner, champion, intro, and bracket overlays.

## Development

You need Go and Wails. The frontend is static HTML/CSS/JavaScript; there is no React, Vite, frontend install, or frontend build step.

```bash
git submodule update --init --recursive
go mod download
wails dev -assetdir frontend -reloaddirs frontend
```

Wails serves `frontend/` directly and regenerates ignored `frontend/wailsjs/` bindings when backend methods change. The explicit asset/reload paths work across Windows, Linux, and macOS.

Build a portable executable:

```bash
wails build
```

Only the controller frontend is embedded. Keep `assets/`, `data/`, `overlays/`, `players/`, and `templates/` beside the release executable. Development uses those folders in the project directory.

Binding obfuscation is disabled: Garble does not protect local data, slows verification, and randomized Windows executables can trigger Defender false positives.

## Usage

1. Run the app.
2. Use **Import** if you want to start from a supported tournament link.
3. Set event details, game, format, size, rule, logo, and background.
4. Fill player names, countries, characters, and portraits.
5. Set bracket seeds and the current match; record scores, wins, DQs, or BYEs.
6. Let autosave write changes through Go into `data/tournament.json`.
7. Add the required `overlays/` pages as OBS Browser sources.

Only Go writes files. Save, upload, remove, reset, randomize, and swap actions go through Wails-bound methods. The UI follows backend results; overlays are read-only.

## OBS overlays

| Page | View |
| --- | --- |
| `overlays/scoreboard.html` | Current match scores. |
| `overlays/versus.html` | Current match versus screen. |
| `overlays/winner.html` | Current match winner. |
| `overlays/champion.html` | Tournament champion after a decisive final. |
| `overlays/bracket.html` | Stored bracket slice. |
| `overlays/intro.html` | Event intro/standby screen. |

Use a **1920 × 1080** source. Pages scale that canvas to fit the browser viewport and read `../data/tournament.json` plus sibling asset folders. They poll every 1 or 2.5 seconds, depending on the page. Changed values fade out, update, then return with `fadeInUp`.

Test through HTTP, for example `http://localhost/stream.fgc/overlays/scoreboard.html`. Normal browsers block sibling JSON reads over `file:///`; OBS may behave differently.

Keep game-specific artwork at matching paths:

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

The controller uses `assets/{game}/_bg.jpg`. Uploaded `players/_bg.jpg` changes overlays only. Display-side swaps affect the selected match; seed swaps change `bracket.seeds`, not player slot IDs.

## External imports

start.gg uses its official GraphQL API. Save the key in the Import page; it goes into ignored `data/integrations.json`:

```json
{ "startgg": { "api_key": "..." } }
```

`STARTGG_TOKEN`, `START_GG_TOKEN`, and `STARTGG_API_TOKEN` remain local overrides. Challonge, Tonamel, and Parry.gg links are detected but their adapters are not implemented.

Imports bring event metadata and player slots into the local JSON. Provider matches are preview-only; local templates still control the bracket.

Accepted start.gg hosts are `start.gg`, `www.start.gg`, `smash.gg`, and `www.smash.gg` over HTTP(S). Similar names in other hosts, paths, or queries do not select that provider.

Previews read one page, up to 512 entrants and 256 matches, with an 8 MiB response limit. The UI reports these limits, entrant shortfalls, and the local 64-player capacity separately. Players are imported in response order, not guaranteed provider seed order. A complete provider bracket is not promised.

The live parser test is opt-in. Save a key and run the real import path against the Blink Respawn SF6 event:

```powershell
$env:STREAM_FGC_STARTGG_LIVE_TEST="1"
go test ./backend -run TestStartGGLivePreview -count=1 -v
```

## Data Model

`data/tournament.json` is the source of truth.

| Key | Contents |
| --- | --- |
| `version` | Schema version. |
| `event` | Name, phase, rule, game, format, and size. |
| `current` | Current match ID. |
| `players` | Records keyed by stable player slot ID. |
| `matches` | State keyed by template match ID. |
| `bracket` | Overlay view, seed assignments, and BYEs. |

`event.size` is bracket capacity, not necessarily the real player count. Reducing it trims unused player slots. `event.rule` is numeric (`3` means FT3); scores stay between zero and the active first-to limit.

Player records do not store portrait paths. Portraits come from `players/{player}.png`, with `assets/nopic.png` as the UI fallback.

## Bracket Model

Templates define bracket shape. Participants come from a seed assignment, another match's winner, or another match's loser.

| Participant state | Meaning |
| --- | --- |
| `player` | A real player is resolved. |
| `tbd` | The seed exists but has no player yet. |
| `bye` | The seed slot is intentionally a BYE. |
| `pending` | The source match has not been decided. |

Format and size select a template: `double_elimination` with `8` uses `templates/double8.json`; `robin` with `8` uses `templates/robin8.json`. A catalog size without a matching file produces `[template] template missing`; Go does not generate a substitute bracket.

Bundled templates cover 2–64 players for single elimination, double elimination, robin, and Swiss. Robin includes every seed pairing. Swiss currently uses fixed-round seed schedules, not dynamic re-pairing.

### Results and corrections

- Results can be normal, `bye`, or `dq`. Generated setup BYEs do not count as started play, so setup randomization/reset remains available before real matches begin.
- A generated BYE stays a BYE along dependent loser paths even without a player ID. Slot BYEs do not alter a player's global BYE flag; legacy global BYEs remain supported. Slot toggles recalculate generated results.
- Corrections and clears reject when a dependent match has scores or recorded results, including loser paths and later rounds. Clear results and zero scores from the latest round backward before correcting the ancestor.
- BYE changes also reject affected recorded history; repeated toggles preserve the current result. Unrelated results and display-side swaps remain unchanged.
- Seed swaps and format/size changes reject while real history exists. Reset explicitly before reconfiguring. Generated setup BYEs do not block these actions.
- Detached autosave forms release timers, handlers, and registrations and cannot enqueue more saves. Already-issued backend calls may finish.

### Finals and champion

Ordinary match winners never become tournament champions. Without a completed decisive final, the champion screen clears its old name and hides the panel.

Double-elimination templates mark the first final `reset: true` and the reset match `reset: true, optional: true`. A reset is needed only when the undefeated finalist, identified by its winners-bracket source, loses the first final. There is no champion until that reset finishes. If the undefeated side wins the first final, it is decisive; stale ineligible reset results are ignored. Formats with one final use its winner.

## Uploads and saving

Portraits accept up to **10 MiB**; event logos/backgrounds accept up to **20 MiB**. PNG, JPEG, and GIF sources must be at most 8192 pixels per side and 32 million pixels total. Base64 size and image headers are checked before decode. Oversize images are rejected, not resized. Portraits/logos become PNG; backgrounds become JPEG.

Tournament JSON, credentials, portraits, and event assets are written completely, synced, closed, then replaced using a temporary file. Failed replacement keeps the old file and removes the temporary file. One app mutex orders writes/removals; images decode before that lock.

Windows readers can block replacement/removal if they do not allow delete sharing; the operator receives that failure. Credential files request mode `0600`, but Windows access depends on folder permissions, not a private ACL from that mode. Directory durability after power loss is not guaranteed.

## How is it done?

The backend is one Go package split by responsibility. The frontend uses SPA.js, Bootstrap, Shards, Select2, and jQuery.

| Files | Responsibility |
| --- | --- |
| `main.go`, `backend/app.go` | Wails startup/bindings, embedded frontend, external folders, serialized mutations. |
| `backend/models.go`, `backend/normalization.go` | Data shapes, migration, defaults, score limits, and cleanup. |
| `backend/storage.go`, `backend/paths.go` | Atomic persistence and development/release paths. |
| `backend/tournament.go`, `backend/templates.go` | Mutations, template selection, and participant sources. |
| `backend/seeding.go`, `backend/bracket.go` | Seeds, BYEs, randomization, and bracket projections. |
| `backend/assets.go`, `backend/portraits.go`, `backend/event_assets.go` | Catalogs and validated image uploads. |
| `backend/integrations.go`, `backend/imports.go`, `backend/imports_startgg.go` | Local credentials, import flow, and start.gg adapter. |
| `backend/overlays.go` | Open the overlay folder in the OS explorer. |
| `frontend/index.html`, `frontend/_init.js`, `frontend/_routes.js` | Application shell, initialization, and hash routes. |
| `frontend/_app.js` | Wails calls, status, autosave, catalogs, Select2, assets, event/current-match behavior. |
| `frontend/app/import.js`, `players.js`, `bracket.js` | Page controllers under `frontend/app/`. |
| `frontend/import.html`, `main.html`, `players.html`, `brackets.html` | Routed fragments under `frontend/`. |
| `frontend/_common.css`, `sidebar.html`, `lang/` | Visual overrides, navigation, en/es/ja dictionaries, and localized flag names. |
| `overlays/js/overlay.js`, `overlays/css/overlay.css` | Polling, template resolution, scaling, fallbacks, animation, and stage layout. |
| `overlays/css/_common.css` | Overlay reset and Michroma font. |

Overlays carry their own Bootstrap/Animate.css and jQuery/Popper/Bootstrap files under `overlays/css/` and `overlays/js/`.

### Assets

- `templates/default.json` supplies new/empty tournament defaults; `templates/{format}{size}.json` defines brackets.
- `assets/games.json`, `rules.json`, `formats.json`, and `sizes.json` define catalogs. Game/character keys go into JSON; rule keys become numbers.
- `assets/country_aliases.json` maps provider country names to ISO2 codes. Flags live at `assets/flags/{iso2}.svg`.
- `assets/{game}/` contains `_logo.png`, `_bg.jpg`, `characters.json`, and `portraits/{character}.png`.
- `assets/michroma.ttf` is the shared font. `nopic.png`, `nobg.jpg`, and `stream.fgc.png` are fallback/branding images.
- `players/{player}.png`, `players/_logo.png`, and `players/_bg.jpg` hold uploaded player/event artwork.

<details>
<summary>Reading the Go code</summary>

`module stream.fgc` gives imports their prefix (`stream.fgc/backend`). Files with `package backend` compile together; splitting files does not add runtime layers.

Exported methods such as `func (a *App) UpdateEvent(...)` belong to the Wails-bound app. A `(value, error)` return becomes a JavaScript Promise, rejecting on a non-nil error. Struct `json` tags define the exact saved keys.

`App.mu` serializes read-modify-write operations without a second cached tournament state: each mutation starts from disk. Temporary-file replacement prevents partial saves from truncating live JSON. `//go:build` selects special commands; the manually tagged start.gg smoke command is excluded from ordinary builds/tests.

</details>

## Checks

```bash
go test ./...
go vet ./...
node --check frontend/_app.js
node --check overlays/js/overlay.js
node --test tests/*.test.js
node --test frontend/spa.js/tests/*.test.js
```

The quality workflow runs Go checks, app/overlay behavior tests, the pinned SPA.js suite, and JavaScript syntax checks on Ubuntu and Windows. Tests use temporary folders and deterministic provider responses; live imports stay opt-in. These checks do not replace testing a packaged Wails/OBS session.

### SPA runtime upgrades

The recorded frontend pin is `35b14ede40909cfb18a54a33853ee03586d3a93d`. `frontend/_init.js` is an application-owned copy and adopts per-key storage fallback, failed-removal null markers, and explicit recovery.

When upgrading, review and reconcile that initializer while preserving paths, environment, and settings. A submodule update does not update it. Run both framework and Stream.FGC integration tests plus the normal checks above.

## Coding Conventions

**Simple is complicated enough.** Keep feature flows close to their page or backend owner. Prefer readable repetition over helpers that hide business behavior.

Use Bootstrap utilities before custom CSS; keep CSS for dimensions, media, bracket geometry, and identity. Use jQuery or direct browser APIs wherever each is clearer. Reuse the `StreamFGC` lifecycle and `byCommon.init()` instead of duplicating fragment hooks or plugin setup. Keep filesystem access in Go and overlays read-only.

Document public functions and non-obvious intent near the implementation. Existing file headers and GoDoc/JSDoc conventions are described by the project's [coding standards](CODING_STANDARDS.md). Add dependencies only when the existing tools cannot solve the problem clearly.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and [CODING_STANDARDS.md](CODING_STANDARDS.md) for engineering standards.

## License

MIT (c) Andrés Trujillo [Mateus] byUwUr
