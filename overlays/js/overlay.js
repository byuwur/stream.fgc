"use strict";

/*
 * File: overlay.js
 * Desc: Shared JSON polling, bracket resolution, scaling, and Animate.css transitions for OBS overlays.
 * Deps: jQuery, Animate.css, Bootstrap CSS, local tournament/templates/assets folders.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 *
 * Notes:
 * - The overlay is read-only. tournament.json remains owned by the Wails controller.
 * - Every page renders inside the same 1920x1080 stage and only changed values animate.
 * - Page-specific art may live in overlays/{game}/ while shared data assets stay in ../assets/.
 */
/**
 * Boots the static overlay runtime with jQuery as its DOM layer.
 * @param {Window} global Browser window supplied by OBS or a regular browser.
 * @param {JQueryStatic} $ jQuery loaded before this deferred script.
 */
(function (global, $) {
	if (!$) {
		console.error("Stream.FGC overlays require jQuery.");
		return;
	}

	const STAGE_WIDTH = 1920;
	const STAGE_HEIGHT = 1080;
	const DEFAULT_POLL_MS = 1000;
	const ANIMATION_MS = 420;
	const ANIMATION_CLASSES = "animate__animated animate__fadeInUp animate__fadeOut";
	const jsonCache = new Map();
	let activeTimer = 0;
	let lastStateText = "";
	let refreshRunning = false;

	/** Converts nullable JSON values into trimmed strings. */
	function text(value) {
		return String(value ?? "").trim();
	}

	/** Converts a value into a lowercase key. */
	function lower(value) {
		return text(value).toLowerCase();
	}

	/** Parses an integer and returns a fallback for invalid input. */
	function integer(value, fallback = 0) {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : fallback;
	}

	/** Escapes data before inserting it into generated bracket markup. */
	function escapeHTML(value) {
		return String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	/** Adds a timestamp so polling cannot be satisfied by a stale browser cache. */
	function freshURL(url) {
		return `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;
	}

	/** Loads text through jQuery and reports useful HTTP failures. */
	function requestText(url) {
		return new Promise(function (resolve, reject) {
			$.ajax({ cache: false, dataType: "text", url: freshURL(url) })
				.done(function (value) {
					resolve(typeof value === "string" ? value : JSON.stringify(value));
				})
				.fail(function (xhr, status, error) {
					const code = xhr?.status ? `HTTP ${xhr.status}` : status || "request failed";
					reject(new Error(`Could not load ${url}: ${error || code}`));
				});
		});
	}

	/** Loads static JSON once; tournament.json deliberately bypasses this cache. */
	async function loadJSON(url, cacheKey) {
		if (cacheKey && jsonCache.has(cacheKey)) return jsonCache.get(cacheKey);
		const promise = requestText(url).then(JSON.parse);
		if (cacheKey) jsonCache.set(cacheKey, promise);
		try {
			return await promise;
		} catch (error) {
			if (cacheKey) jsonCache.delete(cacheKey);
			throw error;
		}
	}

	/** Loads optional catalog JSON without stopping the live overlay. */
	async function loadOptionalJSON(url, fallback, cacheKey) {
		try {
			return await loadJSON(url, cacheKey);
		} catch (error) {
			console.warn(error.message || error);
			return fallback;
		}
	}

	/** Converts a tournament format and size into its data-driven template filename. */
	function templateFileName(format, size) {
		let key = lower(format).replace(/_elimination$/, "").replace(/_system$/, "");
		if (key === "round_robin") key = "robin";
		key = key.replace(/[^a-z0-9]/g, "");
		return `${key || "double"}${integer(size, 8)}.json`;
	}

	/** Returns stable match order from explicit template order or match IDs. */
	function matchOrder(id, match) {
		if (Number.isFinite(Number(match?.order))) return Number(match.order);
		const numeric = integer(text(id).replace(/^M/i, ""), 0);
		if (numeric) return numeric;
		return Array.from(text(id).toUpperCase()).reduce(function (order, character) {
			return character >= "A" && character <= "Z" ? order * 26 + character.charCodeAt(0) - 64 : order;
		}, 0);
	}

	/** Returns template match IDs in visual progression order. */
	function sortedMatchIDs(template) {
		return Object.keys(template?.matches || {}).sort(function (left, right) {
			const difference = matchOrder(left, template.matches[left]) - matchOrder(right, template.matches[right]);
			return difference || left.localeCompare(right);
		});
	}

	/** Loads the tournament's format/size template or a readable missing-template fallback. */
	async function loadTemplate(state, options) {
		const fileName = templateFileName(state?.event?.format, state?.event?.size);
		return loadOptionalJSON(
			`${options.templateRoot}/${fileName}`,
			{ error: `[${fileName}] template missing`, matches: {}, size: integer(state?.event?.size, 0), type: text(state?.event?.format) },
			`template:${fileName}`,
		);
	}

	/** Resolves a bracket seed to a player ID without changing player records. */
	function seedPlayerID(state, seed) {
		const key = String(seed);
		return text(Object.prototype.hasOwnProperty.call(state?.bracket?.seeds || {}, key) ? state.bracket.seeds[key] : key);
	}

	/** Reports whether a seed has been explicitly marked as a BYE. */
	function seedIsBye(state, seed) {
		const playerID = seedPlayerID(state, seed);
		return Boolean(state?.bracket?.byes?.[String(seed)] || state?.players?.[playerID]?.bye);
	}

	/** Creates one unresolved participant while preserving its bracket source label. */
	function unresolvedParticipant(source, label) {
		return { pending_label: label || "TBD", player: {}, player_id: "", resolved: false, source: source || {}, status: "pending" };
	}

	/** Resolves a template participant from a seed or another match result. */
	function resolveParticipant(source, state) {
		if (!source) return unresolvedParticipant({}, "TBD");
		if (source.type === "seed") {
			const playerID = seedPlayerID(state, source.seed);
			const player = state?.players?.[playerID] || {};
			if (seedIsBye(state, source.seed)) {
				return { bracket_seed: source.seed, pending_label: "BYE", player, player_id: playerID, resolved: true, source, status: "bye" };
			}
			if (!playerID || !text(player.name)) {
				return { bracket_seed: source.seed, pending_label: "TBD", player, player_id: playerID, resolved: false, source, status: "tbd" };
			}
			return { bracket_seed: source.seed, pending_label: "", player, player_id: playerID, resolved: true, source, status: "player" };
		}

		if (source.type === "winner" || source.type === "loser") {
			const result = state?.matches?.[source.match] || {};
			const playerID = text(source.type === "winner" ? result.winner : result.loser);
			const label = `${source.type === "winner" ? "Winner" : "Loser"} of ${source.match || ""}`;
			if (!playerID || !text(state?.players?.[playerID]?.name)) return unresolvedParticipant(source, label);
			return { pending_label: "", player: state.players[playerID], player_id: playerID, resolved: true, source, status: "player" };
		}

		return unresolvedParticipant(source, "TBD");
	}

	/** Adds display labels and shared asset URLs to one resolved participant. */
	function decorateParticipant(participant, context) {
		const player = participant?.player || {};
		const playerID = text(participant?.player_id);
		const characterKey = text(player.character);
		const country = text(player.country).toUpperCase();
		return {
			...participant,
			character_key: characterKey,
			character_name: characterKey ? context.characters[characterKey] || characterKey : "",
			character_url: characterKey && context.gameKey ? `${context.options.assetRoot}/${context.gameKey}/portraits/${characterKey}.png` : context.nopic,
			country,
			flag_url: country ? `${context.options.flagRoot}/${country.toLowerCase()}.svg` : "",
			id: playerID,
			name: text(player.name) || participant?.pending_label || "TBD",
			portrait_url: playerID ? `${context.options.playerRoot}/${playerID}.png` : context.nopic,
			team: text(player.team),
		};
	}

	/** Resolves one template match, including current-screen side swaps. */
	function resolveMatch(state, template, context, requestedID) {
		const id = text(requestedID) || text(state?.current) || sortedMatchIDs(template)[0] || "";
		const definition = template?.matches?.[id] || {};
		const matchState = { player1_score: 0, player2_score: 0, ...(state?.matches?.[id] || {}) };
		let player1 = decorateParticipant(resolveParticipant(definition.p1, state), context);
		let player2 = decorateParticipant(resolveParticipant(definition.p2, state), context);

		if (matchState.swap_sides) {
			[player1, player2] = [player2, player1];
			[matchState.player1_score, matchState.player2_score] = [matchState.player2_score, matchState.player1_score];
		}

		return {
			definition,
			group: text(definition.group) || "matches",
			id,
			name: text(definition.name) || (id ? `Match ${id}` : "Current match"),
			order: matchOrder(id, definition),
			player1,
			player2,
			round: text(definition.round) || text(definition.group) || "Matches",
			state: matchState,
		};
	}

	/** Resolves every template match for bracket rendering. */
	function resolveBracket(state, template, context) {
		return sortedMatchIDs(template).map(function (id) {
			return resolveMatch(state, template, context, id);
		});
	}

	/** Returns the winner participant from a resolved match. */
	function winnerFromMatch(match) {
		const winnerID = text(match?.state?.winner);
		if (winnerID && winnerID === match?.player1?.id) return match.player1;
		if (winnerID && winnerID === match?.player2?.id) return match.player2;
		return null;
	}

	/** Finds the latest completed finals winner for the champion screen. */
	function championFromBracket(matches, currentWinner) {
		const finals = matches
			.filter(function (match) {
				return match.group === "finals" && winnerFromMatch(match);
			})
			.sort(function (left, right) {
				return right.order - left.order;
			});
		return finals.length ? winnerFromMatch(finals[0]) : currentWinner;
	}

	/** Builds all display-ready data required by every overlay page. */
	async function buildContext(state, options) {
		const gameKey = lower(state?.event?.game);
		const [template, characters, games] = await Promise.all([
			loadTemplate(state, options),
			gameKey ? loadOptionalJSON(`${options.assetRoot}/${gameKey}/characters.json`, {}, `characters:${gameKey}`) : {},
			loadOptionalJSON(`${options.assetRoot}/games.json`, {}, "games"),
		]);
		const context = {
			bracket: state?.bracket || {},
			characters,
			event: { ...(state?.event || {}), game: games[gameKey] || text(state?.event?.game) },
			gameKey,
			nopic: `${options.assetRoot}/nopic.png`,
			options,
			page: options.page,
			players: state?.players || {},
			state,
			template,
		};
		context.matches = resolveBracket(state, template, context);
		context.match = resolveMatch(state, template, context, "");
		context.player1 = context.match.player1;
		context.player2 = context.match.player2;
		context.winner = winnerFromMatch(context.match);
		context.champion = championFromBracket(context.matches, context.winner);
		return context;
	}

	/** Reads a dotted object path used by simple data-fgc-text bindings. */
	function readPath(source, path) {
		return text(path)
			.split(".")
			.filter(Boolean)
			.reduce(function (value, key) {
				return value == null ? "" : value[key];
			}, source);
	}

	/** Runs one Animate.css effect and guarantees completion under reduced motion. */
	function animate($element, name, complete) {
		const oldTimer = $element.data("fgc-animation-timer");
		if (oldTimer) global.clearTimeout(oldTimer);
		$element.off("animationend.streamFgc").removeClass(ANIMATION_CLASSES);

		let finished = false;
		/** Completes this animation once, whether CSS or the fallback timer wins. */
		function finish() {
			if (finished) return;
			finished = true;
			$element.off("animationend.streamFgc").removeClass(ANIMATION_CLASSES).removeData("fgc-animation-timer");
			if (typeof complete === "function") complete();
		}

		global.requestAnimationFrame(function () {
			$element.addClass(`animate__animated animate__${name}`).one("animationend.streamFgc", finish);
			$element.data("fgc-animation-timer", global.setTimeout(finish, ANIMATION_MS));
		});
	}

	/** Swaps one changed value with fade-out then fade-in-up transitions. */
	function swapValue(target, valueKey, write) {
		$(target).each(function () {
			const $element = $(this);
			const key = String(valueKey ?? "");
			if ($element.attr("data-fgc-value") === key) return;
			$element.attr("data-fgc-value", key);

			if ($element.attr("data-fgc-ready") !== "true") {
				write($element);
				$element.attr("data-fgc-ready", "true").css("visibility", "visible");
				animate($element, "fadeInUp");
				return;
			}

			animate($element, "fadeOut", function () {
				write($element);
				$element.css("visibility", "visible");
				animate($element, "fadeInUp");
			});
		});
	}

	/** Swaps text only when its value changed. */
	function swapText(target, value) {
		const valueText = text(value);
		swapValue(target, valueText, function ($element) {
			$element.text(valueText);
		});
	}

	/** Swaps generated markup as one animated region. */
	function swapHTML(target, html, valueKey = html, afterWrite) {
		swapValue(target, valueKey, function ($element) {
			$element.html(html);
			if (typeof afterWrite === "function") afterWrite($element);
		});
	}

	/** Writes an image with an ordered local fallback chain. */
	function writeImage($image, candidates, hideOnFailure) {
		const urls = candidates.filter(Boolean);
		let index = 0;
		$image.off("error.streamFgcImage").on("error.streamFgcImage", function () {
			index += 1;
			if (index < urls.length) {
				$image.attr("src", urls[index]);
				return;
			}
			if (hideOnFailure) $image.css("visibility", "hidden");
		});
		if (urls.length) $image.attr("src", urls[0]);
		else if (hideOnFailure) $image.css("visibility", "hidden");
	}

	/** Swaps an image only when its fallback chain changed. */
	function swapImage(target, candidates, hideOnFailure = false) {
		const urls = candidates.filter(Boolean);
		swapValue(target, urls.join("|"), function ($image) {
			writeImage($image, urls, hideOnFailure);
		});
	}

	/** Animates an element between visible and hidden states. */
	function setVisible(target, visible) {
		$(target).each(function () {
			const $element = $(this);
			const key = visible ? "true" : "false";
			if ($element.attr("data-fgc-visible") === key) return;
			$element.attr("data-fgc-visible", key);
			if (visible) {
				$element.show().css("visibility", "visible");
				animate($element, "fadeInUp");
				return;
			}
			if ($element.is(":visible")) animate($element, "fadeOut", () => $element.hide());
			else $element.hide();
		});
	}

	/** Applies generic dotted-path text bindings used by headers and intro pages. */
	function applyBindings(context) {
		$("[data-fgc-text]").each(function () {
			swapText(this, readPath(context, $(this).attr("data-fgc-text")));
		});
	}

	/** Returns a CSS-safe local URL. */
	function cssURL(url) {
		return `url("${String(url).replace(/"/g, "%22")}")`;
	}

	/** Applies tournament, game, and page art as ordered CSS fallback layers. */
	function applyTheme(context) {
		const game = context.gameKey || "default";
		const page = context.page || "overlay";
		const backgrounds = [
			`${context.options.playerRoot}/_bg.jpg`,
			`./${game}/_bg.jpg`,
			`${context.options.assetRoot}/${game}/_bg.jpg`,
			`${context.options.assetRoot}/nobg.jpg`,
		];
		const frames = [`./${game}/${page}.png`, `./${game}/${page}.jpg`];
		$(document.documentElement).css({
			"--fgc-game-bg": backgrounds.map(cssURL).join(", "),
			"--fgc-page-frame": frames.map(cssURL).join(", "),
		});
		$(document.body).attr({ "data-game": game, "data-overlay-page": page });
		swapImage("[data-tournament-logo]", [
			`${context.options.playerRoot}/_logo.png`,
			`./${game}/_logo.png`,
			`${context.options.assetRoot}/${game}/_logo.png`,
			`${context.options.assetRoot}/stream.fgc.png`,
		]);
	}

	/** Updates one optional country flag and hides it when no ISO2 code is present. */
	function renderFlag(target, participant) {
		const visible = Boolean(participant?.flag_url);
		setVisible(target, visible);
		if (visible) swapImage(target, [participant.flag_url], true);
	}

	/** Renders the compact current-match scoreboard. */
	function renderScoreboard(context) {
		swapText("[data-p1-name]", context.player1.name);
		swapText("[data-p1-team]", context.player1.team);
		swapText("[data-p1-score]", context.match.state.player1_score || 0);
		renderFlag("[data-p1-flag]", context.player1);
		swapText("[data-p2-name]", context.player2.name);
		swapText("[data-p2-team]", context.player2.team);
		swapText("[data-p2-score]", context.match.state.player2_score || 0);
		renderFlag("[data-p2-flag]", context.player2);
	}

	/** Renders the current-match versus screen. */
	function renderVersus(context) {
		for (const [prefix, participant] of [["p1", context.player1], ["p2", context.player2]]) {
			swapText(`[data-${prefix}-name]`, participant.name);
			swapText(`[data-${prefix}-team]`, participant.team);
			swapText(`[data-${prefix}-character]`, participant.character_name);
			swapImage(`[data-${prefix}-portrait]`, [participant.portrait_url, context.nopic]);
			renderFlag(`[data-${prefix}-flag]`, participant);
		}
	}

	/** Renders the current match winner or hides the panel until one exists. */
	function renderWinner(context) {
		setVisible("[data-winner-panel]", Boolean(context.winner));
		if (!context.winner) return;
		swapText("[data-winner-name]", context.winner.name);
		swapText("[data-winner-team]", context.winner.team);
		swapText("[data-winner-character]", context.winner.character_name);
		swapImage("[data-winner-portrait]", [context.winner.portrait_url, context.nopic]);
		renderFlag("[data-winner-flag]", context.winner);
	}

	/** Renders the latest completed finals winner as tournament champion. */
	function renderChampion(context) {
		setVisible("[data-champion-panel]", Boolean(context.champion));
		if (!context.champion) return;
		swapText("[data-champion-name]", context.champion.name);
		swapText("[data-event-name]", context.event.name);
		swapImage("[data-champion-portrait]", [context.champion.portrait_url, context.nopic]);
	}

	/** Normalizes stored and query-string bracket view aliases. */
	function normalizeBracketView(value) {
		const view = lower(value);
		if (["winner", "upper", "winners"].includes(view)) return "winners";
		if (["loser", "lower", "losers"].includes(view)) return "losers";
		if (["final", "grand", "grand_finals", "finals"].includes(view)) return "finals";
		if (["top", "top_8", "top-8", "top8"].includes(view)) return "top8";
		return "all";
	}

	/** Extracts the number from a round label such as Losers Round 5. */
	function roundNumber(round) {
		const values = text(round).match(/\d+/g);
		return values?.length ? integer(values[values.length - 1], 0) : 0;
	}

	/** Finds the last three losers rounds used by the common Top 8 view. */
	function top8LosersStart(matches) {
		const maximum = Math.max(
			0,
			...matches.filter((match) => match.group === "losers").map((match) => roundNumber(match.round)),
		);
		return Math.max(1, maximum - 2);
	}

	/** Reports whether one match belongs to the selected overlay bracket slice. */
	function bracketViewAllows(match, view, context) {
		if (view === "winners" || view === "losers" || view === "finals") return match.group === view;
		if (view !== "top8" || integer(context.template?.size, 0) <= 8) return true;
		if (match.group === "finals") return true;
		if (match.group === "winners") return /quarter|semi|final/i.test(match.round);
		if (match.group === "losers") return /final/i.test(match.round) || roundNumber(match.round) >= top8LosersStart(context.matches);
		return true;
	}

	/** Returns a human label for a stored bracket view. */
	function bracketViewLabel(view) {
		return { all: "Full bracket", finals: "Finals", losers: "Losers bracket", top8: "Top 8", winners: "Winners bracket" }[view] || "Full bracket";
	}

	/** Builds one participant row inside a bracket match card. */
	function bracketParticipantHTML(participant, match, side) {
		const winnerID = text(match.state.winner);
		const loserID = text(match.state.loser);
		const winner = Boolean(participant.id && participant.id === winnerID);
		const loser = Boolean(participant.id && (participant.id === loserID || (winnerID && participant.id !== winnerID)));
		const score = side === 1 ? match.state.player1_score : match.state.player2_score;
		const reason = (winner || loser) && match.state.reason ? `<span class="fgc-bracket-reason">${escapeHTML(match.state.reason.toUpperCase())}</span>` : "";
		const flag = participant.flag_url ? `<img class="fgc-bracket-flag" src="${escapeHTML(participant.flag_url)}" alt="${escapeHTML(participant.country)}" />` : "";
		return [
			`<div class="fgc-bracket-player${winner ? " is-winner" : ""}${loser ? " is-loser" : ""}">`,
			flag,
			`<span class="fgc-bracket-player-copy">`,
			`<strong>${escapeHTML(participant.name)}</strong>`,
			participant.team ? `<small>${escapeHTML(participant.team)}</small>` : "",
			`</span>`,
			reason,
			`<strong class="fgc-bracket-score">${integer(score, 0)}</strong>`,
			`</div>`,
		].join("");
	}

	/** Builds one resolved match card for the static bracket overlay. */
	function bracketMatchHTML(match, currentMatchID) {
		return [
			`<article class="fgc-bracket-match${match.id === text(currentMatchID) ? " is-current" : ""}">`,
			`<header><span>${escapeHTML(match.id)}</span><strong>${escapeHTML(match.name)}</strong></header>`,
			bracketParticipantHTML(match.player1, match, 1),
			bracketParticipantHTML(match.player2, match, 2),
			`</article>`,
		].join("");
	}

	/** Builds a proper round-by-round bracket from the selected projection slice. */
	function bracketHTML(context, view) {
		if (context.template?.error) return `<div class="fgc-overlay-empty">${escapeHTML(context.template.error)}</div>`;
		const matches = context.matches.filter((match) => bracketViewAllows(match, view, context));
		if (!matches.length) return `<div class="fgc-overlay-empty">No bracket matches found.</div>`;

		const groups = [];
		for (const match of matches) {
			let group = groups.find((item) => item.key === match.group);
			if (!group) {
				group = { key: match.group, rounds: [] };
				groups.push(group);
			}
			let round = group.rounds.find((item) => item.name === match.round);
			if (!round) {
				round = { matches: [], name: match.round };
				group.rounds.push(round);
			}
			round.matches.push(match);
		}

		return groups
			.map(function (group) {
				const weight = Math.max(1, ...group.rounds.map((round) => round.matches.length));
				const rounds = group.rounds
					.map(function (round) {
						return [
							`<section class="fgc-bracket-round">`,
							`<h3>${escapeHTML(round.name)}</h3>`,
							`<div class="fgc-bracket-round-matches">${round.matches
								.map(function (match) {
									return bracketMatchHTML(match, context.state.current);
								})
								.join("")}</div>`,
							`</section>`,
						].join("");
					})
					.join("");
				return [
					`<section class="fgc-bracket-section" data-bracket-group="${escapeHTML(group.key)}" style="--fgc-group-weight:${weight}">`,
					`<h2>${escapeHTML(group.key)}</h2>`,
					`<div class="fgc-bracket-rounds" style="--fgc-round-count:${Math.max(1, group.rounds.length)}">${rounds}</div>`,
					`</section>`,
				].join("");
			})
			.join("");
	}

	/** Renders the bracket view stored for overlays, unless a query override is present. */
	function renderBracket(context) {
		const queryView = new URLSearchParams(global.location.search).get("view");
		const view = normalizeBracketView(queryView || context.bracket.overlay_view || "all");
		swapText("[data-bracket-view]", bracketViewLabel(view));
		const html = bracketHTML(context, view);
		swapHTML("[data-bracket-region]", html, `${view}:${html}`, function ($region) {
			$region.find("img").off("error.streamFgcBracket").on("error.streamFgcBracket", function () {
				$(this).css("visibility", "hidden");
			});
		});
	}

	/** Applies common bindings, page art, and the page-specific renderer. */
	function render(context) {
		applyTheme(context);
		applyBindings(context);
		const renderers = {
			bracket: renderBracket,
			champion: renderChampion,
			intro: function () {},
			scoreboard: renderScoreboard,
			versus: renderVersus,
			winner: renderWinner,
		};
		(renderers[context.page] || function () {})(context);
		if (typeof global.StreamFGCOverlayPage?.render === "function") global.StreamFGCOverlayPage.render(context, api);
		$(".fgc-stage").addClass("fgc-overlay-ready");
		$("[data-fgc-runtime-warning]").remove();
	}

	/** Wraps and contain-scales the fixed 1920x1080 stage for any viewport. */
	function scaleStage() {
		const $stage = $(".fgc-stage").first();
		if (!$stage.length) return;
		if (!$stage.parent().hasClass("fgc-stage-shell")) $stage.wrap('<div class="fgc-stage-shell"></div>');
		const scale = Math.min(global.innerWidth / STAGE_WIDTH, global.innerHeight / STAGE_HEIGHT);
		$stage.css("transform", `scale(${scale})`);
		$stage.parent().css({ height: STAGE_HEIGHT * scale, width: STAGE_WIDTH * scale });
	}

	/** Builds an HTTP URL hint for browsers that block file:// JSON reads. */
	function browserHTTPHint() {
		const path = global.location.pathname.replace(/\\/g, "/");
		const marker = "/stream.fgc/";
		const index = path.toLowerCase().indexOf(marker);
		return index >= 0 ? `http://localhost${path.slice(index)}` : "http://localhost/stream.fgc/overlays/scoreboard.html";
	}

	/** Shows one readable runtime warning outside the scaled OBS stage. */
	function showProtocolWarning(error) {
		if (global.location.protocol !== "file:") {
			console.warn(error.message || error);
			return;
		}
		const hint = browserHTTPHint();
		let $warning = $("[data-fgc-runtime-warning]");
		if (!$warning.length) {
			$warning = $('<aside class="fgc-runtime-warning" data-fgc-runtime-warning></aside>').appendTo(document.body);
		}
		$warning.html(`Browser security blocked local JSON. Open this overlay through HTTP.<code>${escapeHTML(hint)}</code>`);
	}

	/** Reads runtime paths and polling frequency from body data attributes. */
	function optionsFromDocument(overrides = {}) {
		const $body = $(document.body);
		const query = new URLSearchParams(global.location.search);
		return {
			assetRoot: $body.attr("data-asset-root") || "../assets",
			flagRoot: $body.attr("data-flag-root") || "../assets/flags",
			page: $body.attr("data-overlay-page") || query.get("page") || "overlay",
			playerRoot: $body.attr("data-player-root") || "../players",
			pollMs: Math.max(250, integer(query.get("poll") || $body.attr("data-poll-ms"), DEFAULT_POLL_MS)),
			stateURL: $body.attr("data-state-url") || "../data/tournament.json",
			templateRoot: $body.attr("data-template-root") || "../templates",
			...overrides,
		};
	}

	/** Loads and renders tournament state only when tournament.json changed. */
	async function refresh(options) {
		const stateText = await requestText(options.stateURL);
		if (stateText === lastStateText) return null;
		const state = JSON.parse(stateText);
		const context = await buildContext(state, options);
		lastStateText = stateText;
		render(context);
		return context;
	}

	/** Starts one non-overlapping JSON polling loop. */
	function init(overrides) {
		const options = optionsFromDocument(overrides);
		if (activeTimer) global.clearInterval(activeTimer);
		scaleStage();
		$(global).off("resize.streamFgcOverlay").on("resize.streamFgcOverlay", scaleStage);

		/** Runs one polling pass while preventing overlapping local file requests. */
		async function tick() {
			if (refreshRunning) return;
			refreshRunning = true;
			try {
				await refresh(options);
			} catch (error) {
				showProtocolWarning(error);
			} finally {
				refreshRunning = false;
			}
		}

		void tick();
		activeTimer = global.setInterval(tick, options.pollMs);
		return {
			options,
			refresh: tick,
			stop: function () {
				global.clearInterval(activeTimer);
				activeTimer = 0;
			},
		};
	}

	const api = {
		applyBindings,
		init,
		readPath,
		refresh,
		resolveMatch,
		setVisible,
		sortedMatchIDs,
		swapHTML,
		swapImage,
		swapText,
		templateFileName,
	};

	global.StreamFGCOverlay = api;
	$(function () {
		if ($(document.body).attr("data-overlay-page")) init();
	});
})(window, window.jQuery);
