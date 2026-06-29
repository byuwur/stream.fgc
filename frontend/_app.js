"use strict";

/*
 * File: _app.js
 * Desc: Stream.FGC controller UI. Keeps SPA.js pages in sync with the Wails backend JSON state.
 * Deps: SPA.js, jQuery, Select2, Dropzone, Font Awesome, Wails bindings.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 *
 * Notes:
 * - The frontend never writes files directly. JSON, portraits, and tournament assets go through Go.
 * - All named functions below use SPA.js-style doc blocks so the app can be read section by section.
 * - `players/_logo.png` and `players/_bg.jpg` are overlay assets. The admin SPA background follows the selected game.
 */
/**
 * Boots the Stream.FGC controller against the browser global object.
 * @param {Object} global The global object, usually `window` in Wails or a browser.
 */
(function (global) {
	/** Builds a frontend-owned URL through SPA.js when possible. */
	function appAssetURL(path) {
		const normalized = `/${String(path || "").replace(/^\/+/, "")}`;
		if (typeof global.bySPA?.buildRequestURL === "function") return global.bySPA.buildRequestURL(normalized);
		return `.${normalized}`;
	}

	/** Builds URLs for external runtime folders beside the repo or portable exe. */
	function externalURL(path) {
		const normalized = String(path || "").replace(/^\/+/, "");
		const homePath = String(global.bySPA?.HOME_PATH || global.location.origin || "").replace(/\/$/, "");
		let base = null;
		try {
			base = new URL(`${homePath || "."}/`, global.location.href);
		} catch (_) {
			base = new URL("./", global.location.href);
		}

		if (base.pathname.replace(/\/$/, "").toLowerCase().endsWith("/frontend")) {
			base = new URL("../", base);
		}

		return new URL(normalized, base).toString();
	}

	const GLOBAL_RELOAD = "[data-global-reload]";
	const EVENT_FORM = "[data-event-form]";
	const CURRENT_MATCH = "[data-current-match]";
	const IMPORT_PAGE = "[data-import-page]";
	const PLAYER_PAGE = "[data-player-page]";
	const BRACKET_PAGE = "[data-bracket-page]";
	const BRACKET_OVERLAY = "[data-bracket-overlay]";
	const BRACKET_ADMIN_VIEW = "all";
	const AUTOSAVE_DELAY = 700;
	const BRACKET_OVERLAY_REFRESH_MS = 2000;
	const AUTOSAVE_STORAGE_KEY = "streamFgc.autosave";
	const FALLBACK_ASSET = externalURL("/assets/nopic.png");
	const EMPTY_STATE_CLASS = "fgc-empty border rounded p-3 text-center";
	const SPA_BACKGROUND_FALLBACK = externalURL("/assets/nobg.jpg");
	const EVENT_LOGO_PATH = externalURL("/players/_logo.png");
	const EVENT_BACKGROUND_PATH = externalURL("/players/_bg.jpg");
	const PLAYER_PORTRAIT_MAX_MB = 10;
	const TOURNAMENT_ASSET_MAX_MB = 20;
	let currentState = null;
	let rules = [];
	let formats = [];
	let sizes = [];
	let games = [];
	let providers = [];
	let characters = [];
	let charactersGame = null;
	let countryCodes = [];
	let countryNames = {};
	let backgroundSyncing = false;
	let generatedBackendPromise = null;
	const countryNameCache = {};
	const autosaveForms = new WeakMap();
	const autosaveFormSet = new Set();
	const bracketLoadTickets = new WeakMap();
	const bracketSeedSelections = new WeakMap();
	const currentSeedSelections = new WeakMap();
	const importUndoStates = new WeakMap();

	// --- Backend and status helpers ---

	function backendBinding() {
		return global.go?.backend?.App || global.go?.main?.App || global.streamFgcBackend || null;
	}

	async function loadGeneratedBackend() {
		const existing = backendBinding();
		if (existing) return existing;
		if (generatedBackendPromise) return generatedBackendPromise;
		if (!global.runtime && typeof global.ObfuscatedCall !== "function") return null;

		generatedBackendPromise = import("./wailsjs/go/main/App.js")
			.then(function (module) {
				global.streamFgcBackend = module;
				return module;
			})
			.catch(function (error) {
				console.warn("Could not load generated Wails bindings.", error);
				return null;
			});
		return generatedBackendPromise;
	}

	/** Rejects slow backend calls so status badges cannot spin forever. */
	function withTimeout(promise, timeout, label) {
		let timer = 0;
		return Promise.race([
			promise,
			new Promise(function (_resolve, reject) {
				timer = global.setTimeout(function () {
					reject(new Error(label));
				}, timeout);
			}),
		]).finally(function () {
			global.clearTimeout(timer);
		});
	}

	async function waitForBackend(timeout = 2000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const app = backendBinding() || (await loadGeneratedBackend());
			if (app) return app;
			await new Promise(function (resolve) {
				global.setTimeout(resolve, 50);
			});
		}
		return backendBinding() || (await loadGeneratedBackend());
	}

	/** Resolves one i18n string through SPA.js and falls back to a literal label. */
	function t(key, fallback) {
		return global.byCommon?.getLangString?.(key, fallback) || fallback;
	}

	/** Finds the current Stream.FGC page shell for a form or control. */
	function pageRoot(element) {
		return element.closest(".fgc-page") || document;
	}

	/** Makes non-button controls, such as Dropzone targets, usable from the keyboard. */
	function bindKeyboardClick(element) {
		if (!(element instanceof HTMLElement) || element.dataset.keyboardClickBound === "true") return;
		element.dataset.keyboardClickBound = "true";
		element.addEventListener("keydown", function (event) {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			element.click();
		});
	}

	/** Captures window and bracket lane scroll so async rerenders do not jump the operator around. */
	function captureScrollState(root = document) {
		const scrollElement = document.scrollingElement || document.documentElement;
		const containers = [];
		["[data-bracket-lane]", "[data-bracket-board]", "[data-player-list]", "[data-current-match-body]"].forEach(function (selector) {
			root.querySelectorAll(selector).forEach(function (element, index) {
				if (!(element instanceof HTMLElement)) return;
				containers.push({
					index,
					left: element.scrollLeft,
					selector,
					top: element.scrollTop,
				});
			});
		});

		return {
			containers,
			documentLeft: scrollElement?.scrollLeft || 0,
			documentTop: scrollElement?.scrollTop || 0,
			root,
			windowX: global.scrollX || 0,
			windowY: global.scrollY || 0,
		};
	}

	/** Restores captured scroll immediately and after layout settles. */
	function restoreScrollState(snapshot) {
		if (!snapshot) return;
		const restore = function () {
			const scrollElement = document.scrollingElement || document.documentElement;
			if (scrollElement) {
				scrollElement.scrollLeft = snapshot.documentLeft;
				scrollElement.scrollTop = snapshot.documentTop;
			}
			if (typeof global.scrollTo === "function") global.scrollTo(snapshot.windowX, snapshot.windowY);
			snapshot.containers.forEach(function (entry) {
				const element = snapshot.root.querySelectorAll(entry.selector)[entry.index];
				if (!(element instanceof HTMLElement)) return;
				element.scrollLeft = entry.left;
				element.scrollTop = entry.top;
			});
		};

		restore();
		global.requestAnimationFrame?.(restore);
		global.setTimeout(restore, 60);
	}

	/** Chooses the Font Awesome icon that matches a status key/tone. */
	function statusIconClass(key, tone) {
		if (String(key).includes("loading") || String(key).includes("saving") || String(key).includes("uploading") || String(key).includes("removing") || String(key).includes("swapping")) return "fas fa-spinner fa-spin";
		if (String(key).includes("pending")) return "fas fa-clock";
		if (String(key).includes("unsaved") || tone === "warning") return "fas fa-triangle-exclamation";
		if (tone === "error" || String(key).includes("failed")) return "fas fa-circle-exclamation";
		if (tone === "success" || String(key).includes("ready") || String(key).includes("saved")) return "fas fa-circle-check";
		return "fas fa-circle-info";
	}

	/** Rebuilds a status badge with its i18n key, tone, icon, and text. */
	function setStatusElement(status, key, fallback, tone) {
		status.setAttribute("data-i18n", key);
		status.setAttribute("role", "status");
		status.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
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

	/** Finds the fixed global status badge before falling back to legacy page badges. */
	function statusTarget(root, selector) {
		const globalStatus = document.querySelector("[data-global-status]");
		if (globalStatus instanceof HTMLElement) return globalStatus;
		const scope = root instanceof Element ? pageRoot(root) : document;
		const scoped = scope.querySelector(selector);
		if (scoped instanceof HTMLElement) return scoped;
		const fallback = document.querySelector(selector);
		return fallback instanceof HTMLElement ? fallback : null;
	}

	/** Sets the fixed top-right status badge used across every SPA page. */
	function setGlobalStatus(key, fallback, tone = "neutral") {
		const status = document.querySelector("[data-global-status]");
		if (!(status instanceof HTMLElement)) return;
		setStatusElement(status, key, fallback, tone);
	}

	function setScopedStatus(root, selector, key, fallback, tone = "neutral") {
		const status = statusTarget(root, selector);
		if (status) setStatusElement(status, key, fallback, tone);
	}

	/** Sets the event/current-match status badge. */
	function setStatus(root, key, fallback, tone = "neutral") {
		setScopedStatus(root, "[data-event-status]", key, fallback, tone);
	}

	/** Sets the players page status badge. */
	function setPlayerStatus(page, key, fallback, tone = "neutral") {
		setScopedStatus(page, "[data-player-status]", key, fallback, tone);
	}

	/** Sets the bracket page status badge. */
	function setBracketStatus(page, key, fallback, tone = "neutral") {
		setScopedStatus(page, "[data-bracket-status]", key, fallback, tone);
	}

	/** Sets the import page status badge. */
	function setImportStatus(page, key, fallback, tone = "neutral") {
		setScopedStatus(page, "[data-import-status]", key, fallback, tone);
	}

	/** Issues a render token so older bracket refreshes cannot overwrite newer ones. */
	function nextBracketLoadTicket(root) {
		const ticket = (bracketLoadTickets.get(root) || 0) + 1;
		bracketLoadTickets.set(root, ticket);
		return ticket;
	}

	/** Checks if a bracket refresh is still the newest load for its page. */
	function isCurrentBracketLoad(root, ticket) {
		return bracketLoadTickets.get(root) === ticket;
	}

	/**
	 * Opens the overlays folder through the Wails backend.
	 * @param {HTMLElement} control Sidebar control that triggered the request.
	 */
	async function showOverlaysFolder(control) {
		const app = await waitForBackend();
		if (!app || typeof app.ShowOverlaysFolder !== "function") {
			console.warn("ShowOverlaysFolder is not available in this Wails runtime.");
			return;
		}

		if (control instanceof HTMLButtonElement || control instanceof HTMLAnchorElement) control.setAttribute("aria-busy", "true");
		try {
			await app.ShowOverlaysFolder();
		} catch (error) {
			console.error("ShowOverlaysFolder failed", error);
		} finally {
			if (control instanceof HTMLButtonElement || control instanceof HTMLAnchorElement) control.removeAttribute("aria-busy");
		}
	}

	/**
	 * Binds sidebar actions that need backend access instead of SPA navigation.
	 * @param {Document|Element} root Document or SPA fragment that may contain sidebar controls.
	 */
	function bindSidebarActions(root = document) {
		root.querySelectorAll("[data-overlays-open]").forEach(function (control) {
			if (!(control instanceof HTMLElement) || control.dataset.bound === "true") return;
			control.dataset.bound = "true";
			control.addEventListener("click", function (event) {
				event.preventDefault();
				void showOverlaysFolder(control);
			});
		});
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
		pageRoot(form).dataset.rule = String(parseRuleValue(event?.rule || 3) || 3);
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

	/** Converts old FT labels and new numeric values into a first-to score limit. */
	function parseRuleValue(value) {
		const normalized = String(value ?? "")
			.toLowerCase()
			.replace(/[^a-z0-9]/g, "")
			.replace(/^ft/, "");
		const parsed = Number(normalized);
		if (!Number.isFinite(parsed) || parsed <= 0) return 0;
		return Math.floor(parsed);
	}

	/** Reads the active first-to rule from a page, form, or the cached tournament state. */
	function eventRuleLimit(root = document) {
		const page = root instanceof Element ? pageRoot(root) : document;
		return parseRuleValue(page?.dataset?.rule || currentState?.event?.rule || document.querySelector('[name="rule"]')?.value || 0);
	}

	/** Keeps score inputs between zero and the active first-to rule. */
	function clampScore(value, limit = eventRuleLimit()) {
		const parsed = Math.max(0, Math.floor(Number(value || 0)));
		return limit > 0 ? Math.min(parsed, limit) : parsed;
	}

	/** Reads the event editor into the backend EventInfo shape. */
	function readEventForm(form) {
		return {
			name: formControl(form, "name")?.value.trim() || "",
			phase: formControl(form, "phase")?.value.trim() || "",
			rule: parseRuleValue(formControl(form, "rule")?.value || currentState?.event?.rule || 3) || 3,
			game: formControl(form, "game")?.value.trim() || "",
			format: formControl(form, "format")?.value || "",
			size: Number(formControl(form, "size")?.value || currentState?.event?.size || 0),
		};
	}

	/** Builds a stable comparison string for event autosave. */
	function eventSignature(event) {
		return JSON.stringify({
			name: String(event?.name || ""),
			phase: String(event?.phase || ""),
			rule: parseRuleValue(event?.rule || 3) || 3,
			game: String(event?.game || ""),
			format: String(event?.format || ""),
			size: Number(event?.size || 0),
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

	/** Clones JSON-shaped backend payloads before storing them for undo actions. */
	function cloneJSON(value) {
		return JSON.parse(JSON.stringify(value || null));
	}

	function setControlsEnabled(root, selector, enabled) {
		root.querySelectorAll(selector).forEach(function (control) {
			control.disabled = !enabled;
		});
	}

	/** Enables or disables every editable control in a form. */
	function setFormEnabled(form, enabled) {
		setControlsEnabled(form, "input, select, button", enabled);
	}

	/** Enables or disables every editable control in a page. */
	function setPageEnabled(page, enabled) {
		setControlsEnabled(page, "input, select, button", enabled);
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
		setControlsEnabled(root, "button", enabled);
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
			setStatus(form, "event.status.ready", "Autosave ready", "success");
			return;
		}
		setStatus(form, "event.status.manual_ready", "Manual save ready", "neutral");
	}

	/** Shows the correct ready status for the players page. */
	function setPlayerReadyStatus(page) {
		if (isAutosaveEnabled()) {
			setPlayerStatus(page, "players.status.ready", "Autosave ready", "success");
			return;
		}
		setPlayerStatus(page, "players.status.manual_ready", "Manual save ready", "neutral");
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
				setStatus(form, "event.status.unsaved", "Unsaved event changes", "warning");
			} else if (!formIsDirty(form)) {
				setEventReadyStatus(form);
			}
		}

		document.querySelectorAll(PLAYER_PAGE).forEach(function (page) {
			if (!(page instanceof HTMLElement) || !currentState) return;
			if (!enabled && pageHasDirtyForms(page)) {
				setPlayerStatus(page, "players.status.unsaved", "Unsaved player changes", "warning");
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

	/** Reloads tournament.json from disk and refreshes whichever SPA page is mounted. */
	async function reloadDataFromDisk() {
		const scrollState = captureScrollState(document);
		const app = await waitForBackend();
		const button = document.querySelector(GLOBAL_RELOAD);
		if (button instanceof HTMLButtonElement) button.disabled = true;

		if (!app || typeof app.LoadTournament !== "function") {
			setGlobalStatus("global.status.backend_missing", "Open in Wails to reload tournament JSON.", "warning");
			if (button instanceof HTMLButtonElement) button.disabled = false;
			restoreScrollState(scrollState);
			return;
		}

		setGlobalStatus("global.status.reloading", "Reloading data...", "neutral");
		clearAutosaveTimers();

		try {
			currentState = await withTimeout(app.LoadTournament(), 5000, "Reload data timed out");
			const tasks = [];
			const eventForms = Array.from(document.querySelectorAll(EVENT_FORM)).filter(function (form) {
				return form instanceof HTMLFormElement;
			});

			eventForms.forEach(function (form) {
				tasks.push(loadEvent(form));
			});

			if (eventForms.length === 0) {
				document.querySelectorAll(CURRENT_MATCH).forEach(function (panel) {
					if (panel instanceof HTMLElement) tasks.push(loadCurrentMatch(panel));
				});
			}

			document.querySelectorAll(PLAYER_PAGE).forEach(function (page) {
				if (page instanceof HTMLElement) tasks.push(loadPlayers(page));
			});

			document.querySelectorAll(`${BRACKET_PAGE}, ${BRACKET_OVERLAY}`).forEach(function (page) {
				if (page instanceof HTMLElement) tasks.push(loadBracket(page, page.matches(BRACKET_PAGE) ? bracketManagerView(page) : ""));
			});

			if (tasks.length > 0) await Promise.all(tasks);
			await syncSpaBackground();
			setGlobalStatus("global.status.reloaded", "Data reloaded", "success");
		} catch (error) {
			console.error("Reload data failed", error);
			setGlobalStatus("global.status.reload_failed", "Data reload failed", "error");
		} finally {
			if (button instanceof HTMLButtonElement) button.disabled = false;
			restoreScrollState(scrollState);
		}
	}

	/** Binds the fixed top-right reload button once. */
	function bindGlobalReload(root = document) {
		root.querySelectorAll(GLOBAL_RELOAD).forEach(function (button) {
			if (!(button instanceof HTMLButtonElement) || button.dataset.bound === "true") return;
			button.dataset.bound = "true";
			button.addEventListener("click", function (event) {
				event.preventDefault();
				void reloadDataFromDisk();
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

	/** Normalizes a local key/value JSON object into catalog rows. */
	function normalizeLocalCatalogRows(data) {
		if (Array.isArray(data)) return normalizeAssetRows(data);
		return Object.entries(data || {}).map(function ([key, name]) {
			return {
				key: String(key || ""),
				name: String(name || key || ""),
			};
		});
	}

	/** Returns the active SPA language limited to supported app languages. */
	function currentLanguage() {
		const lang = String(global.byCommon?.getLanguage?.() || global.bySPA?.APP_LANG || global.localStorage?.getItem("APP_LANG") || document.documentElement.getAttribute("lang") || "es")
			.slice(0, 2)
			.toLowerCase();
		return ["en", "es", "ja"].includes(lang) ? lang : "es";
	}

	/** Loads JSON from external runtime folders instead of the embedded frontend. */
	async function loadExternalJSON(path) {
		return loadJSON(externalURL(path));
	}

	/** Loads JSON with jQuery when available, otherwise with fetch. */
	async function loadJSON(path) {
		const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(path || "")) ? String(path) : appAssetURL(path);
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
		const normalized = ["en", "es", "ja"].includes(lang) ? lang : "es";
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
			const rows = await app[methodName]();
			if (Array.isArray(rows) && rows.length === 0 && Array.isArray(fallback) && fallback.length > 0) return fallback;
			return rows;
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

	/** Writes the selected game's background image into the admin SPA shell. */
	function setSpaBackground(url) {
		const background = document.getElementById("spa-bg");
		if (!(background instanceof HTMLElement)) return;
		const imageURL = String(url || SPA_BACKGROUND_FALLBACK);
		background.style.backgroundImage = `url("${imageURL.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
	}

	/** Appends a timestamp so freshly changed external images repaint immediately. */
	function cacheBustURL(url) {
		const value = String(url || "");
		if (!value) return "";
		return `${value}${value.includes("?") ? "&" : "?"}v=${Date.now()}`;
	}

	/** Returns the external tournament overlay asset URL used by Wails and Apache. */
	function eventAssetURL(kind, cacheBust = false) {
		const url = kind === "background" ? EVENT_BACKGROUND_PATH : EVENT_LOGO_PATH;
		return cacheBust ? cacheBustURL(url) : url;
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

	/** Ensures the import provider catalog is loaded from assets/providers.json. */
	async function ensureProviderCatalog() {
		if (providers.length) return providers;
		try {
			providers = normalizeLocalCatalogRows(await loadExternalJSON("/assets/providers.json"));
		} catch (error) {
			console.warn("Could not load import providers catalog", error);
			providers = [];
		}
		if (!providers.length) {
			providers = [{ key: "startgg", name: "start.gg" }];
		}
		return providers;
	}

	/** Finds a game catalog row by stored key or legacy display name. */
	function gameCatalogEntry(game) {
		return games.find(function (entry) {
			return catalogEntryMatches(entry, game);
		});
	}

	/** Applies the saved event game's admin background without using the overlay _bg.jpg. */
	function applyGameBackgroundFromState(state) {
		const game = state?.event?.game || "";
		const entry = gameCatalogEntry(game);
		setSpaBackground(entry?.background || "");
	}

	/** Ensures the character catalog matches the active event game. */
	async function ensureCharacterCatalog(app, game) {
		const gameKey = String(game || "");
		if (charactersGame === gameKey && characters.length) return characters;
		if (typeof app?.ListCharacters === "function") {
			try {
				characters = normalizeAssetRows(await app.ListCharacters(gameKey));
			} catch (error) {
				console.warn("ListCharacters failed", error);
				characters = [];
			}
		} else {
			try {
				const rows = await loadExternalJSON(`/assets/${gameKey}/characters.json`);
				characters = Object.entries(rows || {}).map(function ([key, name]) {
					return {
						key: String(key || ""),
						name: String(name || key || ""),
						portrait: externalURL(`/assets/${gameKey}/portraits/${key}.png`),
					};
				});
			} catch (_) {
				characters = [];
			}
		}
		charactersGame = gameKey;
		return characters;
	}

	/** Finds a character catalog row by stored key or legacy display name. */
	function characterCatalogEntry(character) {
		return characters.find(function (entry) {
			return catalogEntryMatches(entry, character);
		});
	}

	/** Keeps #spa-bg aligned with the selected game on any SPA route. */
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

	/** Replaces the Import page provider select before Select2 is initialized. */
	function renderImportProviderSelect(page, selectedProvider = "startgg") {
		const form = page.querySelector("[data-import-form]");
		if (!(form instanceof HTMLFormElement)) return;
		renderCatalogSelect(form, "provider", providers, selectedProvider, "key");
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

	/** Creates the small callback bundle used by manual save and autosave. */
	function autosaveOptions(manualPending, pending, save, signature) {
		return {
			manualPending,
			pending,
			save,
			signature,
		};
	}

	/** Returns autosave behavior for the event editor. */
	function eventAutosaveOptions(form) {
		return autosaveOptions(
			function () {
				setStatus(form, "event.status.unsaved", "Unsaved event changes", "warning");
			},
			function () {
				setStatus(form, "event.status.pending", "Event changes pending...", "neutral");
			},
			function () {
				return saveEvent(form);
			},
			function () {
				return formSignature(readEventForm, form);
			},
		);
	}

	/** Returns autosave behavior for one player card. */
	function playerAutosaveOptions(form, page) {
		return autosaveOptions(
			function () {
				setPlayerStatus(page, "players.status.unsaved", "Unsaved player changes", "warning");
			},
			function () {
				setPlayerStatus(page, "players.status.pending", "Player changes pending...", "neutral");
			},
			function () {
				return savePlayer(form, page);
			},
			function () {
				return formSignature(readPlayerForm, form);
			},
		);
	}

	// --- Event page ---

	/** Loads tournament/event data, catalogs, and initializes the event form. */
	async function loadEvent(form) {
		const scrollState = captureScrollState(pageRoot(form));
		const app = await waitForBackend();
		if (!app) {
			setFormEnabled(form, true);
			setStatus(form, "event.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			restoreScrollState(scrollState);
			return;
		}

		setStatus(form, "event.status.loading", "Loading event...", "neutral");
		setFormEnabled(form, false);
		try {
			const state = await app.LoadTournament();
			const [ruleRows, formatRows, sizeRows, gameRows, names] = await Promise.all([
				optionalBackendList(app, "ListRules", []),
				optionalBackendList(app, "ListFormats", []),
				optionalBackendList(app, "ListSizes", []),
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
			refreshEventAssetPreviews(form);
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
			if (matchPanel) await loadCurrentMatch(matchPanel);
		} catch (error) {
			console.error("LoadTournament failed", error);
			setStatus(form, "event.status.load_failed", "Event load failed", "error");
		} finally {
			setFormEnabled(form, true);
			restoreScrollState(scrollState);
		}
	}

	/** Persists the event form through the backend and returns its saved signature. */
	async function saveEvent(form) {
		const scrollState = captureScrollState(pageRoot(form));
		const app = await waitForBackend();
		if (!app) {
			setStatus(form, "event.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			restoreScrollState(scrollState);
			return "";
		}

		const eventPayload = readEventForm(form);
		const submittedSignature = JSON.stringify(eventPayload);
		const autosave = isAutosaveEnabled();
		setStatus(form, autosave ? "event.status.saving" : "event.status.saving_manual", autosave ? "Autosaving event..." : "Saving event...", "neutral");
		try {
			currentState = await app.UpdateEvent(eventPayload);
			await ensureCharacterCatalog(app, currentState.event?.game || "");
			if (formSignature(readEventForm, form) === submittedSignature) {
				fillEventForm(form, currentState.event || {});
			}
			const matchPanel = currentMatchPanel(form);
			if (matchPanel) void loadCurrentMatch(matchPanel);
			setStatus(form, autosave ? "event.status.saved" : "event.status.saved_manual", autosave ? "Event autosaved" : "Event saved", "success");
			return submittedSignature;
		} catch (error) {
			console.error("UpdateEvent failed", error);
			setStatus(form, "event.status.failed", "Event save failed", "error");
			return "";
		} finally {
			restoreScrollState(scrollState);
		}
	}

	/** Refreshes one tournament asset preview without touching event JSON. */
	function refreshEventAssetPreview(form, kind, url) {
		const image = form.querySelector(`[data-event-asset-preview="${kind}"]`);
		if (!(image instanceof HTMLImageElement)) return;
		delete image.dataset.fallbackApplied;
		image.src = url || eventAssetURL(kind, true);
	}

	/** Refreshes both event asset previews after loading the page. */
	function refreshEventAssetPreviews(form) {
		refreshEventAssetPreview(form, "logo", eventAssetURL("logo", true));
		refreshEventAssetPreview(form, "background", eventAssetURL("background", true));
	}

	/** Uploads a tournament overlay logo/background through the backend filesystem API. */
	async function uploadEventAsset(form, kind, file) {
		const app = await waitForBackend();
		const methodName = kind === "background" ? "SaveEventBackground" : "SaveEventLogo";
		if (!app || typeof app[methodName] !== "function") {
			setStatus(form, "event.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			return;
		}

		setStatus(form, "event.status.asset_uploading", "Uploading tournament asset...", "neutral");
		try {
			const imageData = await fileAsDataURL(file);
			const url = await app[methodName](imageData);
			refreshEventAssetPreview(form, kind, cacheBustURL(url));
			setStatus(form, "event.status.asset_saved", "Tournament asset uploaded", "success");
		} catch (error) {
			console.error(`${methodName} failed`, error);
			setStatus(form, "event.status.asset_failed", "Tournament asset upload failed", "error");
		}
	}

	/** Removes a tournament overlay logo/background through the backend filesystem API. */
	async function removeEventAsset(form, kind) {
		const app = await waitForBackend();
		const methodName = kind === "background" ? "RemoveEventBackground" : "RemoveEventLogo";
		if (!app || typeof app[methodName] !== "function") {
			setStatus(form, "event.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			return;
		}

		setStatus(form, "event.status.asset_removing", "Removing tournament asset...", "neutral");
		try {
			const url = await app[methodName]();
			refreshEventAssetPreview(form, kind, cacheBustURL(url));
			setStatus(form, "event.status.asset_removed", "Tournament asset removed", "success");
		} catch (error) {
			console.error(`${methodName} failed`, error);
			setStatus(form, "event.status.asset_remove_failed", "Tournament asset remove failed", "error");
		}
	}

	/** Binds Dropzone to event logo/background controls without direct frontend writes. */
	function bindEventAssetDropzones(form) {
		form.querySelectorAll("[data-event-asset-dropzone]").forEach(function (dropzoneElement) {
			if (!(dropzoneElement instanceof HTMLElement) || dropzoneElement.dataset.bound === "true") return;
			dropzoneElement.dataset.bound = "true";
			bindKeyboardClick(dropzoneElement);

			const kind = dropzoneElement.getAttribute("data-event-asset-dropzone") || "logo";
			const image = form.querySelector(`[data-event-asset-preview="${kind}"]`);
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
				maxFilesize: TOURNAMENT_ASSET_MAX_MB,
				previewsContainer: false,
				url: "/players",
			});

			dropzone.on("addedfile", function (file) {
				dropzone.removeAllFiles(true);
				if (!(file instanceof File)) return;
				void uploadEventAsset(form, kind, file);
			});
		});
	}

	/** Binds clear buttons for event logo/background previews. */
	function bindEventAssetRemove(form) {
		form.querySelectorAll("[data-event-asset-remove]").forEach(function (button) {
			if (!(button instanceof HTMLButtonElement) || button.dataset.bound === "true") return;
			button.dataset.bound = "true";
			button.addEventListener("click", function () {
				void removeEventAsset(form, button.getAttribute("data-event-asset-remove") || "logo");
			});
		});
	}

	/** Binds event form submit, asset controls, and autosave behavior once. */
	function bindEventForm(form) {
		if (form.dataset.bound === "true") return;
		form.dataset.bound = "true";
		const options = eventAutosaveOptions(form);
		bindEventAssetDropzones(form);
		bindEventAssetRemove(form);

		form.addEventListener("submit", function (event) {
			event.preventDefault();
			void flushAutosave(form, options);
		});

		bindAutosave(form, options);

		const gameSelect = formControl(form, "game");
		if (gameSelect instanceof HTMLSelectElement) {
			gameSelect.addEventListener("change", function () {
				applyGameBackground(form);
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
		return clampScore(input.value, eventRuleLimit(panel));
	}

	/** Locks score controls while a score write is in flight. */
	function setMatchControlsEnabled(panel, enabled) {
		panel.querySelectorAll("[data-score-action], [data-score-input], [data-current-side-swap], [data-current-seed-swap]").forEach(function (control) {
			control.disabled = !enabled;
		});
	}

	/** Returns a participant display name, falling back to the bracket source. */
	function participantName(participant) {
		if (participant?.status === "bye") return "BYE";
		if (participant?.status === "tbd" || participant?.status === "pending") return participant?.pending_label || t("match.tbd", "TBD");
		if (participant?.resolved) return participant.player?.name || t("match.tbd", "TBD");
		return participant?.pending_label || t("match.tbd", "TBD");
	}

	/** Returns the optional team/country line for a resolved participant. */
	function participantMeta(participant) {
		if (!participant?.resolved || participant?.status === "bye") return participant?.pending_label || "";
		return participant.player?.team || t("match.no_team", "");
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
				name: t("match.no_character", "No character"),
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
		const name = participantName(participant);
		const playerAlt = t("player.portrait.alt", "{name} player portrait").replace("{name}", name);
		const characterAlt = t("character.portrait.alt", "{name} character portrait").replace("{name}", character.name);
		const playerImage = participant?.resolved && participant.player_id ? playerPortraitPath(participant.player_id) : FALLBACK_ASSET;
		return [
			`<div class="d-flex gap-2 col-12 col-sm-6">`,
			`<div class="flex-grow-1 overflow-hidden rounded border d-flex flex-column" data-match-image-frame>`,
			...(side === 1
				? [
						`<img class="w-100 h-100 object-fit-cover" src="${escapeHtml(character.portrait)}" alt="${escapeHtml(characterAlt)}" loading="lazy" data-fallback-image />`,
						`<span class="px-1 py-1 small fw-bold lh-sm text-center text-truncate" data-match-character-label>${escapeHtml(character.name)}</span>`,
					]
				: [`<img class="w-100 h-100 object-fit-cover" src="${escapeHtml(playerImage)}" alt="${escapeHtml(playerAlt)}" loading="lazy" data-fallback-image />`]),
			`</div>`,
			`<div class="flex-grow-1 overflow-hidden rounded border d-flex flex-column" data-match-image-frame>`,
			...(side === 1
				? [`<img class="w-100 h-100 object-fit-cover" src="${escapeHtml(playerImage)}" alt="${escapeHtml(playerAlt)}" loading="lazy" data-fallback-image />`]
				: [
						`<img class="w-100 h-100 object-fit-cover" src="${escapeHtml(character.portrait)}" alt="${escapeHtml(characterAlt)}" loading="lazy" data-fallback-image />`,
						`<span class="px-1 py-1 small fw-bold lh-sm text-center text-truncate" data-match-character-label>${escapeHtml(character.name)}</span>`,
					]),
			`</div>`,
			`</div>`,
		].join("");
	}

	/** Returns the seed/player slot that can be swapped in the bracket graph. */
	function swappableParticipantSeed(participant) {
		if (participant?.source?.type !== "seed") return 0;
		const seed = Number(participant?.source?.seed || participant?.bracket_seed || 0);
		return Number.isInteger(seed) && seed > 0 ? seed : 0;
	}

	/** Keeps seed-swap click targets visually synced with the pending selection. */
	function setSeedSelection(root, selector, selectedSeed) {
		root.querySelectorAll(selector).forEach(function (target) {
			if (!(target instanceof HTMLElement)) return;
			const seed = Number(target.dataset.seed || 0);
			target.toggleAttribute("data-swap-selected", Boolean(selectedSeed && seed === selectedSeed));
		});
	}

	/** Reads a current-match bracket seed slot from its explicit swap handle. */
	function currentSwapSeedFromTarget(target) {
		const explicitHandle = target?.closest("[data-current-seed-swap]");
		return explicitHandle instanceof HTMLElement ? Number(explicitHandle.dataset.currentSeedSwap || 0) : 0;
	}

	/** Reads a bracket seed slot from its explicit swap handle. */
	function bracketSwapSeedFromTarget(target) {
		const explicitHandle = target?.closest("[data-bracket-seed-swap]");
		return explicitHandle instanceof HTMLElement ? Number(explicitHandle.dataset.bracketSeedSwap || 0) : 0;
	}

	/** Builds the compact score control used by current match and bracket admin. */
	function scoreStepperHTML(score, options) {
		const side = Number(options?.side || 0);
		const matchID = options?.matchID || "";
		const prefix = options?.prefix || "score";
		const scoreValue = clampScore(score, options?.limit || eventRuleLimit());
		const inputAttr = prefix === "bracket" ? `data-bracket-score-input="${side}"` : `data-score-input="${side}"`;
		const decAttrs =
			prefix === "bracket"
				? `data-bracket-score-action data-match-id="${escapeHtml(matchID)}" data-side="${side}" data-delta="-1"`
				: `data-score-action="dec" data-score-player="${side}"`;
		const incAttrs =
			prefix === "bracket"
				? `data-bracket-score-action data-match-id="${escapeHtml(matchID)}" data-side="${side}" data-delta="1"`
				: `data-score-action="inc" data-score-player="${side}"`;
		const stepperAttr = prefix === "bracket" ? "data-bracket-score-stepper" : "";
		const spacing = options?.compact ? "m-0" : "mt-3";
		const downLabel = t("match.score.down", "Decrease score");
		const scoreLabel = t("match.score.label", "Score");
		const upLabel = t("match.score.up", "Increase score");
		return [
			`<div class="input-group flex-nowrap ${spacing}" data-score-stepper ${stepperAttr}>`,
			`<button class="btn btn-outline-light d-inline-flex align-items-center justify-content-center" type="button" ${decAttrs} title="${escapeHtml(downLabel)}" aria-label="${escapeHtml(downLabel)}"><i class="fas fa-minus" aria-hidden="true"></i></button>`,
			`<input class="form-control text-center fw-bold" type="text" inputmode="none" readonly value="${scoreValue}" ${inputAttr} title="${escapeHtml(scoreLabel)}" aria-label="${escapeHtml(scoreLabel)}" />`,
			`<button class="btn btn-outline-light d-inline-flex align-items-center justify-content-center" type="button" ${incAttrs} title="${escapeHtml(upLabel)}" aria-label="${escapeHtml(upLabel)}"><i class="fas fa-plus" aria-hidden="true"></i></button>`,
			`</div>`,
		].join("");
	}

	/** Creates compact player and character media for bracket participant rows. */
	function bracketParticipantMediaHTML(participant) {
		const character = participantCharacter(participant);
		const name = participantName(participant);
		const playerAlt = t("player.portrait.alt", "{name} player portrait").replace("{name}", name);
		const characterAlt = t("character.portrait.alt", "{name} character portrait").replace("{name}", character.name);
		const playerImage = participant?.resolved && participant.player_id ? playerPortraitPath(participant.player_id) : FALLBACK_ASSET;
		return [
			`<div class="d-flex flex-column gap-1 align-items-center flex-shrink-0" data-bracket-player-media>`,
			`<div class="d-flex gap-2 align-items-center">`,
			`<div class="overflow-hidden rounded border flex-shrink-0" data-bracket-player-image>`,
			`<img class="w-100 h-100 object-fit-cover" src="${escapeHtml(playerImage)}" alt="${escapeHtml(playerAlt)}" loading="lazy" data-fallback-image />`,
			`</div>`,
			`<div class="overflow-hidden rounded border flex-shrink-0" data-bracket-character-image>`,
			`<img class="w-100 h-100 object-fit-cover" src="${escapeHtml(character.portrait)}" alt="${escapeHtml(characterAlt)}" loading="lazy" data-fallback-image />`,
			`</div>`,
			`</div>`,
			//`<span class="small fw-bold text-truncate d-inline-block text-center" data-bracket-character-label>${escapeHtml(character.name)}</span>`,
			`</div>`,
		].join("");
	}

	/** Creates one side of the current-match scoreboard. */
	function matchPlayerCard(match, side) {
		const participant = side === 1 ? match?.player1 : match?.player2;
		const scoreKey = side === 1 ? "player1_score" : "player2_score";
		const scoreLimit = eventRuleLimit();
		const score = clampScore(match?.state?.[scoreKey] || 0, scoreLimit);
		const complete = Boolean(match?.state?.winner);
		const name = participantName(participant);
		const meta = participantMeta(participant);
		const country = participantCountryHTML(participant);
		const playerID = participant?.player_id ? `${participant.player_id}` : "";
		const opacity = participant?.resolved ? "" : ` style="opacity: 0.72;"`;
		const seed = swappableParticipantSeed(participant);
		const swapAttrs = seed ? ` data-current-seed-player data-seed="${seed}"` : "";
		const swapLabel = t("match.swap_player", "Select player to swap");
		const swapButton = seed
			? `<button class="btn btn-outline-light btn-sm d-inline-flex align-items-center justify-content-center flex-shrink-0" type="button" data-current-seed-swap="${seed}" title="${escapeHtml(swapLabel)}" aria-label="${escapeHtml(swapLabel)}" style="width: 1.9rem; height: 1.9rem;"><i class="fas fa-exchange-alt" aria-hidden="true"></i></button>`
			: "";

		return [
			`<article class="col-12 col-lg-5">`,
			`<div class="h-100 border rounded p-3"${opacity} data-match-card${swapAttrs}>`,
			`<div class="row g-3 align-items-stretch">`,
			`<div class="col-12 d-flex flex-wrap gap-2 align-items-center justify-content-between">`,
			side === 1
				? `<p class="fgc-kicker m-0">${escapeHtml(side === 1 ? t("match.player_one", "Player 1") : t("match.player_two", "Player 2"))}</p>`
				: `<span class="fgc-title fw-bold fs-5">${escapeHtml(playerID)}</span>`,
			//swapButton,
			side === 1
				? `<span class="fgc-title fw-bold fs-5">${escapeHtml(playerID)}</span>`
				: `<p class="fgc-kicker m-0">${escapeHtml(side === 1 ? t("match.player_one", "Player 1") : t("match.player_two", "Player 2"))}</p>`,
			`</div>`,
			side === 1 ? matchMediaHTML(participant, side) : "",
			`<div class="col-12 col-sm d-flex flex-column ${side === 1 ? "align-items-end" : "align-items-start"}">`,
			`<h3 class="fgc-title fs-5 lh-sm m-0">${escapeHtml(name)}</h3>`,
			`<p class="mt-2 mb-0 fw-bold text-truncate" style="color: var(--fgc-text-muted);">${escapeHtml(meta || "")}</p>`,
			country,
			complete ? `<span class="fgc-title fs-4 mt-3">${score}</span>` : scoreStepperHTML(score, { side, prefix: "score", limit: scoreLimit }),
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
		const matchName = match?.name || t("match.title", "Current match");
		const complete = Boolean(match?.state?.winner);
		panel.dataset.matchId = matchID;
		panel.dataset.matchComplete = complete ? "true" : "false";
		if (title) {
			title.removeAttribute("data-i18n");
			title.textContent = matchID ? `${matchName} (${matchID})` : matchName;
		}

		const scoreLimit = eventRuleLimit(panel);
		const player1Score = clampScore(match?.state?.player1_score || 0, scoreLimit);
		const player2Score = clampScore(match?.state?.player2_score || 0, scoreLimit);
		body.innerHTML = [
			matchPlayerCard(match, 1),
			`<div class="col-12 col-lg-2 d-flex align-items-stretch">`,
			`<div class="w-100 border rounded d-flex flex-column gap-2 align-items-center justify-content-center text-center p-3" data-match-card>`,
			`<div class="d-flex gap-2 align-items-center justify-content-center">`,
			`<strong class="fgc-title fs-1 lh-1">${player1Score}</strong>`,
			`<span class="fw-bold small" style="color: var(--fgc-brand-soft);">${escapeHtml(t("match.vs", "VS"))}</span>`,
			`<strong class="fgc-title fs-1 lh-1">${player2Score}</strong>`,
			`</div>`,
			`<button class="btn btn-outline-light btn-sm d-inline-flex gap-2 align-items-center justify-content-center mt-3" type="button" data-current-side-swap title="${escapeHtml(t("match.swap_sides", "Swap sides"))}" aria-label="${escapeHtml(t("match.swap_sides", "Swap sides"))}"><i class="fas fa-exchange-alt" aria-hidden="true"></i><span>${escapeHtml(t("match.swap_sides", "Swap sides"))}</span></button>`,
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
		const scrollState = captureScrollState(pageRoot(panel));
		const app = await waitForBackend();
		const body = panel.querySelector("[data-current-match-body]");
		if (!app) {
			if (body) body.innerHTML = `<div class="col-12"><div class="${EMPTY_STATE_CLASS}">${escapeHtml(t("event.status.backend_missing", "Open in Wails to edit tournament JSON."))}</div></div>`;
			restoreScrollState(scrollState);
			return;
		}

		if (body) body.innerHTML = `<div class="col-12"><div class="${EMPTY_STATE_CLASS}">${escapeHtml(t("match.loading", "Loading current match..."))}</div></div>`;
		try {
			if (!currentState) currentState = await app.LoadTournament();
			await ensureCharacterCatalog(app, currentState?.event?.game || "");
			if (!Object.keys(countryNames).length) countryNames = (await loadCountryNames()) || {};
			const match = await app.ResolveMatch(currentState?.current || "");
			renderCurrentMatch(panel, match);
		} catch (error) {
			console.error("ResolveMatch failed", error);
			if (body) body.innerHTML = `<div class="col-12"><div class="${EMPTY_STATE_CLASS}">${escapeHtml(t("match.load_failed", "Current match load failed"))}</div></div>`;
			setStatus(panel, "match.status.load_failed", "Current match load failed", "error");
		} finally {
			restoreScrollState(scrollState);
		}
	}

	/** Persists current-match score controls into tournament.json. */
	async function saveCurrentMatchScore(panel) {
		const scrollState = captureScrollState(pageRoot(panel));
		const app = await waitForBackend();
		if (!app) {
			setStatus(panel, "event.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			restoreScrollState(scrollState);
			return;
		}

		const matchID = panel.dataset.matchId || currentState?.current || "";
		if (panel.dataset.matchComplete === "true") {
			setStatus(panel, "match.status.complete_locked", "Clear winner before editing scores", "warning");
			restoreScrollState(scrollState);
			return;
		}
		const player1Score = readMatchScore(panel, 1);
		const player2Score = readMatchScore(panel, 2);
		setStatus(panel, "match.status.saving", "Saving match score...", "neutral");
		setMatchControlsEnabled(panel, false);
		try {
			currentState = await app.UpdateMatchScore(matchID, player1Score, player2Score);
			const match = await app.ResolveMatch(matchID);
			renderCurrentMatch(panel, match);
			setStatus(panel, "match.status.saved", "Match score saved", "success");
		} catch (error) {
			console.error("UpdateMatchScore failed", error);
			setStatus(panel, "match.status.failed", "Match score save failed", "error");
		} finally {
			setMatchControlsEnabled(panel, true);
			restoreScrollState(scrollState);
		}
	}

	/** Toggles the display sides for the current match without changing bracket seed order. */
	async function swapCurrentMatchSides(panel) {
		const scrollState = captureScrollState(pageRoot(panel));
		const app = await waitForBackend();
		if (!app || typeof app.SwapMatchSides !== "function") {
			setStatus(panel, "event.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			restoreScrollState(scrollState);
			return;
		}

		const matchID = panel.dataset.matchId || currentState?.current || "";
		setStatus(panel, "match.status.swapping", "Swapping players...", "neutral");
		setMatchControlsEnabled(panel, false);
		try {
			currentState = await withTimeout(app.SwapMatchSides(matchID), 5000, "Current match side swap timed out");
			await loadCurrentMatch(panel);
			setStatus(panel, "match.status.sides_swapped", "Sides swapped", "success");
		} catch (error) {
			console.error("SwapMatchSides failed", error);
			setStatus(panel, "match.status.swap_failed", "Player swap failed", "error");
		} finally {
			setMatchControlsEnabled(panel, true);
			restoreScrollState(scrollState);
		}
	}

	/** Performs a bracket seed assignment swap from the event page current-match panel. */
	async function swapCurrentMatchSeeds(panel, seed, targetSeed) {
		const scrollState = captureScrollState(pageRoot(panel));
		const app = await waitForBackend();
		if (!app || typeof app.SwapBracketSeeds !== "function") {
			setStatus(panel, "event.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			restoreScrollState(scrollState);
			return;
		}

		setStatus(panel, "match.status.swapping", "Swapping players...", "neutral");
		setMatchControlsEnabled(panel, false);
		try {
			currentState = await withTimeout(app.SwapBracketSeeds(seed, targetSeed), 5000, "Current match swap timed out");
			currentSeedSelections.delete(panel);
			await loadCurrentMatch(panel);
			setStatus(panel, "match.status.swapped", "Players swapped", "success");
		} catch (error) {
			console.error("SwapBracketSeeds failed", error);
			setStatus(panel, "match.status.swap_failed", "Player swap failed", "error");
		} finally {
			setMatchControlsEnabled(panel, true);
			restoreScrollState(scrollState);
		}
	}

	/** Handles first/second click selection for current-match bracket seed swaps. */
	function selectCurrentSeedForSwap(panel, seed) {
		if (!seed) return;
		const selectedSeed = currentSeedSelections.get(panel) || 0;
		if (!selectedSeed) {
			currentSeedSelections.set(panel, seed);
			setSeedSelection(panel, "[data-current-seed-player]", seed);
			setStatus(panel, "match.status.swap_select", "Select another player to swap", "neutral");
			return;
		}
		currentSeedSelections.delete(panel);
		setSeedSelection(panel, "[data-current-seed-player]", 0);
		if (selectedSeed === seed) {
			setStatus(panel, "match.status.swap_cleared", "Player swap cancelled", "neutral");
			return;
		}
		void swapCurrentMatchSeeds(panel, selectedSeed, seed);
	}

	/** Binds delegated score and swap controls for the current-match panel. */
	function bindCurrentMatch(panel) {
		const bindingVersion = "score-swap-v1";
		if (panel.dataset.bound === bindingVersion) return;
		panel.dataset.bound = bindingVersion;

		panel.addEventListener("click", function (event) {
			const target = event.target instanceof Element ? event.target : null;
			const sideSwap = target?.closest("[data-current-side-swap]");
			if (sideSwap instanceof HTMLButtonElement) {
				event.preventDefault();
				void swapCurrentMatchSides(panel);
				return;
			}

			const button = target?.closest("[data-score-action]");
			if (button instanceof HTMLButtonElement) {
				event.preventDefault();
				if (panel.dataset.matchComplete === "true") {
					setStatus(panel, "match.status.complete_locked", "Clear winner before editing scores", "warning");
					return;
				}
				const playerNumber = button.getAttribute("data-score-player") || "";
				const input = panel.querySelector(`[data-score-input="${playerNumber}"]`);
				if (!(input instanceof HTMLInputElement)) return;
				const delta = button.getAttribute("data-score-action") === "dec" ? -1 : 1;
				input.value = String(clampScore(readMatchScore(panel, playerNumber) + delta, eventRuleLimit(panel)));
				void saveCurrentMatchScore(panel);
				return;
			}

			const swapSeed = currentSwapSeedFromTarget(target);
			if (swapSeed) {
				selectCurrentSeedForSwap(panel, swapSeed);
			}
		});

		panel.addEventListener("keydown", function (event) {
			if (event.key !== "Enter" && event.key !== " ") return;
			const target = event.target instanceof Element ? event.target : null;
			const swapSeed = currentSwapSeedFromTarget(target);
			if (!swapSeed) return;
			event.preventDefault();
			selectCurrentSeedForSwap(panel, swapSeed);
		});
	}

	// --- Bracket pages ---

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
		return normalizeBracketView(currentState?.bracket?.manager_view || BRACKET_ADMIN_VIEW);
	}

	/** Loads the saved manager view before the bracket page has rendered its select. */
	async function savedBracketManagerView(app) {
		if (currentState?.bracket?.manager_view) return normalizeBracketView(currentState.bracket.manager_view);
		if (typeof app?.LoadTournament === "function") {
			currentState = await withTimeout(app.LoadTournament(), 5000, "Tournament load timed out");
			return normalizeBracketView(currentState?.bracket?.manager_view || BRACKET_ADMIN_VIEW);
		}
		return BRACKET_ADMIN_VIEW;
	}

	/** Tries local static paths used by Apache/OBS overlays. */
	async function loadStaticJSON(candidates) {
		for (const url of candidates) {
			try {
				const response = await fetch(url, { cache: "no-store" });
				if (response.ok) return response.json();
			} catch (_) {
				// Try the next static path.
			}
		}
		throw new Error(`Could not load ${candidates.join(", ")}`);
	}

	/** Mirrors the backend template filename mapping for read-only overlays. */
	function staticTemplateFileName(format, size) {
		const normalized = String(format || "double_elimination").toLowerCase().trim();
		const compact = normalizeCatalogText(normalized);
		if (["double", "double_elimination"].includes(normalized) || ["double", "doubleelimination"].includes(compact)) return `double${size}.json`;
		if (["single", "single_elimination"].includes(normalized) || ["single", "singleelimination"].includes(compact)) return `single${size}.json`;
		if (["robin", "round", "round_robin"].includes(normalized) || ["robin", "round", "roundrobin"].includes(compact)) return `robin${size}.json`;
		if (["swiss", "swiss_system"].includes(normalized) || ["swiss", "swisssystem"].includes(compact)) return `swiss${size}.json`;
		const name = normalized.replace("_elimination", "").replace(/_/g, "") || "double";
		return `${name}${size}.json`;
	}

	/** Provides the same overlay view choices as the backend projection. */
	function staticBracketViewOptions(format) {
		const normalized = String(format || "").toLowerCase().trim();
		const options = [
			{ key: "all", name: "Full bracket" },
			{ key: "top8", name: "Top 8" },
		];
		if (normalized.includes("double")) {
			options.push({ key: "winners", name: "Winners bracket" }, { key: "losers", name: "Losers bracket" });
		}
		if (normalized.includes("single") || normalized.includes("double")) {
			options.push({ key: "finals", name: "Finals" });
		}
		return options;
	}

	/** Extracts a round number from labels like "Losers Round 5". */
	function bracketRoundNumber(round) {
		const match = String(round || "").match(/(\d+)(?!.*\d)/);
		return match ? Number(match[1]) : 0;
	}

	/** Infers where the losers side reaches the Top 8 phase in static templates. */
	function staticTop8LosersRoundStart(template) {
		const maxRound = Object.values(template?.matches || {}).reduce(function (max, match) {
			if (staticMatchGroup(match) !== "losers") return max;
			return Math.max(max, bracketRoundNumber(staticMatchRound(match, "losers")));
		}, 0);
		return Math.max(1, maxRound - 2);
	}

	/** Checks whether a static match belongs in the Top 8 bracket slice. */
	function staticMatchInTop8(group, roundName, template) {
		if (Number(template?.size || 0) <= 8) return true;
		const round = String(roundName || "").toLowerCase();
		if (group === "finals") return true;
		if (group === "winners") return round.includes("quarter") || round.includes("semi") || round.includes("final");
		if (group === "losers") {
			if (round.includes("final")) return true;
			return bracketRoundNumber(roundName) >= staticTop8LosersRoundStart(template);
		}
		return true;
	}

	/** Checks whether a static template match belongs in the requested bracket view. */
	function staticBracketViewAllows(view, group, roundName, template) {
		if (view === "winners") return group === "winners";
		if (view === "losers") return group === "losers";
		if (view === "finals") return group === "finals";
		if (view === "top8") return staticMatchInTop8(group, roundName, template);
		return true;
	}

	/** Resolves one static bracket seed slot to the assigned player ID. */
	function staticBracketSeedPlayerID(state, seed) {
		const key = String(seed || "");
		const seeds = state?.bracket?.seeds || {};
		if (Object.prototype.hasOwnProperty.call(seeds, key)) return String(seeds[key] || "");
		return key;
	}

	/** Reports static bracket-only BYE state for one seed slot. */
	function staticBracketSeedBye(state, seed) {
		const key = String(seed || "");
		if (state?.bracket?.byes?.[key]) return true;
		const playerID = staticBracketSeedPlayerID(state, seed);
		return Boolean(playerID && state?.players?.[playerID]?.bye);
	}

	/** Resolves a participant source using static tournament/template JSON. */
	function staticResolveParticipant(source, state) {
		const type = String(source?.type || "");
		const players = state?.players || {};
		const matches = state?.matches || {};
		if (type === "seed") {
			const seed = Number(source?.seed || 0);
			const playerID = staticBracketSeedPlayerID(state, seed);
			const player = players[playerID] || {};
			if (staticBracketSeedBye(state, seed)) return { player_id: playerID, player, source, bracket_seed: seed, resolved: true, pending_label: "BYE", status: "bye" };
			if (!playerID) return { player_id: "", player, source, bracket_seed: seed, resolved: false, pending_label: `Seed ${seed}`, status: "pending" };
			if (!String(player?.name || "").trim()) return { player_id: playerID, player, source, bracket_seed: seed, resolved: false, pending_label: "TBD", status: "tbd" };
			return { player_id: playerID, player, source, bracket_seed: seed, resolved: true, pending_label: "", status: "player" };
		}
		if (type === "winner" || type === "loser") {
			const sourceMatch = matches[String(source?.match || "")] || {};
			const playerID = String(type === "winner" ? sourceMatch.winner || "" : sourceMatch.loser || "");
			if (!playerID) {
				const label = `${type === "winner" ? "Winner" : "Loser"} of ${source?.match || ""}`;
				return { player_id: "", player: {}, source, resolved: false, pending_label: label, status: "pending" };
			}
			const player = players[playerID] || {};
			if (player?.bye) return { player_id: playerID, player, source, resolved: true, pending_label: "BYE", status: "bye" };
			return { player_id: playerID, player, source, resolved: true, pending_label: "", status: "player" };
		}
		return { player_id: "", player: {}, source, resolved: false, pending_label: "TBD", status: "pending" };
	}

	/** Infers the bracket section for static templates. */
	function staticMatchGroup(match) {
		if (match?.group) {
			const normalized = normalizeBracketView(match.group);
			if (["winners", "losers", "finals"].includes(normalized)) return normalized;
			return normalizeCatalogText(match.group) || "bracket";
		}
		const name = String(match?.name || "").toLowerCase();
		if (name.includes("grand")) return "finals";
		if (name.includes("loser")) return "losers";
		if (name.includes("winner")) return "winners";
		if (name.includes("final")) return "finals";
		return "bracket";
	}

	/** Converts static section keys into readable names. */
	function staticGroupName(group) {
		if (group === "winners") return "Winners";
		if (group === "losers") return "Losers";
		if (group === "finals") return "Finals";
		if (group === "robin") return "Round Robin";
		if (group === "roundrobin") return "Round Robin";
		if (group === "swiss") return "Swiss";
		return "Bracket";
	}

	/** Infers the visual round for static templates. */
	function staticMatchRound(match, group) {
		if (group === "finals" && match?.reset && String(match?.name || "").trim()) return String(match.name).trim();
		if (match?.round) return match.round;
		const name = String(match?.name || "");
		const index = name.indexOf(" - ");
		if (index > 0) return name.slice(0, index).trim();
		return name || group;
	}

	/** Gives stable visual ordering to static template IDs. */
	function staticMatchOrder(id, match) {
		if (Number(match?.order || 0) > 0) return Number(match.order);
		const text = String(id || "").toUpperCase();
		if (/^M\d+$/.test(text)) return Number(text.slice(1));
		let order = 0;
		for (const character of text) {
			const code = character.charCodeAt(0);
			if (code < 65 || code > 90) continue;
			order = order * 26 + (code - 64);
		}
		return order || 9999;
	}

	/** Builds a read-only projection when Wails bindings are unavailable. */
	async function loadStaticBracketProjection(requestedView = "", admin = false) {
		const state = await loadStaticJSON(["../../data/tournament.json", "./data/tournament.json", "/data/tournament.json"]);
		const fileName = staticTemplateFileName(state?.event?.format, Number(state?.event?.size || 8));
		let template = null;
		let templateError = "";
		try {
			template = await loadStaticJSON([`../../templates/${fileName}`, `./templates/${fileName}`, `/templates/${fileName}`]);
		} catch (_) {
			templateError = `[${fileName}] template missing`;
			template = {
				type: state?.event?.format || "",
				size: Number(state?.event?.size || 0),
				matches: {},
				placements: {},
				error: templateError,
			};
		}
		const options = staticBracketViewOptions(template?.type || state?.event?.format);
		const optionKeys = options.map(function (option) {
			return option.key;
		});
		const overlayCandidate = normalizeBracketView(state?.bracket?.overlay_view || "all");
		const overlayView = optionKeys.includes(overlayCandidate) ? overlayCandidate : "all";
		const managerCandidate = normalizeBracketView(state?.bracket?.manager_view || "all");
		const managerView = optionKeys.includes(managerCandidate) ? managerCandidate : "all";
		const viewCandidate = normalizeBracketView(requestedView || (admin ? managerView : overlayView));
		const view = optionKeys.includes(viewCandidate) ? viewCandidate : "all";
		const sections = [];
		const sectionMap = new Map();
		const started = Object.values(state?.matches || {}).some(function (match) {
			return Boolean(((match?.winner || match?.loser) && match?.reason !== "bye") || Number(match?.player1_score || 0) || Number(match?.player2_score || 0));
		});
		const seedOptions = Array.from({ length: Number(state?.event?.size || 0) }, function (_value, index) {
			const seed = index + 1;
			const playerID = staticBracketSeedPlayerID(state, seed);
			const player = state?.players?.[playerID] || {};
			return { seed, player_id: playerID, name: player?.name || "", team: player?.team || "", bye: staticBracketSeedBye(state, seed) };
		});
		const playerCount = Object.keys(state?.players || {}).filter(function (id) {
			const player = state.players[id];
			return Number(id) <= Number(state?.event?.size || 0) && String(player?.name || "").trim() && !player?.bye;
		}).length;

		Object.entries(template?.matches || {})
			.sort(function ([leftID, left], [rightID, right]) {
				return staticMatchOrder(leftID, left) - staticMatchOrder(rightID, right);
			})
			.forEach(function ([matchID, match]) {
				const group = staticMatchGroup(match);
				const roundName = staticMatchRound(match, group);
				if (!staticBracketViewAllows(view, group, roundName, template)) return;
				const order = staticMatchOrder(matchID, match);
				const player1 = staticResolveParticipant(match?.p1, state);
				const player2 = staticResolveParticipant(match?.p2, state);
				const matchState = state?.matches?.[matchID] || {};
				const status = matchState.winner ? "complete" : player1.status === "bye" || player2.status === "bye" ? "bye" : player1.resolved && player2.resolved ? "ready" : "pending";
				if (!sectionMap.has(group)) {
					const section = { key: group, name: staticGroupName(group), rounds: [] };
					sectionMap.set(group, section);
					sections.push(section);
				}
				const section = sectionMap.get(group);
				let round = section.rounds.find(function (candidate) {
					return candidate.name === roundName;
				});
				if (!round) {
					round = { key: normalizeCatalogText(roundName) || "round", name: roundName, matches: [] };
					section.rounds.push(round);
				}
				round.matches.push({
					id: matchID,
					name: match?.name || `${t("bracket.match", "Match")} ${matchID}`,
					group,
					round: roundName,
					order,
					current: matchID === state?.current,
					optional: Boolean(match?.optional),
					reset: Boolean(match?.reset),
					winner_to: match?.winner_to || "",
					loser_to: match?.loser_to || "",
					player1,
					player2,
					state: matchState,
					status,
					can_play: status === "ready",
					can_decide: false,
					winner_id: matchState.winner || "",
					loser_id: matchState.loser || "",
				});
			});

		return {
			event: state?.event || {},
			current: state?.current || "",
			format: template?.type || state?.event?.format || "",
			size: Number(template?.size || state?.event?.size || 0),
			view,
			overlay_view: overlayView,
			manager_view: managerView,
			started,
			can_randomize: !started,
			views: options,
			seed_options: seedOptions,
			sections,
			match_count: sections.reduce(function (count, section) {
				return count + section.rounds.reduce(function (roundCount, round) {
					return roundCount + round.matches.length;
				}, 0);
			}, 0),
			player_count: playerCount,
			error: templateError || template?.error || "",
		};
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
		root.dataset.rule = String(parseRuleValue(projection?.event?.rule || currentState?.event?.rule || 3) || 3);
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
			? scoreStepperHTML(score, { side, matchID: match?.id || "", prefix: "bracket", compact: true, limit: parseRuleValue(projection?.event?.rule || currentState?.event?.rule || 3) || 3 })
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
		const scoreLimit = parseRuleValue(projection?.event?.rule || currentState?.event?.rule || 3) || 3;
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
				try {
					const projection = await withTimeout(loadStaticBracketProjection(requestedView, admin), 5000, "Static bracket load timed out");
					if (!isCurrentBracketLoad(root, ticket)) return projection;
					await ensureCharacterCatalog(null, projection?.event?.game || "");
					renderBracketProjection(root, projection, admin);
					if (projection?.error) {
						setBracketStatus(root, "bracket_status_template_missing", projection.error, "warning");
					} else {
						setBracketStatus(root, "bracket.status.ready", "Bracket ready", "success");
					}
					return projection;
				} catch (error) {
					if (!isCurrentBracketLoad(root, ticket)) return null;
					console.error("Static bracket load failed", error);
					const board = root.querySelector("[data-bracket-board]");
					if (board) board.innerHTML = `<div class="col-12"><div class="${EMPTY_STATE_CLASS}">${escapeHtml(t("bracket.status.backend_missing", "Open in Wails to edit tournament JSON."))}</div></div>`;
					setBracketStatus(root, "bracket.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
					return null;
				}
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
			currentState = await withTimeout(app.SetBracketOverlayView(view), 5000, "Bracket overlay save timed out");
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
				currentState = await withTimeout(app.SetBracketManagerView(normalizedView), 5000, "Bracket manager view save timed out");
			} else {
				const state = await withTimeout(app.LoadTournament(), 5000, "Tournament load timed out");
				state.bracket = { ...(state.bracket || {}), manager_view: normalizedView };
				await withTimeout(app.SaveTournament(state), 10000, "Bracket manager view save timed out");
				currentState = await withTimeout(app.LoadTournament(), 5000, "Tournament load timed out");
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
			currentState = await withTimeout(action(app), 5000, "Bracket action timed out");
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

	/** Normalizes country codes from backend flags or language dictionaries. */
	function normalizeCountryCodes(codes, names = countryNames) {
		const source = (codes || []).length ? codes : Object.keys(names || {});
		return Array.from(
			new Set(
				source
					.map(function (code) {
						return String(code || "").toUpperCase();
					})
					.filter(isISO2Code),
			),
		).sort();
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
		return externalURL(`/assets/flags/${String(code).toLowerCase()}.svg`);
	}

	/** Returns the player portrait URL, optionally cache-busted after upload/remove. */
	function playerPortraitPath(playerID, cacheBust = false) {
		const key = encodeURIComponent(String(playerID || ""));
		const suffix = cacheBust ? `?v=${Date.now()}` : "";
		return `${externalURL(`/players/${key}.png`)}${suffix}`;
	}

	/** Applies a fallback when a preview URL cannot be loaded. */
	function setImageFallback(image, fallback = FALLBACK_ASSET) {
		if (!(image instanceof HTMLImageElement)) return;
		image.addEventListener("error", function () {
			if (image.dataset.fallbackApplied === "true") return;
			image.dataset.fallbackApplied = "true";
			image.src = fallback;
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
		const playerName = player?.name || `${t("players.player", "Player")} ${playerID}`;
		const portraitAlt = t("player.portrait.alt", "{name} player portrait").replace("{name}", playerName);
		return [
			`<div class="col-12 col-md-6">`,
			`<form class="h-100 border rounded p-3" data-player-card data-player-form="${escapeHtml(playerID)}">`,
			`<div class="row g-3 align-items-stretch">`,
			`<section class="col-12 col-md-4 d-flex">`,
			`<div class="ratio ratio-1x1 overflow-hidden rounded border w-100 mx-auto mx-md-0" data-player-portrait-frame><img class="w-100 h-100 object-fit-cover" data-player-portrait src="${escapeHtml(playerPortraitPath(playerID))}" alt="${escapeHtml(portraitAlt)}" loading="lazy" /></div>`,
			`</section>`,
			`<section class="col-12 col-md-8 d-flex flex-column">`,
			`<div class="d-inline-flex gap-2 align-items-baseline text-nowrap mb-3" data-section-heading><span class="fgc-kicker fgc-title fs-6 lh-1 m-0" data-i18n="players.player">Player</span><strong class="fgc-title d-inline-block fs-4 lh-1">${escapeHtml(playerID)}</strong></div>`,
			`<div class="row g-3">`,
			`<label class="col-12 col-xl-6 m-0"><span class="d-block mb-2 fw-bold" data-field-label data-i18n="player.name">Name</span><input class="form-control" type="text" name="name" autocomplete="off" value="${escapeHtml(player?.name || "")}" title="${escapeHtml(t("player.name.title", "Edit player name"))}" aria-label="${escapeHtml(t("player.name.title", "Edit player name"))}" /></label>`,
			`<label class="col-12 col-xl-6 m-0"><span class="d-block mb-2 fw-bold" data-field-label data-i18n="player.team">Team</span><input class="form-control" type="text" name="team" autocomplete="off" value="${escapeHtml(player?.team || "")}" title="${escapeHtml(t("player.team.title", "Edit player team"))}" aria-label="${escapeHtml(t("player.team.title", "Edit player team"))}" /></label>`,
			`<label class="col-12 col-xl-6 m-0"><span class="d-block mb-2 fw-bold" data-field-label data-i18n="player.country">Country</span><select class="form-select" name="country" data-enhance="select2" data-select-template="country" title="${escapeHtml(t("player.country.title", "Choose player country"))}" aria-label="${escapeHtml(t("player.country.title", "Choose player country"))}">${countryOptions(player?.country)}</select></label>`,
			`<label class="col-12 col-xl-6 m-0"><span class="d-block mb-2 fw-bold" data-field-label data-i18n="player.character">Character</span><select class="form-select" name="character" data-enhance="select2" data-select-template="character" title="${escapeHtml(t("player.character.title", "Choose player character"))}" aria-label="${escapeHtml(t("player.character.title", "Choose player character"))}">${characterOptions(player?.character)}</select></label>`,
			`</div>`,
			`<div class="row g-2 align-items-stretch mt-auto pt-3">`,
			`<div class="col-12 col-sm-auto"><div class="dropzone d-inline-flex align-items-center justify-content-center rounded w-100 px-3 py-2" data-player-dropzone role="button" tabindex="0" title="${escapeHtml(t("player.portrait.drop.title", "Upload player portrait"))}" aria-label="${escapeHtml(t("player.portrait.drop.title", "Upload player portrait"))}"><div class="dz-message d-inline-flex gap-2 align-items-center justify-content-center m-0 text-center text-nowrap fw-bold lh-sm"><i class="fas fa-cloud-arrow-up" aria-hidden="true"></i><span data-i18n="player.portrait.drop">Drop or click image</span></div></div></div>`,
			`<div class="col-12 col-sm-auto"><button class="btn btn-outline-danger d-inline-flex gap-2 align-items-center justify-content-center w-100 fw-bold py-2" type="button" data-player-portrait-remove title="${escapeHtml(t("player.portrait.remove.title", "Remove player portrait"))}" aria-label="${escapeHtml(t("player.portrait.remove.title", "Remove player portrait"))}"><i class="fas fa-trash" aria-hidden="true"></i> <span data-i18n="player.portrait.remove">Remove picture</span></button></div>`,
			`<div class="col-12 col-sm-auto"><button class="btn btn-danger btn-sm d-inline-flex gap-2 align-items-center justify-content-center w-100 fw-bold py-2" type="submit" data-manual-save title="${escapeHtml(t("players.save.title", "Save this player now"))}" aria-label="${escapeHtml(t("players.save.title", "Save this player now"))}"><i class="fas fa-save" aria-hidden="true"></i> <span data-i18n="players.save">Save now</span></button></div>`,
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
			const label = select.getAttribute("aria-label") || select.getAttribute("title") || "";
			if (label) jquery(select).next(".select2").find(".select2-selection").attr({ "aria-label": label, title: label });
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
		if (!countryCodes.length) countryCodes = normalizeCountryCodes([], countryNames);
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

	/** Returns root plus descendants matching a selector without firing SPA.js lifecycle events. */
	function matchingElements(root, selector) {
		const matches = [];
		if (root instanceof Element && root.matches(selector)) matches.push(root);
		root.querySelectorAll?.(selector).forEach(function (element) {
			matches.push(element);
		});
		return matches;
	}

	/** Applies i18n to injected markup without dispatching bycommon:language again. */
	function applyLanguage(root) {
		matchingElements(root, "[data-i18n]").forEach(function (element) {
			const key = element.getAttribute("data-i18n") || "";
			element.textContent = t(key, element.textContent);
		});
		matchingElements(root, "[data-i18n-html]").forEach(function (element) {
			const key = element.getAttribute("data-i18n-html") || "";
			element.innerHTML = t(key, element.innerHTML);
		});
		matchingElements(root, "[data-i18n-title]").forEach(function (element) {
			const key = element.getAttribute("data-i18n-title") || "";
			const value = t(key, element.getAttribute("title") || "");
			element.setAttribute("title", value);
		});
		matchingElements(root, "[data-i18n-label]").forEach(function (element) {
			const key = element.getAttribute("data-i18n-label") || "";
			const value = t(key, element.getAttribute("aria-label") || element.getAttribute("title") || "");
			element.setAttribute("aria-label", value);
		});
		matchingElements(root, "[data-i18n-alt]").forEach(function (element) {
			const key = element.getAttribute("data-i18n-alt") || "";
			const value = t(key, element.getAttribute("alt") || "");
			element.setAttribute("alt", value);
		});
		matchingElements(root, "[data-i18n-route]").forEach(function (element) {
			const key = element.getAttribute("data-i18n-route") || "";
			const route = t(key, "").replace(/^\/+/, "");
			if (route) element.setAttribute("href", `#/${route}`);
		});
		const jquery = global.jQuery;
		if (jquery?.fn?.select2) {
			matchingElements(root, "select.select2-hidden-accessible").forEach(function (select) {
				const label = select.getAttribute("aria-label") || select.getAttribute("title") || "";
				if (label) jquery(select).next(".select2").find(".select2-selection").attr({ "aria-label": label, title: label });
			});
		}
	}

	/** Re-runs SPA.js common Bootstrap wiring after this app changes translated attributes. */
	function refreshCommonWidgets() {
		const common = global.byCommon;
		if (typeof common?.init === "function") {
			common.init();
			return;
		}
	}

	// --- Import page ---

	/** Reads provider API keys from the import integrations form. */
	function readImportIntegrationsForm(page) {
		const form = page.querySelector("[data-import-integrations-form]");
		if (!(form instanceof HTMLFormElement)) return { startgg: { api_key: "" } };
		return {
			startgg: {
				api_key: formControl(form, "startgg_api_key")?.value.trim() || "",
			},
		};
	}

	/** Fills provider API key fields from saved integration settings. */
	function fillImportIntegrationsForm(page, settings) {
		const form = page.querySelector("[data-import-integrations-form]");
		if (!(form instanceof HTMLFormElement)) return;
		const startGGInput = formControl(form, "startgg_api_key");
		if (startGGInput) startGGInput.value = settings?.startgg?.api_key || "";
	}

	/** Loads provider API keys from the backend into the Import page. */
	async function loadImportIntegrations(page) {
		const app = await waitForBackend();
		if (!app || typeof app.LoadImportIntegrations !== "function") {
			setImportStatus(page, "import.status.backend_missing", "Open in Wails to import tournament links.", "warning");
			return;
		}

		try {
			const settings = await withTimeout(app.LoadImportIntegrations(), 5000, "Integration settings load timed out");
			fillImportIntegrationsForm(page, settings);
			setImportStatus(page, "import.status.idle", "Paste a tournament link to preview imported data.", "neutral");
		} catch (error) {
			console.error("LoadImportIntegrations failed", error);
			setImportStatus(page, "import.status.integrations_load_failed", error?.message || "API key load failed", "error");
		}
	}

	/** Loads provider options into the Import form's provider select. */
	async function loadImportProviderSelect(page) {
		try {
			await ensureProviderCatalog();
			renderImportProviderSelect(page, readImportProvider(page) || "startgg");
			enhanceSelects(page);
		} catch (error) {
			console.warn("Could not initialize import providers", error);
		}
	}

	/** Saves provider API keys through Go so the frontend never writes files directly. */
	async function saveImportIntegrations(page) {
		const app = await waitForBackend();
		if (!app || typeof app.SaveImportIntegrations !== "function") {
			setImportStatus(page, "import.status.backend_missing", "Open in Wails to import tournament links.", "warning");
			return;
		}

		setImportStatus(page, "import.status.integrations.saving", "Saving API keys...", "neutral");
		setPageEnabled(page, false);
		try {
			const settings = await withTimeout(app.SaveImportIntegrations(readImportIntegrationsForm(page)), 5000, "Integration settings save timed out");
			fillImportIntegrationsForm(page, settings);
			setImportStatus(page, "import.status.integrations.saved", "API keys saved", "success");
		} catch (error) {
			console.error("SaveImportIntegrations failed", error);
			setImportStatus(page, "import.status.integrations.failed", error?.message || "API key save failed", "error");
		} finally {
			setPageEnabled(page, true);
			syncImportActionButtons(page);
			if (!page.dataset.previewUrl) setImportReady(page, false);
		}
	}

	/** Reads the selected provider key from the import form. */
	function readImportProvider(page) {
		const form = page.querySelector("[data-import-form]");
		if (!(form instanceof HTMLFormElement)) return "";
		return formControl(form, "provider")?.value.trim() || "";
	}

	/** Reads the tournament URL from the import form. */
	function readImportURL(page) {
		const form = page.querySelector("[data-import-form]");
		if (!(form instanceof HTMLFormElement)) return "";
		return formControl(form, "url")?.value.trim() || "";
	}

	/** Enables undo only when the page has a saved pre-import tournament snapshot. */
	function setImportUndoReady(page, ready) {
		const button = page.querySelector("[data-import-undo]");
		if (button instanceof HTMLButtonElement) button.disabled = !ready;
	}

	/** Enables import only after a successful preview of the current URL. */
	function setImportReady(page, ready, url = "") {
		page.dataset.previewUrl = ready ? url : "";
		const button = page.querySelector("[data-import-apply]");
		if (button instanceof HTMLButtonElement) button.disabled = !ready;
	}

	/** Reapplies Import/Undo disabled state after temporary page-wide locks. */
	function syncImportActionButtons(page) {
		const readyURL = page.dataset.previewUrl || "";
		const importButton = page.querySelector("[data-import-apply]");
		if (importButton instanceof HTMLButtonElement) importButton.disabled = !readyURL;
		setImportUndoReady(page, importUndoStates.has(page));
	}

	/** Formats a provider name from an import preview. */
	function importProviderName(preview) {
		return preview?.provider_name || preview?.provider || t("import.unknown_provider", "Unknown provider");
	}

	/** Renders one small import summary tile. */
	function importSummaryTile(label, value, options) {
		const body = options?.html ? String(value || "") : escapeHtml(value);
		return [
			`<div class="col-12 col-sm-6 col-lg-4 col-xl">`,
			`<div class="border rounded p-3 h-100">`,
			`<span class="d-block small fw-bold text-uppercase" data-muted-text>${escapeHtml(label)}</span>`,
			`<strong>${body}</strong>`,
			`</div>`,
			`</div>`,
		].join("");
	}

	/** Renders the imported game as full catalog name and logo when supported. */
	function importGameHTML(game) {
		const rawGame = String(game?.key || game?.name || game || "").trim();
		const entry = gameCatalogEntry(rawGame);
		const supported = Boolean(entry);
		const name = supported ? entry.name : rawGame || t("import.unknown_game", "Unknown");
		const logo = supported ? entry.logo || FALLBACK_ASSET : FALLBACK_ASSET;
		const suffix = supported ? "" : ` ${t("import.not_supported", "(not supported)")}`;
		return [
			`<span class="d-inline-flex gap-2 align-items-center mw-100">`,
			`<img class="fgc-media-image flex-shrink-0" src="${escapeHtml(logo)}" alt="" loading="lazy" data-fallback-image />`,
			`<span class="text-truncate">${escapeHtml(name)}${escapeHtml(suffix)}</span>`,
			`</span>`,
		].join("");
	}

	/** Renders an imported ISO2 country with its flag and localized label. */
	function importCountryHTML(country) {
		const code = String(country || "").toUpperCase();
		if (!code) return "";
		if (!isISO2Code(code)) return escapeHtml(code);
		return [
			`<span class="d-inline-flex gap-2 align-items-center">`,
			`<img class="fgc-country-flag flex-shrink-0" src="${escapeHtml(countryFlagPath(code))}" alt="" loading="lazy" data-flag-image />`,
			`<span>${escapeHtml(countryLabel(code))}</span>`,
			`</span>`,
		].join("");
	}

	/** Builds the imported player preview table. */
	function importPlayersTable(players) {
		if (!players.length) {
			return `<div class="fgc-empty border rounded p-3 text-center">${escapeHtml(t("import.no_players", "No players found in this import."))}</div>`;
		}
		const rows = players
			.slice(0, 64)
			.map(function (player, index) {
				return [
					`<tr>`,
					`<td>${escapeHtml(String(player.seed || index + 1))}</td>`,
					`<td>${escapeHtml(player.name || "")}</td>`,
					`<td>${escapeHtml(player.team || "")}</td>`,
					`<td>${importCountryHTML(player.country)}</td>`,
					`</tr>`,
				].join("");
			})
			.join("");
		const hiddenCount = Math.max(0, players.length - 64);
		const hiddenNote = hiddenCount
			? `<p class="mt-2 mb-0 small" data-muted-text>${escapeHtml(t("import.players_more", "{count} more players hidden from preview.").replace("{count}", String(hiddenCount)))}</p>`
			: "";
		return [
			`<div class="table-responsive border rounded p-2" data-import-preview-table>`,
			`<table class="table table-dark align-middle m-0">`,
			`<thead><tr>`,
			`<th class="small text-uppercase">${escapeHtml(t("import.seed", "Seed"))}</th>`,
			`<th class="small text-uppercase">${escapeHtml(t("import.player", "Player"))}</th>`,
			`<th class="small text-uppercase">${escapeHtml(t("import.team", "Team"))}</th>`,
			`<th class="small text-uppercase">${escapeHtml(t("import.country", "Country"))}</th>`,
			`</tr></thead>`,
			`<tbody>${rows}</tbody>`,
			`</table>`,
			`</div>`,
			hiddenNote,
		].join("");
	}

	/** Draws an import preview returned by the backend provider layer. */
	function renderImportPreview(page, preview) {
		const body = page.querySelector("[data-import-preview-body]");
		if (!(body instanceof HTMLElement)) return;
		const players = Array.isArray(preview?.players) ? preview.players : [];
		const matches = Array.isArray(preview?.matches) ? preview.matches : [];
		const warnings = Array.isArray(preview?.warnings) ? preview.warnings : [];
		const event = preview?.event || {};
		body.innerHTML = [
			importSummaryTile(t("import.provider", "Provider"), importProviderName(preview)),
			importSummaryTile(t("import.event", "Event"), event.name || t("import.unknown_event", "Unknown event")),
			importSummaryTile(t("import.phase", "Phase"), event.phase || ""),
			importSummaryTile(t("import.game", "Game"), importGameHTML(event.game), { html: true }),
			importSummaryTile(t("import.counts", "Counts"), `${players.length} ${t("players", "Players")} / ${matches.length} ${t("bracket.match", "Match")}`),
			warnings.length
				? `<div class="col-12"><div class="border border-warning rounded p-3">${warnings
						.map(function (warning) {
							return `<p class="m-0 small">${escapeHtml(warning)}</p>`;
						})
						.join("")}</div></div>`
				: "",
			`<div class="col-12">`,
			`<h3 class="fgc-title fs-6 lh-sm mb-2">${escapeHtml(t("import.players.title", "Players"))}</h3>`,
			importPlayersTable(players),
			`</div>`,
		].join("");
		applyLanguage(body);
	}

	/** Loads an external tournament preview through the backend. */
	async function previewTournamentImport(page) {
		const app = await waitForBackend();
		if (!app || typeof app.PreviewTournamentImport !== "function") {
			setImportStatus(page, "import.status.backend_missing", "Open in Wails to import tournament links.", "warning");
			return;
		}

		const url = readImportURL(page);
		const provider = readImportProvider(page);
		setImportReady(page, false);
		setImportStatus(page, "import.status.loading", "Loading import preview...", "neutral");
		setPageEnabled(page, false);
		try {
			if (!provider) throw new Error(t("import.status.provider_required", "Select an import provider."));
			const preview = await withTimeout(app.PreviewTournamentImport(url), 30000, "Import preview timed out");
			await ensureGameCatalog(app);
			if (!Object.keys(countryNames).length) countryNames = (await loadCountryNames()) || {};
			renderImportPreview(page, preview);
			setImportReady(page, true, url);
			setImportStatus(page, "import.status.ready", "Import preview ready", "success");
		} catch (error) {
			console.error("PreviewTournamentImport failed", error);
			setImportStatus(page, "import.status.failed", error?.message || "Import preview failed", "error");
		} finally {
			setPageEnabled(page, true);
			syncImportActionButtons(page);
		}
	}

	/** Imports the previously previewed tournament into local JSON through Go. */
	async function importTournamentLink(page) {
		const app = await waitForBackend();
		if (!app || typeof app.ImportTournamentLink !== "function") {
			setImportStatus(page, "import.status.backend_missing", "Open in Wails to import tournament links.", "warning");
			return;
		}

		const url = page.dataset.previewUrl || "";
		if (!url || url !== readImportURL(page)) {
			setImportReady(page, false);
			setImportStatus(page, "import.status.preview_required", "Preview this link before importing.", "warning");
			return;
		}

		setImportStatus(page, "import.status.importing", "Importing tournament...", "neutral");
		setPageEnabled(page, false);
		try {
			const previousState = typeof app.LoadTournament === "function" ? await withTimeout(app.LoadTournament(), 5000, "Tournament load timed out") : currentState;
			currentState = await withTimeout(app.ImportTournamentLink(url), 30000, "Tournament import timed out");
			importUndoStates.set(page, cloneJSON(previousState || currentState));
			setImportStatus(page, "import.status.imported", "Tournament imported", "success");
			setImportReady(page, false);
		} catch (error) {
			console.error("ImportTournamentLink failed", error);
			setImportStatus(page, "import.status.import_failed", error?.message || "Tournament import failed", "error");
		} finally {
			setPageEnabled(page, true);
			syncImportActionButtons(page);
		}
	}

	/** Restores the tournament JSON captured immediately before the last import. */
	async function undoTournamentImport(page) {
		const app = await waitForBackend();
		const state = importUndoStates.get(page);
		if (!state) {
			setImportStatus(page, "import.status.undo_unavailable", "No import to undo", "warning");
			setImportUndoReady(page, false);
			return;
		}
		if (!app || typeof app.SaveTournament !== "function") {
			setImportStatus(page, "import.status.backend_missing", "Open in Wails to import tournament links.", "warning");
			return;
		}

		setImportStatus(page, "import.status.undoing", "Undoing import...", "neutral");
		setPageEnabled(page, false);
		try {
			await withTimeout(app.SaveTournament(state), 10000, "Import undo timed out");
			currentState = typeof app.LoadTournament === "function" ? await withTimeout(app.LoadTournament(), 5000, "Tournament load timed out") : cloneJSON(state);
			importUndoStates.delete(page);
			setImportReady(page, false);
			setImportStatus(page, "import.status.undone", "Import undone", "success");
		} catch (error) {
			console.error("UndoTournamentImport failed", error);
			setImportStatus(page, "import.status.undo_failed", error?.message || "Import undo failed", "error");
		} finally {
			setPageEnabled(page, true);
			syncImportActionButtons(page);
		}
	}

	/** Binds the import page form and action buttons. */
	function bindImportPage(page) {
		if (page.dataset.bound === "true") return;
		page.dataset.bound = "true";
		const integrationsForm = page.querySelector("[data-import-integrations-form]");
		if (integrationsForm instanceof HTMLFormElement) {
			integrationsForm.addEventListener("submit", function (event) {
				event.preventDefault();
				void saveImportIntegrations(page);
			});
		}
		const form = page.querySelector("[data-import-form]");
		if (form instanceof HTMLFormElement) {
			form.addEventListener("submit", function (event) {
				event.preventDefault();
				void previewTournamentImport(page);
			});
			form.addEventListener("input", function () {
				setImportReady(page, false);
			});
			form.addEventListener("change", function () {
				setImportReady(page, false);
			});
		}
		const importButton = page.querySelector("[data-import-apply]");
		if (importButton instanceof HTMLButtonElement) {
			importButton.addEventListener("click", function () {
				void importTournamentLink(page);
			});
		}
		const undoButton = page.querySelector("[data-import-undo]");
		if (undoButton instanceof HTMLButtonElement) {
			undoButton.addEventListener("click", function () {
				void undoTournamentImport(page);
			});
		}
		setImportReady(page, false);
		setImportUndoReady(page, false);
		setImportStatus(page, "import.status.idle", "Paste a tournament link to preview imported data.", "neutral");
		void loadImportProviderSelect(page);
		void loadImportIntegrations(page);
	}

	/** Renders player cards and binds each generated form. */
	function renderPlayers(page) {
		const list = page.querySelector("[data-player-list]");
		if (!list) return;
		destroySelects(list);
		const rows = playerEntriesForEvent(currentState).map(function ([playerID, player]) {
			return playerCard(playerID, player);
		});
		list.innerHTML = rows.length ? rows.join("") : `<div class="col-12"><div class="${EMPTY_STATE_CLASS}" data-i18n="players.empty">No players found.</div></div>`;
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
		const scrollState = captureScrollState(page);
		const app = await waitForBackend();
		if (!app) {
			setPageEnabled(page, true);
			setPlayerStatus(page, "players.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			restoreScrollState(scrollState);
			return;
		}

		setPlayerStatus(page, "players.status.loading", "Loading players...", "neutral");
		setPageEnabled(page, false);
		try {
			const [state, codes, names] = await Promise.all([app.LoadTournament(), app.ListCountryCodes(), loadCountryNames()]);
			currentState = state;
			await ensureGameCatalog(app);
			applyGameBackgroundFromState(currentState);
			await ensureCharacterCatalog(app, currentState.event?.game || "");
			countryNames = names || {};
			countryCodes = normalizeCountryCodes(codes, countryNames);
			renderPlayers(page);
			setPlayerReadyStatus(page);
		} catch (error) {
			console.error("Load players failed", error);
			setPlayerStatus(page, "players.status.load_failed", "Player load failed", "error");
		} finally {
			setPageEnabled(page, true);
			restoreScrollState(scrollState);
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
			setPlayerStatus(page, "players.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			return "";
		}

		const playerID = form.getAttribute("data-player-form") || "";
		const playerPayload = readPlayerForm(form);
		const submittedSignature = JSON.stringify(playerPayload);
		const autosave = isAutosaveEnabled();
		setPlayerStatus(page, autosave ? "players.status.saving" : "players.status.saving_manual", autosave ? "Autosaving player..." : "Saving player...", "neutral");
		try {
			currentState = await app.UpdatePlayer(playerID, playerPayload);
			setPlayerStatus(page, autosave ? "players.status.saved" : "players.status.saved_manual", autosave ? "Player autosaved" : "Player saved", "success");
			return submittedSignature;
		} catch (error) {
			console.error("UpdatePlayer failed", error);
			setPlayerStatus(page, "players.status.failed", "Player save failed", "error");
			return "";
		}
	}

	/** Uploads a custom portrait through the backend filesystem API. */
	async function uploadPlayerPortrait(form, page, file) {
		const app = await waitForBackend();
		if (!app || typeof app.SavePlayerPortrait !== "function") {
			setPlayerStatus(page, "players.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			return;
		}

		const playerID = form.getAttribute("data-player-form") || "";
		setPlayerStatus(page, "players.status.portrait_uploading", "Uploading portrait...", "neutral");
		try {
			const imageData = await fileAsDataURL(file);
			const url = await app.SavePlayerPortrait(playerID, imageData);
			refreshPlayerPortrait(form, `${url}?v=${Date.now()}`);
			setPlayerStatus(page, "players.status.portrait_saved", "Portrait uploaded", "success");
		} catch (error) {
			console.error("SavePlayerPortrait failed", error);
			setPlayerStatus(page, "players.status.portrait_failed", "Portrait upload failed", "error");
		}
	}

	/** Removes a custom portrait through the backend filesystem API. */
	async function removePlayerPortrait(form, page) {
		const app = await waitForBackend();
		if (!app || typeof app.RemovePlayerPortrait !== "function") {
			setPlayerStatus(page, "players.status.backend_missing", "Open in Wails to edit tournament JSON.", "warning");
			return;
		}

		const playerID = form.getAttribute("data-player-form") || "";
		setPlayerStatus(page, "players.status.portrait_removing", "Removing portrait...", "neutral");
		try {
			const url = await app.RemovePlayerPortrait(playerID);
			refreshPlayerPortrait(form, `${url}?v=${Date.now()}`);
			setPlayerStatus(page, "players.status.portrait_removed", "Portrait removed", "success");
		} catch (error) {
			console.error("RemovePlayerPortrait failed", error);
			setPlayerStatus(page, "players.status.portrait_remove_failed", "Portrait remove failed", "error");
		}
	}

	/** Binds Dropzone to one player card without allowing direct filesystem writes. */
	function bindPlayerPortraitDropzone(form, page) {
		const dropzoneElement = form.querySelector("[data-player-dropzone]");
		if (!(dropzoneElement instanceof HTMLElement) || dropzoneElement.dataset.bound === "true") return;
		dropzoneElement.dataset.bound = "true";
		bindKeyboardClick(dropzoneElement);

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
		const options = playerAutosaveOptions(form, page);
		markAutosaved(form, formSignature(readPlayerForm, form));
		bindPlayerPortraitDropzone(form, page);
		bindPlayerPortraitRemove(form, page);

		form.addEventListener("submit", function (event) {
			event.preventDefault();
			void flushAutosave(form, options);
		});

		bindAutosave(form, options);
	}

	/** Binds the players page shell and triggers its initial load. */
	function bindPlayerPage(page) {
		if (page.dataset.bound === "true") return;
		page.dataset.bound = "true";
		void loadPlayers(page);
	}

	// --- SPA lifecycle ---

	/** Initializes controls in the current document or newly loaded SPA content. */
	function init(root = document) {
		applyLanguage(root);
		refreshCommonWidgets();
		bindSidebarActions(root);
		bindAutosaveToggles(root);
		bindGlobalReload(root);
		applyAutosavePreference();
		refreshStatusIcons(root);
		void syncSpaBackground();
		root.querySelectorAll(EVENT_FORM).forEach(function (form) {
			if (form instanceof HTMLFormElement) bindEventForm(form);
		});
		root.querySelectorAll(CURRENT_MATCH).forEach(function (panel) {
			if (panel instanceof HTMLElement) bindCurrentMatch(panel);
		});
		root.querySelectorAll(IMPORT_PAGE).forEach(function (page) {
			if (page instanceof HTMLElement) bindImportPage(page);
		});
		root.querySelectorAll(PLAYER_PAGE).forEach(function (page) {
			if (page instanceof HTMLElement) bindPlayerPage(page);
		});
		root.querySelectorAll(BRACKET_PAGE).forEach(function (page) {
			if (page instanceof HTMLElement) bindBracketPage(page);
		});
		root.querySelectorAll(BRACKET_OVERLAY).forEach(function (page) {
			if (page instanceof HTMLElement) bindBracketOverlay(page);
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
		applyLanguage(document);
		refreshCommonWidgets();
		const form = document.querySelector(EVENT_FORM);
		if (form instanceof HTMLFormElement && currentState?.event) {
			fillEventForm(form, currentState.event);
		}
		void (async function () {
			countryNames = (await loadCountryNames()) || {};
			const matchPanel = document.querySelector(CURRENT_MATCH);
			if (matchPanel instanceof HTMLElement && currentState) await loadCurrentMatch(matchPanel);
			document.querySelectorAll(`${BRACKET_PAGE}, ${BRACKET_OVERLAY}`).forEach(function (page) {
				if (page instanceof HTMLElement) void loadBracket(page, page.matches(BRACKET_PAGE) ? bracketManagerView(page) : "");
			});
			await refreshCountrySelects(document);
			refreshStatusIcons(document);
		})();
	});
})(typeof window !== "undefined" ? window : this);
