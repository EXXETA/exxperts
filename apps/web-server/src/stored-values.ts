// Which stored values a shared server keeps sealed, and the place each one is
// sealed for: the one list, walked by the server (index.ts, mcp-admin.ts,
// mcp-status.ts) and by a shared server's start and its operator's programs,
// so none of them holds its own list of fields. The codec itself comes from
// the storedValues slot (server-hooks.ts); without one, as on the desktop,
// every value is stored as typed and nothing here changes a byte.
//
// The places (a value sealed for one place opens at no other):
// - auth.json: ["auth.json", <provider id>, "key"], the key of each api_key entry;
// - mcp.json, each connector by name, under mcpServers or mcp-servers:
//   ["mcp.json", <name>, "url"]; ["mcp.json", <name>, "bearerToken", <origin>];
//   ["mcp.json", <name>, "headers", <header name>, <origin>] for each header
//   with a value; ["mcp.json", <name>, "oauth", "clientSecret", <origin>].
//   <origin> is the opened address's origin, or "" without an address, so a
//   token or a header moved to another host opens nowhere.
//
// Imports nothing but types, so a shared server's start and its operator's
// programs can carry it.
import type { StoredValueCodec } from "./server-hooks.js";

type Json = Record<string, unknown>;
export type StoredPlace = readonly string[];
type Each = (value: string, place: StoredPlace) => string;

const AUTH = "auth.json";
const CONNECTORS = "mcp.json";
const CONNECTOR_SECTIONS = ["mcpServers", "mcp-servers"] as const;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function originOf(url: unknown): string {
	if (typeof url !== "string") return "";
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}

/** auth.json's root with the key of each api_key entry passed through each; every other entry as it is. */
export function mapAuthFile(root: Json, each: Each): Json {
	const out: Json = {};
	for (const [provider, entry] of Object.entries(root)) {
		out[provider] = isRecord(entry) && entry.type === "api_key" && typeof entry.key === "string" ? { ...entry, key: each(entry.key, [AUTH, provider, "key"]) } : entry;
	}
	return out;
}

/**
 * One connector's entry with each stored value passed through each, the
 * address first: "open" takes the origin from the address each gives back,
 * "seal" from the address it is given. An empty header value is no value.
 */
export function mapConnectorEntry<T extends object>(name: string, entry: T, each: Each, direction: "open" | "seal"): T {
	const given = entry as Json;
	const out: Json = { ...given };
	let address: unknown = given.url;
	if (typeof given.url === "string") {
		out.url = each(given.url, [CONNECTORS, name, "url"]);
		if (direction === "open") address = out.url;
	}
	const origin = originOf(address);
	if (typeof given.bearerToken === "string") out.bearerToken = each(given.bearerToken, [CONNECTORS, name, "bearerToken", origin]);
	if (isRecord(given.headers)) {
		out.headers = Object.fromEntries(Object.entries(given.headers).map(([header, value]) => [header, typeof value === "string" && value !== "" ? each(value, [CONNECTORS, name, "headers", header, origin]) : value]));
	}
	if (isRecord(given.oauth) && typeof given.oauth.clientSecret === "string") {
		out.oauth = { ...given.oauth, clientSecret: each(given.oauth.clientSecret, [CONNECTORS, name, "oauth", "clientSecret", origin]) };
	}
	return out as T;
}

/** mcp.json's root with every connector's entry passed through mapConnectorEntry. */
export function mapConnectorFile(root: Json, each: Each, direction: "open" | "seal"): Json {
	const out: Json = { ...root };
	for (const section of CONNECTOR_SECTIONS) {
		const servers = root[section];
		if (!isRecord(servers)) continue;
		out[section] = Object.fromEntries(Object.entries(servers).map(([name, entry]) => [name, isRecord(entry) ? mapConnectorEntry(name, entry, each, direction) : entry]));
	}
	return out;
}

/** Each stored value of auth.json's or mcp.json's root, as stored, with its place; the connectors' origins read from the stored address. */
export function storedValuesOf(file: "auth.json" | "mcp.json", root: Json): { readonly value: string; readonly place: StoredPlace }[] {
	const found: { value: string; place: StoredPlace }[] = [];
	const note: Each = (value, place) => {
		found.push({ value, place });
		return value;
	};
	if (file === AUTH) mapAuthFile(root, note);
	else mapConnectorFile(root, note, "seal");
	return found;
}

/**
 * Whether auth.json's or mcp.json's root keeps its secrets only in the places
 * storedValuesOf walks: every auth.json entry an api_key entry with its key
 * (a sign-in's tokens are never sealed), and no connector a program or with an
 * env (whose values are never sealed). A file that does not is never taken
 * whole into a pack, however its walked values read.
 */
