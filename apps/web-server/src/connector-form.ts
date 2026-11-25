/**
 * The custom connector form's rules and sentences, in one place for the server
 * and the page. Browser-safe on purpose (no node imports): the page imports
 * these same functions and lines, so the two sides never word or judge a
 * connector differently.
 */

import { CONNECTOR_CATALOG } from "../../../pi-package/extensions/mcp/connector-catalog.js";
import { trimHumanText } from "./room-name.js";

/** What the form says when a field is wrong, one sentence each. */
export const CONNECTOR_FORM_LINES = {
	nameMissing: "Give it a name.",
	nameTooLong: "Keep the name to 64 characters.",
	nameTaken: (shownName: string) => `You already have a connector named "${shownName}". Pick another name.`,
	addressNotAnAddress: "Use the full address, starting with https://.",
	addressNotWeb: "The address must start with https:// or http://.",
	keyAndSignInApp: "Use the key or your own sign-in app, not both.",
	keyAndAuthorizationHeader: "Use only one of these: the key, your own sign-in app or an Authorization header.",
	clientIdMissing: "Add the Client ID from the service.",
	headerUnnamed: "Give each header a name.",
	tooManyHeaders: (max: number) => `A connector can have at most ${max} extra headers.`,
	headerHiddenCharacter: (header: string) => `The ${header} header's value contains a line break or another hidden character. Type it again by hand.`,
	anotherSiteKey: "On another site it keeps only its name and rooms, so enter its key again.",
	anotherSiteSignIn: "On another site it keeps only its name and rooms, so you'll sign in again.",
	anotherSiteKeyAndSignIn: "On another site it keeps only its name and rooms, so enter its key and sign in again.",
	cantMoveSite: "This connector can't move to another site here. Remove it, then add it again with the new address.",
	keyNotChangeable: "This key can't be changed here. Remove this connector and add it again with the new key.",
	addressNotChangeable: "This connector's address can't be changed here. Change it where it was added.",
} as const;

/** The connector page's button that starts the choices again from the defaults when they can't be read; the removal's refusal names it, as it shows on the list too. */
export const RESET_CHOICES = "Reset choices";

/** The connector routes' own sentences, shared by the server and the page's fallbacks for the same failure. */
export const CONNECTOR_REQUEST_LINES = {
	loadFailed: "Couldn't load your connectors.",
	saveFailed: "Couldn't save the change. Try again.",
	noLongerExists: "This connector no longer exists.",
	/** A tool choice saved for a connector that changed since the page showed it. */
	toolsChanged: "This connector changed, so nothing was saved. Check its tools and choose again.",
	notRemovable: (app: string | null) => (app ? `This connector can't be removed here. Remove it in ${app}.` : "This connector can't be removed here. Remove it where it was added."),
	/** The removal's line on the connector's own page, with Reset choices in it. */
	removeChoicesUnreadableBesideReset: "You can't remove it while your choices for connector tools can't be read. Reset them first.",
	/** A removal refused while the tool choices can't be read, by why (connector-tool-choices.ts); Reset choices is on the connector's page under Tools. */
	removeChoicesUnreadable: {
		"cannot-read": `You can't remove it while your choices for connector tools can't be read. Use ${RESET_CHOICES} on its page first.`,
		newer: "You can't remove it while your choices for connector tools are from a newer version of exxperts. Update exxperts first.",
	},
	/** Reset choices, refused: the choices can be read again, or a newer version wrote them. */
	choicesReadableAgain: "Your choices for connector tools can be read again, so nothing was reset.",
	choicesFromNewerVersion: "Your choices for connector tools are from a newer version of exxperts, so nothing was reset. Update exxperts to use them.",
	choicesResetFailed: "Couldn't reset your choices. Try again.",
	signInStillClosing: "An earlier sign-in is still closing. Try again in a few seconds.",
	signInStartFailed: "Couldn't start the sign-in. Try again.",
	signInCheckFailed: "Couldn't find out how the sign-in went. Try again.",
	disconnectFailed: "Couldn't disconnect. Try again.",
} as const;

/** The other apps a connector can be brought in from, as people know them; the adapter names them by these ids. */
const IMPORT_APP_NAMES: Record<string, string> = { cursor: "Cursor", "claude-code": "Claude Code", "claude-desktop": "Claude Desktop", codex: "Codex", windsurf: "Windsurf", vscode: "VS Code" };

/** The app a connector was brought in from, by the adapter's id for it; null for an id that names no app (the shared file). */
export function importAppName(kind: string | undefined): string | null {
	return kind ? (IMPORT_APP_NAMES[kind] ?? null) : null;
}

/**
 * A status a later try can get past: a timeout, "too early", too many
 * requests, the service's own error, or a gateway or the service being down
 * for now. A 501 or 505 never passes with waiting.
 */
export function isPassingStatus(status: number): boolean {
	return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

export const MAX_CONNECTOR_NAME_LENGTH = 64;

/**
 * Where a web connector keeps its key: "none"; "replaceable", one place a new
 * key can go (the token, or its one key header, beside its own sign-in app or
 * not); "fixed", more than one (two key headers, a token beside a key header
 * or a sign-in app), where a new key couldn't tell which one it replaces.
 */
export type ConnectorKey = "none" | "replaceable" | "fixed";

/** The name a person typed, as it is kept and shown: one space between words, nothing invisible at either end. */
export function connectorDisplayName(typed: string): string {
	return trimHumanText(typed);
}

/**
 * The name a person sees for a connector: the directory's own name, else the
 * name they typed when they added it, else the fixed name as it was typed
 * before connectors had a display name.
 */
export function connectorShownName(name: string, displayName?: string | null): string {
	const fromDirectory = CONNECTOR_CATALOG.find((entry) => entry.id === name)?.name;
	return fromDirectory ?? (displayName || name);
}

/**
 * A connector name a room can be given access to. The fixed name made here
 * always is one; a name written by hand or brought in from another app (with
 * a space or a dot) may not be, and rooms refuse it.
 */
export function isValidMcpConnectorName(name: unknown): name is string {
	return typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name);
}

/**
 * The fixed name exxperts keeps for a connector, made from the name a person
 * typed: lower case, spaces as dashes, only letters, digits, dashes and
 * underscores. It never changes, because room access and the saved sign-in
 * are kept under it. `taken` is checked without case, and a number is added
 * until the name is free.
 */
export function connectorFixedName(displayName: string, taken: ReadonlySet<string>): string {
	const base =
		displayName
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/\s+/g, "-")
			.replace(/[^a-z0-9_-]/g, "")
			.replace(/-{2,}/g, "-")
			.replace(/^[-_]+|[-_]+$/g, "")
			.slice(0, 56) || "connector";
	const lowerTaken = new Set([...taken].map((name) => name.toLowerCase()));
	if (!lowerTaken.has(base)) return base;
	for (let n = 2; ; n++) {
		const next = `${base}-${n}`;
		if (!lowerTaken.has(next)) return next;
	}
}

/** The address a person typed, read as a web address, or the form's sentence for what is wrong with it. */
export function readConnectorAddress(typed: string): { url: string } | { error: string } {
	let parsed: URL;
	try {
		parsed = new URL(typed.trim());
	} catch {
		return { error: CONNECTOR_FORM_LINES.addressNotAnAddress };
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { error: CONNECTOR_FORM_LINES.addressNotWeb };
	return { url: typed.trim() };
}

/**
 * Two addresses on the same site: the same scheme, host and port. A changed
 * address keeps the saved sign-in and key only then; on another site they
 * would go to whoever answers there.
 */
export function sameConnectorSite(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return false;
	}
}
