/**
 * The Connectors page's words and the state of each connector's row, in one
 * place. Every sentence the page shows about a connector is one line here, so
 * a change of words is a one-line edit; the form's sentences the server also
 * says live in apps/web-server/src/connector-form.ts. Pure: no React, no
 * requests.
 */

import { CONNECTOR_CATALOG, type ConnectorCatalogEntry } from "./connector-catalog";
import type { McpConnectorCheck, McpConnectorRoomUse, McpConnectorStatus, McpLoginFailure } from "./mcp-api";
import { CONNECTOR_REQUEST_LINES, connectorShownName, importAppName, isPassingStatus } from "../../web-server/src/connector-form";

/**
 * A line in two parts: what happened, shown everywhere, and the way on, shown
 * only where its step can be taken (never over remote access, where the page
 * changes nothing).
 */
export interface TwoPartLine {
	fact: string;
	way: string | null;
}

const line = (fact: string, way: string | null = null): TwoPartLine => ({ fact, way });

const ADD_CUSTOM_WITH_SIGN_IN_APP = 'use Add custom connector and fill in "Your own sign-in app".';

export const CONNECTOR_WORDS = {
	title: "Connectors",
	subtitle: line("Apps your rooms can use.", "Turn them on in each room's settings."),
	sharedServerSubtitle: "External tools your rooms can reach.",
	listTitle: "Your connectors",
	addCustom: "Add custom connector",
	noneYet: "No connectors yet.",
	empty: { before: "Add one from the ", link: "directory below", after: "." },
	setUpOnComputer: "Connectors are set up and signed in on the computer itself.",
	loadAgain: "Try again",
	sharedFile: { before: "Connectors in the shared ", after: ", a file other apps can use, show here too." },
	tagCustom: "Custom",
	tagImported: (tool: string) => `From ${tool}`,
	roomsLink: (count: number) => (count === 0 ? "Not used in any room" : count === 1 ? "Used in 1 room" : `Used in ${count} rooms`),

	status: {
		connected: "Connected",
		notConnected: "Not connected",
		needsReconnecting: "Needs reconnecting",
		cantConnectNow: "Can't connect right now",
		notAnswering: "Not answering",
		cantConnect: "Can't connect",
		cantStart: "Can't start",
		program: "Runs on this computer",
		programRemote: "Runs on the computer itself",
		checking: "Checking…",
		signingIn: "Continue in your browser",
		signInFailed: "Sign-in didn't finish",
		cantSignIn: "Can't sign in",
	},
	button: {
		connect: "Connect",
		reconnect: "Reconnect",
		tryAgain: "Try again",
		cancel: "Cancel",
		keep: "Keep",
		remove: "Remove",
		save: "Save",
		changeAddress: "Change address",
		changeKey: "Change key",
	},
	menu: {
		label: (name: string) => `More for ${name}`,
		checkConnection: "Check connection",
		disconnect: "Disconnect",
		changeAddress: "Change address",
		remove: "Remove",
	},

	details: {
		wentWrong: "What went wrong",
		address: "Address",
		key: "Key",
		usedIn: "Used in",
		canDo: "What it can do",
		toolCount: (count: number) => `${count} tool${count === 1 ? "" : "s"}`,
		showAll: "Show all",
		showLess: "Show less",
		runs: "Runs",
		runsHere: "On this computer",
		runsHereRemote: "On the computer itself",
		technicalDetails: "Technical details",
		copy: "Copy",
		copied: "Copied",
	},
	wentWrong: {
		busy: line("Its service couldn't accept the connection.", "Try again later."),
		noAnswer: line("It didn't answer in time.", "Check your internet connection, and that its address is right."),
		addressNotFound: line("Its address wasn't found.", "Change it to connect again."),
		addressRefused: line("Its service turned the connection down.", "If its address is wrong, change it; if it's right, ask whoever runs the service."),
		addressNotFoundElsewhere: line("Its address wasn't found.", "Change it where it was added, or ask whoever added it."),
		addressRefusedElsewhere: line("Its service turned the connection down.", "Check its address where it was added, or ask whoever added it."),
		imported: (tool: string) => line(`Change its address in ${tool}.`),
		keyRefused: line("Its key was turned down.", "Change it to connect again."),
		keyFixed: line("Its key was turned down.", "Remove this connector and add it again with the new key."),
		keyRefusedElsewhere: line("Its key was turned down.", "Change it where it was added, or ask whoever added it."),
		importedKey: (tool: string) => line("Its key was turned down.", `Change it in ${tool}.`),
		refused: line("Its service turned the connection down.", "If you get a key for it, remove this connector and add it again with the key."),
		refusedElsewhere: line("Its service turned the connection down.", "If you get a key for it, add the key where it was added, or ask whoever added it."),
		refusedImported: (tool: string) => line("Its service turned the connection down.", `If you get a key for it, remove it in ${tool}, then use Add custom connector with that key.`),
		turnedDown: line("Its service turned the connection down."),
		program: line("It didn't answer on this computer.", "Check its command, then try again."),
		programRemote: line("It didn't answer on the computer itself."),
		cantStart: (room: string) => line(`The room "${room}" can change the files this connector runs from, so it can't start.`, "Move the connector's files out of that room's folders, or make those folders read-only in the room's settings."),
	},
	/** A sign-in that failed, by why; the service's own words go to Technical details. */
	signInFailed: {
		needsOwnApp: (place: ConnectorPlace, tool: string) =>
			line(
				"This service needs a sign-in app made in its developer settings, so trying again won't help.",
				place === "app" ? `Remove it in ${tool}, then ${ADD_CUSTOM_WITH_SIGN_IN_APP}` : place === "file" ? "Ask whoever added this connector to set up its own sign-in app." : `Remove this connector, then ${ADD_CUSTOM_WITH_SIGN_IN_APP}`,
			),
		refused: (place: ConnectorPlace, tool: string) =>
			line(
				"This service doesn't let exxperts sign in, so trying again won't help.",
				place === "app" ? `If you get a key for it, remove it in ${tool}, then use Add custom connector with that key.` : "If you get a key for it, remove this connector and add it again with the key.",
			),
		noSignIn: line("This connector doesn't offer a sign-in, so it likely works without one.", "Use Check connection to see."),
		tooSlow: line("The sign-in took too long.", "Try again."),
		other: line("The sign-in didn't work.", "Try again."),
	},
	importedNote: (tool: string) => `Added in ${tool}. To remove it, remove it there.`,
	/** A row from a file says which, where a row from another app names the app; the file is shown as code between the parts. */
	addedInSharedFile: { before: "Added in the shared ", after: ", a file other apps can use." },
	addedInProjectFile: { before: "Added in ", after: "." },
	room: {
		empty: "Use Open connectors to add one, then enable it here.",
		gone: line(CONNECTOR_REQUEST_LINES.noLongerExists, "Unless you remove it here, this room can use any connector added later with the same name."),
		removeTitle: "Only this room stops using it.",
		removeGoneTitle: "Take it off this room's list.",
		archived: "This room is archived, so its connectors can't be changed.",
		loadFailed: "Couldn't load this room's connectors.",
		badName: (tool: string | null) =>
			`This connector can't be turned on in a room because of its name. Rename it ${tool ? `in ${tool}` : "where it was added"}, using only letters, digits and dashes.`,
	},
	addressSaved: "Saved. Rooms use the new address the next time you open them.",
	keySaved: "Saved. Rooms use the new key the next time you open them.",

	removeQuestion: (name: string) => `Remove ${name}?`,
	removeRooms: (rooms: readonly string[]) => `${namesInLine(rooms)} will stop using it.`,
	removeCustomUnused: "You'll need its address to add it back.",
	removeProgramUnused: "You'll need its command to add it back.",
	removeSharedFile: "Other apps on this computer that use it lose it too.",

	addedFromDirectory: (name: string) => `${name} added. Connect it on its row above.`,
	addedCustom: (name: string) => `${name} added. Turn it on in each room that should use it.`,

	directoryTags: {
		oauth: "Sign in",
		open: "No sign-in",
		token: "Needs a key",
		"oauth-client": "Needs setup",
		guided: "Needs setup",
	} satisfies Record<ConnectorCatalogEntry["kind"], string>,
	directoryAdd: (entry: Pick<ConnectorCatalogEntry, "name" | "kind">) =>
		entry.kind === "token" ? `Add ${entry.name} with a key` : entry.kind === "oauth-client" ? `Add ${entry.name} with your own sign-in app` : `Add ${entry.name}`,
	directoryKeyPlaceholder: "Key",

	form: {
		title: "Custom connector",
		name: "Name",
		namePlaceholder: "Team wiki",
		howItConnects: "How it connects",
		web: "Web address",
		program: "Program on this computer",
		address: "Address",
		addressPlaceholder: "https://wiki.example.com/mcp",
		key: "Key (only if the service gave you one)",
		signInApp: "Your own sign-in app (advanced)",
		signInAppHint: { before: "Some services, like HubSpot, need an app you create in their developer settings. Give it this redirect URL ", after: ", then paste its Client ID and secret here." },
		clientId: "Client ID",
		clientSecret: "Client secret (if the service gave you one)",
		scopes: "Scopes (optional, separated by spaces)",
		headers: "Extra headers (advanced)",
		headersHint: { before: "Sent to the service each time exxperts connects, for example ", example: "X-Api-Key", after: " with your key. A header named Authorization, or with token, secret or API key in its name, counts as the sign-in, so this connector won't ask you to sign in." },
		headerName: (n: number) => `Header ${n} name`,
		headerValue: (n: number) => `Header ${n} value`,
		removeHeader: (n: number) => `Remove header ${n}`,
		addHeader: "Add another header",
		command: "Command",
		commandHint: "Copy it from the connector's setup instructions.",
		add: "Add connector",
		adding: "Adding…",
		cancel: "Cancel",
		headerNoValue: (header: string) => `The ${header} header needs a value.`,
		headerTwice: (header: string) => `The ${header} header is listed twice.`,
	},
} as const;

