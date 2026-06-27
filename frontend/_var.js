"use strict";
/*
 * File: _var.js
 * Desc: Initializes the system environment, sets up path-related variables, and optionally stores these values in the browser's localStorage. (MUST be included in every file)
 * Deps: none
 * Copyright (c) 2025 Andrés Trujillo [Mateus] byUwUr
 */

/**
 * Initializes the system environment.
 * This IIFE (Immediately Invoked Function Expression) ensures bySPA object exists globally
 * (typically on `window` in a browser) to avoid pollution and conflicts in the global namespace.
 * @param {Object} global - The global object, usually `window` in a browser.
 */
(function (global) {
	global.bySPA = global.bySPA || {};
	const bySPA = global.bySPA;

	// --- functions ---

	/**
	 * Replaces "\\" directory separators to "/"
	 * @param {string} path String to convert
	 * @return {string} Converted path
	 */
	const std_dir_separator = (path) => {
		return String(path || "").replace(/\\/g, "/");
	};

	/**
	 * Returns the directory portion of a path using normalized "/" separators.
	 * @param {string} path Path string to inspect.
	 * @return {string} Directory path, or "." when no directory portion exists.
	 */
	const dirname = (path) => {
		return std_dir_separator(path).replace(/\/[^/]*$/, "") || ".";
	};

	// Check if we're on localhost for DEVbugging
	const host = global.location.host || "";
	const NOTENV_APP_ENV = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/.test(host) ? "DEV" : "PROD";

	/*
	 * Initializes the path variables that _var.php normally calculates from
	 * PHP server values. Static /spa.js/ uses the script URL and browser
	 * location instead of __FILE__, SCRIPT_FILENAME and PHP_SELF.
	 */
	const currentScript = document.currentScript;
	const scriptURL = new URL(currentScript?.getAttribute("src") || "_var.js", global.location.href);

	// === /spa.js/ only: static routing can run in hash or path mode ===
	const ROUTER_MODE = (localStorage.getItem("ROUTER_MODE") || "hash").toLowerCase();

	bySPA.APP_ENV = localStorage.getItem("APP_ENV") || NOTENV_APP_ENV;
	bySPA.ROUTER_MODE = ROUTER_MODE === "path" ? "path" : "hash";
	// Stream.FGC dictionaries are loaded by spa.js/_lang.js, so expose the app allowlist before that file boots.
	bySPA.APP_LANGS = ["es", "en", "ja"];
	bySPA.DEFAULT_APP_LANG = "es";
	// Determine the protocol (HTTP or HTTPS)
	bySPA.PROTOCOL = global.location.protocol === "https:" ? "https://" : "http://";
	// Get this script's file and directory path
	bySPA.THIS__FILE__ = std_dir_separator(scriptURL.href);
	bySPA.THIS_PATH = dirname(bySPA.THIS__FILE__);
	// Set the absolute path to the home directory
	bySPA.HOME_PATH = bySPA.THIS_PATH;

	const currentDir = dirname(global.location.href);
	const homeURL = new URL(bySPA.HOME_PATH + "/");
	const currentURL = new URL(currentDir + "/");

	const homeParts = homeURL.pathname.split("/").filter(Boolean);
	const currentParts = currentURL.pathname.split("/").filter(Boolean);

	// Calculate the difference in directory depth between the current document and the root directory
	let common = 0;
	while (homeParts[common] && homeParts[common] === currentParts[common]) common++;
	bySPA.PATH_DIFF = Math.max(0, currentParts.length - homeParts.length);

	const up = "../".repeat(Math.max(0, currentParts.length - common));
	const down = homeParts.slice(common).join("/");
	// Set the relative path to the home directory
	bySPA.TO_HOME = up + down || ".";

	// Store the calculated paths in the browser's localStorage
	localStorage.setItem("APP_ENV", bySPA.APP_ENV);
	localStorage.setItem("ROUTER_MODE", bySPA.ROUTER_MODE);
	localStorage.setItem("PROTOCOL", bySPA.PROTOCOL);
	localStorage.setItem("PATH_DIFF", String(bySPA.PATH_DIFF));
	localStorage.setItem("TO_HOME", bySPA.TO_HOME);
	localStorage.setItem("THIS_PATH", bySPA.THIS_PATH);
	localStorage.setItem("HOME_PATH", bySPA.HOME_PATH);

	if (bySPA.APP_ENV === "DEV") {
		console.log("APP_ENV", bySPA.APP_ENV);
		console.log("ROUTER_MODE", bySPA.ROUTER_MODE);
		console.log("PROTOCOL", bySPA.PROTOCOL);
		console.log("PATH_DIFF", bySPA.PATH_DIFF);
		console.log("TO_HOME", bySPA.TO_HOME);
		console.log("THIS_PATH", bySPA.THIS_PATH);
		console.log("HOME_PATH", bySPA.HOME_PATH);
	}
})(typeof window !== "undefined" ? window : this);
