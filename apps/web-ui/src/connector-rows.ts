/**
 * The Connectors page's words and the state of each connector's row, in one
 * place. Every sentence the page shows about a connector is one line here, so
 * a change of words is a one-line edit; the form's sentences the server also
 * says live in apps/web-server/src/connector-form.ts. Pure: no React, no
 * requests.
 */

import { CONNECTOR_CATALOG, CONNECTOR_DIRECTORY, type ConnectorCatalogEntry, type ConnectorDirectoryEntry } from "./connector-catalog";
import type { ConnectorReach, ConnectorRuntime, McpConnectorCheck, McpConnectorRoomUse, McpConnectorStatus, McpLoginFailure, ProgramStartFailure } from "./mcp-api";
import { CONNECTOR_REQUEST_LINES, RESET_CHOICES, connectorShownName, importAppName, isPassingStatus } from "../../web-server/src/connector-form";
import { CONNECTOR_CHOICE_WORDS, type ConnectorToolChoice } from "../../web-server/src/room-approval-titles";

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

/** The way on for a connector with no key yet that takes its first one in place (`takesFirstKey`). */
const KEY_IN_PLACE = "If you have a key for it, use Change key.";

/** A service that turned the connection down, and the way on for a key by where the connector was added; a sign-in that can't help says the same way on. */
const CONNECTOR_WORDS_REFUSED = {
	refused: line("Its service turned the connection down.", "If you have a key for it, remove this connector and add it again with the key."),
	refusedKeyInPlace: line("Its service turned the connection down.", KEY_IN_PLACE),
	refusedElsewhere: line("Its service turned the connection down.", "If you have a key for it, add the key where it was added, or ask whoever added it."),
	refusedImported: (tool: string) => line("Its service turned the connection down.", `If you have a key for it, remove it in ${tool}, then add it by its web address with that key.`),
};

const WANTS_KEY = "It wants a sign-in or a key, and doesn't offer a sign-in here.";
const REFUSED_SIGN_IN = "This service doesn't let exxperts sign in, so trying again won't help.";

const ADD_CUSTOM_WITH_SIGN_IN_APP = 'use Add connector, By web address, and fill in "Your own sign-in app".';