/** The line after adding from the directory: Connect is the next step only for one that signs in, as the rest connect by themselves. */
export function addedNotice(entry: Pick<ConnectorCatalogEntry, "name" | "kind">): string {
	return entry.kind === "open" || entry.kind === "token" ? CONNECTOR_WORDS.addedCustom(entry.name) : CONNECTOR_WORDS.addedFromDirectory(entry.name);
}

/** "A", "A and B", "A, B and C", and from four on "A, B and 2 more rooms". */
export function namesInLine(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
	const more = names.length - 2;
	return `${names[0]}, ${names[1]} and ${more} more room${more === 1 ? "" : "s"}`;
}

/** The other app a connector was imported from, by its name; null for one added here (or in the shared file, which Remove can change). */
export function importedFrom(server: Pick<McpConnectorStatus, "source">): string | null {
	const kind = server.source?.importKind;
	return server.source?.importFile && kind ? (importAppName(kind) ?? kind) : null;
}

/**
 * Where a connector was added, as far as its way on goes: "here", in
 * exxperts' own file, which this page changes; "file", the shared file or a
 * project's own file, which another app or a person may have written; "app",
 * brought in from another app, which changes it there.
 */
export type ConnectorPlace = "here" | "file" | "app";

export function connectorPlace(server: Pick<McpConnectorStatus, "source">): ConnectorPlace {
	if (importedFrom(server)) return "app";
	return server.source?.kind === "user" && !server.source.importKind ? "here" : "file";
}

