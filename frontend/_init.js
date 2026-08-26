"use strict";
/*
 * File: _init.js
 * Desc: Initializes the application-specific SPA environment, paths, storage, and runtime state. (MUST load before routes and the SPA runtime)
 * Deps: none
 * Copyright (c) 2026 Andrés Trujillo [Mateus] byUwUr
 */

/**
 * Initializes the system environment.
 * This IIFE (Immediately Invoked Function Expression) ensures bySPA object exists globally
 * (typically on `window` in a browser) to avoid pollution and conflicts in the global namespace.
 * @param {Object} global - The global object, usually `window` in a browser.
 */
(function (global) {
  const currentScript = document.currentScript;
  const scriptURL = new URL(currentScript?.getAttribute("src") || "_init.js", global.location.href);
  const applicationURL = new URL("./", scriptURL);

  /*
   * File: _storage.js
   * Desc: Manages the Single Page Application (SPA) storage.
   * Deps: none
   * Copyright (c) 2026 Andrés Trujillo [Mateus] byUwUr
   */

  /**
   * Provides namespaced SPA storage with an in-memory fallback.
   * Legacy unprefixed keys are migrated on first read.
   * @namespace byStorage
   */
  global.byStorage = global.byStorage || {};
  const byStorage = global.byStorage;
  byStorage.memory = {};
  byStorage.base = applicationURL.pathname.replace(/\/$/, "") || "/";
  byStorage.prefix = `bySPA:${byStorage.base}:`;

  /**
   * Gets a stored value, migrating a legacy key when needed.
   * @param {string} key
   * @returns {string|null}
   */
  byStorage.getItem = function (key) {
    try {
      const value = global.localStorage.getItem(byStorage.prefix + key);
      if (value !== null) return value;
      // Migrate legacy unprefixed storage.
      const legacy = global.localStorage.getItem(key);
      if (legacy !== null) {
        byStorage.memory[key] = legacy;
        global.localStorage.setItem(byStorage.prefix + key, legacy);
        // Remove the old key only after storage confirms the migrated value.
        if (global.localStorage.getItem(byStorage.prefix + key) === legacy)
          try {
            global.localStorage.removeItem(key);
          } catch (_) {}
      }
      return legacy;
    } catch (_) {
      return Object.prototype.hasOwnProperty.call(byStorage.memory, key) ? byStorage.memory[key] : null;
    }
  };

  /**
   * Stores a value using the SPA namespace.
   * @param {string} key
   * @param {*} value
   * @returns {void}
   */
  byStorage.setItem = function (key, value) {
    byStorage.memory[key] = String(value);
    try {
      global.localStorage.setItem(byStorage.prefix + key, value);
    } catch (_) {}
  };

  /**
   * Removes a stored value.
   * @param {string} key
   * @returns {void}
   */
  byStorage.removeItem = function (key) {
    delete byStorage.memory[key];
    try {
      global.localStorage.removeItem(byStorage.prefix + key);
    } catch (_) {}
  };

  // ===========================

  global.bySPA = global.bySPA || {};
  const bySPA = global.bySPA;

  // --- functions ---

  /**
   * Replaces "\\" directory separators to "/"
   * @param {string} path String to convert
   * @return string Converted path
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
   * Initializes the path values that _init.php normally calculates from
   * PHP server values. Static /spa.js/ uses the script URL and browser
   * location instead of __FILE__, SCRIPT_FILENAME and PHP_SELF.
   */
  // === /spa.js/ only: static routing can run in hash or path mode ===
  const ROUTER_MODE = (byStorage.getItem("ROUTER_MODE") || "hash").toLowerCase();

  bySPA.APP_ENV = byStorage.getItem("APP_ENV") || NOTENV_APP_ENV;
  bySPA.ROUTER_MODE = ROUTER_MODE === "path" ? "path" : "hash";
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
  byStorage.setItem("APP_ENV", bySPA.APP_ENV);
  byStorage.setItem("ROUTER_MODE", bySPA.ROUTER_MODE);
  byStorage.setItem("PROTOCOL", bySPA.PROTOCOL);
  byStorage.setItem("PATH_DIFF", String(bySPA.PATH_DIFF));
  byStorage.setItem("TO_HOME", bySPA.TO_HOME);
  byStorage.setItem("THIS_PATH", bySPA.THIS_PATH);
  byStorage.setItem("HOME_PATH", bySPA.HOME_PATH);

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