export const CONNECTOR_WORDS = {
	title: "Connectors",
	subtitle: line("Apps and services your rooms can use.", "Switch one on in a room's settings."),
	sharedServerSubtitle: "External tools your rooms can reach.",
	listTitle: "Your connectors",
	addConnector: "Add connector",
	/** The Add connector menu's three ways, in order. */
	addWays: { directory: "From the directory", web: "By web address", program: "Program on this computer" },
	noneYet: "No connectors yet.",
	empty: { before: "Add one from the ", link: "directory below", after: ", or by its web address." },
	setUpOnComputer: "Connectors are set up and signed in on the computer itself.",
	loadAgain: "Try again",
	tagCustom: "Custom",
	tagImported: (tool: string) => `From ${tool}`,
	roomsLink: (count: number) => (count === 0 ? "Not on in any room" : count === 1 ? "On in 1 room" : `On in ${count} rooms`),
	/** The same, ending a row's status line in the settings look: "Connected · 4 tools · on in 1 room". */
	roomsInLine: (count: number) => (count === 0 ? "not on in any room" : count === 1 ? "on in 1 room" : `on in ${count} rooms`),
	/** Under a connected row with nothing else to say: its tools. */
	toolCount: (count: number) => (count === 0 ? "No tools" : count === 1 ? "1 tool" : `${count} tools`),

	status: {
		connected: "Connected",
		notConnected: "Not connected",
		needsReconnecting: "Sign-in expired",
		cantConnectNow: "Can't connect right now",
		notAnswering: "Not answering",
		addressNotFound: "Address not found",
		cantConnect: "Can't connect",
		cantStart: "Can't start",
		program: "Runs on this computer",
		programRemote: "Runs on the computer itself",
		checking: "Checking…",
		gettingReady: "Getting it ready…",
		signingIn: "Continue in your browser",
		signInFailed: "Sign-in didn't finish",
		cantSignIn: "Can't sign in",
	},
	button: {
		connect: "Connect",
		signIn: "Sign in",
		reconnect: "Reconnect",
		tryAgain: "Try again",
		cancel: "Cancel",
		keep: "Keep",
		remove: "Remove",
		save: "Save",
		changeAddress: "Change address",
		changeKey: "Change key",
		install: "How to install it ↗",
		checkConnection: "Check connection",
		disconnect: "Disconnect",
	},
	/** Under a row signing in, and beside its state on the connector's own page. */
	signingInNote: "Sign in on the page that opened in your browser, then come back here.",

	details: {
		back: "← Connectors",
		/** The settings look's arrow, for a screen reader. */
		backName: "Back to Connectors",
		/** The settings look's first row; the old look says What went wrong and Connection. */
		status: "Status",
		wentWrong: "What went wrong",
		address: "Web address",
		key: "Key",
		signIn: "Sign-in",
		signedIn: "Signed in",
		notSignedIn: "Not signed in",
		keySaved: "Saved",
		keyNone: "None",
		connection: "Connection",
		usedIn: "Rooms",
		runs: "Runs",
		runsHere: "On this computer, as you",
		runsHereRemote: "On the computer itself, as you",
		technicalDetails: "Technical details",
		copy: "Copy",
		copied: "Copied",
	},
	wentWrong: {
		busy: line("Its service couldn't accept the connection.", "Try again later."),
		noAnswer: line("It didn't answer in time.", "Check your internet connection, and that its address is right."),
		nothingThere: line("Nothing is answering at its address.", "If the address is right, try again later."),
		nameNotFound: line("Its web address wasn't found.", "Check it, and that this computer is online."),
		webPage: line("Its address leads to a web page, not a connector."),
		untrustedCertificate: line("This computer doesn't trust its address, so it wasn't used."),
		untrustedCertificateRemote: line("The computer itself doesn't trust its address, so it wasn't used."),
		addressNotFound: line("Its web address wasn't found.", "Change it to connect again."),
		addressRefused: line("Its service turned the connection down.", "If its address is wrong, change it; if it's right, ask whoever runs the service."),
		addressNotFoundElsewhere: line("Its web address wasn't found.", "Change it where it was added, or ask whoever added it."),
		addressRefusedElsewhere: line("Its service turned the connection down.", "Check its address where it was added, or ask whoever added it."),
		imported: (tool: string) => line(`Change its address in ${tool}.`),
		keyRefused: line("Its key was turned down.", "Change it to connect again."),
		keyFixed: line("Its key was turned down.", "Remove this connector and add it again with the new key."),
		keyRefusedElsewhere: line("Its key was turned down.", "Change it where it was added, or ask whoever added it."),
		importedKey: (tool: string) => line("Its key was turned down.", `Change it in ${tool}.`),
		...CONNECTOR_WORDS_REFUSED,
		turnedDown: line("Its service turned the connection down."),
		program: line("It didn't answer on this computer.", "Check its command, then try again."),
		programRemote: line("It didn't answer on the computer itself."),
		nodeMissing: line("It needs Node.js, which isn't on this computer."),
		nodeMissingRemote: line("It needs Node.js, which isn't on the computer itself."),
		uvMissing: line("It needs uv, which isn't on this computer."),
		uvMissingRemote: line("It needs uv, which isn't on the computer itself."),
		/** found: the name this computer has Python by; typed: the one its command says. */
		pythonOtherName: (found: string, typed: string) => line(`This computer has Python as "${found}", not "${typed}".`, `Remove this connector and add it again with ${found} in its command.`),
		pythonOtherNameRemote: (found: string, typed: string) => line(`The computer itself has Python as "${found}", not "${typed}".`),
		programMissing: (program: string) => line(`The program "${program}" wasn't found on this computer.`, "Install it, or check the command."),
		programMissingRemote: (program: string) => line(`The program "${program}" wasn't found on the computer itself.`),
		programStopped: line("It stopped right after starting.", "Check its command, then try again."),
		programTooSlow: line("It took too long to start.", "Try again."),
		notAConnector: line("It started, but it isn't a connector.", "Check its command."),
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
			line(REFUSED_SIGN_IN, place === "app" ? CONNECTOR_WORDS_REFUSED.refusedImported(tool).way : CONNECTOR_WORDS_REFUSED.refused.way),
		refusedKeyInPlace: line(REFUSED_SIGN_IN, KEY_IN_PLACE),
		noSignIn: line("This connector doesn't offer a sign-in, so it likely works without one.", "Use Check connection to see."),
		/** One that takes its first key in place: a key is the other way in. */
		noSignInKey: line("This connector doesn't offer a sign-in.", KEY_IN_PLACE),
		/** It doesn't offer a sign-in, though its check found it wants one: only a key can help, where it was added. */
		wantsKey: (place: ConnectorPlace, tool: string) => {
			const words = CONNECTOR_WORDS_REFUSED;
			return line(WANTS_KEY, place === "app" ? words.refusedImported(tool).way : place === "file" ? words.refusedElsewhere.way : words.refused.way);
		},
		/** One added here by its address, which takes its key in place. */
		wantsKeyAdd: line(WANTS_KEY, KEY_IN_PLACE),
		declined: line("The service didn't give exxperts access.", "If you said no there by mistake, try again."),
		tooSlow: line("The sign-in took too long.", "Try again."),
		other: line("The sign-in didn't work.", "Try again."),
	},
	importedNote: (tool: string) => `Added in ${tool}. To remove it, remove it there.`,
	/** A row from a file says which, where a row from another app names the app; the file is shown as code between the parts. */
	addedInSharedFile: { before: "Added in the shared ", after: ", a file other apps can use." },
	addedInProjectFile: { before: "Added in ", after: "." },
	room: {
		empty: "Use Open connectors to add one, then enable it here.",
		/** In the settings look, where each connector has a switch, and the way to Settings, Connectors at its end. */
		lead: "Switch a connector on to use it in this room.",
		manage: "Manage connectors in Settings",
		gone: line(CONNECTOR_REQUEST_LINES.noLongerExists, "Unless you remove it here, this room can use any connector added later with the same name."),
		removeTitle: "Only this room stops using it.",
		removeGoneTitle: "Take it off this room's list.",
		/** Over a connector's old yeses, which count only in this room until a choice is picked for the tool. */
		allowedHere: "Allowed without asking in this room:",
		/** The same words as the title of their own section in the settings look. */
		allowedHereTitle: "Allowed without asking in this room",
		archived: "This room is archived, so its connectors can't be changed.",
		loadFailed: "Couldn't load this room's connectors.",
		badName: (tool: string | null) =>
			`This connector can't be turned on in a room because of its name. Rename it ${tool ? `in ${tool}` : "where it was added"}, using only letters, digits and dashes.`,
	},
	/** Under a row getting ready, where the status has room for its first words only. */
	gettingReadyNote: "The first time can take a few minutes.",
	addressSaved: "Saved. Rooms use the new address the next time you open them.",
	keySaved: "Saved. Rooms use the new key the next time you open them.",

	tools: {
		title: "Tools",
		readOnly: "Read-only tools",
		change: "Tools that may change things",
		notChecked: "Its tools show here once you check its connection.",
		notConnected: "Its tools show here once it connects.",
		none: "It has no tools.",
		/** Above the tools, where each one's choice is shown. */
		applies: "Your choices count in every room where this connector is on, also when you're away. A room on Auto with protection off never asks.",
		/** Where the choices can't be read, by why; only the first offers the reset. */
		unreadable: {
			"cannot-read": "Your choices for connector tools can't be read, so every tool asks first.",
			newer: "Your choices for connector tools are from a newer version of exxperts, so every tool asks first. Update exxperts to use them.",
		} satisfies Record<NonNullable<McpConnectorStatus["choicesUnreadable"]>, string>,
		reset: RESET_CHOICES,
		resetQuestion: "Reset your choices for every connector?",
		resetConsequence: "Every tool of every connector goes back to its default, so a tool you blocked is no longer blocked.",
		choices: CONNECTOR_CHOICE_WORDS,
		useDefault: "Use default",
		/** A tool's line when a save's answer and the read after it were both lost: what is saved can't be told, so no choice shows. */
		unsure: "Couldn't check whether your change was saved.",
		/** The control's name, for a screen reader: the tool and what it may do now. */
		choiceLabel: (tool: string, choice: string) => `${tool}: ${choice}`,
	},

	remove: {
		title: "Remove connector",
		line: "Removes it from exxperts. Rooms that use it stop using it.",
		failed: "Couldn't remove it. Try again.",
	},
	removeQuestion: (name: string) => `Remove ${name}?`,
	removeRooms: (rooms: readonly string[]) => `${namesInLine(rooms)} ${rooms.length === 1 ? "stops" : "stop"} using it.`,
	removeCustomUnused: "To add it back, you need its web address.",
	removeProgramUnused: "To add it back, you need its command.",
	removeSharedFile: "Other apps on this computer that use it lose it too.",

	addedFromDirectory: (name: string) => `${name} added. Connect it on its row above.`,
	addedCustom: (name: string) => `${name} added. Switch it on in each room that should use it.`,

	directoryTags: {
		oauth: "Sign in",
		open: "No sign-in",
		token: "Needs a key",
	} satisfies Record<ConnectorDirectoryEntry["kind"], string>,
	directoryAdd: (entry: Pick<ConnectorDirectoryEntry, "name" | "kind">) => (entry.kind === "token" ? `Add ${entry.name} with a key` : `Add ${entry.name}`),
	directoryKeyPlaceholder: "Key",
	directoryNoMatch: "No matches. Use Add connector to add one by its web address.",

	form: {
		webTitle: "Add by web address",
		programTitle: "Add a program on this computer",
		name: "Name",
		namePlaceholder: "Team wiki",
		address: "Web address",
		addressPlaceholder: "https://wiki.example.com/mcp",
		more: "A key, headers or your own sign-in app",
		key: "Key (only if the service gave you one)",
		signInApp: "Your own sign-in app",
		signInAppHint: { before: "Some services, like HubSpot, need an app you create in their developer settings. Give it this redirect URL ", after: ", then paste its Client ID and secret here." },
		clientId: "Client ID",
		clientSecret: "Client secret (if the service gave you one)",
		scopes: "Scopes (optional, separated by spaces)",
		headers: "Extra headers",
		headersHint: { before: "Sent to the service each time exxperts connects, for example ", example: "X-Api-Key", after: " with your key. A header named Authorization, or with token, secret or API key in its name, counts as the sign-in, so this connector won't ask you to sign in." },
		headerName: (n: number) => `Header ${n} name`,
		headerValue: (n: number) => `Header ${n} value`,
		removeHeader: (n: number) => `Remove header ${n}`,
		addHeader: "Add another header",
		command: "Command",
		commandHint: "Copy it from the connector's setup instructions.",
		settings: "Settings it needs (optional)",
		settingName: (n: number) => `Setting ${n} name`,
		settingValue: (n: number) => `Setting ${n} value`,
		removeSetting: (n: number) => `Remove setting ${n}`,
		addSetting: "Add another setting",
		signInLater: "If it needs a sign-in, you'll see Connect on its row.",
		/** host: where the typed address leads, or null before it reads as one. */
		trustWeb: (host: string | null) => `Add only connectors you trust. What a room sends goes to ${host ?? "its web address"}, and what comes back can change what the assistant does.`,
		trustProgram: "It runs on this computer as you, outside the rooms' protection: it can open your files and reach the internet. Add it only if you trust where it came from.",
		programChecked: "Add starts it once to check that it works.",
		add: "Add",
		adding: "Adding…",
		cancel: "Cancel",
		headerNoValue: (header: string) => `The ${header} header needs a value.`,
		headerTwice: (header: string) => `The ${header} header is listed twice.`,
	},
} as const;