/** The directory's entry for a connector added from it. */
export function catalogEntryOf(server: Pick<McpConnectorStatus, "name" | "target">): ConnectorCatalogEntry | undefined {
	return CONNECTOR_CATALOG.find((entry) => entry.id === server.name || (entry.url !== undefined && entry.url === server.target));
}

/** The connector's name as a person sees it, everywhere on the page and in room settings. */
export function shownName(server: Pick<McpConnectorStatus, "name" | "displayName">): string {
	return connectorShownName(server.name, server.displayName);
}

/** A tool as a person reads it: its own title, else its name without the connector's prefix, in plain words. */
export function toolTitle(server: Pick<McpConnectorStatus, "name" | "tools">, toolName: string): string {
	const own = server.tools?.titles?.[toolName];
	if (own) return own;
	const prefix = server.name.toLowerCase();
	const lower = toolName.toLowerCase();
	const bare = [`${prefix}-`, `${prefix}_`, `${prefix}.`].some((p) => lower.startsWith(p) && lower.length > p.length) ? toolName.slice(prefix.length + 1) : toolName;
	const words = bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_.\s]+/g, " ").trim().toLowerCase();
	return words ? words[0].toUpperCase() + words.slice(1) : toolName;
}

/**
 * Why a check that reached nothing it could use failed, as the row tells it;
 * where the connector was added picks the way on. Each cause has its own line,
 * so a line never names a cause that didn't happen: "address-not-found" a 404
 * or 410; "address-refused" any other refusal of the address; "key-refused" a
 * 401 or 403 to one with a key; "refused" the same to one with no key;
 * "turned-down" an address the directory set; "program" by its command.
 */
