"use strict";

/*
 * File: _app.js
 * Desc: Stream.FGC controller UI. Keeps SPA.js pages in sync with the Wails backend JSON state.
 * Deps: SPA.js, jQuery, Select2, Dropzone, Font Awesome, Wails bindings.
 */
(function (global) {
	const EVENT_FORM = "[data-event-form]";
	const CURRENT_MATCH = "[data-current-match]";
	const PLAYER_PAGE = "[data-player-page]";
	const AUTOSAVE_DELAY = 700;
	const AUTOSAVE_STORAGE_KEY = "streamFgc.autosave";
	const FALLBACK_ASSET = "./assets/nopic.png";
	const EMPTY_STATE_CLASS = "fgc-empty border rounded p-3 text-center";
	const SPA_BACKGROUND_FALLBACK = "./assets/nobg.jpg";
	const PLAYER_PORTRAIT_MAX_MB = 10;
	const DEFAULT_RULES = [
		{ key: "ft1", name: "FT1" },
		{ key: "ft2", name: "FT2" },
		{ key: "ft3", name: "FT3" },
		{ key: "ft5", name: "FT5" },
		{ key: "ft10", name: "FT10" },
	];
	const DEFAULT_FORMATS = [
		{ key: "single_elimination", name: "Single Elimination" },
		{ key: "double_elimination", name: "Double Elimination" },
	];
	const DEFAULT_SIZES = [
		{ key: "2", name: "2" },
		{ key: "4", name: "4" },
		{ key: "8", name: "8" },
		{ key: "16", name: "16" },
		{ key: "32", name: "32" },
	];
	let currentState = null;
	let rules = [];
	let formats = [];
	let sizes = [];
	let games = [];
	let characters = [];
	let charactersGame = null;
	let countryCodes = [];
	let countryNames = {};
	let backgroundSyncing = false;
	const countryNameCache = {};
	const autosaveForms = new WeakMap();
	const autosaveFormSet = new Set();

	// --- Backend and status helpers ---

	/** Returns the Wails backend binding, supporting current and generated namespaces. */
	function backend() {
		return global.go?.backend?.App || global.go?.main?.App || null;
	}

	/** Waits without blocking the UI thread. */
	function sleep(ms) {
		return new Promise(function (resolve) {
			global.setTimeout(resolve, ms);
		});
	}

	/** Polls briefly for Wails bindings, which can arrive after page scripts run. */
	async function waitForBackend(timeout = 2000) {
		const started = Date.now();
		let app = backend();
		while (!app && Date.now() - started < timeout) {
			await sleep(50);
			app = backend();
		}
		return app;
	}

	/** Resolves one i18n string through SPA.js and falls back to a literal label. */
	function t(key, fallback) {
		return global.byCommon?.getLangString?.(key, fallback) || fallback;
	}

	/** Finds the current Stream.FGC page shell for a form or control. */
	function pageRoot(element) {
		return element.closest(".fgc-page") || document;
	}

	/** Chooses the Font Awesome icon that matches a status key/tone. */
	function statusIconClass(key, tone) {
		if (String(key).includes("loading") || String(key).includes("saving") || String(key).includes("uploading") || String(key).includes("removing")) return "fas fa-spinner fa-spin";
		if (String(key).includes("pending")) return "fas fa-clock";
		if (String(key).includes("unsaved") || tone === "warning") return "fas fa-triangle-exclamation";
		if (tone === "error" || String(key).includes("failed")) return "fas fa-circle-exclamation";
		if (tone === "success" || String(key).includes("ready") || String(key).includes("saved")) return "fas fa-circle-check";
		return "fas fa-circle-info";
	}

	/** Rebuilds a status badge with its i18n key, tone, icon, and text. */
	function setStatusElement(status, key, fallback, tone) {
		status.setAttribute("data-i18n", key);
		status.dataset.tone = tone;
		status.replaceChildren();

		const icon = document.createElement("i");
		icon.className = `${statusIconClass(key, tone)} flex-shrink-0`;
		icon.setAttribute("aria-hidden", "true");

		const text = document.createElement("span");
		text.className = "fgc-status-text";
		text.textContent = t(key, fallback);

		status.append(icon, text);
	}

	/** Re-applies status icons after SPA language changes replace text content. */
	function refreshStatusIcons(root = document) {
		root.querySelectorAll(".fgc-status[data-i18n]").forEach(function (status) {
			if (!(status instanceof HTMLElement)) return;
			const key = status.getAttribute("data-i18n") || "";
			const fallback = status.textContent.trim() || key;
			setStatusElement(status, key, fallback, status.dataset.tone || "neutral");
		});
	}

	/** Sets the event page status badge. */
	function setStatus(form, key, fallback, tone = "neutral") {
		const status = pageRoot(form).querySelector("[data-event-status]");
		if (!status) return;
		setStatusElement(status, key, fallback, tone);
	}

	/** Sets the players page status badge. */
	function setPlayerStatus(page, key, fallback, tone = "neutral") {
		const status = page.querySelector("[data-player-status]");
		if (!status) return;
		setStatusElement(status, key, fallback, tone);
	}

	// --- DOM and form helpers ---

	/** Escapes strings before interpolating dynamic HTML. */
	function escapeHtml(value) {
		return String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	}

	/** Reads a named input/select from a form. */
	function formControl(form, name) {
		const control = form.elements.namedItem(name);
		return control instanceof HTMLInputElement || control instanceof HTMLSelectElement ? control : null;
	}

	/** Selects an option by key, value, display name, or normalized text. */
	function setSelectValue(select, value) {
		const selected = String(value ?? "");
		const option = Array.from(select.options).find(function (candidate) {
			return (
				String(candidate.value).toLowerCase() === selected.toLowerCase() ||
				String(candidate.dataset.key || "").toLowerCase() === selected.toLowerCase() ||
				normalizeCatalogText(candidate.value) === normalizeCatalogText(selected) ||
				normalizeCatalogText(candidate.textContent) === normalizeCatalogText(selected)
			);
		});
		select.value = option?.value || selected;
	}

	/** Writes a backend event state into the event form controls. */
	function fillEventForm(form, event) {
		["name", "phase", "rule", "game", "format", "size"].forEach(function (field) {
			const control = formControl(form, field);
			if (!control) return;
			const value = event?.[field] ?? (field === "size" ? 8 : "");
			if (control instanceof HTMLSelectElement) {
				setSelectValue(control, value);
			} else {
				control.value = String(value);
			}
			if (control instanceof HTMLSelectElement && control.classList.contains("select2-hidden-accessible")) {
				global.jQuery?.(control)?.trigger("change.select2");
			}
		});
		applyGameBackground(form);
	}

	/** Reads the event editor into the backend EventInfo shape. */
	function readEventForm(form) {
		return {
			name: formControl(form, "name")?.value.trim() || "",
			phase: formControl(form, "phase")?.value.trim() || "",
			rule: formControl(form, "rule")?.value.trim() || "",
			game: formControl(form, "game")?.value.trim() || "",
			format: formControl(form, "format")?.value || "double_elimination",
			size: Number(formControl(form, "size")?.value || 8),
		};
	}

	/** Builds a stable comparison string for event autosave. */
	function eventSignature(event) {
		return JSON.stringify({
			name: String(event?.name || ""),
			phase: String(event?.phase || ""),
			rule: String(event?.rule || ""),
			game: String(event?.game || ""),
			format: String(event?.format || "double_elimination"),
			size: Number(event?.size || 8),
		});
	}

	/** Builds a stable comparison string for player autosave. */
	function playerSignature(player) {
		return JSON.stringify({
			name: String(player?.name || ""),
			team: String(player?.team || ""),
			country: String(player?.country || "").toUpperCase(),
			character: String(player?.character || ""),
		});
	}

	/** Enables or disables every editable control in a form. */
	function setFormEnabled(form, enabled) {
		form.querySelectorAll("input, select, button").forEach(function (control) {
			control.disabled = !enabled;
		});
	}

	/** Enables or disables every editable control in a page. */
	function setPageEnabled(page, enabled) {
		page.querySelectorAll("input, select, button").forEach(function (control) {
			control.disabled = !enabled;
		});
	}

	/** Builds a form signature through the supplied reader function. */
	function formSignature(reader, form) {
		return JSON.stringify(reader(form));
	}

	// --- Autosave ---

	/** Returns or initializes the autosave bookkeeping for a form. */
	function autosaveState(form) {
		let state = autosaveForms.get(form);
		if (!state) {
			state = {
				lastSaved: "",
				options: null,
				pending: false,
				saving: false,
				timer: 0,
			};
			autosaveForms.set(form, state);
		}
		return state;
	}

	/** Marks the current form signature as already persisted. */
	function markAutosaved(form, signature) {
		autosaveState(form).lastSaved = signature;
	}

	/** Temporarily locks buttons while a save request is in flight. */
	function setButtonsEnabled(root, enabled) {
		root.querySelectorAll("button").forEach(function (button) {
			button.disabled = !enabled;
		});
	}

	/** Reads the user's autosave preference from localStorage. */
	function isAutosaveEnabled() {
		try {
			return global.localStorage?.getItem(AUTOSAVE_STORAGE_KEY) !== "false";
		} catch (_) {
			return true;
		}
	}

	/** Persists the user's autosave preference. */
	function setAutosaveEnabled(enabled) {
		try {
			global.localStorage?.setItem(AUTOSAVE_STORAGE_KEY, enabled ? "true" : "false");
		} catch (_) {
			// localStorage may be unavailable in some embedded contexts.
		}
	}

	/** Shows the correct ready status for the event page. */
	function setEventReadyStatus(form) {
		if (isAutosaveEnabled()) {
			setStatus(form, "event_status_ready", "Autosave ready", "success");
			return;
		}
		setStatus(form, "event_status_manual_ready", "Manual save ready", "neutral");
	}

	/** Shows the correct ready status for the players page. */
	function setPlayerReadyStatus(page) {
		if (isAutosaveEnabled()) {
			setPlayerStatus(page, "players_status_ready", "Autosave ready", "success");
			return;
		}
		setPlayerStatus(page, "players_status_manual_ready", "Manual save ready", "neutral");
	}

	/** Checks whether one form has edits not reflected in its last saved signature. */
	function formIsDirty(form) {
		const state = autosaveForms.get(form);
		return Boolean(state?.options && state.options.signature() !== state.lastSaved);
	}

	/** Checks whether any form in a page has pending manual-save changes. */
	function pageHasDirtyForms(page) {
		return Array.from(page.querySelectorAll("form")).some(function (form) {
			return form instanceof HTMLFormElement && formIsDirty(form);
		});
	}

	/** Refreshes status text when autosave is toggled on or off. */
	function refreshAutosaveModeStatuses() {
		const enabled = isAutosaveEnabled();
		const form = document.querySelector(EVENT_FORM);
		if (form instanceof HTMLFormElement && currentState?.event) {
			if (!enabled && formIsDirty(form)) {
				setStatus(form, "event_status_unsaved", "Unsaved event changes", "warning");
			} else if (!formIsDirty(form)) {
				setEventReadyStatus(form);
			}
		}

		document.querySelectorAll(PLAYER_PAGE).forEach(function (page) {
			if (!(page instanceof HTMLElement) || !currentState) return;
			if (!enabled && pageHasDirtyForms(page)) {
				setPlayerStatus(page, "players_status_unsaved", "Unsaved player changes", "warning");
			} else if (!pageHasDirtyForms(page)) {
				setPlayerReadyStatus(page);
			}
		});
	}

	/** Cancels delayed autosaves when manual mode is enabled. */
	function clearAutosaveTimers() {
		autosaveFormSet.forEach(function (form) {
			const state = autosaveForms.get(form);
			if (!state?.timer) return;
			global.clearTimeout(state.timer);
			state.timer = 0;
		});
	}

	/** Applies autosave preference to toggles, page attributes, and dirty forms. */
	function applyAutosavePreference(scheduleDirty = false) {
		const enabled = isAutosaveEnabled();
		document.querySelectorAll("[data-autosave-toggle]").forEach(function (toggle) {
			if (toggle instanceof HTMLInputElement) toggle.checked = enabled;
		});
		document.querySelectorAll(".fgc-page").forEach(function (page) {
			page.setAttribute("data-autosave", enabled ? "on" : "off");
		});

		if (!enabled) {
			clearAutosaveTimers();
			return;
		}

		if (!scheduleDirty) return;
		autosaveFormSet.forEach(function (form) {
			const state = autosaveForms.get(form);
			if (!state?.options || state.options.signature() === state.lastSaved) return;
			scheduleAutosave(form, state.options);
		});
	}

	/** Binds every autosave toggle found in a freshly loaded SPA page. */
	function bindAutosaveToggles(root = document) {
		root.querySelectorAll("[data-autosave-toggle]").forEach(function (toggle) {
			if (!(toggle instanceof HTMLInputElement) || toggle.dataset.bound === "true") return;
			toggle.dataset.bound = "true";
			toggle.checked = isAutosaveEnabled();
			toggle.addEventListener("change", function () {
				setAutosaveEnabled(toggle.checked);
				applyAutosavePreference(toggle.checked);
				refreshAutosaveModeStatuses();
			});
		});
	}

	// --- Asset catalogs and select options ---

	/** Normalizes backend catalog rows so select builders can share one shape. */
	function normalizeAssetRows(rows) {
		return (rows || []).map(function (row) {
			return {
				background: String(row?.background || ""),
				key: String(row?.key || ""),
				logo: String(row?.logo || ""),
				name: String(row?.name || ""),
				portrait: String(row?.portrait || ""),
			};
		});
	}

	/** Returns the active SPA language limited to supported app languages. */
	function currentLanguage() {
		const lang = String(global.byCommon?.getLanguage?.() || global.bySPA?.APP_LANG || global.localStorage?.getItem("APP_LANG") || document.documentElement.getAttribute("lang") || "es")
			.slice(0, 2)
			.toLowerCase();
		return lang === "en" ? "en" : "es";
	}

	/** Builds a local asset URL compatible with SPA.js and direct file serving. */
	function appAssetURL(path) {
		const normalized = `/${String(path || "").replace(/^\/+/, "")}`;
		if (typeof global.bySPA?.buildRequestURL === "function") return global.bySPA.buildRequestURL(normalized);
		return `.${normalized}`;
	}

	/** Loads JSON with jQuery when available, otherwise with fetch. */
	async function loadJSON(path) {
		const url = appAssetURL(path);
		const jquery = global.jQuery;
		if (jquery?.ajax) {
			return Promise.resolve(
				jquery.ajax({
					url,
					type: "GET",
					dataType: "json",
					cache: true,
				}),
			);
		}

		const response = await fetch(url, { cache: "force-cache" });
		if (!response.ok) throw new Error(`Could not load ${url}: ${response.status}`);
		return response.json();
	}

	/** Loads localized country names used by the flag Select2 template. */
	async function loadCountryNames(lang = currentLanguage()) {
		const normalized = lang === "en" ? "en" : "es";
		if (countryNameCache[normalized]) return countryNameCache[normalized];

		try {
			const names = await loadJSON(`/lang/flags.${normalized}.json`);
			countryNameCache[normalized] = names || {};
			return countryNameCache[normalized];
		} catch (error) {
			console.warn(`Could not load flag names for ${normalized}`, error);
			if (normalized !== "en") return loadCountryNames("en");
			return {};
		}
	}

	/** Returns the localized country name for a country code. */
	function countryName(code) {
		return countryNames[String(code || "").toLowerCase()] || "";
	}

	/** Builds the visible country select label: CODE (Country). */
	function countryLabel(code) {
		const normalized = String(code || "").toUpperCase();
		const name = countryName(normalized);
		return name ? `${normalized} (${name})` : normalized;
	}

	/** Calls an optional backend list method and falls back quietly if unavailable. */
	async function optionalBackendList(app, methodName, fallback) {
		if (typeof app?.[methodName] !== "function") {
			console.warn(`${methodName} is not available in this Wails runtime.`);
			return fallback;
		}

		try {
			return await app[methodName]();
		} catch (error) {
			console.warn(`${methodName} failed`, error);
			return fallback;
		}
	}

	/** Normalizes catalog labels for forgiving old-data comparisons. */
	function normalizeCatalogText(value) {
		return String(value || "")
			.toLowerCase()
			.replace(/[^a-z0-9]/g, "");
	}

	/** Checks whether a stored key/name matches a catalog option. */
	function catalogEntryMatches(entry, value) {
		const selected = String(value || "");
		if (!selected) return false;
		return (
			String(entry?.key || "").toLowerCase() === selected.toLowerCase() ||
			String(entry?.name || "").toLowerCase() === selected.toLowerCase() ||
			normalizeCatalogText(entry?.key) === normalizeCatalogText(selected) ||
			normalizeCatalogText(entry?.name) === normalizeCatalogText(selected)
		);
	}

	/** Writes the selected game's background image into the SPA shell. */
	function setSpaBackground(url) {
		const background = document.getElementById("spa-bg");
		if (!(background instanceof HTMLElement)) return;
		const imageURL = String(url || SPA_BACKGROUND_FALLBACK);
		background.style.backgroundImage = `url("${imageURL.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
	}

	/** Reads the selected game option background and applies it to #spa-bg. */
	function applyGameBackground(form) {
		const select = formControl(form, "game");
		if (!(select instanceof HTMLSelectElement)) return;
		const option = select.selectedOptions[0];
		setSpaBackground(option?.dataset?.background || "");
	}

	/** Ensures the games catalog is loaded before background-only routes need it. */
	async function ensureGameCatalog(app) {
		if (games.length) return games;
		games = normalizeAssetRows(await optionalBackendList(app, "ListGames", []));
		return games;
	}

	/** Finds a game catalog row by stored key or legacy display name. */
	function gameCatalogEntry(game) {
		return games.find(function (entry) {
			return catalogEntryMatches(entry, game);
		});
	}

	/** Applies the saved event game's background without requiring the event page. */
	function applyGameBackgroundFromState(state) {
		const game = state?.event?.game || "";
		const entry = gameCatalogEntry(game);
		setSpaBackground(entry?.background || "");
	}

	/** Ensures the character catalog matches the active event game. */
	async function ensureCharacterCatalog(app, game) {
		const gameKey = String(game || "");
		if (charactersGame === gameKey) return characters;
		characters = typeof app?.ListCharacters === "function" ? normalizeAssetRows(await app.ListCharacters(gameKey)) : [];
		charactersGame = gameKey;
		return characters;
	}

	/** Finds a character catalog row by stored key or legacy display name. */
	function characterCatalogEntry(character) {
		return characters.find(function (entry) {
			return catalogEntryMatches(entry, character);
		});
	}

	/** Keeps #spa-bg aligned with tournament.json on any SPA route. */
	async function syncSpaBackground() {
		if (backgroundSyncing) return;
		backgroundSyncing = true;
		try {
			const app = await waitForBackend();
			if (!app) return;
			const state = currentState || (typeof app.LoadTournament === "function" ? await app.LoadTournament() : null);
			await ensureGameCatalog(app);
			applyGameBackgroundFromState(state);
		} catch (error) {
			console.warn("Could not sync SPA background", error);
		} finally {
			backgroundSyncing = false;
		}
	}

	/** Builds game select options with logo metadata for Select2. */
	function gameOptions(selectedGame) {
		const selected = String(selectedGame || "");
		let matched = false;
		const options = games.map(function (game) {
			const isSelected = catalogEntryMatches(game, selected);
			matched = matched || isSelected;
			return `<option value="${escapeHtml(game.key)}" data-key="${escapeHtml(game.key)}" data-logo="${escapeHtml(game.logo || FALLBACK_ASSET)}" data-background="${escapeHtml(game.background || "")}"${isSelected ? " selected" : ""}>${escapeHtml(game.name)}</option>`;
		});

		if (selected && !matched) {
			options.unshift(`<option value="${escapeHtml(selected)}" data-logo="${escapeHtml(FALLBACK_ASSET)}" data-background="" selected>${escapeHtml(selected)}</option>`);
		}

		return ['<option value=""></option>'].concat(options).join("");
	}

	/** Builds simple key/value select options for rules and formats. */
	function catalogOptions(rows, selectedValue, valueField) {
		const selected = String(selectedValue || "");
		let matched = false;
		const options = rows.map(function (row) {
			const isSelected = catalogEntryMatches(row, selected);
			const value = valueField === "key" ? row.key : row.name;
			matched = matched || isSelected;
			return `<option value="${escapeHtml(value)}" data-key="${escapeHtml(row.key)}"${isSelected ? " selected" : ""}>${escapeHtml(row.name)}</option>`;
		});

		if (selected && !matched) {
			options.unshift(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>`);
		}

		return ['<option value=""></option>'].concat(options).join("");
	}

	/** Builds character select options with portrait metadata for Select2. */
	function characterOptions(selectedCharacter) {
		const selected = String(selectedCharacter || "");
		let matched = false;
		const options = characters.map(function (character) {
			const isSelected = catalogEntryMatches(character, selected);
			matched = matched || isSelected;
			return `<option value="${escapeHtml(character.key)}" data-key="${escapeHtml(character.key)}" data-portrait="${escapeHtml(character.portrait || FALLBACK_ASSET)}"${isSelected ? " selected" : ""}>${escapeHtml(character.name)}</option>`;
		});

		if (selected && !matched) {
			options.unshift(`<option value="${escapeHtml(selected)}" data-portrait="${escapeHtml(FALLBACK_ASSET)}" selected>${escapeHtml(selected)}</option>`);
		}

		return ['<option value=""></option>'].concat(options).join("");
	}

	/** Replaces the game select options before Select2 is initialized. */
	function renderGameSelect(form, selectedGame) {
		const select = formControl(form, "game");
		if (!(select instanceof HTMLSelectElement)) return;
		destroySelect(select);
		select.innerHTML = gameOptions(selectedGame);
	}

	/** Replaces a simple catalog select before Select2 is initialized. */
	function renderCatalogSelect(form, name, rows, selectedValue, valueField) {
		const select = formControl(form, name);
		if (!(select instanceof HTMLSelectElement)) return;
		destroySelect(select);
		select.innerHTML = catalogOptions(rows, selectedValue, valueField);
	}

	/** Saves immediately and repeats if edits arrived while the save was running. */
	async function flushAutosave(form, options) {
		const state = autosaveState(form);
		if (state.timer) {
			global.clearTimeout(state.timer);
			state.timer = 0;
		}

		if (state.saving) {
			state.pending = true;
			return;
		}

		state.saving = true;
		setButtonsEnabled(form, false);
		try {
			do {
				state.pending = false;
				const signature = options.signature();
				if (signature === state.lastSaved) continue;
				const savedSignature = await options.save();
				if (!savedSignature) break;
				state.lastSaved = savedSignature;
			} while (state.pending || options.signature() !== state.lastSaved);
		} finally {
			state.saving = false;
			setButtonsEnabled(form, true);
		}
	}

	/** Debounces autosave or marks the form as dirty in manual mode. */
	function scheduleAutosave(form, options) {
		const state = autosaveState(form);
		const signature = options.signature();
		if (signature === state.lastSaved && !state.saving) return;

		if (!isAutosaveEnabled()) {
			options.manualPending?.();
			return;
		}

		options.pending();
		if (state.timer) global.clearTimeout(state.timer);
		state.timer = global.setTimeout(function () {
			void flushAutosave(form, options);
		}, AUTOSAVE_DELAY);
	}

	/** Binds autosave listeners to native controls and Select2 change events. */
	function bindAutosave(form, options) {
		if (form.dataset.autosaveBound === "true") return;
		form.dataset.autosaveBound = "true";
		const state = autosaveState(form);
		state.options = options;
		autosaveFormSet.add(form);

		const schedule = function () {
			scheduleAutosave(form, options);
		};

		form.addEventListener("input", schedule);
		form.addEventListener("change", schedule);

		const jquery = global.jQuery;
		if (jquery?.fn) {
			jquery(form).on("change.streamFgcAutosave", "select", schedule);
		}
	}

	// --- Event page ---

	/** Loads tournament/event data, catalogs, and initializes the event form. */
	async function loadEvent(form) {
		const app = await waitForBackend();
		if (!app) {
			setFormEnabled(form, true);
			setStatus(form, "event_status_backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			return;
		}

		setStatus(form, "event_status_loading", "Loading event...", "neutral");
		setFormEnabled(form, false);
		try {
			const state = await app.LoadTournament();
			const [ruleRows, formatRows, sizeRows, gameRows, names] = await Promise.all([
				optionalBackendList(app, "ListRules", DEFAULT_RULES),
				optionalBackendList(app, "ListFormats", DEFAULT_FORMATS),
				optionalBackendList(app, "ListSizes", DEFAULT_SIZES),
				optionalBackendList(app, "ListGames", []),
				loadCountryNames(),
			]);
			currentState = state;
			rules = normalizeAssetRows(ruleRows);
			formats = normalizeAssetRows(formatRows);
			sizes = normalizeAssetRows(sizeRows);
			games = normalizeAssetRows(gameRows);
			countryNames = names || {};
			await ensureCharacterCatalog(app, currentState.event?.game || "");
			renderCatalogSelect(form, "rule", rules, currentState.event?.rule, "key");
			renderCatalogSelect(form, "format", formats, currentState.event?.format, "key");
			renderCatalogSelect(form, "size", sizes, currentState.event?.size, "key");
			renderGameSelect(form, currentState.event?.game);
			fillEventForm(form, currentState.event || {});
			setFormEnabled(form, true);
			enhanceSelects(form);
			applyAutosavePreference();
			markAutosaved(form, eventSignature(currentState.event || {}));
			if (formSignature(readEventForm, form) !== eventSignature(currentState.event || {})) {
				const state = autosaveForms.get(form);
				if (state?.options) scheduleAutosave(form, state.options);
			} else {
				setEventReadyStatus(form);
			}
			const matchPanel = currentMatchPanel(form);
			if (matchPanel) void loadCurrentMatch(matchPanel);
		} catch (error) {
			console.error("LoadTournament failed", error);
			setStatus(form, "event_status_load_failed", "Event load failed", "error");
		} finally {
			setFormEnabled(form, true);
		}
	}

	/** Persists the event form through the backend and returns its saved signature. */
	async function saveEvent(form) {
		const app = await waitForBackend();
		if (!app) {
			setStatus(form, "event_status_backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			return "";
		}

		const eventPayload = readEventForm(form);
		const submittedSignature = JSON.stringify(eventPayload);
		const autosave = isAutosaveEnabled();
		setStatus(form, autosave ? "event_status_saving" : "event_status_saving_manual", autosave ? "Autosaving event..." : "Saving event...", "neutral");
		try {
			currentState = await app.UpdateEvent(eventPayload);
			await ensureCharacterCatalog(app, currentState.event?.game || "");
			if (formSignature(readEventForm, form) === submittedSignature) {
				fillEventForm(form, currentState.event || {});
			}
			const matchPanel = currentMatchPanel(form);
			if (matchPanel) void loadCurrentMatch(matchPanel);
			setStatus(form, autosave ? "event_status_saved" : "event_status_saved_manual", autosave ? "Event autosaved" : "Event saved", "success");
			return submittedSignature;
		} catch (error) {
			console.error("UpdateEvent failed", error);
			setStatus(form, "event_status_failed", "Event save failed", "error");
			return "";
		}
	}

	/** Binds event form submit, reload, and autosave behavior once. */
	function bindEventForm(form) {
		if (form.dataset.bound === "true") return;
		form.dataset.bound = "true";

		form.addEventListener("submit", function (event) {
			event.preventDefault();
			void flushAutosave(form, {
				manualPending: function () {
					setStatus(form, "event_status_unsaved", "Unsaved event changes", "warning");
				},
				pending: function () {
					setStatus(form, "event_status_pending", "Event changes pending...", "neutral");
				},
				save: function () {
					return saveEvent(form);
				},
				signature: function () {
					return formSignature(readEventForm, form);
				},
			});
		});

		bindAutosave(form, {
			manualPending: function () {
				setStatus(form, "event_status_unsaved", "Unsaved event changes", "warning");
			},
			pending: function () {
				setStatus(form, "event_status_pending", "Event changes pending...", "neutral");
			},
			save: function () {
				return saveEvent(form);
			},
			signature: function () {
				return formSignature(readEventForm, form);
			},
		});

		const gameSelect = formControl(form, "game");
		if (gameSelect instanceof HTMLSelectElement) {
			gameSelect.addEventListener("change", function () {
				applyGameBackground(form);
			});
		}

		const reload = pageRoot(form).querySelector("[data-event-reload]");
		if (reload) {
			reload.addEventListener("click", function () {
				void loadEvent(form);
			});
		}

		void loadEvent(form);
	}

	// --- Current match panel ---

	/** Returns the current-match panel that belongs to an event form. */
	function currentMatchPanel(form) {
		const panel = pageRoot(form).querySelector(CURRENT_MATCH);
		return panel instanceof HTMLElement ? panel : null;
	}

	/** Reads one numeric score from the current-match panel. */
	function readMatchScore(panel, playerNumber) {
		const input = panel.querySelector(`[data-score-input="${playerNumber}"]`);
		if (!(input instanceof HTMLInputElement)) return 0;
		return Math.max(0, Math.floor(Number(input.value || 0)));
	}

	/** Locks score controls while a score write is in flight. */
	function setMatchControlsEnabled(panel, enabled) {
		panel.querySelectorAll("[data-score-action], [data-score-input], [data-current-match-reload]").forEach(function (control) {
			control.disabled = !enabled;
		});
	}

	/** Returns a participant display name, falling back to the bracket source. */
	function participantName(participant) {
		if (participant?.resolved) return participant.player?.name || t("match_tbd", "TBD");
		return participant?.pending_label || t("match_tbd", "TBD");
	}

	/** Returns the optional team/country line for a resolved participant. */
	function participantMeta(participant) {
		if (!participant?.resolved) return participant?.pending_label || "";
		return participant.player?.team || t("match_no_team", "No team");
	}

	/** Builds the country flag and localized label for a match participant. */
	function participantCountryHTML(participant) {
		const country = String(participant?.player?.country || "").toUpperCase();
		if (!participant?.resolved || !country) return "";
		const image = isISO2Code(country)
			? `<img class="flex-shrink-0 rounded-1" src="${escapeHtml(countryFlagPath(country))}" alt="" loading="lazy" data-flag-image style="width: 1.35rem; height: 0.95rem; object-fit: cover; box-shadow: 0 0 0 1px var(--fgc-border);" />`
			: "";
		return `<span class="d-inline-flex gap-2 align-items-center mw-100 mt-2 fw-bold" style="color: var(--fgc-text-soft);">${image}<span class="text-truncate">${escapeHtml(countryLabel(country))}</span></span>`;
	}

	/** Returns display metadata for a player's selected character. */
	function participantCharacter(participant) {
		const key = String(participant?.player?.character || "");
		const entry = characterCatalogEntry(key);
		if (!participant?.resolved || !key) {
			return {
				name: t("match_no_character", "No character"),
				portrait: FALLBACK_ASSET,
			};
		}
		return {
			name: entry?.name || key,
			portrait: entry?.portrait || FALLBACK_ASSET,
		};
	}

	/** Creates the player and character image cluster for one match side. */
	function matchMediaHTML(participant, side) {
		const character = participantCharacter(participant);
		const playerImage = participant?.resolved && participant.player_id ? playerPortraitPath(participant.player_id) : FALLBACK_ASSET;
		return [
			`<div class="d-flex gap-2 col-12 col-sm-6">`,
			`<div class="flex-grow-1 overflow-hidden rounded border d-flex flex-column" data-match-image-frame>`,
			...(side === 1
				? [
						`<img class="w-100 h-100 object-fit-cover" src="${escapeHtml(character.portrait)}" alt="" loading="lazy" data-fallback-image />`,
						`<span class="px-1 py-1 small fw-bold lh-sm text-center text-truncate" data-match-character-label>${escapeHtml(character.name)}</span>`,
					]
				: [`<img class="w-100 h-100 object-fit-cover" src="${escapeHtml(playerImage)}" alt="" loading="lazy" data-fallback-image />`]),
			`</div>`,
			`<div class="flex-grow-1 overflow-hidden rounded border d-flex flex-column" data-match-image-frame>`,
			...(side === 1
				? [`<img class="w-100 h-100 object-fit-cover" src="${escapeHtml(playerImage)}" alt="" loading="lazy" data-fallback-image />`]
				: [
						`<img class="w-100 h-100 object-fit-cover" src="${escapeHtml(character.portrait)}" alt="" loading="lazy" data-fallback-image />`,
						`<span class="px-1 py-1 small fw-bold lh-sm text-center text-truncate" data-match-character-label>${escapeHtml(character.name)}</span>`,
					]),
			`</div>`,
			`</div>`,
		].join("");
	}

	/** Creates one side of the current-match scoreboard. */
	function matchPlayerCard(match, side) {
		const participant = side === 1 ? match?.player1 : match?.player2;
		const scoreKey = side === 1 ? "player1_score" : "player2_score";
		const score = Math.max(0, Number(match?.state?.[scoreKey] || 0));
		const name = participantName(participant);
		const meta = participantMeta(participant);
		const country = participantCountryHTML(participant);
		const playerID = participant?.player_id ? `${participant.player_id}` : "";
		const opacity = participant?.resolved ? "" : ` style="opacity: 0.72;"`;

		return [
			`<article class="col-12 col-lg-5">`,
			`<div class="h-100 border rounded p-3"${opacity} data-match-card>`,
			`<div class="row g-3 align-items-stretch">`,
			`<div class="col-12 d-flex flex-wrap gap-2 align-items-baseline justify-content-between">`,
			side === 1
				? `<p class="fgc-kicker m-0">${escapeHtml(side === 1 ? t("match_player_one", "Player 1") : t("match_player_two", "Player 2"))}</p>`
				: `<span class="fgc-title fw-bold fs-5">${escapeHtml(playerID)}</span>`,
			side === 1
				? `<span class="fgc-title fw-bold fs-5">${escapeHtml(playerID)}</span>`
				: `<p class="fgc-kicker m-0">${escapeHtml(side === 1 ? t("match_player_one", "Player 1") : t("match_player_two", "Player 2"))}</p>`,
			`</div>`,
			side === 1 ? matchMediaHTML(participant, side) : "",
			`<div class="col-12 col-sm d-flex flex-column ${side === 1 ? "align-items-end" : "align-items-start"}">`,
			`<h3 class="fgc-title fs-5 lh-sm m-0">${escapeHtml(name)}</h3>`,
			`<p class="m-0 mt-2 fw-bold text-truncate" style="color: var(--fgc-text-muted);">${escapeHtml(meta || "")}</p>`,
			country,
			`<div class="input-group mt-3" data-score-group="${side}" style="max-width: 10rem;">`,
			`<button class="btn btn-outline-light" type="button" data-score-action="dec" data-score-player="${side}" aria-label="${escapeHtml(t("match_score_down", "Decrease score"))}"><i class="fas fa-minus" aria-hidden="true"></i></button>`,
			`<input class="form-control text-center" style="max-width: 4.5rem;" type="number" min="0" step="1" value="${score}" data-score-input="${side}" aria-label="${escapeHtml(t("match_score_label", "Score"))}" />`,
			`<button class="btn btn-outline-light" type="button" data-score-action="inc" data-score-player="${side}" aria-label="${escapeHtml(t("match_score_up", "Increase score"))}"><i class="fas fa-plus" aria-hidden="true"></i></button>`,
			`</div>`,
			`</div>`,
			side === 1 ? "" : matchMediaHTML(participant, side),
			`</div>`,
			`</div>`,
			`</article>`,
		].join("");
	}

	/** Draws a resolved current match into the event page. */
	function renderCurrentMatch(panel, match) {
		const title = panel.querySelector("[data-current-match-title]");
		const body = panel.querySelector("[data-current-match-body]");
		if (!body) return;

		const matchID = match?.id || currentState?.current || "";
		const matchName = match?.name || t("match_title", "Current match");
		panel.dataset.matchId = matchID;
		if (title) {
			title.removeAttribute("data-i18n");
			title.textContent = matchID ? `${matchName} (${matchID})` : matchName;
		}

		const player1Score = Math.max(0, Number(match?.state?.player1_score || 0));
		const player2Score = Math.max(0, Number(match?.state?.player2_score || 0));
		body.innerHTML = [
			matchPlayerCard(match, 1),
			`<div class="col-12 col-lg-2 d-flex align-items-stretch">`,
			`<div class="w-100 border rounded d-flex gap-2 align-items-center justify-content-center text-center" data-match-card>`,
			`<strong class="fgc-title fs-1 lh-1">${player1Score}</strong>`,
			`<span class="fw-bold small" style="color: var(--fgc-brand-soft);">${escapeHtml(t("match_vs", "VS"))}</span>`,
			`<strong class="fgc-title fs-1 lh-1">${player2Score}</strong>`,
			`</div>`,
			`</div>`,
			matchPlayerCard(match, 2),
		].join("");

		body.querySelectorAll("[data-fallback-image]").forEach(function (image) {
			setImageFallback(image);
		});
		body.querySelectorAll("[data-flag-image]").forEach(function (image) {
			if (!(image instanceof HTMLImageElement)) return;
			image.addEventListener("error", function () {
				image.remove();
			});
		});
	}

	/** Loads the current match through the backend resolver. */
	async function loadCurrentMatch(panel) {
		const app = await waitForBackend();
		const body = panel.querySelector("[data-current-match-body]");
		if (!app) {
			if (body) body.innerHTML = `<div class="col-12"><div class="${EMPTY_STATE_CLASS}">${escapeHtml(t("event_status_backend_missing", "Open in Wails to edit tournament JSON."))}</div></div>`;
			return;
		}

		if (body) body.innerHTML = `<div class="col-12"><div class="${EMPTY_STATE_CLASS}">${escapeHtml(t("match_loading", "Loading current match..."))}</div></div>`;
		try {
			if (!currentState) currentState = await app.LoadTournament();
			await ensureCharacterCatalog(app, currentState?.event?.game || "");
			if (!Object.keys(countryNames).length) countryNames = (await loadCountryNames()) || {};
			const match = await app.ResolveMatch(currentState?.current || "");
			renderCurrentMatch(panel, match);
		} catch (error) {
			console.error("ResolveMatch failed", error);
			if (body) body.innerHTML = `<div class="col-12"><div class="${EMPTY_STATE_CLASS}">${escapeHtml(t("match_load_failed", "Current match load failed"))}</div></div>`;
			setStatus(panel, "match_status_load_failed", "Current match load failed", "error");
		}
	}

	/** Persists current-match score controls into tournament.json. */
	async function saveCurrentMatchScore(panel) {
		const app = await waitForBackend();
		if (!app) {
			setStatus(panel, "event_status_backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			return;
		}

		const matchID = panel.dataset.matchId || currentState?.current || "";
		const player1Score = readMatchScore(panel, 1);
		const player2Score = readMatchScore(panel, 2);
		setStatus(panel, "match_status_saving", "Saving match score...", "neutral");
		setMatchControlsEnabled(panel, false);
		try {
			currentState = await app.UpdateMatchScore(matchID, player1Score, player2Score);
			const match = await app.ResolveMatch(matchID);
			renderCurrentMatch(panel, match);
			setStatus(panel, "match_status_saved", "Match score saved", "success");
		} catch (error) {
			console.error("UpdateMatchScore failed", error);
			setStatus(panel, "match_status_failed", "Match score save failed", "error");
		} finally {
			setMatchControlsEnabled(panel, true);
		}
	}

	/** Binds delegated score and reload controls for the current-match panel. */
	function bindCurrentMatch(panel) {
		if (panel.dataset.bound === "true") return;
		panel.dataset.bound = "true";

		panel.addEventListener("click", function (event) {
			const target = event.target instanceof Element ? event.target : null;
			const reload = target?.closest("[data-current-match-reload]");
			if (reload) {
				void loadCurrentMatch(panel);
				return;
			}

			const button = target?.closest("[data-score-action]");
			if (!(button instanceof HTMLButtonElement)) return;
			const playerNumber = button.getAttribute("data-score-player") || "";
			const input = panel.querySelector(`[data-score-input="${playerNumber}"]`);
			if (!(input instanceof HTMLInputElement)) return;
			const delta = button.getAttribute("data-score-action") === "dec" ? -1 : 1;
			input.value = String(Math.max(0, readMatchScore(panel, playerNumber) + delta));
			void saveCurrentMatchScore(panel);
		});

		panel.addEventListener("change", function (event) {
			if (!(event.target instanceof HTMLInputElement) || !event.target.matches("[data-score-input]")) return;
			event.target.value = String(Math.max(0, Math.floor(Number(event.target.value || 0))));
			void saveCurrentMatchScore(panel);
		});
	}

	// --- Players page ---

	/** Returns one row per configured tournament player slot. */
	function playerEntriesForEvent(state) {
		const players = state?.players || {};
		const configuredSize = Math.floor(Number(state?.event?.size || 0));
		const size = Math.max(0, configuredSize || Object.keys(players).length);
		const rows = [];

		for (let seed = 1; seed <= size; seed += 1) {
			const playerID = String(seed);
			rows.push([playerID, players[playerID] || {}]);
		}

		return rows;
	}

	/** Builds country options from the backend flag list and loaded i18n names. */
	function countryOptions(selectedCountry) {
		const selected = String(selectedCountry || "").toUpperCase();
		const options = countryCodes.slice();
		if (selected && !options.includes(selected)) options.unshift(selected);
		return ['<option value=""></option>']
			.concat(
				options.map(function (code) {
					const name = countryName(code);
					return `<option value="${escapeHtml(code)}" data-country-name="${escapeHtml(name)}"${code === selected ? " selected" : ""}>${escapeHtml(countryLabel(code))}</option>`;
				}),
			)
			.join("");
	}

	/** Validates ISO2 country codes before rendering flag images. */
	function isISO2Code(code) {
		return /^[A-Z]{2}$/.test(String(code || ""));
	}

	/** Returns the frontend flag SVG path for a country code. */
	function countryFlagPath(code) {
		return `./flags/${String(code).toLowerCase()}.svg`;
	}

	/** Returns the player portrait URL, optionally cache-busted after upload/remove. */
	function playerPortraitPath(playerID, cacheBust = false) {
		const key = encodeURIComponent(String(playerID || ""));
		const suffix = cacheBust ? `?v=${Date.now()}` : "";
		return `/players/${key}.png${suffix}`;
	}

	/** Applies the nopic fallback when a portrait URL cannot be loaded. */
	function setImageFallback(image) {
		if (!(image instanceof HTMLImageElement)) return;
		image.addEventListener("error", function () {
			if (image.dataset.fallbackApplied === "true") return;
			image.dataset.fallbackApplied = "true";
			image.src = FALLBACK_ASSET;
		});
	}

	/** Refreshes the portrait preview without rewriting player JSON. */
	function refreshPlayerPortrait(form, url) {
		const image = form.querySelector("[data-player-portrait]");
		if (!(image instanceof HTMLImageElement)) return;
		delete image.dataset.fallbackApplied;
		image.src = url;
	}

	/** Reads an uploaded file as a browser data URL for the Wails backend. */
	function fileAsDataURL(file) {
		return new Promise(function (resolve, reject) {
			const reader = new FileReader();
			reader.addEventListener("load", function () {
				resolve(String(reader.result || ""));
			});
			reader.addEventListener("error", function () {
				reject(reader.error || new Error("Could not read image file"));
			});
			reader.readAsDataURL(file);
		});
	}

	// --- Select2 templates ---

	/** Renders a country Select2 option with flag and localized country name. */
	function countrySelectTemplate(data) {
		const jquery = global.jQuery;
		if (!jquery) return data.text || "";

		const code = String(data.id || data.text || "").toUpperCase();
		if (!code) return jquery("<span>").addClass("fgc-country-option d-inline-flex gap-2 align-items-center");

		const name = data.element?.dataset?.countryName || countryName(code);
		const option = jquery("<span>").addClass("fgc-country-option d-inline-flex gap-2 align-items-center");
		if (isISO2Code(code)) {
			jquery("<img>", {
				alt: "",
				class: "fgc-country-flag",
				loading: "lazy",
				src: countryFlagPath(code),
			}).appendTo(option);
		}
		jquery("<span>")
			.addClass("fgc-country-label")
			.text(name ? `${code} (${name})` : code)
			.appendTo(option);
		return option;
	}

	/** Renders a Select2 option with an image supplied through option metadata. */
	function mediaSelectTemplate(data, imageAttribute, imageClass) {
		const jquery = global.jQuery;
		if (!jquery) return data.text || "";

		const text = String(data.text || "");
		if (!text) return jquery("<span>").addClass("fgc-media-option d-inline-flex gap-2 align-items-center");

		const element = data.element;
		const imagePath = element?.dataset?.[imageAttribute] || FALLBACK_ASSET;
		const option = jquery("<span>").addClass("fgc-media-option d-inline-flex gap-2 align-items-center");
		jquery("<img>", {
			alt: "",
			class: `fgc-media-image ${imageClass}`,
			loading: "lazy",
			src: imagePath,
		})
			.on("error", function () {
				if (this.dataset.fallbackApplied === "true") return;
				this.dataset.fallbackApplied = "true";
				this.src = FALLBACK_ASSET;
			})
			.appendTo(option);
		jquery("<span>").text(text).appendTo(option);
		return option;
	}

	/** Renders game options with their logo. */
	function gameSelectTemplate(data) {
		return mediaSelectTemplate(data, "logo", "fgc-media-image-logo");
	}

	/** Renders character options with their portrait. */
	function characterSelectTemplate(data) {
		return mediaSelectTemplate(data, "portrait", "fgc-media-image-portrait");
	}

	/** Builds the complete Bootstrap player card markup for one player slot. */
	function playerCard(playerID, player) {
		return [
			`<div class="col-12 col-md-6">`,
			`<form class="h-100 border rounded p-3" data-player-card data-player-form="${escapeHtml(playerID)}">`,
			`<div class="row g-3 align-items-stretch">`,
			`<section class="col-12 col-md-4 d-flex">`,
			`<div class="ratio ratio-1x1 overflow-hidden rounded border w-100 mx-auto mx-md-0" data-player-portrait-frame><img class="w-100 h-100 object-fit-cover" data-player-portrait src="${escapeHtml(playerPortraitPath(playerID))}" alt="" loading="lazy" /></div>`,
			`</section>`,
			`<section class="col-12 col-md-8 d-flex flex-column">`,
			`<div class="d-inline-flex gap-2 align-items-baseline text-nowrap mb-3 pb-3"><span class="fgc-kicker fgc-title fs-6 lh-1 m-0" data-i18n="players_player">Player</span><strong class="fgc-title d-inline-block fs-4 lh-1">${escapeHtml(playerID)}</strong></div>`,
			`<div class="row g-3">`,
			`<label class="col-12 col-xl-6 m-0"><span class="d-block mb-2 fw-bold" data-field-label data-i18n="player_name">Name</span><input class="form-control" type="text" name="name" autocomplete="off" value="${escapeHtml(player?.name || "")}" /></label>`,
			`<label class="col-12 col-xl-6 m-0"><span class="d-block mb-2 fw-bold" data-field-label data-i18n="player_team">Team</span><input class="form-control" type="text" name="team" autocomplete="off" value="${escapeHtml(player?.team || "")}" /></label>`,
			`<label class="col-12 col-xl-6 m-0"><span class="d-block mb-2 fw-bold" data-field-label data-i18n="player_country">Country</span><select class="form-select" name="country" data-enhance="select2" data-select-template="country">${countryOptions(player?.country)}</select></label>`,
			`<label class="col-12 col-xl-6 m-0"><span class="d-block mb-2 fw-bold" data-field-label data-i18n="player_character">Character</span><select class="form-select" name="character" data-enhance="select2" data-select-template="character">${characterOptions(player?.character)}</select></label>`,
			`</div>`,
			`<div class="row g-2 align-items-stretch mt-auto pt-3">`,
			`<div class="col-12 col-sm-auto"><div class="dropzone d-inline-flex align-items-center justify-content-center rounded w-100 px-3 py-2" data-player-dropzone><div class="dz-message d-inline-flex gap-2 align-items-center justify-content-center m-0 text-center text-nowrap fw-bold lh-sm"><i class="fas fa-cloud-arrow-up" aria-hidden="true"></i><span data-i18n="player_portrait_drop">Drop or click image</span></div></div></div>`,
			`<div class="col-12 col-sm-auto"><button class="btn btn-outline-danger d-inline-flex gap-2 align-items-center justify-content-center w-100 fw-bold py-2" type="button" data-player-portrait-remove><i class="fas fa-trash" aria-hidden="true"></i> <span data-i18n="player_portrait_remove">Remove picture</span></button></div>`,
			`<div class="col-12 col-sm-auto"><button class="btn btn-danger btn-sm d-inline-flex gap-2 align-items-center justify-content-center w-100 fw-bold py-2" type="submit" data-manual-save><i class="fas fa-save" aria-hidden="true"></i> <span data-i18n="players_save">Save now</span></button></div>`,
			`</div>`,
			`</section>`,
			`</div>`,
			`</form>`,
			`</div>`,
		].join("");
	}

	/** Initializes Select2 on every marked select inside root. */
	function enhanceSelects(root) {
		const jquery = global.jQuery;
		if (!jquery?.fn?.select2) return;
		root.querySelectorAll("select[data-enhance='select2']").forEach(function (select) {
			if (!(select instanceof HTMLSelectElement) || select.classList.contains("select2-hidden-accessible")) return;
			const template = select.getAttribute("data-select-template") || "";
			const templateOptions = {};
			if (template === "country") {
				templateOptions.templateResult = countrySelectTemplate;
				templateOptions.templateSelection = countrySelectTemplate;
			}
			if (template === "game") {
				templateOptions.templateResult = gameSelectTemplate;
				templateOptions.templateSelection = gameSelectTemplate;
			}
			if (template === "character") {
				templateOptions.templateResult = characterSelectTemplate;
				templateOptions.templateSelection = characterSelectTemplate;
			}

			jquery(select).select2({
				dropdownAutoWidth: true,
				width: "100%",
				...templateOptions,
			});
		});
	}

	/** Safely destroys one Select2 instance before replacing its options. */
	function destroySelect(select) {
		const jquery = global.jQuery;
		if (!jquery?.fn?.select2 || !select.classList.contains("select2-hidden-accessible")) return;
		try {
			jquery(select).select2("destroy");
		} catch (_) {
			// Select2 may already be detached during a route rerender.
		}
	}

	/** Destroys all Select2 instances inside a rerendered region. */
	function destroySelects(root) {
		const jquery = global.jQuery;
		if (!jquery?.fn?.select2) return;
		root.querySelectorAll("select.select2-hidden-accessible").forEach(function (select) {
			destroySelect(select);
		});
	}

	/** Reloads localized country labels and refreshes existing country selects. */
	async function refreshCountrySelects(root = document) {
		countryNames = await loadCountryNames();
		root.querySelectorAll("select[name='country']").forEach(function (select) {
			if (!(select instanceof HTMLSelectElement)) return;
			const selected = select.value;
			const wasEnhanced = select.classList.contains("select2-hidden-accessible");
			if (wasEnhanced) destroySelect(select);
			select.innerHTML = countryOptions(selected);
			select.value = selected;
		});
		enhanceSelects(root);
	}

	/** Applies SPA.js i18n to dynamically injected markup. */
	function applyLanguage(root) {
		if (global.byCommon?.applyLanguage && global.byCommon?.LANG_STRINGS) {
			global.byCommon.applyLanguage(root, global.byCommon.LANG_STRINGS);
		}
	}

	/** Renders player cards and binds each generated form. */
	function renderPlayers(page) {
		const list = page.querySelector("[data-player-list]");
		if (!list) return;
		destroySelects(list);
		const rows = playerEntriesForEvent(currentState).map(function ([playerID, player]) {
			return playerCard(playerID, player);
		});
		list.innerHTML = rows.length ? rows.join("") : `<div class="col-12"><div class="${EMPTY_STATE_CLASS}" data-i18n="players_empty">No players found.</div></div>`;
		list.querySelectorAll("[data-player-form]").forEach(function (form) {
			if (!(form instanceof HTMLFormElement)) return;
			bindPlayerForm(form, page);
			const playerID = form.getAttribute("data-player-form") || "";
			const savedSignature = playerSignature(currentState?.players?.[playerID] || {});
			if (formSignature(readPlayerForm, form) !== savedSignature) {
				markAutosaved(form, savedSignature);
				const state = autosaveForms.get(form);
				if (state?.options) scheduleAutosave(form, state.options);
			}
		});
		enhanceSelects(list);
		applyAutosavePreference();
		applyLanguage(list);
	}

	/** Loads tournament players, country codes, and character options for the page. */
	async function loadPlayers(page) {
		const app = await waitForBackend();
		if (!app) {
			setPageEnabled(page, true);
			setPlayerStatus(page, "players_status_backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			return;
		}

		setPlayerStatus(page, "players_status_loading", "Loading players...", "neutral");
		setPageEnabled(page, false);
		try {
			const [state, codes, names] = await Promise.all([app.LoadTournament(), app.ListCountryCodes(), loadCountryNames()]);
			currentState = state;
			await ensureGameCatalog(app);
			applyGameBackgroundFromState(currentState);
			await ensureCharacterCatalog(app, currentState.event?.game || "");
			countryNames = names || {};
			countryCodes = Array.from(
				new Set(
					(codes || []).map(function (code) {
						return String(code).toUpperCase();
					}),
				),
			).sort();
			renderPlayers(page);
			setPlayerReadyStatus(page);
		} catch (error) {
			console.error("Load players failed", error);
			setPlayerStatus(page, "players_status_load_failed", "Player load failed", "error");
		} finally {
			setPageEnabled(page, true);
		}
	}

	/** Reads one player card into the backend Player shape. */
	function readPlayerForm(form) {
		return {
			name: formControl(form, "name")?.value.trim() || "",
			team: formControl(form, "team")?.value.trim() || "",
			country: formControl(form, "country")?.value.trim().toUpperCase() || "",
			character: formControl(form, "character")?.value.trim() || "",
		};
	}

	/** Persists one player card and returns its saved signature. */
	async function savePlayer(form, page) {
		const app = await waitForBackend();
		if (!app) {
			setPlayerStatus(page, "players_status_backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			return "";
		}

		const playerID = form.getAttribute("data-player-form") || "";
		const playerPayload = readPlayerForm(form);
		const submittedSignature = JSON.stringify(playerPayload);
		const autosave = isAutosaveEnabled();
		setPlayerStatus(page, autosave ? "players_status_saving" : "players_status_saving_manual", autosave ? "Autosaving player..." : "Saving player...", "neutral");
		try {
			currentState = await app.UpdatePlayer(playerID, playerPayload);
			setPlayerStatus(page, autosave ? "players_status_saved" : "players_status_saved_manual", autosave ? "Player autosaved" : "Player saved", "success");
			return submittedSignature;
		} catch (error) {
			console.error("UpdatePlayer failed", error);
			setPlayerStatus(page, "players_status_failed", "Player save failed", "error");
			return "";
		}
	}

	/** Uploads a custom portrait through the backend filesystem API. */
	async function uploadPlayerPortrait(form, page, file) {
		const app = await waitForBackend();
		if (!app || typeof app.SavePlayerPortrait !== "function") {
			setPlayerStatus(page, "players_status_backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			return;
		}

		const playerID = form.getAttribute("data-player-form") || "";
		setPlayerStatus(page, "players_status_portrait_uploading", "Uploading portrait...", "neutral");
		try {
			const imageData = await fileAsDataURL(file);
			const url = await app.SavePlayerPortrait(playerID, imageData);
			refreshPlayerPortrait(form, `${url}?v=${Date.now()}`);
			setPlayerStatus(page, "players_status_portrait_saved", "Portrait uploaded", "success");
		} catch (error) {
			console.error("SavePlayerPortrait failed", error);
			setPlayerStatus(page, "players_status_portrait_failed", "Portrait upload failed", "error");
		}
	}

	/** Removes a custom portrait through the backend filesystem API. */
	async function removePlayerPortrait(form, page) {
		const app = await waitForBackend();
		if (!app || typeof app.RemovePlayerPortrait !== "function") {
			setPlayerStatus(page, "players_status_backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			return;
		}

		const playerID = form.getAttribute("data-player-form") || "";
		setPlayerStatus(page, "players_status_portrait_removing", "Removing portrait...", "neutral");
		try {
			const url = await app.RemovePlayerPortrait(playerID);
			refreshPlayerPortrait(form, `${url}?v=${Date.now()}`);
			setPlayerStatus(page, "players_status_portrait_removed", "Portrait removed", "success");
		} catch (error) {
			console.error("RemovePlayerPortrait failed", error);
			setPlayerStatus(page, "players_status_portrait_remove_failed", "Portrait remove failed", "error");
		}
	}

	/** Binds Dropzone to one player card without allowing direct filesystem writes. */
	function bindPlayerPortraitDropzone(form, page) {
		const dropzoneElement = form.querySelector("[data-player-dropzone]");
		if (!(dropzoneElement instanceof HTMLElement) || dropzoneElement.dataset.bound === "true") return;
		dropzoneElement.dataset.bound = "true";

		const image = form.querySelector("[data-player-portrait]");
		setImageFallback(image);

		if (typeof global.Dropzone === "undefined") {
			dropzoneElement.dataset.disabled = "true";
			return;
		}

		global.Dropzone.autoDiscover = false;
		const dropzone = new global.Dropzone(dropzoneElement, {
			acceptedFiles: "image/png,image/jpeg,image/gif",
			autoProcessQueue: false,
			autoQueue: false,
			clickable: true,
			createImageThumbnails: false,
			disablePreviews: true,
			maxFiles: 1,
			maxFilesize: PLAYER_PORTRAIT_MAX_MB,
			previewsContainer: false,
			url: "/players",
		});

		dropzone.on("addedfile", function (file) {
			dropzone.removeAllFiles(true);
			if (!(file instanceof File)) return;
			void uploadPlayerPortrait(form, page, file);
		});
	}

	/** Binds the remove portrait button for one player card. */
	function bindPlayerPortraitRemove(form, page) {
		const removeButton = form.querySelector("[data-player-portrait-remove]");
		if (!(removeButton instanceof HTMLButtonElement) || removeButton.dataset.bound === "true") return;
		removeButton.dataset.bound = "true";
		removeButton.addEventListener("click", function () {
			void removePlayerPortrait(form, page);
		});
	}

	/** Binds save, autosave, and portrait controls for one player card. */
	function bindPlayerForm(form, page) {
		if (form.dataset.bound === "true") return;
		form.dataset.bound = "true";
		markAutosaved(form, formSignature(readPlayerForm, form));
		bindPlayerPortraitDropzone(form, page);
		bindPlayerPortraitRemove(form, page);

		form.addEventListener("submit", function (event) {
			event.preventDefault();
			void flushAutosave(form, {
				manualPending: function () {
					setPlayerStatus(page, "players_status_unsaved", "Unsaved player changes", "warning");
				},
				pending: function () {
					setPlayerStatus(page, "players_status_pending", "Player changes pending...", "neutral");
				},
				save: function () {
					return savePlayer(form, page);
				},
				signature: function () {
					return formSignature(readPlayerForm, form);
				},
			});
		});

		bindAutosave(form, {
			manualPending: function () {
				setPlayerStatus(page, "players_status_unsaved", "Unsaved player changes", "warning");
			},
			pending: function () {
				setPlayerStatus(page, "players_status_pending", "Player changes pending...", "neutral");
			},
			save: function () {
				return savePlayer(form, page);
			},
			signature: function () {
				return formSignature(readPlayerForm, form);
			},
		});
	}

	/** Binds the players page shell and triggers its initial load. */
	function bindPlayerPage(page) {
		if (page.dataset.bound === "true") return;
		page.dataset.bound = "true";
		const reload = page.querySelector("[data-players-reload]");
		if (reload) {
			reload.addEventListener("click", function () {
				void loadPlayers(page);
			});
		}
		void loadPlayers(page);
	}

	// --- SPA lifecycle ---

	/** Initializes controls in the current document or newly loaded SPA content. */
	function init(root = document) {
		bindAutosaveToggles(root);
		applyAutosavePreference();
		refreshStatusIcons(root);
		void syncSpaBackground();
		root.querySelectorAll(EVENT_FORM).forEach(function (form) {
			if (form instanceof HTMLFormElement) bindEventForm(form);
		});
		root.querySelectorAll(CURRENT_MATCH).forEach(function (panel) {
			if (panel instanceof HTMLElement) bindCurrentMatch(panel);
		});
		root.querySelectorAll(PLAYER_PAGE).forEach(function (page) {
			if (page instanceof HTMLElement) bindPlayerPage(page);
		});
	}

	document.addEventListener("DOMContentLoaded", function () {
		init(document);
	});

	// SPA.js swaps page fragments without a full reload, so bind after every route load.
	document.addEventListener("byspa:load", function () {
		init(document);
	});

	// Language changes require dynamic Select2 labels and status icons to be rebuilt.
	document.addEventListener("bycommon:language", function () {
		const form = document.querySelector(EVENT_FORM);
		if (form instanceof HTMLFormElement && currentState?.event) {
			fillEventForm(form, currentState.event);
		}
		void (async function () {
			countryNames = (await loadCountryNames()) || {};
			const matchPanel = document.querySelector(CURRENT_MATCH);
			if (matchPanel instanceof HTMLElement && currentState) await loadCurrentMatch(matchPanel);
			await refreshCountrySelects(document);
			refreshStatusIcons(document);
		})();
	});
})(typeof window !== "undefined" ? window : this);
