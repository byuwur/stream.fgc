/*
 * File: overlay.js
 * Desc: Shared JSON polling, state resolution, and fade-swap helpers for OBS overlays.
 * Deps: Browser Fetch API, optional jQuery/Bootstrap vendor files.
 */
(function (global) {
	"use strict";

	const DEFAULT_STATE_URL = "../data/tournament.json";
	const DEFAULT_TEMPLATE_ROOT = "../templates";
	const DEFAULT_ASSET_ROOT = "../assets";
	const DEFAULT_PLAYER_ROOT = "../players";
	const DEFAULT_FLAG_ROOT = "../assets/flags";
	const DEFAULT_FRONTEND_FLAG_ROOT = "../frontend/flags";
	const DEFAULT_POLL_MS = 1000;
	const DEFAULT_FADE_MS = 220;

	const nopicSVG = [
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">',
		'<rect width="320" height="320" fill="#e7e7ff"/>',
		'<circle cx="160" cy="104" r="58" fill="#bab8ff"/>',
		'<path d="M52 302c13-77 70-116 108-116s95 39 108 116z" fill="#bab8ff"/>',
		'<path d="M286 44 44 286" stroke="#8b0011" stroke-width="12"/>',
		'<path d="M300 58 58 300" stroke="#111" stroke-width="5"/>',
		"</svg>",
	].join("");

	const NOPIC_URL = "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(nopicSVG);
	const imageCache = new Map();
	const jsonCache = new Map();

	let activeTimer = null;
	let lastStateText = "";
	let lastRuntimeWarning = "";

	function trim(value) {
		return String(value == null ? "" : value).trim();
	}

	function lower(value) {
		return trim(value).toLowerCase();
	}

	function toInt(value, fallback) {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : fallback;
	}

	function cacheBustedURL(url) {
		const separator = url.includes("?") ? "&" : "?";
		return `${url}${separator}_=${Date.now()}`;
	}

	async function fetchText(url) {
		const response = await fetch(cacheBustedURL(url), { cache: "no-store" });
		if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);
		return response.text();
	}

	function escapeHTML(value) {
		return String(value == null ? "" : value)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	function resolvedProtocol(url) {
		try {
			return new URL(url, global.location.href).protocol;
		} catch (error) {
			return global.location.protocol;
		}
	}

	function browserHTTPHint() {
		const pathname = global.location.pathname || "";
		const normalized = pathname.replace(/\\/g, "/");
		const marker = "/stream.fgc/";
		const markerIndex = normalized.toLowerCase().indexOf(marker);
		if (markerIndex >= 0) return `http://localhost${normalized.slice(markerIndex)}${global.location.search || ""}`;
		return "http://localhost/stream.fgc/overlays/scoreboard.html";
	}

	function showRuntimeWarning(message, detail) {
		if (!document.body) return;
		let warning = document.querySelector("[data-fgc-runtime-warning]");
		if (!warning) {
			warning = document.createElement("aside");
			warning.className = "fgc-runtime-warning";
			warning.setAttribute("data-fgc-runtime-warning", "true");
			document.body.appendChild(warning);
		}
		warning.innerHTML = `<div>${escapeHTML(message)}</div><code>${escapeHTML(detail || "")}</code>`;
	}

	function handleRuntimeError(error, options) {
		const message = error?.message || String(error || "Overlay runtime error");
		const isFileRead = global.location.protocol === "file:" && resolvedProtocol(options.stateURL) === "file:";
		if (isFileRead && /fetch|cors|url scheme|failed/i.test(message)) {
			const friendly = "Browser blocked the overlay from reading local JSON through file://.";
			const detail = `For browser testing, open it through HTTP instead: ${browserHTTPHint()}`;
			showRuntimeWarning(friendly, detail);
			if (lastRuntimeWarning !== detail) console.warn(`${friendly} ${detail}`);
			lastRuntimeWarning = detail;
			return;
		}
		if (lastRuntimeWarning !== message) console.warn(message);
		lastRuntimeWarning = message;
	}

	async function fetchJSON(url, cacheKey) {
		if (cacheKey && jsonCache.has(cacheKey)) return jsonCache.get(cacheKey);
		const data = JSON.parse(await fetchText(url));
		if (cacheKey) jsonCache.set(cacheKey, data);
		return data;
	}

	async function fetchJSONSafe(url, fallback, cacheKey) {
		try {
			return await fetchJSON(url, cacheKey);
		} catch (error) {
			console.warn(error.message || error);
			return fallback;
		}
	}

	function normalizeAssetName(value) {
		let normalized = "";
		for (const character of lower(value)) {
			if ((character >= "a" && character <= "z") || (character >= "0" && character <= "9")) normalized += character;
		}
		return normalized;
	}

	function normalizeGameKey(state) {
		return lower(state?.event?.game || "");
	}

	function templateFileName(format, size) {
		const normalized = lower(format);
		const compact = normalizeAssetName(normalized);
		switch (true) {
			case normalized === "double" || normalized === "double_elimination" || compact === "double" || compact === "doubleelimination":
				return `double${size}.json`;
			case normalized === "single" || normalized === "single_elimination" || compact === "single" || compact === "singleelimination":
				return `single${size}.json`;
			case normalized === "robin" || normalized === "round_robin" || compact === "robin" || compact === "roundrobin":
				return `robin${size}.json`;
			case normalized === "swiss" || normalized === "swiss_system" || compact === "swiss" || compact === "swisssystem":
				return `swiss${size}.json`;
			default:
				return `${compact || "double"}${size}.json`;
		}
	}

	function sortedMatchIDs(template) {
		return Object.keys(template?.matches || {}).sort(function (leftID, rightID) {
			const left = template.matches[leftID] || {};
			const right = template.matches[rightID] || {};
			const leftOrder = Number(left.order || naturalMatchOrder(leftID));
			const rightOrder = Number(right.order || naturalMatchOrder(rightID));
			return leftOrder === rightOrder ? leftID.localeCompare(rightID) : leftOrder - rightOrder;
		});
	}

	function naturalMatchOrder(id) {
		const text = trim(id).toUpperCase();
		const numeric = Number.parseInt(text.replace(/^M/, ""), 10);
		if (Number.isFinite(numeric)) return numeric;
		let order = 0;
		for (const character of text) {
			if (character < "A" || character > "Z") continue;
			order = order * 26 + character.charCodeAt(0) - 64;
		}
		return order || Number.MAX_SAFE_INTEGER;
	}

	async function loadTemplate(state, options) {
		const format = state?.event?.format || "double_elimination";
		const size = toInt(state?.event?.size, 8);
		const fileName = templateFileName(format, size);
		const url = `${options.templateRoot}/${fileName}`;
		return fetchJSONSafe(url, { type: format, size, matches: {}, error: `[${fileName}] template missing` }, `template:${fileName}`);
	}

	async function loadCharacterNames(gameKey, options) {
		if (!gameKey) return {};
		return fetchJSONSafe(`${options.assetRoot}/${gameKey}/characters.json`, {}, `characters:${gameKey}`);
	}

	function bracketSeedPlayerID(state, seed) {
		const key = String(seed);
		const seedMap = state?.bracket?.seeds || {};
		return trim(Object.prototype.hasOwnProperty.call(seedMap, key) ? seedMap[key] : key);
	}

	function bracketSeedBye(state, seed) {
		const key = String(seed);
		if (state?.bracket?.byes?.[key]) return true;
		const playerID = bracketSeedPlayerID(state, seed);
		return Boolean(playerID && state?.players?.[playerID]?.bye);
	}

	function unresolved(source, label) {
		return {
			player_id: "",
			player: {},
			source,
			resolved: false,
			status: "pending",
			pending_label: label || "TBD",
		};
	}

	function resolveParticipant(source, state) {
		if (!source) return unresolved({}, "TBD");
		if (source.type === "seed") {
			const playerID = bracketSeedPlayerID(state, source.seed);
			const player = state?.players?.[playerID] || {};
			if (bracketSeedBye(state, source.seed)) {
				return { player_id: playerID, player, source, bracket_seed: source.seed, resolved: true, status: "bye", pending_label: "BYE" };
			}
			if (!playerID || !trim(player.name)) {
				return { player_id: playerID, player, source, bracket_seed: source.seed, resolved: false, status: "tbd", pending_label: "TBD" };
			}
			return { player_id: playerID, player, source, bracket_seed: source.seed, resolved: true, status: "player", pending_label: "" };
		}
		if (source.type === "winner" || source.type === "loser") {
			const match = state?.matches?.[source.match] || {};
			const playerID = trim(source.type === "winner" ? match.winner : match.loser);
			const label = `${source.type === "winner" ? "Winner" : "Loser"} of ${source.match || ""}`;
			if (!playerID) return unresolved(source, label);
			const player = state?.players?.[playerID] || {};
			return trim(player.name) ? { player_id: playerID, player, source, resolved: true, status: "player", pending_label: "" } : unresolved(source, label);
		}
		return unresolved(source, "TBD");
	}

	function decorateParticipant(participant, context) {
		const player = participant?.player || {};
		const playerID = participant?.player_id || "";
		const characterKey = trim(player.character);
		const characterName = characterKey ? context.characters[characterKey] || characterKey : "";
		const country = trim(player.country).toUpperCase();
		return Object.assign({}, participant, {
			id: playerID,
			name: trim(player.name) || participant?.pending_label || "TBD",
			team: trim(player.team),
			country,
			character_key: characterKey,
			character_name: characterName,
			flag_url: country ? `${context.options.flagRoot}/${country.toLowerCase()}.svg` : "",
			frontend_flag_url: country ? `${context.options.frontendFlagRoot}/${country.toLowerCase()}.svg` : "",
			portrait_url: playerID ? `${context.options.playerRoot}/${playerID}.png` : NOPIC_URL,
			character_url: characterKey && context.gameKey ? `${context.options.assetRoot}/${context.gameKey}/portraits/${characterKey}.png` : NOPIC_URL,
		});
	}

	function resolveMatch(state, template, context, requestedMatchID) {
		const matchID = trim(requestedMatchID) || trim(state?.current) || sortedMatchIDs(template)[0] || "A";
		const templateMatch = template?.matches?.[matchID] || {};
		const matchState = Object.assign({ player1_score: 0, player2_score: 0 }, state?.matches?.[matchID] || {});
		let player1 = decorateParticipant(resolveParticipant(templateMatch.p1, state), context);
		let player2 = decorateParticipant(resolveParticipant(templateMatch.p2, state), context);

		if (matchState.swap_sides) {
			player1 = decorateParticipant(resolveParticipant(templateMatch.p2, state), context);
			player2 = decorateParticipant(resolveParticipant(templateMatch.p1, state), context);
			[matchState.player1_score, matchState.player2_score] = [matchState.player2_score, matchState.player1_score];
		}

		return {
			id: matchID,
			name: templateMatch.name || `Match ${matchID}`,
			template: templateMatch,
			state: matchState,
			player1,
			player2,
		};
	}

	function resolveCurrentMatch(state, template, context) {
		return resolveMatch(state, template, context, "");
	}

	function winnerFromMatch(match) {
		const winnerID = trim(match?.state?.winner);
		if (!winnerID) return null;
		if (winnerID === match?.player1?.id) return match.player1;
		if (winnerID === match?.player2?.id) return match.player2;
		return null;
	}

	async function imageExists(url) {
		if (!url || url === "none") return false;
		if (imageCache.has(url)) return imageCache.get(url);
		const promise = new Promise(function (resolve) {
			const image = new Image();
			image.onload = function () {
				resolve(true);
			};
			image.onerror = function () {
				resolve(false);
			};
			image.src = cacheBustedURL(url);
		});
		imageCache.set(url, promise);
		return promise;
	}

	async function firstExistingImage(candidates) {
		for (const url of candidates) {
			if (await imageExists(url)) return url;
		}
		return "";
	}

	async function setCSSImageVar(variable, candidates, fallback) {
		const url = await firstExistingImage(candidates);
		document.documentElement.style.setProperty(variable, url ? `url("${url}")` : fallback || "none");
	}

	function setOverlayTheme(context) {
		const game = context.gameKey || "default";
		const page = context.page || document.body.getAttribute("data-overlay-page") || "overlay";
		document.body.setAttribute("data-game", game);
		document.body.setAttribute("data-overlay-page", page);

		void setCSSImageVar("--fgc-game-bg", [`./${game}/_bg.jpg`, `./${game}/_bg.png`, `${context.options.assetRoot}/${game}/_bg.jpg`], "none");
		void setCSSImageVar("--fgc-game-logo", [`./${game}/_logo.png`, `${context.options.assetRoot}/${game}/_logo.png`], "none");
		void setCSSImageVar("--fgc-page-frame", [`./${game}/${page}.png`, `./${game}/${page}.jpg`], "none");
	}

	function readPath(source, path) {
		return trim(path)
			.split(".")
			.filter(Boolean)
			.reduce(function (value, key) {
				return value == null ? "" : value[key];
			}, source);
	}

	function transition(element, valueKey, apply) {
		const key = String(valueKey == null ? "" : valueKey);
		if (element.dataset.fgcValue === key) return;
		element.dataset.fgcValue = key;
		if (!element.dataset.fgcReady) {
			apply();
			element.dataset.fgcReady = "true";
			return;
		}

		const fadeMs = toInt(element.dataset.fgcFadeMs, DEFAULT_FADE_MS);
		element.classList.add("fgc-is-changing");
		global.setTimeout(function () {
			apply();
			global.requestAnimationFrame(function () {
				element.classList.remove("fgc-is-changing");
			});
		}, fadeMs);
	}

	function swapText(element, value) {
		const text = trim(value);
		transition(element, text, function () {
			element.textContent = text;
		});
	}

	function swapHTML(element, value) {
		const html = String(value == null ? "" : value);
		transition(element, html, function () {
			element.innerHTML = html;
		});
	}

	function swapImage(element, value, fallback) {
		const url = trim(value) || fallback || NOPIC_URL;
		transition(element, url, function () {
			let triedFallback = false;
			element.onerror = function () {
				if (fallback && !triedFallback && element.src !== fallback) {
					triedFallback = true;
					element.src = fallback;
					return;
				}
				if (element.src !== NOPIC_URL) element.src = NOPIC_URL;
			};
			element.src = url;
		});
	}

	function swapBackground(element, value) {
		const url = trim(value);
		transition(element, url, function () {
			element.style.backgroundImage = url ? `url("${url}")` : "";
		});
	}

	function applyBindings(root, context) {
		root.querySelectorAll("[data-fgc-text]").forEach(function (element) {
			swapText(element, readPath(context, element.getAttribute("data-fgc-text")));
		});
		root.querySelectorAll("[data-fgc-html]").forEach(function (element) {
			swapHTML(element, readPath(context, element.getAttribute("data-fgc-html")));
		});
		root.querySelectorAll("[data-fgc-src]").forEach(function (element) {
			swapImage(element, readPath(context, element.getAttribute("data-fgc-src")));
		});
		root.querySelectorAll("[data-fgc-bg]").forEach(function (element) {
			swapBackground(element, readPath(context, element.getAttribute("data-fgc-bg")));
		});
	}

	async function buildContext(state, options) {
		const gameKey = normalizeGameKey(state);
		const context = {
			options,
			page: options.page,
			state,
			event: state.event || {},
			players: state.players || {},
			matches: state.matches || {},
			bracket: state.bracket || {},
			gameKey,
			characters: await loadCharacterNames(gameKey, options),
			template: null,
			match: null,
			winner: null,
		};
		context.template = await loadTemplate(state, options);
		context.match = resolveCurrentMatch(state, context.template, context);
		context.player1 = context.match.player1;
		context.player2 = context.match.player2;
		context.winner = winnerFromMatch(context.match);
		return context;
	}

	function optionsFromDocument(overrides) {
		const body = document.body || {};
		const params = new URLSearchParams(global.location.search || "");
		return Object.assign(
			{
				stateURL: body.getAttribute?.("data-state-url") || DEFAULT_STATE_URL,
				templateRoot: body.getAttribute?.("data-template-root") || DEFAULT_TEMPLATE_ROOT,
				assetRoot: body.getAttribute?.("data-asset-root") || DEFAULT_ASSET_ROOT,
				playerRoot: body.getAttribute?.("data-player-root") || DEFAULT_PLAYER_ROOT,
				flagRoot: body.getAttribute?.("data-flag-root") || DEFAULT_FLAG_ROOT,
				frontendFlagRoot: body.getAttribute?.("data-frontend-flag-root") || DEFAULT_FRONTEND_FLAG_ROOT,
				pollMs: toInt(params.get("poll") || body.getAttribute?.("data-poll-ms"), DEFAULT_POLL_MS),
				page: body.getAttribute?.("data-overlay-page") || params.get("page") || "overlay",
			},
			overrides || {},
		);
	}

	async function refresh(options, root, render) {
		const text = await fetchText(options.stateURL);
		if (text === lastStateText) return null;
		lastStateText = text;

		const state = JSON.parse(text);
		const context = await buildContext(state, options);
		setOverlayTheme(context);
		applyBindings(root, context);
		if (typeof render === "function") render(context, StreamFGCOverlay);
		return context;
	}

	function start(options) {
		const settings = optionsFromDocument(options);
		const root = settings.root || document;
		const render = settings.render;

		if (activeTimer) global.clearInterval(activeTimer);

		async function tick() {
			try {
				await refresh(settings, root, render);
			} catch (error) {
				handleRuntimeError(error, settings);
			}
		}

		void tick();
		activeTimer = global.setInterval(tick, Math.max(250, settings.pollMs));
		return {
			stop: function () {
				global.clearInterval(activeTimer);
				activeTimer = null;
			},
			refresh: tick,
			options: settings,
		};
	}

	const StreamFGCOverlay = {
		init: start,
		refresh,
		applyBindings,
		swapText,
		swapHTML,
		swapImage,
		swapBackground,
		readPath,
		nopic: NOPIC_URL,
		templateFileName,
		sortedMatchIDs,
		resolveMatch,
	};

	global.StreamFGCOverlay = StreamFGCOverlay;
})(window);
