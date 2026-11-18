# byuwur/stream.fgc

A local fighting-game tournament controller built with Go, Wails, and [SPA.js](https://github.com/byuwur/spa.js). Manage players, imports, matches, scores, brackets, and artwork, then display them in OBS. No cloud service or database.

Go owns all file mutations. `data/tournament.json` is authoritative; the UI follows backend results and overlays only read.

## Development

Install Go and Wails. The frontend is static HTML/CSS/JavaScript with no frontend install or build step.

```bash
git submodule update --init --recursive
go mod download
wails dev -assetdir frontend -reloaddirs frontend
```

Wails serves `frontend/` and regenerates ignored `frontend/wailsjs/` bindings when backend methods change. Build with `wails build`; only the controller frontend is embedded. Keep `assets/`, `data/`, `overlays/`, `players/`, and `templates/` beside the executable. Development uses the project folders.

## Usage

1. Run the app; optionally import a supported tournament link.
2. Configure the event/game, format, capacity, first-to rule, artwork, players, and seeds.
3. Select matches and record scores, wins, DQs, or BYEs. Autosave writes through Go.
4. Add the overlay pages to OBS.

## OBS overlays

| Page                       | View                             |
| -------------------------- | -------------------------------- |
| `overlays/scoreboard.html` | Current scores.                  |
| `overlays/versus.html`     | Current matchup.                 |
| `overlays/winner.html`     | Match winner.                    |
| `overlays/champion.html`   | Champion after a decisive final. |
| `overlays/bracket.html`    | Stored bracket slice.            |
| `overlays/intro.html`      | Event intro/standby.             |

Use **1920 × 1080** sources. Pages scale to the viewport and poll `../data/tournament.json` every 1 or 2.5 seconds. Test through HTTP, such as `http://localhost/stream.fgc/overlays/scoreboard.html`; normal browsers block sibling JSON reads over `file:///`.

Game artwork lives in `overlays/{game}/`: `_bg.jpg`, `_logo.png`, `intro.png`, `scoreboard.png`, `versus.png`, `winner.png`, `champion.png`, and `bracket.png`. The controller background is `assets/{game}/_bg.jpg`; uploaded `players/_bg.jpg` affects overlays only.

## External imports

Save a start.gg API key on the Import page; it stays in ignored `data/integrations.json` as `{ "startgg": { "api_key": "..." } }`. Local environment overrides are `STARTGG_TOKEN`, `START_GG_TOKEN`, and `STARTGG_API_TOKEN`.

The official GraphQL adapter accepts HTTP(S) links on `start.gg`, `www.start.gg`, `smash.gg`, and `www.smash.gg`. Challonge, Tonamel, and Parry.gg are detected but unimplemented.

Imports copy event metadata and players into local JSON. Provider matches are preview-only; local templates own the bracket. Previews read one page, capped at 512 entrants, 256 matches, and 8 MiB. Local capacity is 64 players; response order is not guaranteed seed order. The UI reports truncation and capacity limits separately.

After saving a key, opt into the live Blink Respawn SF6 preview check:

```powershell
$env:STREAM_FGC_STARTGG_LIVE_TEST="1"
go test ./backend -run TestStartGGLivePreview -count=1 -v
```

## Data Model

| JSON key             | Contents                                                         |
| -------------------- | ---------------------------------------------------------------- |
| `version`, `event`   | Schema version; event name, phase, rule, game, format, capacity. |
| `current`, `players` | Current match ID; records keyed by stable player slot ID.        |
| `matches`, `bracket` | Template-keyed match state; overlay view, seeds, and BYEs.       |

`event.size` is the saved capacity. Editing an existing tournament preserves that capacity if its size catalog is missing or unreadable. Changing capacity requires the requested size in `assets/sizes.json`; reducing it trims unused slots. `event.rule` is numeric (`3` means FT3); scores stay within that limit. Portraits use `players/{player}.png`, with `assets/nopic.png` as UI fallback, rather than saved portrait paths.

## Bracket Model

Format/size selects a template, such as `templates/double8.json` or `templates/robin8.json`. Missing files produce `[template] template missing`; Go does not generate substitutes. Bundled single/double elimination, robin, and Swiss templates cover 2-64 players. Robin includes every pairing; Swiss uses fixed-round seed schedules.

Participants resolve from seeds or previous winners/losers:

| State     | Meaning                 |
| --------- | ----------------------- |
| `player`  | Resolved player.        |
| `tbd`     | Seed without a player.  |
| `bye`     | Intentional empty slot. |
| `pending` | Undecided source match. |

### Results and corrections

- Results are normal, `bye`, or `dq`. Generated setup BYEs do not count as started play; randomization/reset remains available before real matches.
- BYEs propagate through loser paths without requiring a player ID. Slot BYEs do not change global player flags; legacy global BYEs remain supported.
- Corrections/clears reject dependent scores/results, including loser paths. BYE changes reject affected recorded history. Clear results and zero scores from the latest round backward first. Repeated BYE toggles preserve existing results.
- Seed swaps and format/size changes require no real history; reset before reconfiguring. Seed swaps change `bracket.seeds`, not player IDs. Display-side swaps affect only the selected match.

### Finals and champion

Only a completed decisive final produces a champion; otherwise the champion panel clears and hides. Double elimination marks the first final `reset: true` and its reset `reset: true, optional: true`. A reset is required when the undefeated finalist, identified by its winners-bracket source, loses the first final. Otherwise that first final is decisive and stale reset results are ignored. Single-final formats use that final's winner.

## Uploads and saving

Portraits accept **10 MiB**; event artwork **20 MiB**. PNG/JPEG/GIF inputs must fit 8192 pixels per side and 32 million pixels total. Size/headers are checked before decoding; oversized images are rejected. Portraits/logos become PNG; backgrounds become JPEG.

Mutations read current disk state under one app mutex. JSON, credentials, and images are written, synced, closed, then replaced through temporary files; replacement failures preserve the old file. Images decode before locking. Detached forms stop autosave timers/handlers; issued calls may finish.

Windows readers without delete sharing can block replacement/removal. Credential mode `0600` does not establish a private Windows ACL; folder permissions apply. Directory durability after power loss is not guaranteed.

## How is it done?

| Files                                           | Responsibility                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `main.go`, `backend/app.go`                     | Wails startup, bindings, external folders, serialized mutations.             |
| `backend/`                                      | Models/defaults, persistence, templates, brackets, assets, uploads, imports. |
| `frontend/index.html`, `_init.js`, `_routes.js` | Shell, app-owned initialization, hash routes under `frontend/`.              |
| `frontend/_app.js`, `frontend/app/`             | Wails calls, autosave, catalogs, and page controllers.                       |
| `frontend/_common.css`, `sidebar.html`, `lang/` | Appearance, navigation, en/es/ja dictionaries under `frontend/`.             |
| `overlays/js/overlay.js`, `overlays/css/`       | Read-only polling, bracket resolution, scaling, animation, and styles.       |

The frontend uses SPA.js, Bootstrap, Shards, Select2, and jQuery. Reuse `StreamFGC` lifecycle and `byCommon.init()` for fragment/plugin setup. Overlays carry their own libraries. Wails methods return Promises that reject backend errors.

`templates/default.json` supplies defaults. Catalogs live in `assets/{games,rules,formats,sizes}.json`; country aliases/flags in `assets/country_aliases.json` and `assets/flags/`. `assets/{game}/` contains branding, `characters.json`, and character portraits. Uploaded event artwork is `players/_logo.png` and `players/_bg.jpg`.

## Checks

```bash
go test -short -timeout 2m ./backend
go vet ./backend
node --check frontend/_app.js
node --check overlays/js/overlay.js
node --test __tests__/*.test.js
```

[CI](.github/workflows/quality.yml) runs core backend, app/overlay behavior, and authored JavaScript syntax checks on Ubuntu with a five-minute job limit. Go tests have a two-minute execution limit. Enable **extended** on a manual run to repeat the core contracts on Windows. Backend tests cover persistence, tournament/bracket state, imports, and upload boundaries without requiring the Wails desktop toolchain. Live provider checks, full `go test ./...`, and the pinned SPA submodule suite remain manual. New controls and styling do not need individual tests unless they protect a core contract or a real regression. Test packaged Wails/OBS sessions separately.

### SPA runtime upgrades

Review the pinned `frontend/spa.js` revision and reconcile app-owned `frontend/_init.js`, including per-key storage fallback, failed-removal null markers, and recovery. Preserve app paths/environment/settings; submodule updates do not update this copy. Run framework and Stream.FGC integration checks.

## Releases

[Windows x64 ZIP](https://github.com/byuwur/stream.fgc/releases/latest/download/stream.fgc.windows-x64.zip) · [Runtime ZIP](https://github.com/byuwur/stream.fgc/releases/latest/download/stream.fgc.runtime.zip). Filenames stay the same across releases; `manifest.json` records the version and source commit.

[Release workflow](.github/workflows/release.yml) builds a reviewable preview on pushes to `main`, pull requests, and manual runs. Only a pushed version tag publishes a GitHub release. Source/browser checks and the complete distribution build must succeed on both main and tag runs before publication. Failed builds remove their own temporary stage and retain the last completed output. Two-part tags such as `v1.8` and three-part tags such as `v1.8.1` are supported. Keep release tags consistent with the project's source version.

**Windows x64 ZIP:** Wails controller executable with external runtime folders. Extract everything together and run `stream.fgc.exe`. Windows WebView2 Runtime is required.

**Runtime ZIP:** external assets, OBS overlays, templates, and clean starter tournament data for use beside your own executable. It does not contain the controller.

Player uploads, saved tournaments, API keys, and integration settings are excluded. Releases start from `templates/default.json`; keep backups before replacing an existing installation. OBS overlay JSON requests require the documented HTTP serving setup.

Packaging reads only tracked assets, overlays, templates, README, and license. It adds starter data from `templates/default.json`. The Windows build embeds the pinned SPA.js submodule. It never packages the checkout's live `data/` or `players/` files. See [Wails Windows requirements](https://v2.wails.io/docs/v2.15.0/guides/windows/) for WebView2 installation.

### Local preview

Requires Node.js 22 or newer; packaging/test dependencies are private to `.github`. Run from the repository root. In PowerShell, use `npm.cmd` if execution policy blocks `npm`.

```sh
npm --prefix .github ci --ignore-scripts --no-audit --no-fund
node .github/scripts/build.mjs --tag v0.0.0-local
npm --prefix .github run release:test
```

The default local preview builds the runtime ZIP. To include the controller, initialize submodules, run `wails build -clean -platform windows/amd64 -webview2 download`, then `node .github/scripts/build.mjs --tag v0.0.0-local --binary build/bin/stream.fgc.exe`. Go and the project's Wails version are needed for this native build. CI performs that build on Windows.

Open `dist/RELEASE_NOTES.md` for the generated notes and `dist/assets/` for the complete tested output. Download `tested-release` from the workflow run to review CI results. Local commands and manual runs do not publish.

### Script responsibilities

- [release.json](.github/release.json) owns the repository identity, package inventory, and download explanations.
- [build.mjs](.github/scripts/build.mjs) builds runtime ZIPs in a temporary output directory, then writes notes, provenance, and checksums.
- [release.mjs](.github/scripts/release.mjs) reads the real Git history. `--check` validates the exact pushed tag on `main`; `--publish` verifies the tested output and creates or resumes its matching draft before publishing.
- [release tests](.github/tests/release.mjs) verify checksums, ZIP inventories, and the distributed runtime folders and clean starter state. [Publication tests](.github/tests/publish-release.mjs) verify draft ownership, interrupted uploads, integrity, and reruns with a mock GitHub API.

The workflow uses read-only access while building/testing, passes the exact tested output to a separate publication job, and grants write access only there. Published releases are never overwritten. A failed upload leaves a draft that the same tested build can resume. Tag pushes and live release publication are separate from local validation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODING_STANDARDS.md](CODING_STANDARDS.md). Keep filesystem access in Go, overlays read-only, and feature behavior near its owner.

## License

MIT (c) Andrés Trujillo [Mateus] byUwUr

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/byuwur/stream.fgc)