/** The line after adding from the directory: Connect is the next step only for one that signs in, as the rest connect by themselves. */
export function addedNotice(entry: Pick<ConnectorDirectoryEntry, "name" | "kind">): string {
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

const addedFrom = (server: Pick<McpConnectorStatus, "name" | "target">) => (entry: ConnectorCatalogEntry) => entry.id === server.name || (entry.url !== undefined && entry.url === server.target);

/** The known app a connector was added from, the directory's or one that left it: its icon and description. */
export function catalogEntryOf(server: Pick<McpConnectorStatus, "name" | "target">): ConnectorCatalogEntry | undefined {
	return CONNECTOR_CATALOG.find(addedFrom(server));
}

/** The directory's entry for a connector added from it, which the directory can add again. */
function directoryEntryOf(server: Pick<McpConnectorStatus, "name" | "target">): ConnectorDirectoryEntry | undefined {
	return CONNECTOR_DIRECTORY.find(addedFrom(server));
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
 * Why a check failed without a connector turning it down: "busy" a status the
 * same check later may get past; "nothing-there" nothing listening at its
 * address; "name-not-found" its name not found, which may be the address or
 * the network; "web-page" an ordinary web page answered; "untrusted-certificate"
 * its certificate isn't one this computer trusts; "no-answer" no status and no
 * other sign (nothing answered in time, or something else that isn't a
 * connector did, which a check can't tell apart), which may be the network.
 */
export type CantConnectNowCause = "busy" | "no-answer" | ConnectorReach;

/** The one state a connector's row is in. Its words, dot, button and menu all follow from it. */
export type RowState =
	/** noSignIn: a sign-in pressed here found none on offer, and it still connects. */
	| { kind: "connected"; noSignIn?: true }
	| { kind: "not-connected" }
	| { kind: "needs-reconnecting" }
	| { kind: "cant-connect-now"; cause: CantConnectNowCause; check: McpConnectorCheck }
	| { kind: "cant-connect"; cause: CantConnectCause; check: McpConnectorCheck }
	| { kind: "program" }
	| { kind: "cant-start"; room: string }
	| { kind: "program-failed"; failure: ProgramStartFailure; check: McpConnectorCheck }
	| { kind: "checking" }
	| { kind: "getting-ready" }
	| { kind: "signing-in" }
	| { kind: "sign-in-failed"; error?: string; cause?: McpLoginFailure; detail?: string; checkWantsSignIn?: boolean };

/** A finished check, in the shape the server keeps it. */
export function checkOf(result: { ok: boolean; needsAuth?: boolean; httpStatus?: number; reach?: ConnectorReach; error?: string; startRefused?: McpConnectorCheck["startRefused"]; programFailure?: ProgramStartFailure }): McpConnectorCheck {
	return { at: Date.now(), ok: result.ok, ...(result.needsAuth ? { needsAuth: true } : {}), ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }), ...(result.reach ? { reach: result.reach } : {}), ...(result.error ? { error: result.error } : {}), ...(result.startRefused ? { startRefused: result.startRefused } : {}), ...(result.programFailure ? { programFailure: result.programFailure } : {}) };
}

/**
 * What the person is doing on the row right now, or a check the page runs on
 * it; null when nothing is under way. "getting-ready": the check of a program
 * that fetches what it runs at its first start, still running after a few
 * seconds, which the person can stop.
 */
export type RowActivity = { kind: "checking" } | { kind: "getting-ready" } | { kind: "signing-in" } | { kind: "sign-in-failed"; error?: string; cause?: McpLoginFailure; detail?: string } | null;

/** A sign-in the person said no to, the service was too busy for, that ran too long, failed for a reason not known, or never got an answer may finish on a second try. */
export const signInMayWork = (cause: McpLoginFailure | undefined) => cause === undefined || cause === "declined" || cause === "busy" || cause === "too-slow" || cause === "other";

function failedCheckState(server: McpConnectorStatus, check: McpConnectorCheck): RowState {
	if (server.transport !== "http") return check.programFailure ? { kind: "program-failed", failure: check.programFailure, check } : { kind: "cant-connect", cause: "program", check };
	const status = check.httpStatus;
	if (status === undefined) return { kind: "cant-connect-now", cause: check.reach ?? "no-answer", check };
	if (isPassingStatus(status)) return { kind: "cant-connect-now", cause: "busy", check };
	if (status === 401 || status === 403) return { kind: "cant-connect", cause: server.key === "none" ? "refused" : "key-refused", check };
	// An address the directory set, on a connector added here, is not the person's to change.
	if (directoryEntryOf(server) && connectorPlace(server) === "here") return { kind: "cant-connect", cause: "turned-down", check };
	return { kind: "cant-connect", cause: status === 404 || status === 410 ? "address-not-found" : "address-refused", check };
}

/**
 * The row's state from what is known: what the person is doing on it, else
 * the newest check (this page's, else the one the server kept), else the
 * saved sign-in and tools. A program is never started to find out.
 */
export function connectorRowState(server: McpConnectorStatus, check: McpConnectorCheck | null, activity: RowActivity): RowState {
	if (activity?.kind === "sign-in-failed" && activity.cause === "no-sign-in") {
		// One that still connects stays connected: only the sign-in it doesn't offer is said, beside its row.
		if (!check?.needsAuth && connectorRowState(server, check, null).kind === "connected") return { kind: "connected", noSignIn: true };
		// Where the newest check was asked for one: only a key can help.
		return { ...activity, checkWantsSignIn: check?.needsAuth === true };
	}
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
	return !CONNECTOR_DIRECTORY.some((entry) => entry.kind === "open" && entry.url === server.target);
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
	return server.auth.explicit || directoryEntryOf(server)?.kind === "oauth";
}

export type DotLook = "ok" | "wait" | "warn" | "err" | "ring" | "busy";

/** How the row reads: its status words, its dot, whether the words take the body colour, and its one button. */
/** The one button a row can show. */
export type RowButton = "connect" | "reconnect" | "tryAgain" | "cancel" | "checkConnection";

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
			// It answered, but not as a connector, or wasn't used: trying again finds the same, and its address is the way on.
			if (state.cause === "web-page" || state.cause === "untrusted-certificate") return { status: words.cantConnect, dot: "err", broken: true, button: null };
			return { status: state.cause === "busy" ? words.cantConnectNow : state.cause === "name-not-found" ? words.addressNotFound : words.notAnswering, dot: "err", broken: true, button: "tryAgain" };
		case "cant-connect":
			return { status: words.cantConnect, dot: "err", broken: true, button: null };
		case "program":
			return { status: remote ? words.programRemote : words.program, dot: "ring", broken: false, button: null };
		case "cant-start":
			return { status: words.cantStart, dot: "err", broken: true, button: null };
		case "program-failed":
			if (state.failure.cause === "too-slow") return { status: words.notAnswering, dot: "err", broken: true, button: "tryAgain" };
			return { status: state.failure.cause === "not-a-connector" ? words.cantConnect : words.cantStart, dot: "err", broken: true, button: null };
		case "checking":
			return { status: words.checking, dot: "busy", broken: false, button: null };
		case "getting-ready":
			return { status: words.gettingReady, dot: "busy", broken: false, button: "cancel" };
		case "signing-in":
			return { status: words.signingIn, dot: "busy", broken: false, button: "cancel" };
		case "sign-in-failed":
			// A refusal, a service that needs its own sign-in app and one with no sign-in fail the same way twice.
			return signInMayWork(state.cause) ? { status: words.signInFailed, dot: "err", broken: true, button: "tryAgain" } : { status: words.cantSignIn, dot: "err", broken: true, button: null };
	}
}

