"use strict";
/*
 * File: _routes.js
 * Desc: Defines the routing map for the application, including URIs, GET/POST parameters, and associated components.
 * Deps: none
 * Copyright (c) 2025 Andrés Trujillo [Mateus] byUwUr
 */

(function (global) {
	global.bySPA = global.bySPA || {};
	const bySPA = global.bySPA;

	// URIs
	const ROUTE_ROOT = "/";

	const ROUTE_IMPORT_ES = "importar";
	const ROUTE_IMPORT_EN = "import";
	const ROUTE_HOME_ES = "inicio";
	const ROUTE_HOME_EN = "home";
	const ROUTE_PLAYERS_ES = "jugadores";
	const ROUTE_PLAYERS_EN = "players";
	const ROUTE_BRACKET_ES = "llaves";
	const ROUTE_BRACKET_EN = "brackets";

	const ROUTE_ES = "es";
	const ROUTE_EN = "en";
	const ROUTE_TEST = "test";

	// Default components to include on each route
	const COMPONENTS_EMPTY = { COMPONENT: { "nav#spa-nav": "", "footer#spa-foot": "" } };
	const ROOT_COMPONENTS = { COMPONENT: { "nav#spa-nav": "/sidebar.html", "footer#spa-foot": "" } };

	// Route definitions
	bySPA.ROUTES = {
		// "/"
		[`${ROUTE_ROOT}`]: { URI: `/main.html`, ...ROOT_COMPONENTS },
		[`/${ROUTE_ES}`]: { URI: ``, GET: { lang: "es" }, ...ROOT_COMPONENTS },
		[`/${ROUTE_EN}`]: { URI: ``, GET: { lang: "en" }, ...ROOT_COMPONENTS },
		[`/${ROUTE_IMPORT_ES}`]: { URI: `/import.html`, GET: { lang: "es" }, ...ROOT_COMPONENTS },
		[`/${ROUTE_IMPORT_EN}`]: { URI: `/import.html`, GET: { lang: "en" }, ...ROOT_COMPONENTS },
		[`/${ROUTE_HOME_ES}`]: { URI: `/main.html`, GET: { lang: "es" }, ...ROOT_COMPONENTS },
		[`/${ROUTE_HOME_EN}`]: { URI: `/main.html`, GET: { lang: "en" }, ...ROOT_COMPONENTS },
		[`/${ROUTE_PLAYERS_ES}`]: { URI: `/players.html`, GET: { lang: "es" }, ...ROOT_COMPONENTS },
		[`/${ROUTE_PLAYERS_EN}`]: { URI: `/players.html`, GET: { lang: "en" }, ...ROOT_COMPONENTS },
		[`/${ROUTE_BRACKET_ES}`]: { URI: `/brackets.html`, GET: { lang: "es" }, ...ROOT_COMPONENTS },
		[`/${ROUTE_BRACKET_EN}`]: { URI: `/brackets.html`, GET: { lang: "en" }, ...ROOT_COMPONENTS },
		[`/${ROUTE_TEST}`]: { URI: `/test.html`, ...ROOT_COMPONENTS },
	};

	localStorage.setItem("ROUTES", JSON.stringify(bySPA.ROUTES));
})(typeof window !== "undefined" ? window : this);