export type CantConnectCause = "address-not-found" | "address-refused" | "key-refused" | "refused" | "turned-down" | "program";

/**
 * Why a check failed in a way trying again can get past: "busy" a status the
 * same check later may get past; "no-answer" no status at all (nothing
 * answered, or something that isn't a connector did, which a check can't tell
 * apart), which may be the network.
 */
export type CantConnectNowCause = "busy" | "no-answer";

/** The one state a connector's row is in. Its words, dot, button and menu all follow from it. */
export type RowState =
	| { kind: "connected" }
	| { kind: "not-connected" }
	| { kind: "needs-reconnecting" }
	| { kind: "cant-connect-now"; cause: CantConnectNowCause; check: McpConnectorCheck }
	| { kind: "cant-connect"; cause: CantConnectCause; check: McpConnectorCheck }
	| { kind: "program" }
	| { kind: "cant-start"; room: string }
	| { kind: "checking" }
	| { kind: "signing-in" }
	| { kind: "sign-in-failed"; error?: string; cause?: McpLoginFailure; detail?: string };

/** A finished check, in the shape the server keeps it. */
export function checkOf(result: { ok: boolean; needsAuth?: boolean; httpStatus?: number; error?: string; startRefused?: McpConnectorCheck["startRefused"] }): McpConnectorCheck {
	return { at: Date.now(), ok: result.ok, ...(result.needsAuth ? { needsAuth: true } : {}), ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }), ...(result.error ? { error: result.error } : {}), ...(result.startRefused ? { startRefused: result.startRefused } : {}) };
}

/** What the person is doing on the row right now; null when nothing is under way. */
export type RowActivity = { kind: "checking" } | { kind: "signing-in" } | { kind: "sign-in-failed"; error?: string; cause?: McpLoginFailure; detail?: string } | null;

/** A sign-in the service was too busy for, that ran too long, failed for a reason not known, or never got an answer may finish on a second try. */
export const signInMayWork = (cause: McpLoginFailure | undefined) => cause === undefined || cause === "busy" || cause === "too-slow" || cause === "other";