/** The button beside the line under "What went wrong"; "installNode" and "installUv" are links to the runtime's install page. */
export type WentWrongButton = "changeAddress" | "changeKey" | "tryAgain" | "remove" | "installNode" | "installUv";

/** Each runtime a connector program needs: its lines when it is missing, and the link to where it is installed from. */
const RUNTIME_MISSING: Record<ConnectorRuntime, { here: TwoPartLine; remote: TwoPartLine; button: "installNode" | "installUv" }> = {
	node: { here: CONNECTOR_WORDS.wentWrong.nodeMissing, remote: CONNECTOR_WORDS.wentWrong.nodeMissingRemote, button: "installNode" },
	uv: { here: CONNECTOR_WORDS.wentWrong.uvMissing, remote: CONNECTOR_WORDS.wentWrong.uvMissingRemote, button: "installUv" },
};

/** Where each runtime's install link leads. */
export const RUNTIME_INSTALL_URL: Record<"installNode" | "installUv", string> = {
	installNode: "https://nodejs.org/en/download",
	installUv: "https://docs.astral.sh/uv/getting-started/installation/",
};

/** remote: over remote access; place: where it was added, as a way on that removes it is taken only here. */
function programFailedLine(failure: ProgramStartFailure, remote: boolean, place: ConnectorPlace): { line: TwoPartLine; button: WentWrongButton | null } {
	const words = CONNECTOR_WORDS.wentWrong;
	switch (failure.cause) {
		case "runtime-missing": {
			const runtime = RUNTIME_MISSING[failure.runtime];
			return remote ? { line: runtime.remote, button: null } : { line: runtime.here, button: runtime.button };
		}
		case "python-is-python3": {
			const typed = failure.found === "python" ? "python3" : "python";
			if (remote) return { line: words.pythonOtherNameRemote(failure.found, typed), button: null };
			const said = words.pythonOtherName(failure.found, typed);
			return place !== "here" ? { line: line(said.fact), button: null } : { line: said, button: "remove" };
		}
		case "not-found":
			return remote ? { line: words.programMissingRemote(failure.program), button: null } : { line: words.programMissing(failure.program), button: "tryAgain" };
		case "stopped":
			return { line: words.programStopped, button: remote ? null : "tryAgain" };
		case "too-slow":
			// Its Try again sits beside the status, as for any connector that isn't answering.
			return { line: words.programTooSlow, button: null };
		case "not-a-connector":
			return { line: words.notAConnector, button: null };
	}
}

