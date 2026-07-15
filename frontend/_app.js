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
	const fgc = (global.StreamFGC = global.StreamFGC || {});

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
	const currentSeedSelections = new WeakMap();

	// --- Backend and status helpers ---

	/** Returns whichever Wails binding shape is available in development or production. */
	function backendBinding() {
		return global.go?.backend?.App || global.go?.main?.App || global.streamFgcBackend || null;
	}

	/** Loads generated Wails bindings on demand when the injected global is not present. */
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

	/** Waits briefly for Wails to inject the backend during WebView startup. */
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

	/** Updates one status element inside a page without touching the global status badge. */
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

	/** Keeps the sidebar copyright year current after SPA fragment loads. */
	function refreshCurrentYear() {
		global.jQuery?.("#current-year").text(new Date().getFullYear());
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

	/** Enables or disables matching form controls while an asynchronous save is running. */
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
				if (page instanceof HTMLElement && fgc.players?.load) tasks.push(fgc.players.load(page));
			});

			document.querySelectorAll(`${BRACKET_PAGE}, ${BRACKET_OVERLAY}`).forEach(function (page) {
				if (page instanceof HTMLElement && fgc.bracket?.load) {
					tasks.push(fgc.bracket.load(page, page.matches(BRACKET_PAGE) ? fgc.bracket.managerView(page) : ""));
				}
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
		global.byCommon?.init?.();
	}

	// --- Page controller API ---

	/*
	 * Page files share this small API instead of reaching into one another.
	 * The mutable properties keep one tournament/catalog state across SPA routes.
	 */
	Object.defineProperties(fgc, {
		countryCodes: {
			configurable: true,
			get: function () {
				return countryCodes;
			},
			set: function (value) {
				countryCodes = value;
			},
		},
		countryNames: {
			configurable: true,
			get: function () {
				return countryNames;
			},
			set: function (value) {
				countryNames = value;
			},
		},
		currentState: {
			configurable: true,
			get: function () {
				return currentState;
			},
			set: function (value) {
				currentState = value;
			},
		},
	});

	Object.assign(fgc, {
		applyAutosavePreference,
		applyGameBackgroundFromState,
		applyLanguage,
		autosaveOptions,
		autosaveForms,
		bindAutosave,
		bindKeyboardClick,
		bracketParticipantMediaHTML,
		bracketSwapSeedFromTarget,
		captureScrollState,
		clampScore,
		cloneJSON,
		constants: Object.freeze({
			BRACKET_ADMIN_VIEW,
			BRACKET_OVERLAY_REFRESH_MS,
			BRACKET_PAGE,
			EMPTY_STATE_CLASS,
			FALLBACK_ASSET,
			PLAYER_PORTRAIT_MAX_MB,
		}),
		countryFlagPath,
		countryLabel,
		destroySelect,
		destroySelects,
		enhanceSelects,
		ensureCharacterCatalog,
		ensureGameCatalog,
		ensureProviderCatalog,
		escapeHtml,
		eventRuleLimit,
		fileAsDataURL,
		flushAutosave,
		formControl,
		formSignature,
		gameCatalogEntry,
		isAutosaveEnabled,
		isCurrentBracketLoad,
		isISO2Code,
		loadCountryNames,
		markAutosaved,
		nextBracketLoadTicket,
		normalizeCountryCodes,
		parseRuleValue,
		participantMeta,
		participantName,
		playerCard,
		playerEntriesForEvent,
		playerSignature,
		refreshPlayerPortrait,
		renderImportProviderSelect,
		restoreScrollState,
		scheduleAutosave,
		scoreStepperHTML,
		setBracketStatus,
		setImageFallback,
		setImportStatus,
		setPageEnabled,
		setPlayerReadyStatus,
		setPlayerStatus,
		setSeedSelection,
		swappableParticipantSeed,
		t,
		waitForBackend,
		withTimeout,
	});


	// --- SPA lifecycle ---

	/** Initializes controls in the current document or newly loaded SPA content. */
	function init(root = document) {
		applyLanguage(root);
		refreshCommonWidgets();
		bindSidebarActions(root);
		refreshCurrentYear();
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
			if (page instanceof HTMLElement) fgc.imports?.bindPage?.(page);
		});
		root.querySelectorAll(PLAYER_PAGE).forEach(function (page) {
			if (page instanceof HTMLElement) fgc.players?.bindPage?.(page);
		});
		root.querySelectorAll(BRACKET_PAGE).forEach(function (page) {
			if (page instanceof HTMLElement) fgc.bracket?.bindPage?.(page);
		});
		root.querySelectorAll(BRACKET_OVERLAY).forEach(function (page) {
			if (page instanceof HTMLElement) fgc.bracket?.bindOverlay?.(page);
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
				if (page instanceof HTMLElement && fgc.bracket?.load) {
					void fgc.bracket.load(page, page.matches(BRACKET_PAGE) ? fgc.bracket.managerView(page) : "");
				}
			});
			await refreshCountrySelects(document);
			refreshStatusIcons(document);
		})();
	});
})(typeof window !== "undefined" ? window : this);
