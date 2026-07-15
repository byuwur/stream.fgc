"use strict";

/*
 * File: app/import.js
 * Desc: External tournament provider settings, preview, import, and undo controller.
 * Deps: _app.js shared StreamFGC runtime and the Wails backend bindings.
 * Copyright (c) 2026 Andres Trujillo [Mateus] byUwUr
 */
/**
 * Registers this page controller on the shared Stream.FGC browser namespace.
 * @param {Window} global Browser window provided by Wails WebView or a regular browser.
 */
(function (global) {
	const fgc = global.StreamFGC;
	if (!fgc) throw new Error("StreamFGC core must load before app/import.js");

	const {
		applyLanguage,
		cloneJSON,
		countryFlagPath,
		countryLabel,
		enhanceSelects,
		ensureGameCatalog,
		ensureProviderCatalog,
		escapeHtml,
		formControl,
		gameCatalogEntry,
		isISO2Code,
		loadCountryNames,
		renderImportProviderSelect,
		setImportStatus,
		setPageEnabled,
		t,
		waitForBackend,
		withTimeout,
	} = fgc;
	const { FALLBACK_ASSET } = fgc.constants;
	const importUndoStates = new WeakMap();


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
			importSummaryTile(t("import.counts", "Counts"), `${players.length} ${t("players.title", "Players")} / ${matches.length} ${t("bracket.match", "Match")}`),
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
			if (!Object.keys(fgc.countryNames).length) fgc.countryNames = (await loadCountryNames()) || {};
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
			const previousState = typeof app.LoadTournament === "function" ? await withTimeout(app.LoadTournament(), 5000, "Tournament load timed out") : fgc.currentState;
			fgc.currentState = await withTimeout(app.ImportTournamentLink(url), 30000, "Tournament import timed out");
			importUndoStates.set(page, cloneJSON(previousState || fgc.currentState));
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
			fgc.currentState = typeof app.LoadTournament === "function" ? await withTimeout(app.LoadTournament(), 5000, "Tournament load timed out") : cloneJSON(state);
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

	fgc.imports = {
		bindPage: bindImportPage,
	};
})(window);
