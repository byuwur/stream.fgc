"use strict";

/*
 * File: app/bracket.js
 * Desc: Bracket manager and bracket preview controller.
 * Deps: _app.js shared StreamFGC runtime and the Wails backend bindings.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
/**
 * Registers this page controller on the shared Stream.FGC browser namespace.
 * @param {Window} global Browser window provided by Wails WebView or a regular browser.
 */
(function (global) {
	const fgc = global.StreamFGC;
	if (!fgc) throw new Error("StreamFGC core must load before app/bracket.js");

	const {
		applyLanguage,
		bracketParticipantMediaHTML,
		bracketSwapSeedFromTarget,
		captureScrollState,
		clampScore,
		countryFlagPath,
		destroySelect,
		enhanceSelects,
		ensureCharacterCatalog,
		escapeHtml,
		eventRuleLimit,
		isCurrentBracketLoad,
		isISO2Code,
		nextBracketLoadTicket,
		parseRuleValue,
		participantMeta,
		participantName,
		restoreScrollState,
		scoreStepperHTML,
		setBracketStatus,
		setImageFallback,
		setSeedSelection,
		swappableParticipantSeed,
		t,
		waitForBackend,
		withTimeout,
	} = fgc;
	const { BRACKET_ADMIN_VIEW, BRACKET_OVERLAY_REFRESH_MS, BRACKET_PAGE, EMPTY_STATE_CLASS } = fgc.constants;
	const bracketSeedSelections = new WeakMap();


	/** Returns the localized label for a bracket match status. */
	function bracketStatusLabel(status) {
		const labels = {
			bye: t("bracket.status.bye", "BYE"),
			complete: t("bracket.status.complete", "Complete"),
			pending: t("bracket.status.pending", "Pending"),
			ready: t("bracket.status.ready_match", "Ready"),
		};
		return labels[status] || status || t("bracket.status.pending", "Pending");
	}

	/** Normalizes bracket view keys for backend and static overlay rendering. */
	function normalizeBracketView(view) {
		const key = String(view || "").toLowerCase().trim();
		if (["winners", "winner", "upper"].includes(key)) return "winners";
		if (["losers", "loser", "lower"].includes(key)) return "losers";
		if (["finals", "final", "grand", "grand_finals"].includes(key)) return "finals";
		if (["top8", "top", "top_8", "top-8"].includes(key)) return "top8";
		return "all";
	}

	/** Finds a view option in a backend bracket projection. */
	function bracketViewName(projection, viewKey = "") {
		const key = viewKey || projection?.view || "";
		const view = projection?.views?.find(function (option) {
			return option.key === key;
		});
		return view?.name || key || "";
	}

	/** Returns the active admin manager view from the Select2-backed control. */
	function bracketManagerView(page) {
		const select = page?.querySelector?.("[data-bracket-manager-view-select]");
		if (select instanceof HTMLSelectElement && select.value) return normalizeBracketView(select.value);
		return normalizeBracketView(fgc.currentState?.bracket?.manager_view || BRACKET_ADMIN_VIEW);
	}

	/** Loads the saved manager view before the bracket page has rendered its select. */
	async function savedBracketManagerView(app) {
		if (fgc.currentState?.bracket?.manager_view) return normalizeBracketView(fgc.currentState.bracket.manager_view);
		if (typeof app?.LoadTournament === "function") {
			fgc.currentState = await withTimeout(app.LoadTournament(), 5000, "Tournament load timed out");
			return normalizeBracketView(fgc.currentState?.bracket?.manager_view || BRACKET_ADMIN_VIEW);
		}
		return BRACKET_ADMIN_VIEW;
	}

	/** Builds the compact summary shown above admin and overlay brackets. */
	function bracketSummary(projection, admin = false) {
		if (projection?.error) return projection.error;
		const template = admin
			? t("bracket.admin_summary", "{players}/{size} players - {matches} matches - Admin: {view} - Overlay: {overlay}")
			: t("bracket.summary", "{players}/{size} players - {matches} matches - {view}");
		return template
			.replace("{players}", String(projection?.player_count ?? 0))
			.replace("{size}", String(projection?.size ?? 0))
			.replace("{matches}", String(projection?.match_count ?? 0))
			.replace("{view}", bracketViewName(projection))
			.replace("{overlay}", bracketViewName(projection, projection?.overlay_view));
	}

	/** Returns the compact label for an exceptional match result reason. */
	function bracketResultReasonLabel(reason) {
		switch (String(reason || "").toLowerCase()) {
		case "bye":
			return t("bracket.result.bye", "BYE");
		case "dq":
			return t("bracket.result.dq", "DQ");
		default:
			return "";
		}
	}

	/** Rebuilds one bracket view select while keeping Select2 synchronized. */
	function renderBracketViewSelect(root, selector, options, selectedView) {
		const select = root.querySelector(selector);
		if (!(select instanceof HTMLSelectElement)) return;
		destroySelect(select);
		select.innerHTML = (options || [])
			.map(function (option) {
				const selected = option.key === selectedView ? " selected" : "";
				return `<option value="${escapeHtml(option.key)}"${selected}>${escapeHtml(option.name)}</option>`;
			})
			.join("");
		select.value = selectedView;
	}

	/** Writes projection metadata into the optional view selectors and summary. */
	function renderBracketHeader(root, projection) {
		const admin = root.matches(BRACKET_PAGE);
		root.dataset.rule = String(parseRuleValue(projection?.event?.rule || fgc.currentState?.event?.rule || 3) || 3);
		const summary = root.querySelector("[data-bracket-summary]");
		if (summary) summary.textContent = bracketSummary(projection, admin);

		const eventLabel = root.querySelector("[data-bracket-overlay-event]");
		if (eventLabel) eventLabel.textContent = [projection?.event?.name, projection?.event?.phase].filter(Boolean).join(" · ") || "Stream.FGC";

		const title = root.querySelector("[data-bracket-overlay-title]");
		if (title) title.textContent = bracketViewName(projection) || t("bracket.title", "Bracket");

		const randomize = root.querySelector("[data-bracket-randomize]");
		if (randomize instanceof HTMLButtonElement) {
			randomize.disabled = !projection?.can_randomize;
			randomize.dataset.started = projection?.started ? "true" : "false";
		}

		const options = projection?.views || [];
		renderBracketViewSelect(root, "[data-bracket-overlay-view-select]", options, projection?.overlay_view || BRACKET_ADMIN_VIEW);
		renderBracketViewSelect(root, "[data-bracket-manager-view-select]", options, projection?.manager_view || projection?.view || BRACKET_ADMIN_VIEW);
		enhanceSelects(root);
	}

	/** Returns one participant line for the bracket board. */
	function bracketParticipantHTML(participant, score, match, side, admin, projection) {
		const status = participant?.status || "pending";
		const playerID = participant?.player_id || "";
		const name = participantName(participant);
		const team = participantMeta(participant);
		const matchWinnerID = String(match?.winner_id || match?.winnerId || match?.state?.winner || "");
		const matchLoserID = String(match?.loser_id || match?.loserId || match?.state?.loser || "");
		const complete = match?.status === "complete" || Boolean(matchWinnerID);
		const winner = Boolean(playerID && playerID === matchWinnerID);
		const loser = Boolean(playerID && (playerID === matchLoserID || (!matchLoserID && complete && !winner && participant?.resolved)));
		const inferredReason = !match?.state?.reason && complete && (match?.player1?.status === "bye" || match?.player2?.status === "bye") ? "bye" : "";
		const reasonKey = match?.state?.reason || match?.reason || inferredReason;
		const reason = bracketResultReasonLabel(reasonKey);
		const country = String(participant?.player?.country || "").toUpperCase();
		const seed = swappableParticipantSeed(participant);
		const controlsLocked = admin && complete;
		const swapAttrs = admin && seed && !controlsLocked ? ` data-bracket-seed-player data-seed="${seed}"` : "";
		const flag = participant?.resolved && isISO2Code(country) && status !== "bye"
			? [
					`<span class="d-inline-flex flex-column gap-1 align-items-center flex-shrink-0" data-bracket-country>`,
					`<img class="rounded-1" src="${escapeHtml(countryFlagPath(country))}" alt="" loading="lazy" data-flag-image style="width: 1.25rem; height: 0.88rem; object-fit: cover; box-shadow: 0 0 0 1px var(--fgc-border);" />`,
					`<span class="fw-bold lh-1" data-bracket-country-code>${escapeHtml(country)}</span>`,
					`</span>`,
				].join("")
			: "";
		const scoreControl = admin && !controlsLocked
			? scoreStepperHTML(score, { side, matchID: match?.id || "", prefix: "bracket", compact: true, limit: parseRuleValue(projection?.event?.rule || fgc.currentState?.event?.rule || 3) || 3 })
			: `<span class="fgc-title fs-6">${Number(score || 0)}</span>`;
		const actionControls = controlsLocked ? "" : bracketParticipantActionsHTML(match, side, admin);
		const swapLabel = t("bracket.swap_player", "Select player to swap");
		return [
			`<div class="border rounded px-2 py-2 ${winner ? "border-success" : ""} ${loser ? "border-danger" : ""}" data-bracket-participant data-status="${escapeHtml(status)}" data-outcome="${winner ? "winner" : loser ? "loser" : ""}"${winner ? ` data-winner="true"` : ""}${loser ? ` data-loser="true"` : ""}${swapAttrs}>`,
			`<div class="d-flex flex-nowrap gap-2 align-items-center">`,
			`<span class="small fw-bold flex-shrink-0" style="color: var(--fgc-brand-soft);">${escapeHtml(playerID || "-")}</span>`,
			flag,
			bracketParticipantMediaHTML(participant),
			`<span class="min-w-0 flex-grow-1">`,
			`<span class="d-block fw-bold text-truncate">${escapeHtml(name)}</span>`,
			team ? `<span class="d-block small text-truncate" style="color: var(--fgc-text-muted);">${escapeHtml(team)}</span>` : "",
			`</span>`,
			reason && (winner || loser) ? `<span class="badge rounded-pill border flex-shrink-0" data-bracket-reason="${escapeHtml(reasonKey)}">${escapeHtml(reason)}</span>` : "",
			`<div class="d-flex flex-nowrap gap-1 align-items-center justify-content-end flex-shrink-0 ms-2" data-bracket-player-controls>`,
			scoreControl,
			actionControls,
			swapAttrs && !controlsLocked
				? `<button class="btn btn-outline-light btn-sm d-inline-flex align-items-center justify-content-center flex-shrink-0" type="button" data-bracket-seed-swap="${seed}" title="${escapeHtml(swapLabel)}" aria-label="${escapeHtml(swapLabel)}" style="width: 1.9rem; height: 1.9rem;"><i class="fas fa-exchange-alt" aria-hidden="true"></i></button>`
				: "",
			`</div>`,
			`</div>`,
			`</div>`,
		].join("");
	}

	/** Builds admin-only result controls for one bracket participant row, hidden after completion. */
	function bracketParticipantActionsHTML(match, side, admin) {
		if (!admin) return "";
		if (match?.status === "complete" || match?.winner_id || match?.state?.winner) return "";
		const p1 = match?.player1?.player_id || "";
		const p2 = match?.player2?.player_id || "";
		const canDecide = Boolean(match?.can_decide);
		const playerID = side === 1 ? p1 : p2;
		const opponentID = side === 1 ? p2 : p1;
		const seedParticipant = (side === 1 ? match?.player1 : match?.player2)?.source?.type === "seed";
		const bye = (side === 1 ? match?.player1 : match?.player2)?.status === "bye";
		const winLabel = t("bracket.win.title", "Mark this player as the winner");
		const dqLabel = t("bracket.dq.title", "Disqualify this player");
		const byeLabel = bye ? t("bracket.live.title", "Remove BYE from this player") : t("bracket.bye.title", "Give this player a BYE");
		return [
			canDecide
				? `<button class="btn btn-outline-success btn-sm" type="button" data-bracket-action data-bracket-winner="${escapeHtml(match.id)}" data-player-id="${escapeHtml(playerID)}" title="${escapeHtml(winLabel)}" aria-label="${escapeHtml(winLabel)}">${escapeHtml(t("bracket.win", "Win"))}</button>`
				: "",
			canDecide
				? `<button class="btn btn-outline-danger btn-sm" type="button" data-bracket-action data-bracket-winner="${escapeHtml(match.id)}" data-player-id="${escapeHtml(opponentID)}" data-result-reason="dq" title="${escapeHtml(dqLabel)}" aria-label="${escapeHtml(dqLabel)}">${escapeHtml(t("bracket.dq", "DQ"))}</button>`
				: "",
			seedParticipant
				? `<button class="btn btn-outline-warning btn-sm" type="button" data-bracket-action data-bracket-bye="${escapeHtml(match.id)}" data-side="${side}" data-bye="${bye ? "false" : "true"}" title="${escapeHtml(byeLabel)}" aria-label="${escapeHtml(byeLabel)}">${escapeHtml(bye ? t("bracket.live", "Live") : t("bracket.bye", "BYE"))}</button>`
				: "",
		].join("");
	}

	/** Builds admin-only match-level controls that are not tied to one player. */
	function bracketMatchActionsHTML(match, admin) {
		if (!admin) return "";
		const current = match?.current ? " disabled" : "";
		const currentLabel = match?.current ? t("bracket.current", "Current") : t("bracket.set_current", "Current");
		const currentTitle = match?.current ? t("bracket.current", "Current") : t("bracket.set_current.title", "Set this match as the current match");
		const clearTitle = t("bracket.clear_winner", "Clear winner");
		const currentButton = `<button class="btn btn-outline-light btn-sm d-inline-flex gap-2 align-items-center" type="button" data-bracket-action data-bracket-current="${escapeHtml(match.id)}" title="${escapeHtml(currentTitle)}" aria-label="${escapeHtml(currentTitle)}"${current}><i class="fas fa-crosshairs" aria-hidden="true"></i><span>${escapeHtml(currentLabel)}</span></button>`;
		const complete = match?.status === "complete" || Boolean(match?.winner_id || match?.state?.winner);
		if (complete) {
			return [
				`<div class="d-flex flex-wrap gap-2 mt-2">`,
				currentButton,
				match?.winner_id || match?.state?.winner ? `<button class="btn btn-outline-light btn-sm" type="button" data-bracket-action data-bracket-clear="${escapeHtml(match.id)}" title="${escapeHtml(clearTitle)}" aria-label="${escapeHtml(clearTitle)}">${escapeHtml(t("bracket.clear", "Clear"))}</button>` : "",
				`</div>`,
			].join("");
		}
		return [
			`<div class="d-flex flex-wrap gap-2 mt-2">`,
			currentButton,
			match?.winner_id ? `<button class="btn btn-outline-light btn-sm" type="button" data-bracket-action data-bracket-clear="${escapeHtml(match.id)}" title="${escapeHtml(clearTitle)}" aria-label="${escapeHtml(clearTitle)}">${escapeHtml(t("bracket.clear", "Clear"))}</button>` : "",
			`</div>`,
		].join("");
	}

	/** Builds one bracket match card. */
	function bracketMatchHTML(match, admin, projection) {
		const scoreLimit = parseRuleValue(projection?.event?.rule || fgc.currentState?.event?.rule || 3) || 3;
		const score1 = clampScore(match?.state?.player1_score || 0, scoreLimit);
		const score2 = clampScore(match?.state?.player2_score || 0, scoreLimit);
		return [
			`<article class="w-100" data-bracket-match-wrap>`,
			`<div class="h-100 border rounded p-2 ${match?.current ? "border-danger" : ""}" data-bracket-match data-status="${escapeHtml(match?.status || "pending")}">`,
			`<div class="d-flex gap-2 align-items-start justify-content-between mb-2">`,
			`<div class="min-w-0">`,
			`<p class="fgc-kicker m-0">${escapeHtml(match?.id || "")}</p>`,
			`<h4 class="fgc-title fs-6 lh-sm m-0 text-truncate">${escapeHtml(match?.name || t("bracket.match", "Match"))}</h4>`,
			`</div>`,
			`<span class="badge rounded-pill text-bg-dark border" data-bracket-status-pill>${escapeHtml(bracketStatusLabel(match?.status))}</span>`,
			`</div>`,
			`<div class="d-flex flex-column gap-2">`,
			bracketParticipantHTML(match?.player1, score1, match, 1, admin, projection),
			bracketParticipantHTML(match?.player2, score2, match, 2, admin, projection),
			`</div>`,
			bracketMatchActionsHTML(match, admin),
			`</div>`,
			`</article>`,
		].join("");
	}

	/** Builds one bracket section with Bootstrap columns for rounds. */
	function bracketSectionHTML(section, admin, projection) {
		const rounds = section?.rounds || [];
		return [
			`<section class="col-12 mb-3" data-bracket-section="${escapeHtml(section?.key || "")}">`,
			`<div class="d-flex flex-column gap-3">`,
			`<div class="d-flex gap-2 align-items-baseline">`,
			`<p class="fgc-kicker m-0">${escapeHtml(section?.name || "")}</p>`,
			`<span class="small" style="color: var(--fgc-text-muted);">${rounds.length}</span>`,
			`</div>`,
			`<div class="d-flex flex-nowrap overflow-auto pb-2" data-bracket-lane>`,
			rounds
				.map(function (round) {
					const matches = (round.matches || []).map(function (match) {
						return bracketMatchHTML(match, admin, projection);
					});
					return [
						`<div class="flex-shrink-0 pe-4" data-bracket-round>`,
						`<div class="w-100 d-flex flex-column gap-2">`,
						`<h3 class="fgc-title fs-6 lh-sm m-0">${escapeHtml(round.name || "")}</h3>`,
						`<div class="d-flex flex-column gap-3" data-bracket-round-matches>`,
						matches.join(""),
						`</div>`,
						`</div>`,
						`</div>`,
					].join("");
				})
				.join(""),
			`</div>`,
			`</div>`,
			`</section>`,
		].join("");
	}

	/** Draws a backend bracket projection into either admin or overlay root. */
	function renderBracketProjection(root, projection, admin = false) {
		renderBracketHeader(root, projection);
		const board = root.querySelector("[data-bracket-board]");
		if (!board) return;
		const error = String(projection?.error || "");
		if (error) {
			board.innerHTML = `<div class="col-12"><div class="${EMPTY_STATE_CLASS}">${escapeHtml(error)}</div></div>`;
			return;
		}
		const sections = projection?.sections || [];
		board.innerHTML = sections.length
			? sections
					.map(function (section) {
						return bracketSectionHTML(section, admin, projection);
					})
					.join("")
			: `<div class="col-12"><div class="${EMPTY_STATE_CLASS}">${escapeHtml(t("bracket.empty", "No bracket matches found."))}</div></div>`;
		board.querySelectorAll("[data-flag-image]").forEach(function (image) {
			if (!(image instanceof HTMLImageElement)) return;
			image.addEventListener("error", function () {
				image.remove();
			});
		});
		board.querySelectorAll("[data-fallback-image]").forEach(function (image) {
			setImageFallback(image);
		});
		applyLanguage(board);
	}

	/** Loads the bracket projection through Wails. */
	async function loadBracket(root, requestedView = "") {
		const scrollState = captureScrollState(root);
		const ticket = nextBracketLoadTicket(root);
		const app = await waitForBackend();
		const admin = root.matches(BRACKET_PAGE);
		try {
			if (!app || typeof app.GetBracketView !== "function") {
				const board = root.querySelector("[data-bracket-board]");
				if (board) board.innerHTML = `<div class="col-12"><div class="${EMPTY_STATE_CLASS}">${escapeHtml(t("bracket.status.backend_missing", "Open in Wails to edit tournament JSON."))}</div></div>`;
				setBracketStatus(root, "bracket.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
				return null;
			}

			setBracketStatus(root, "bracket.status.loading", "Loading bracket...", "neutral");
			const view = admin ? requestedView || (await savedBracketManagerView(app)) : requestedView;
			const projection = await withTimeout(app.GetBracketView(view), 5000, "Bracket load timed out");
			if (!isCurrentBracketLoad(root, ticket)) return projection;
			await ensureCharacterCatalog(app, projection?.event?.game || "");
			renderBracketProjection(root, projection, admin);
			if (projection?.error) {
				setBracketStatus(root, "bracket_status_template_missing", projection.error, "warning");
			} else {
				setBracketStatus(root, "bracket.status.ready", "Bracket ready", "success");
			}
			return projection;
		} catch (error) {
			if (!isCurrentBracketLoad(root, ticket)) return null;
			console.error("GetBracketView failed", error);
			setBracketStatus(root, "bracket.status.load_failed", "Bracket load failed", "error");
			return null;
		} finally {
			restoreScrollState(scrollState);
		}
	}

	/** Saves the selected overlay view and refreshes the admin preview. */
	async function saveBracketOverlayView(page, view) {
		const scrollState = captureScrollState(page);
		const app = await waitForBackend();
		if (!app || typeof app.SetBracketOverlayView !== "function") {
			setBracketStatus(page, "bracket.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			restoreScrollState(scrollState);
			return;
		}

		setBracketStatus(page, "bracket.status.saving", "Saving bracket...", "neutral");
		try {
			fgc.currentState = await withTimeout(app.SetBracketOverlayView(view), 5000, "Bracket overlay save timed out");
			await loadBracket(page, bracketManagerView(page));
			setBracketStatus(page, "bracket.status.overlay_saved", "Overlay view saved", "success");
		} catch (error) {
			console.error("SetBracketOverlayView failed", error);
			setBracketStatus(page, "bracket.status.failed", "Bracket save failed", "error");
		} finally {
			restoreScrollState(scrollState);
		}
	}

	/** Saves the selected manager view and refreshes the admin bracket slice. */
	async function saveBracketManagerView(page, view) {
		const scrollState = captureScrollState(page);
		const app = await waitForBackend();
		if (!app || (typeof app.SetBracketManagerView !== "function" && (typeof app.LoadTournament !== "function" || typeof app.SaveTournament !== "function"))) {
			setBracketStatus(page, "bracket.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			restoreScrollState(scrollState);
			return;
		}

		const normalizedView = normalizeBracketView(view);
		setBracketStatus(page, "bracket.status.saving", "Saving bracket...", "neutral");
		try {
			if (typeof app.SetBracketManagerView === "function") {
				fgc.currentState = await withTimeout(app.SetBracketManagerView(normalizedView), 5000, "Bracket manager view save timed out");
			} else {
				const state = await withTimeout(app.LoadTournament(), 5000, "Tournament load timed out");
				state.bracket = { ...(state.bracket || {}), manager_view: normalizedView };
				await withTimeout(app.SaveTournament(state), 10000, "Bracket manager view save timed out");
				fgc.currentState = await withTimeout(app.LoadTournament(), 5000, "Tournament load timed out");
			}
			await loadBracket(page, normalizedView);
			setBracketStatus(page, "bracket.status.manager_saved", "Manager view saved", "success");
		} catch (error) {
			console.error("SetBracketManagerView failed", error);
			setBracketStatus(page, "bracket.status.failed", "Bracket save failed", "error");
		} finally {
			restoreScrollState(scrollState);
		}
	}

	/** Performs one admin bracket action and reloads the projection. */
	async function runBracketAction(page, action) {
		const scrollState = captureScrollState(page);
		const app = await waitForBackend();
		if (!app) {
			setBracketStatus(page, "bracket.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			restoreScrollState(scrollState);
			return;
		}

		setBracketStatus(page, "bracket.status.saving", "Saving bracket...", "neutral");
		try {
			fgc.currentState = await withTimeout(action(app), 5000, "Bracket action timed out");
			await loadBracket(page, bracketManagerView(page));
			setBracketStatus(page, "bracket.status.saved", "Bracket saved", "success");
		} catch (error) {
			console.error("Bracket action failed", error);
			setBracketStatus(page, "bracket.status.failed", "Bracket save failed", "error");
		} finally {
			restoreScrollState(scrollState);
		}
	}

	/** Runs one named backend bracket method and keeps button handlers readable. */
	function runBracketBackendMethod(page, methodName, ...args) {
		void runBracketAction(page, function (app) {
			if (typeof app[methodName] !== "function") return Promise.reject(new Error(`${methodName} is unavailable`));
			return app[methodName](...args);
		});
	}

	/** Reads one bracket score from a rendered match card. */
	function readBracketScore(matchCard, side) {
		const input = matchCard?.querySelector(`[data-bracket-score-input="${side}"]`);
		if (!(input instanceof HTMLInputElement)) return 0;
		return clampScore(input.value, eventRuleLimit(matchCard));
	}

	/** Handles compact bracket score +/- controls. */
	function updateBracketScoreFromButton(page, button) {
		const matchID = button.getAttribute("data-match-id") || "";
		const side = Number(button.getAttribute("data-side") || 0);
		const delta = Number(button.getAttribute("data-delta") || 0);
		const matchCard = button.closest("[data-bracket-match]");
		if (!matchID || !side || !delta || !(matchCard instanceof HTMLElement)) return;

		let player1Score = readBracketScore(matchCard, 1);
		let player2Score = readBracketScore(matchCard, 2);
		const scoreLimit = eventRuleLimit(page);
		if (side === 1) player1Score = clampScore(player1Score + delta, scoreLimit);
		if (side === 2) player2Score = clampScore(player2Score + delta, scoreLimit);

		const player1Input = matchCard.querySelector('[data-bracket-score-input="1"]');
		const player2Input = matchCard.querySelector('[data-bracket-score-input="2"]');
		if (player1Input instanceof HTMLInputElement) player1Input.value = String(player1Score);
		if (player2Input instanceof HTMLInputElement) player2Input.value = String(player2Score);

		runBracketBackendMethod(page, "UpdateMatchScore", matchID, player1Score, player2Score);
	}

	/** Handles first/second click selection for bracket seed swaps without moving player records. */
	function selectBracketSeedForSwap(page, seed) {
		if (!seed) return;
		const selectedSeed = bracketSeedSelections.get(page) || 0;
		if (!selectedSeed) {
			bracketSeedSelections.set(page, seed);
			setSeedSelection(page, "[data-bracket-seed-player]", seed);
			setBracketStatus(page, "bracket.status.swap_select", "Select another player to swap", "neutral");
			return;
		}
		bracketSeedSelections.delete(page);
		setSeedSelection(page, "[data-bracket-seed-player]", 0);
		if (selectedSeed === seed) {
			setBracketStatus(page, "bracket.status.swap_cleared", "Player swap cancelled", "neutral");
			return;
		}
		runBracketBackendMethod(page, "SwapBracketSeeds", selectedSeed, seed);
	}

	/** Handles native and Select2-driven bracket view changes through one path. */
	function handleBracketViewSelectChange(page, select) {
		if (!(select instanceof HTMLSelectElement)) return false;
		if (select.matches("[data-bracket-overlay-view-select]")) {
			void saveBracketOverlayView(page, select.value);
			return true;
		}
		if (select.matches("[data-bracket-manager-view-select]")) {
			void saveBracketManagerView(page, select.value);
			return true;
		}
		return false;
	}

	/** Binds admin bracket controls. */
	function bindBracketPage(page) {
		const bindingVersion = "view-select2-v2";
		if (page.dataset.bound === bindingVersion) return;
		page.dataset.bound = bindingVersion;

		page.addEventListener(
			"click",
			function (event) {
				const target = event.target instanceof Element ? event.target : null;
				const seed = bracketSwapSeedFromTarget(target);
				if (!seed) return;
				event.preventDefault();
				event.stopPropagation();
				selectBracketSeedForSwap(page, seed);
			},
			true,
		);

		page.addEventListener("change", function (event) {
			const target = event.target instanceof Element ? event.target : null;
			if (handleBracketViewSelectChange(page, target)) event.preventDefault();
		});

		const jquery = global.jQuery;
		if (jquery?.fn?.on) {
			jquery(page)
				.off("change.streamFgcBracketViews")
				.on("change.streamFgcBracketViews", "[data-bracket-overlay-view-select], [data-bracket-manager-view-select]", function () {
					handleBracketViewSelectChange(page, this);
				});
		}

		const reset = page.querySelector("[data-bracket-reset]");
		if (reset) {
			reset.addEventListener("click", function () {
				runBracketBackendMethod(page, "ResetBracket");
			});
		}
		const randomize = page.querySelector("[data-bracket-randomize]");
		if (randomize) {
			randomize.addEventListener("click", function () {
				runBracketBackendMethod(page, "RandomizeBracketSeeds");
			});
		}

		page.addEventListener("click", function (event) {
			const target = event.target instanceof Element ? event.target : null;
			const scoreButton = target?.closest("[data-bracket-score-action]");
			if (scoreButton instanceof HTMLButtonElement) {
				event.preventDefault();
				updateBracketScoreFromButton(page, scoreButton);
				return;
			}

			const currentButton = target?.closest("[data-bracket-current]");
			if (currentButton instanceof HTMLButtonElement) {
				event.preventDefault();
				const matchID = currentButton.getAttribute("data-bracket-current") || "";
				runBracketBackendMethod(page, "SetCurrentMatch", matchID);
				return;
			}

			const winnerButton = target?.closest("[data-bracket-winner]");
			if (winnerButton instanceof HTMLButtonElement) {
				event.preventDefault();
				const matchID = winnerButton.getAttribute("data-bracket-winner") || "";
				const playerID = winnerButton.getAttribute("data-player-id") || "";
				const reason = winnerButton.getAttribute("data-result-reason") || "";
				if (reason) runBracketBackendMethod(page, "SetMatchResult", matchID, playerID, reason);
				else runBracketBackendMethod(page, "SetMatchWinner", matchID, playerID);
				return;
			}

			const byeButton = target?.closest("[data-bracket-bye]");
			if (byeButton instanceof HTMLButtonElement) {
				event.preventDefault();
				const matchID = byeButton.getAttribute("data-bracket-bye") || "";
				const side = Number(byeButton.getAttribute("data-side") || 0);
				const bye = byeButton.getAttribute("data-bye") === "true";
				runBracketBackendMethod(page, "SetMatchParticipantBye", matchID, side, bye);
				return;
			}

			const clearButton = target?.closest("[data-bracket-clear]");
			if (clearButton instanceof HTMLButtonElement) {
				event.preventDefault();
				const matchID = clearButton.getAttribute("data-bracket-clear") || "";
				runBracketBackendMethod(page, "SetMatchWinner", matchID, "");
				return;
			}

			const seed = bracketSwapSeedFromTarget(target);
			if (seed) selectBracketSeedForSwap(page, seed);
		});

		page.addEventListener("keydown", function (event) {
			if (event.key !== "Enter" && event.key !== " ") return;
			const target = event.target instanceof Element ? event.target : null;
			const swapTarget = target?.closest("[data-bracket-seed-swap]");
			if (!(swapTarget instanceof HTMLElement)) return;
			event.preventDefault();
			const seed = bracketSwapSeedFromTarget(target) || Number(swapTarget.dataset.bracketSeedSwap || 0);
			selectBracketSeedForSwap(page, seed);
		});

		void loadBracket(page, bracketManagerView(page));
	}

	/** Binds the standalone overlay bracket page with a light refresh loop. */
	function bindBracketOverlay(root) {
		if (root.dataset.bound === "true") return;
		root.dataset.bound = "true";
		void loadBracket(root);
		global.setInterval(function () {
			void loadBracket(root);
		}, BRACKET_OVERLAY_REFRESH_MS);
	}

	fgc.bracket = {
		bindOverlay: bindBracketOverlay,
		bindPage: bindBracketPage,
		load: loadBracket,
		managerView: bracketManagerView,
	};
})(window);
