/**
 * The Web pages row's words on a shared server, shared by the server and the
 * Web search page: the server refuses a request to turn web pages on with the
 * unreachable line, the same words the page shows in that row.
 *
 * Browser-safe on purpose: no imports, so apps/web-ui can import it the way it
 * imports the other pure server modules.
 */
export const WEB_PAGES_LINES = {
	on: "On. Rooms open public web pages. A page may lead on to another public site.",
	off: "Off. Rooms open no web pages, not even links you give them.",
	unreachable: "Off. This server can't reach public web pages.",
} as const;