function failedCheckState(server: McpConnectorStatus, check: McpConnectorCheck): RowState {
	if (server.transport !== "http") return { kind: "cant-connect", cause: "program", check };
	const status = check.httpStatus;
	if (status === undefined) return { kind: "cant-connect-now", cause: "no-answer", check };
	if (isPassingStatus(status)) return { kind: "cant-connect-now", cause: "busy", check };
	if (status === 401 || status === 403) return { kind: "cant-connect", cause: server.key === "none" ? "refused" : "key-refused", check };
	// An address the directory set, on a connector added here, is not the person's to change.
	if (catalogEntryOf(server) && connectorPlace(server) === "here") return { kind: "cant-connect", cause: "turned-down", check };
	return { kind: "cant-connect", cause: status === 404 || status === 410 ? "address-not-found" : "address-refused", check };
}

/**
 * The row's state from what is known: what the person is doing on it, else
 * the newest check (this page's, else the one the server kept), else the
 * saved sign-in and tools. A program is never started to find out.
 */
export function connectorRowState(server: McpConnectorStatus, check: McpConnectorCheck | null, activity: RowActivity): RowState {
	if (activity) return activity;
	if (server.transport !== "http") {
		// Said by the server at each read, or by this page's last check, whatever an earlier check found.
		const refused = server.startRefused ?? check?.startRefused;
		if (refused) return { kind: "cant-start", room: refused.roomName };
		if (check && !check.ok) return failedCheckState(server, check);
		return server.tools || check?.ok ? { kind: "connected" } : { kind: "program" };
	}
	const { auth } = server;
	if (check?.needsAuth) return auth.hasStoredTokens ? { kind: "needs-reconnecting" } : { kind: "not-connected" };
	if (check && !check.ok) return failedCheckState(server, check);
	// An expired sign-in with no way to renew it needs the person.
	if (auth.mode === "oauth" && auth.hasStoredTokens && auth.tokenExpired && !auth.hasRefreshToken) return { kind: "needs-reconnecting" };
	// A connector that names its own sign-in app expects a sign-in even when it lists its tools without one.
	if (auth.mode === "oauth" && auth.explicit && !auth.hasStoredTokens) return { kind: "not-connected" };
	if (check?.ok || server.tools || auth.hasStoredTokens) return { kind: "connected" };
	return { kind: "not-connected" };
}

/** The directory knows some web addresses need no sign-in: Connect there checks the connection instead. */
export function connectsBySignIn(server: McpConnectorStatus): boolean {
	if (server.transport !== "http" || server.auth.mode !== "oauth") return false;
	return !CONNECTOR_CATALOG.some((entry) => entry.kind === "open" && entry.url === server.target);
}

/**
 * Checked in the background when the page opens or the connector is added: a
 * web connector that has connected or tried to, so its row can change, and one
 * not known to need a sign-in (its key, if any, was given when it was added),
 * whose row is unknown until its first check. One known to wait for a sign-in,
 * from its own sign-in app or a kept check, waits for the person's Connect,
 * and a program is never started by opening the page.
 */
export function checksInBackground(server: McpConnectorStatus, state: RowState): boolean {
	if (server.transport !== "http") return false;
	if (state.kind === "not-connected") return !server.lastCheck && !waitsForSignIn(server);
	return state.kind === "connected" || state.kind === "cant-connect-now" || state.kind === "cant-connect";
}

/**
 * Known to need a sign-in before it answers: it names its own sign-in app, or
 * the directory says it signs in. A bare web address may need none, and only a
 * check can tell.
 */
export function waitsForSignIn(server: McpConnectorStatus): boolean {
	if (server.auth.mode !== "oauth") return false;
	return server.auth.explicit || catalogEntryOf(server)?.kind === "oauth";
}

export type DotLook = "ok" | "wait" | "warn" | "err" | "ring" | "busy";

/** How the row reads: its status words, its dot, whether the words take the body colour, and its one button. */
/** The one button a row can show. */
export type RowButton = "connect" | "reconnect" | "tryAgain" | "cancel";

