# byuwur/stream.fgc

**Set up your tourney quickly!**

~ For the FGC made easy, with love, for the FGC, with Go. ~

## Overview

This project is designed to provide various overlay options for live streaming tournaments using OBS (Open Broadcaster Software).

## Current Architecture

Stream.FGC is a local Wails desktop app. The backend is Go, the frontend is plain HTML/CSS/JavaScript using the SPA.js submodule libraries already present in `frontend/dist/spa.js`.

- Tournament state lives in `data/tournament.json`.
- External tournament assets live in `assets/`.
- Player portraits live in `players/`.
- Bracket templates live in `templates/`, but the backend can generate a template when a size/format file is missing.
- OBS-facing pages are standalone files in `frontend/dist/`, separate from admin SPA fragments.

## Bracket Model

`event.size` means bracket capacity, not the number of real players currently checked in. The backend normalizes player seed slots `1..size` so a bracket can render consistently even when some players are blank.

Participant states:

- `player`: a real player seed has a name.
- `tbd`: a seed slot exists but is blank.
- `bye`: reserved for intentional free advancement with `bye: true`.
- `pending`: a winner/loser source has not been decided yet.

The backend exposes a resolved `BracketProjection` through `GetBracketView(view)`. Admin and overlay pages both render that same projection, so their bracket logic stays aligned. The admin bracket page intentionally requests `all`; changing the overlay view selector only changes what `bracket.html` renders.

Overlay selection is stored in `tournament.json` at `bracket.overlay_view`. Supported views are:

- `all`
- `winners`
- `losers`
- `finals`

The admin route uses `frontend/dist/brackets.html`. The OBS-style standalone overlay is `bracket.html`.

Admin match controls use winner saves for normal wins. DQs use a reasoned match result with `reason: "dq"`. BYE is separate: it marks a seeded player slot with `bye: true`, writes auto-advanced matches with `reason: "bye"`, and lets the backend move the non-BYE participant through template-defined winner/loser sources.

Setup controls are backend-owned too. `ResetBracket()` clears match state, bracket seed assignments, and setup BYEs while keeping player records intact. `RandomizeBracketSeeds()` shuffles `bracket.seeds` only when no real match score/result has been recorded; auto-advanced BYE matches do not count as started. `SwapBracketSeeds(seed, targetSeed)` powers the click-to-swap player controls on the bracket and current-match views, swapping bracket assignments instead of moving `players["1"]`, `players["2"]`, etc.

Key backend entry points:

- `GetBracketView(view)`
- `SetBracketOverlayView(view)`
- `SetCurrentMatch(matchID)`
- `SetMatchWinner(matchID, winnerPlayerID)`
- `SetMatchResult(matchID, winnerPlayerID, reason)`
- `SetMatchParticipantBye(matchID, side, bye)`
- `ResetBracket()`
- `RandomizeBracketSeeds()`
- `SwapBracketSeeds(seed, targetSeed)`
- `UpdateMatchScore(matchID, player1Score, player2Score)`

## License

MIT (c) Andrés Trujillo [Mateus] byUwUr
