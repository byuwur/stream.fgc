"use strict";

/*
 * File: app/players.js
 * Desc: Player cards, autosave, country/character selects, and portrait controller.
 * Deps: _app.js shared StreamFGC runtime and the Wails backend bindings.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
/**
 * Registers this page controller on the shared Stream.FGC browser namespace.
 * @param {Window} global Browser window provided by Wails WebView or a regular browser.
 */
(function (global) {
	const fgc = global.StreamFGC;
	if (!fgc) throw new Error("StreamFGC core must load before app/players.js");

	const {
		applyAutosavePreference,
		applyGameBackgroundFromState,
		applyLanguage,
		autosaveOptions,
		autosaveForms,
		bindAutosave,
		bindKeyboardClick,
		captureScrollState,
		destroySelects,
		enhanceSelects,
		ensureCharacterCatalog,
		ensureGameCatalog,
		fileAsDataURL,
		flushAutosave,
		formControl,
		formSignature,
		isAutosaveEnabled,
		loadCountryNames,
		markAutosaved,
		normalizeCountryCodes,
		playerCard,
		playerEntriesForEvent,
		playerSignature,
		refreshPlayerPortrait,
		restoreScrollState,
		scheduleAutosave,
		setImageFallback,
		setPageEnabled,
		setPlayerReadyStatus,
		setPlayerStatus,
		waitForBackend,
	} = fgc;
	const { EMPTY_STATE_CLASS, PLAYER_PORTRAIT_MAX_MB } = fgc.constants;

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

	/** Renders player cards and binds each generated form. */
	function renderPlayers(page) {
		const list = page.querySelector("[data-player-list]");
		if (!list) return;
		destroySelects(list);
		const rows = playerEntriesForEvent(fgc.currentState).map(function ([playerID, player]) {
			return playerCard(playerID, player);
		});
		list.innerHTML = rows.length ? rows.join("") : `<div class="col-12"><div class="${EMPTY_STATE_CLASS}" data-i18n="players.empty">No players found.</div></div>`;
		list.querySelectorAll("[data-player-form]").forEach(function (form) {
			if (!(form instanceof HTMLFormElement)) return;
			bindPlayerForm(form, page);
			const playerID = form.getAttribute("data-player-form") || "";
			const savedSignature = playerSignature(fgc.currentState?.players?.[playerID] || {});
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
			fgc.currentState = state;
			await ensureGameCatalog(app);
			applyGameBackgroundFromState(fgc.currentState);
			await ensureCharacterCatalog(app, fgc.currentState.event?.game || "");
			fgc.countryNames = names || {};
			fgc.countryCodes = normalizeCountryCodes(codes, fgc.countryNames);
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
			fgc.currentState = await app.UpdatePlayer(playerID, playerPayload);
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

	fgc.players = {
		bindPage: bindPlayerPage,
		load: loadPlayers,
	};
})(window);
