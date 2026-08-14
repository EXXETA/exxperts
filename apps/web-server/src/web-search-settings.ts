import fs from "node:fs";
import path from "node:path";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";
import { resolveWebSearchSettings, type WebSearchSettings } from "../../../pi-package/extensions/web-search/index.js";

/**
 * The app's own web search, as a setting somebody can see and change.
 *
 * The file this reads and writes, ~/.exxperts/app/web-search.json, is not new:
 * the terminal setup command has been writing it since SearXNG became an
 * option, and the search tool has been reading it ever since. What was missing
 * was any way to know it existed. So the shape stays exactly what the setup
 * command writes, {provider, baseUrl}, and both writers stay interchangeable:
 * the screen can change what the command set up, and the command can change
 * what the screen set up, and neither has to know about the other.
 *
 * Resolution lives with the tool that has to obey it, so there is one answer to
 * "what will the next search do" rather than two that can drift.
 */

const FILE_NAME = "web-search.json";

export class WebSearchSettingsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WebSearchSettingsError";
	}
}

/** The file exists and cannot be understood. Not the caller's fault, so not a 400. */
export class WebSearchSettingsUnreadableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WebSearchSettingsUnreadableError";
	}
}

export function readWebSearchSettings(): WebSearchSettings {
	return resolveWebSearchSettings();
}

/**
 * A SearXNG base URL as typed. It has to be an absolute http(s) URL because the
 * tool concatenates "/search" onto it and hands the result to fetch: anything
 * else fails later, at search time, as an error nobody can act on.
 */
function normalizeSearxngBaseUrl(value: unknown): string {
	const text = String(value ?? "").trim();
	if (!text) throw new WebSearchSettingsError("Enter the address of your SearXNG instance, for example http://localhost:8080.");
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		throw new WebSearchSettingsError(`Not a valid address: ${text}. It should look like http://localhost:8080.`);
	}
	if (!/^https?:$/.test(parsed.protocol)) throw new WebSearchSettingsError("The SearXNG address must start with http:// or https://.");
	return parsed.href.replace(/\/+$/, "");
}

/**
 * Save what was changed and hand back what the next search will actually do.
 *
 * A patch rather than a whole document, because the pane holds two independent
 * decisions now: which local backend runs, and whether the two subscription
 * profiles are allowed to search on their own side. Flipping the toggle must
 * not restate the backend choice, and picking a backend must not restate the
 * toggle. The saved file is only half the answer whenever an environment
 * variable is set, which is why this returns the resolved settings rather than
 * what it wrote.
 */
export function writeWebSearchSettings(patch: { provider?: unknown; baseUrl?: unknown; providerSearch?: unknown }): WebSearchSettings {
	const current = resolveWebSearchSettings();
	// A save seeded from a file we could not read would quietly delete whatever
	// it says. Refuse until somebody repairs it, the same way the gateway store
	// refuses rather than treating an unreadable file as an empty one.
	if (current.unreadable) {
		throw new WebSearchSettingsUnreadableError(
			`The web search settings file ${current.unreadable}. Refusing to save, because saving now would replace settings that cannot be read. Repair or delete ${productAppStatePath(FILE_NAME)} and try again.`,
		);
	}
	const saved = current.saved;

	let chosen = saved.provider;
	if (patch.provider !== undefined) {
		const requested = String(patch.provider ?? "").trim().toLowerCase();
		if (requested !== "duckduckgo" && requested !== "searxng" && requested !== "disabled") {
			throw new WebSearchSettingsError(`Unknown search setting: ${requested || "(empty)"}.`);
		}
		chosen = requested;
	}

	// The address is kept when the choice moves away from SearXNG: somebody
	// switching off for an afternoon should not have to find their instance
	// again to switch back on. It is only validated when it is the address
	// SearXNG is about to be used at, so a stale or half-typed one cannot stand
	// between somebody and turning search off. An explicit empty string is the
	// one way to say "forget it".
	let nextBaseUrl = saved.baseUrl;
	if (patch.baseUrl !== undefined) {
		const requested = String(patch.baseUrl ?? "").trim();
		if (!requested) nextBaseUrl = undefined;
		else if (chosen === "searxng") nextBaseUrl = normalizeSearxngBaseUrl(requested);
		else nextBaseUrl = requested;
	}
	if (chosen === "searxng") nextBaseUrl = normalizeSearxngBaseUrl(nextBaseUrl);

	let nextProviderSearch = saved.providerSearch;
	if (patch.providerSearch !== undefined) {
		if (typeof patch.providerSearch !== "boolean") {
			throw new WebSearchSettingsError("Provider search must be on or off.");
		}
		nextProviderSearch = patch.providerSearch;
	}

	const filePath = productAppStatePath(FILE_NAME);
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	const document = {
		...(chosen ? { provider: chosen } : {}),
		...(nextBaseUrl ? { baseUrl: nextBaseUrl } : {}),
		...(nextProviderSearch !== undefined ? { providerSearch: nextProviderSearch } : {}),
	};
	fs.writeFileSync(tmpPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmpPath, filePath);

	// No cache to clear: the tool reads this file on every search, and rooms
	// re-read it per turn, so the next one already obeys the new answer.
	return resolveWebSearchSettings();
}