/** remote: read over remote access, where "this computer" would be the device in hand. */
export function rowLook(state: RowState, remote: boolean): { status: string; dot: DotLook; broken: boolean; button: RowButton | null } {
	const words = CONNECTOR_WORDS.status;
	switch (state.kind) {
		case "connected":
			return { status: words.connected, dot: "ok", broken: false, button: null };
		case "not-connected":
			return { status: words.notConnected, dot: "wait", broken: false, button: "connect" };
		case "needs-reconnecting":
			return { status: words.needsReconnecting, dot: "warn", broken: true, button: "reconnect" };
		case "cant-connect-now":
			return { status: state.cause === "busy" ? words.cantConnectNow : words.notAnswering, dot: "err", broken: true, button: "tryAgain" };
		case "cant-connect":
			return { status: words.cantConnect, dot: "err", broken: true, button: null };
		case "program":
			return { status: remote ? words.programRemote : words.program, dot: "ring", broken: false, button: null };
		case "cant-start":
			return { status: words.cantStart, dot: "err", broken: true, button: null };
		case "checking":
			return { status: words.checking, dot: "busy", broken: false, button: null };
		case "signing-in":
			return { status: words.signingIn, dot: "busy", broken: false, button: "cancel" };
		case "sign-in-failed":
			// A refusal, a service that needs its own sign-in app and one with no sign-in fail the same way twice.
			return signInMayWork(state.cause) ? { status: words.signInFailed, dot: "err", broken: true, button: "tryAgain" } : { status: words.cantSignIn, dot: "err", broken: true, button: null };
	}
}

/** The button beside the line under "What went wrong". */
export type WentWrongButton = "changeAddress" | "changeKey" | "tryAgain" | "remove";

/**
 * The line under "What went wrong", and the button that takes its way on;
 * null when the row has nothing to say there. remote: read over remote
 * access, which shows only the line's first part.
 */
export function wentWrongLine(server: McpConnectorStatus, state: RowState, remote: boolean): { line: TwoPartLine; button: WentWrongButton | null } | null {
	const words = CONNECTOR_WORDS.wentWrong;
	const place = connectorPlace(server);
	const tool = importedFrom(server) ?? "";
	const changeAddress = isCustom(server) && server.editable ? "changeAddress" : null;
	// A wrong address is one cause no answer can't rule out: one added here can change it.
	if (state.kind === "cant-connect-now") return state.cause === "busy" ? { line: words.busy, button: null } : { line: words.noAnswer, button: changeAddress };
	if (state.kind === "cant-connect") {
		switch (state.cause) {
			case "address-not-found":
				return place === "app" ? { line: words.imported(tool), button: null } : place === "file" ? { line: words.addressNotFoundElsewhere, button: null } : { line: words.addressNotFound, button: changeAddress };
			case "address-refused":
				return place === "app" ? { line: words.imported(tool), button: null } : place === "file" ? { line: words.addressRefusedElsewhere, button: null } : { line: words.addressRefused, button: changeAddress };
			case "key-refused":
				if (place !== "here") return { line: place === "app" ? words.importedKey(tool) : words.keyRefusedElsewhere, button: null };
				// A key Change key can't replace (two of them, or one beside its own sign-in app) is added again instead.
				return server.key === "replaceable" ? { line: words.keyRefused, button: "changeKey" } : { line: words.keyFixed, button: "remove" };
			case "refused":
				return place === "here" ? { line: words.refused, button: "remove" } : { line: place === "app" ? words.refusedImported(tool) : words.refusedElsewhere, button: null };
			case "turned-down":
				return { line: words.turnedDown, button: null };
			case "program":
				return remote ? { line: words.programRemote, button: null } : { line: words.program, button: "tryAgain" };
		}
	}
	if (state.kind === "cant-start") return { line: words.cantStart(state.room), button: null };
	if (state.kind === "sign-in-failed") {
		const failed = CONNECTOR_WORDS.signInFailed;
		switch (state.cause) {
			// Added here, the way on starts with removing this connector, which its button asks about.
			case "needs-own-app": return { line: failed.needsOwnApp(place, tool), button: place === "here" ? "remove" : null };
			case "refused": return { line: failed.refused(place, tool), button: place === "here" ? "remove" : null };
			case "busy": return { line: words.busy, button: null };
			case "no-sign-in": return { line: failed.noSignIn, button: null };
			case "too-slow": return { line: failed.tooSlow, button: null };
			case "other": return { line: failed.other, button: null };
		}
		// A request that failed before the sign-in began says why in its own words.
		if (state.error) return { line: line(state.error), button: null };
	}
	return null;
}