/**
 * One added here by its address, with no key, not set to sign in on purpose
 * and with no sign-in stored: Change key takes its first key in place, where
 * Add would have kept it. A stored sign-in is left by Disconnect first, as a
 * first key would leave it on disk. A shared server shows no connector list,
 * and its server refuses a first key.
 */
function takesFirstKey(server: McpConnectorStatus): boolean {
	return connectorPlace(server) === "here" && isCustom(server) && server.editable && server.key === "none" && !server.auth.explicit && !server.auth.hasStoredTokens;
}

/**
 * The Key row on a web connector's page: Change key where its server takes a
 * key here (its one key in exxperts' own file, or a first one in place), else
 * the line that says where its key is changed. Null for a program, over
 * remote access, and for one with no key that can't take one here.
 */
export function keyRow(server: McpConnectorStatus, remote: boolean): { line: string | null; button: "changeKey" | null } | null {
	if (server.transport !== "http" || remote) return null;
	const place = connectorPlace(server);
	if (place === "here" && (server.key === "replaceable" || takesFirstKey(server))) return { line: null, button: "changeKey" };
	if (server.key === "none") return null;
	const words = CONNECTOR_WORDS.wentWrong;
	const said = place === "app" ? words.importedKey(importedFrom(server) ?? "") : place === "file" ? words.keyRefusedElsewhere : words.keyFixed;
	return { line: said.way, button: null };
}