export function storesOnlySealablePlaces(file: "auth.json" | "mcp.json", root: Json): boolean {
	if (file === AUTH) return Object.values(root).every((entry) => isRecord(entry) && entry.type === "api_key" && typeof entry.key === "string");
	return connectorsOf(root).every(({ entry }) => entry.command === undefined && entry.env === undefined);
}

/** The connectors of mcp.json's root, by name, with the section each sits in. */
export function connectorsOf(root: Json): { readonly section: string; readonly name: string; readonly entry: Json }[] {
	const out: { section: string; name: string; entry: Json }[] = [];
	for (const section of CONNECTOR_SECTIONS) {
		const servers = root[section];
		if (!isRecord(servers)) continue;
		for (const [name, entry] of Object.entries(servers)) if (isRecord(entry)) out.push({ section, name, entry });
	}
	return out;
}

/**
 * A connector's entry with its values gone, for a lost key: its address,
 * token and sign-in client's secret removed, each header kept by name with an
 * empty value, everything else as it was (its name, kind, shown name, tool
 * settings).
 */
export function emptiedConnectorEntry(entry: Json): Json {
	const out: Json = { ...entry };
	delete out.url;
	delete out.bearerToken;
	if (isRecord(entry.headers)) out.headers = Object.fromEntries(Object.keys(entry.headers).map((header) => [header, ""]));
	if (isRecord(entry.oauth)) {
		const { clientSecret: _gone, ...oauth } = entry.oauth;
		out.oauth = oauth;
	}
	return out;
}

/** A shared server's connector that a lost key emptied: neither an address nor a command. */
export function connectorAddressGone(entry: { readonly url?: unknown; readonly command?: unknown }): boolean {
	return entry.url === undefined && entry.command === undefined;
}

// --- The server's codec, once index.ts adopts it ---------------------------

let adopted: StoredValueCodec | undefined;

function authText(text: string, each: Each): string {
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch {
		// Text that is not JSON goes to the runtime's own parse, which fails as before.
		return text;
	}
	return isRecord(root) ? JSON.stringify(mapAuthFile(root, each), null, 2) : text;
}

/**
 * Called once, by index.ts, with the storedValues slot's codec and the
 * runtime's setter for auth.json's text: auth.json then opens and seals in the
 * runtime, and the connector adapter opens a connector's values right before
 * it connects (scripts/patch-mcp-adapter.mjs, its global
 * exxpertsOpenConnectorEntry). A second call throws.
 */
export function adoptStoredValues(codec: StoredValueCodec, setAuthTextCodec: (codec: { readonly open: (stored: string) => string; readonly seal: (text: string) => string }) => void): void {
	if (adopted) throw new Error("the stored values are already adopted");
	adopted = codec;
	setAuthTextCodec({ open: (stored) => authText(stored, codec.open), seal: (text) => authText(text, codec.seal) });
	(globalThis as { exxpertsOpenConnectorEntry?: (name: string, entry: object) => object }).exxpertsOpenConnectorEntry = (name, entry) => mapConnectorEntry(name, entry, codec.open, "open");
}

/** The entry with every stored value opened; as given without a codec. Throws for a value that does not open. */
export function openedConnectorEntry<T extends object>(name: string, entry: T): T {
	return adopted ? mapConnectorEntry(name, entry, adopted.open, "open") : entry;
}

/**
 * The entry as it is stored: every value sealed, except one that stored
 * gives sealed at the same place with the same opened value, which keeps its
 * stored string, so an unchanged value reads the same to whoever compares it.
 * A stored value that does not open, or one stored as typed (it opens to
 * itself), is simply not kept, so the save seals it. As given without a
 * codec.
 */
export function sealedConnectorEntry<T extends object>(name: string, plain: T, stored?: object): T {
	const codec = adopted;
	if (!codec) return plain;
	const kept = new Map<string, { stored: string; opened: string }>();
	if (stored) {
		mapConnectorEntry(name, stored, (value, place) => {
			let opened: string;
			try {
				opened = codec.open(value, place);
			} catch {
				return value;
			}
			if (opened !== value) kept.set(JSON.stringify(place), { stored: value, opened });
			return opened;
		}, "open");
	}
	return mapConnectorEntry(name, plain, (value, place) => {
		const prior = kept.get(JSON.stringify(place));
		return prior && prior.opened === value ? prior.stored : codec.seal(value, place);
	}, "seal");
}