/**
 * Where a row from a file was added, said where a row from another app names
 * the app: the shared file by the same path the page's line about it shows, a
 * file in the folder exxperts runs from by its own. Null for any other row.
 */
export function addedInFile(server: Pick<McpConnectorStatus, "source">, sharedFile: string | null): { before: string; file: string; after: string } | null {
	if (connectorPlace(server) !== "file" || !server.source) return null;
	return server.source.kind === "project"
		? { ...CONNECTOR_WORDS.addedInProjectFile, file: server.source.path }
		: { ...CONNECTOR_WORDS.addedInSharedFile, file: sharedFile ?? server.source.path };
}

/** A line as a person reads it there: over remote access, its first part only. */
export function lineText(two: TwoPartLine, remote: boolean): string {
	return remote || !two.way ? two.fact : `${two.fact} ${two.way}`;
}

/** The server's own words behind a failure, for Technical details. */
export function technicalDetails(state: RowState): string | null {
	if (state.kind === "sign-in-failed") return state.detail ?? null;
	return (state.kind === "cant-connect-now" || state.kind === "cant-connect") && state.check.error ? state.check.error : null;
}

/** The row's "⋯" items, in order; Remove last, after a divider. */
export function rowMenu(server: McpConnectorStatus, state: RowState, readOnly: boolean): Array<"checkConnection" | "disconnect" | "changeAddress" | "remove"> {
	if (readOnly) return [];
	const items: Array<"checkConnection" | "disconnect" | "changeAddress" | "remove"> = [];
	// After a failed sign-in too: its line may say the service needs none, which only a check can show.
	// A directory connector its service turned down may be let in later: a check finds out.
	// After a fix in the room's settings, a check shows the program starts.
	if (state.kind === "connected" || state.kind === "program" || state.kind === "cant-start" || state.kind === "sign-in-failed" || (state.kind === "cant-connect" && state.cause === "turned-down")) items.push("checkConnection");
	if (server.auth.mode === "oauth" && server.auth.hasStoredTokens) items.push("disconnect");
	if (isCustom(server) && server.editable) items.push("changeAddress");
	if (!importedFrom(server)) items.push("remove");
	return items;
}

/** Added by address or command, not from the directory and not imported. */
export function isCustom(server: McpConnectorStatus): boolean {
	return !catalogEntryOf(server) && !importedFrom(server);
}

/** The remove question's second line: who stops using it, or what adding it back takes; null when neither applies. */
export function removeConsequence(server: McpConnectorStatus, rooms: readonly McpConnectorRoomUse[] | null): string | null {
	const lines = [
		rooms && rooms.length > 0 ? CONNECTOR_WORDS.removeRooms(rooms.map((room) => room.name))
			: !isCustom(server) ? null
			: server.transport === "http" ? CONNECTOR_WORDS.removeCustomUnused : CONNECTOR_WORDS.removeProgramUnused,
		// Remove deletes it from every file that names it, a file other apps read included.
		server.inSharedFile ? CONNECTOR_WORDS.removeSharedFile : null,
	].filter((line): line is string => line !== null);
	return lines.length > 0 ? lines.join(" ") : null;
}