/**
 * Sign in on a connected page: a service can list its tools to anyone and
 * still refuse a call, so one that may sign in through its service, with no
 * sign-in stored, offers it. Not where the directory says it needs none, nor
 * over remote access.
 */
export function signInOffered(server: McpConnectorStatus, state: RowState, remote: boolean): boolean {
	return !remote && state.kind === "connected" && !state.noSignIn && connectsBySignIn(server) && !server.auth.hasStoredTokens;
}

/** The Sign-in row's line once a sign-in pressed on a connected page found none on offer: a key where one goes in here, else none needed. */
export function noSignInLine(server: McpConnectorStatus, state: RowState): TwoPartLine | null {
	if (state.kind !== "connected" || !state.noSignIn) return null;
	return keyRow(server, false)?.button === "changeKey" ? CONNECTOR_WORDS.signInFailed.noSignInKey : CONNECTOR_WORDS.signInFailed.noSignIn;
}

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
	if (state.kind === "cant-connect-now") {
		switch (state.cause) {
			case "busy": return { line: words.busy, button: null };
			case "nothing-there": return { line: words.nothingThere, button: changeAddress };
			case "name-not-found": return { line: words.nameNotFound, button: changeAddress };
			case "web-page": return { line: words.webPage, button: changeAddress };
			case "untrusted-certificate": return { line: remote ? words.untrustedCertificateRemote : words.untrustedCertificate, button: changeAddress };
			case "no-answer": return { line: words.noAnswer, button: changeAddress };
		}
	}
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
				if (takesFirstKey(server)) return { line: words.refusedKeyInPlace, button: "changeKey" };
				return place === "here" ? { line: words.refused, button: "remove" } : { line: place === "app" ? words.refusedImported(tool) : words.refusedElsewhere, button: null };
			case "turned-down":
				return { line: words.turnedDown, button: null };
			case "program":
				return remote ? { line: words.programRemote, button: null } : { line: words.program, button: "tryAgain" };
		}
	}
	if (state.kind === "cant-start") return { line: words.cantStart(state.room), button: null };
	if (state.kind === "program-failed") return programFailedLine(state.failure, remote, place);
	if (state.kind === "sign-in-failed") {
		const failed = CONNECTOR_WORDS.signInFailed;
		switch (state.cause) {
			// Added here, the way on starts with removing this connector, which its button asks about.
			case "needs-own-app": return { line: failed.needsOwnApp(place, tool), button: place === "here" ? "remove" : null };
			case "refused":
				if (takesFirstKey(server)) return { line: failed.refusedKeyInPlace, button: "changeKey" };
				return { line: failed.refused(place, tool), button: place === "here" ? "remove" : null };
			case "busy": return { line: words.busy, button: null };
			case "no-sign-in":
				if (!state.checkWantsSignIn) return takesFirstKey(server) ? { line: failed.noSignInKey, button: "changeKey" } : { line: failed.noSignIn, button: null };
				// Its check found it wants one all the same: only a key can help.
				if (takesFirstKey(server)) return { line: failed.wantsKeyAdd, button: "changeKey" };
				return { line: failed.wantsKey(place, tool), button: place === "here" ? "remove" : null };
			case "declined": return { line: failed.declined, button: null };
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
	return (state.kind === "cant-connect-now" || state.kind === "cant-connect" || state.kind === "program-failed") && state.check.error ? state.check.error : null;
}

/** Something under way on the row: its own button stops it, and no other step starts meanwhile. */
export const isUnderWay = (state: RowState) => state.kind === "checking" || state.kind === "getting-ready" || state.kind === "signing-in";

/**
 * The row's one button: its state's own (Connect, Reconnect, Try again,
 * Cancel), else the fix its line under the status names, else Check
 * connection for a program never checked, which its page also offers. None
 * over remote access, where the page changes nothing.
 */
export function rowFix(server: McpConnectorStatus, state: RowState, readOnly: boolean): RowButton | WentWrongButton | null {
	if (readOnly) return null;
	return rowLook(state, readOnly).button ?? wentWrongLine(server, state, readOnly)?.button ?? (state.kind === "program" ? "checkConnection" : null);
}

/**
 * The row's line under its status, which every row keeps room for: what to do
 * while signing in or getting ready, else what went wrong, in its first part
 * only, as the row's button carries the way on, else a connected one's tool
 * count while it is known. Null for a row with nothing to say.
 */
export function rowNote(server: McpConnectorStatus, state: RowState, readOnly: boolean): string | null {
	if (state.kind === "signing-in") return CONNECTOR_WORDS.signingInNote;
	if (state.kind === "getting-ready") return CONNECTOR_WORDS.gettingReadyNote;
	// "Sign-in expired" says it all, with Reconnect beside it.
	if (state.kind === "needs-reconnecting") return null;
	if (state.kind === "connected") return server.tools ? CONNECTOR_WORDS.toolCount(server.tools.count) : null;
	return wentWrongLine(server, state, readOnly)?.line.fact ?? null;
}

/** Signed in through its service, so Disconnect can sign it out. */
export const isSignedIn = (server: McpConnectorStatus) => server.auth.mode === "oauth" && server.auth.hasStoredTokens;

/** Removed here; one brought in from another app is removed there. */
export const removableHere = (server: McpConnectorStatus) => !importedFrom(server);

/**
 * Where a tool's choice comes from: the person picked it; nothing is chosen,
 * so it shows what it does by default as of the last check; its entry
 * switches it off by hand; or the choices couldn't be read, so it asks. Only
 * the first two get a control.
 */
export type ToolChoiceSource = "chosen" | "default" | "excluded" | "unknown";

/** A tool as its connector's page lists it, with what it may do now. */
export interface ToolLine {
	name: string;
	title: string;
	description: string | null;
	choice: ConnectorToolChoice;
	source: ToolChoiceSource;
}

/**
 * The connector's tools in its page's two groups, each in the connector's own
 * order: read-only, as its saved tool list marks it by the rule the room's
 * gate uses, then what a room can call to read its resources, and the rest, a
 * tool with no mark included. Each with its choice: the person's, else its
 * default by those marks; where the choices couldn't be read, every tool
 * asks. Null for one never checked.
 */
export function toolGroups(server: Pick<McpConnectorStatus, "name" | "tools" | "choices" | "choicesUnreadable">): { readOnly: ToolLine[]; change: ToolLine[] } | null {
	const tools = server.tools;
	if (!tools) return null;
	const readOnly = new Set([...tools.readOnly, ...(tools.resources ?? [])]);
	const excluded = new Set(tools.excluded ?? []);
	const chosen = server.choices ?? {};
	const line = (name: string): ToolLine => {
		const base = { name, title: toolTitle(server, name), description: tools.descriptions[name] ?? null };
		if (excluded.has(name)) return { ...base, choice: "blocked", source: "excluded" };
		if (server.choicesUnreadable) return { ...base, choice: "ask", source: "unknown" };
		if (Object.hasOwn(chosen, name)) return { ...base, choice: chosen[name], source: "chosen" };
		return { ...base, choice: readOnly.has(name) ? "allow" : "ask", source: "default" };
	};
	const lines = [...tools.names, ...(tools.resources ?? [])].map(line);
	return { readOnly: lines.filter((tool) => readOnly.has(tool.name)), change: lines.filter((tool) => !readOnly.has(tool.name)) };
}

/** Added by address or command, not from the directory and not imported. */
export function isCustom(server: McpConnectorStatus): boolean {
	return !directoryEntryOf(server) && !importedFrom(server);
}

/**
 * The remove question's body: the rooms that stop using it, what adding it
 * back takes (one from the directory is added there again), and the other
 * apps that lose it; null when none applies.
 */
export function removeConsequence(server: McpConnectorStatus, rooms: readonly McpConnectorRoomUse[] | null): string | null {
	const lines = [
		rooms && rooms.length > 0 ? CONNECTOR_WORDS.removeRooms(rooms.map((room) => room.name)) : null,
		!isCustom(server) ? null : server.transport === "http" ? CONNECTOR_WORDS.removeCustomUnused : CONNECTOR_WORDS.removeProgramUnused,
		// Remove deletes it from every file that names it, a file other apps read included.
		server.inSharedFile ? CONNECTOR_WORDS.removeSharedFile : null,
	].filter((line): line is string => line !== null);
	return lines.length > 0 ? lines.join(" ") : null;
}
