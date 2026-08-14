import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage, getAgentDir, type ExtensionAPI } from "@exxeta/exxperts-runtime";
import { resolveWebSearchSettings } from "./index.js";

/**
 * Search the model runs itself, on the provider's own infrastructure.
 *
 * The two subscription profiles both offer it, and both already charge for it,
 * so a room on Claude or ChatGPT asking the app to go and scrape DuckDuckGo was
 * the worse search and the slower one. Declaring the provider's own search tool
 * lets the model look things up while it is answering, with nothing running on
 * this machine.
 *
 * This rides the before_provider_request seam rather than the provider layer,
 * so the runtime needs no changes at all: the payload is already built and on
 * its way out, and all that happens here is one more tool on it.
 *
 * Deliberately only these two providers. The gateway and API-key paths are
 * somebody else's endpoint with somebody else's billing, and a model there says
 * whether it searches through its own per-model flag instead.
 */

/** Anthropic's server tool, versioned by them. Named web_search on their side too, which is the whole reason the client tool has to stand down. */
const ANTHROPIC_WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 8 } as const;
/** The Codex surface takes the bare declaration and picks its own limits. */
const CODEX_WEB_SEARCH_TOOL = { type: "web_search" } as const;

/**
 * The provider ids that search for themselves: exactly the two built-in
 * subscription profiles. Matched by provider id rather than by API shape,
 * because the same Anthropic API shape is also what a company gateway speaks,
 * and that gateway has no server-side search behind it.
 */
export const NATIVE_SEARCH_PROVIDER_IDS = ["anthropic", "openai-codex"] as const;

export type NativeSearchProviderId = (typeof NATIVE_SEARCH_PROVIDER_IDS)[number];

export function isNativeSearchProvider(providerId: string | undefined): providerId is NativeSearchProviderId {
	return !!providerId && (NATIVE_SEARCH_PROVIDER_IDS as readonly string[]).includes(providerId);
}

/**
 * Anthropic's provider id covers two different customers. A subscription
 * sign-in is OAuth and the search is included in what it already pays for; an
 * API key is metered, and server-side search is billed per thousand searches
 * on top of tokens. Turning that on for somebody who typed in an API key would
 * be spending their money on their behalf, quietly, because of a default. So
 * the API-key path is treated like any other provider: it keeps the app's own
 * search and gets no declaration. The Codex surface needs no such check; it
 * only exists as a subscription.
 *
 * Answers true, false, or null when the question could not be asked. That third
 * answer matters at the one call site that compares this against a value
 * captured earlier: a missing credential and an API key are real answers, but a
 * store that failed to read is not, and treating a hiccup as "they switched to
 * an API key" would rebuild a live session and throw away its warm cache.
 */
function anthropicIsSubscriptionSignIn(): boolean | null {
	try {
		const credential = AuthStorage.create().get("anthropic");
		if (credential) return credential.type === "oauth";
		// No credential in hand, which the store reports the same way whether
		// nobody ever signed in or the file could not be read this time: a failed
		// load leaves it empty and records the error privately. Those are very
		// different answers here, so the file itself is asked. Absent is a real
		// answer. Present and unparseable is a question we could not ask, and
		// must not be mistaken for somebody switching to an API key.
		const authPath = path.join(getAgentDir(), "auth.json");
		if (!fs.existsSync(authPath)) return false;
		try {
			JSON.parse(fs.readFileSync(authPath, "utf-8"));
		} catch {
			return null;
		}
		return false;
	} catch {
		return null;
	}
}

/**
 * Everything about native search this session is going to do, decided once.
 *
 * This is deliberately a decision rather than a question you can keep asking.
 * Which web_search a session offers is fixed when it binds, because the tool
 * registry is; if the transform re-read the setting per request, a save landing
 * mid-turn would leave the rest of that turn with a registered tool the request
 * no longer declares, or with neither. A turn, and in fact a whole binding,
 * runs under one rule. Changes reach the room through the rebind that happens
 * before the next turn.
 */
export type NativeProviderSearchDecision = {
	active: boolean;
	/** Only set when active, and only ever one of the two ids. */
	providerId?: NativeSearchProviderId;
	/**
	 * Set when the credential store could not be read, so the `active` above is
	 * the safe guess rather than the answer, and a caller comparing this against
	 * an earlier decision should keep the earlier one.
	 *
	 * Only the credential read gets this treatment, and the difference is worth
	 * being precise about. A credential store that failed to open says nothing
	 * about how somebody signs in; treating a hiccup as "they switched to an API
	 * key" would rebuild a live session and throw away its warm cache for no
	 * reason. An unreadable settings file is not the same kind of silence: that
	 * file is where somebody turns provider search OFF, and the whole point of
	 * failing closed there is that a machine which configured something and can
	 * no longer be read must not keep sending queries out to a provider on the
	 * strength of a stale in-memory decision. So that one is a hard answer, it
	 * does flip a bound session, and the rebind is exactly what should happen.
	 */
	indeterminate?: boolean;
};

export function resolveNativeProviderSearchDecision(providerId: string | undefined): NativeProviderSearchDecision {
	if (!isNativeSearchProvider(providerId)) return { active: false };
	if (providerId === "anthropic") {
		const subscription = anthropicIsSubscriptionSignIn();
		// Safe guess at bind time, but flagged, so nothing downstream mistakes a
		// failed read for somebody changing how they sign in.
		if (subscription === null) return { active: false, indeterminate: true };
		if (!subscription) return { active: false };
	}
	// Deliberately NOT flagged: unreadable settings are a hard no, and a session
	// already running under a yes should be rebuilt to stop searching.
	if (!resolveWebSearchSettings().providerSearch) return { active: false };
	return { active: true, providerId };
}

/**
 * Whether this session should register the room's own web_search tool.
 *
 * The single rule, in one place, because the live room and the background
 * runner have to answer it identically: a room whose model searches for itself
 * does not also carry a local searcher of the same name. Registration is what
 * decides availability, so this is where the client tool actually stands down.
 */
export function shouldRegisterClientWebSearch(decision: NativeProviderSearchDecision): boolean {
	return !decision.active;
}

/**
 * The same model, minus its permission to search the web through its provider.
 *
 * A gateway model marked for web search carries that mark everywhere the model
 * goes, and it goes further than the room: Learn, Review Memory, consult and
 * the file specialists all run on a model somebody chose elsewhere, and a
 * gateway may well point its maintenance model at one of its room models. Those
 * sessions are defined by what they are not allowed to reach. Consult answers
 * from memory only, a specialist is explicitly forbidden the web_search tool,
 * and none of them registers a search extension at all. A capability that
 * arrives through the model rather than through the tool list would walk
 * straight past all of that, so it is taken off the model at the point those
 * sessions resolve one.
 *
 * Returns the model untouched unless the flag is actually set, so the common
 * case allocates nothing and object identity is preserved.
 */
export function stripProviderSearchFromModel<T>(model: T): T {
	const candidate = model as unknown as { compat?: Record<string, unknown> } | null;
	if (!candidate || typeof candidate !== "object") return model;
	const compat = candidate.compat;
	if (!isRecord(compat) || compat.supportsWebSearch !== true) return model;
	const { supportsWebSearch: _removed, ...restCompat } = compat;
	// Provider and id are deliberately untouched: the worker runtimes check the
	// resolved model against a fresh registry lookup on exactly those two fields.
	return { ...(candidate as object), compat: restCompat } as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one edit this module makes to an outgoing request: add the provider's
 * search tool, and take the app's own web_search out of the same list.
 *
 * Both halves matter. Anthropic's server tool is itself called web_search, so a
 * request carrying our client tool of the same name is asking one name to mean
 * two things; the provider is within its rights to reject it outright. The
 * removal is also what makes a mid-conversation settings change safe, since the
 * session's registered tools were decided when it bound and this list is the
 * last word before the request leaves.
 *
 * Exported pure so the smoke can assert on the exact shape without a provider.
 */
export function applyNativeProviderSearch(payload: unknown, providerId: string | undefined): unknown {
	if (!isNativeSearchProvider(providerId) || !isRecord(payload)) return payload;
	const declaration = providerId === "anthropic" ? ANTHROPIC_WEB_SEARCH_TOOL : CODEX_WEB_SEARCH_TOOL;
	const existing = Array.isArray(payload.tools) ? payload.tools : [];
	// A request with no client tools at all has no tools array yet, since both
	// providers only set one when there is something to put in it.
	const withoutClientSearch = existing.filter((tool) => !(isRecord(tool) && clientToolName(tool) === "web_search"));
	// Never twice: a retried payload has already been through here.
	const alreadyDeclared = withoutClientSearch.some((tool) => isRecord(tool) && tool.type === declaration.type);
	return { ...payload, tools: alreadyDeclared ? withoutClientSearch : [...withoutClientSearch, { ...declaration }] };
}

/**
 * A tool's name across the two shapes these providers use: Anthropic puts it at
 * the top level, the Codex responses surface does too for function tools, and a
 * server tool has a type we would not want to match on anyway.
 */
function clientToolName(tool: Record<string, unknown>): string | undefined {
	if (typeof tool.name === "string") return tool.name;
	const fn = tool.function;
	if (isRecord(fn) && typeof fn.name === "string") return fn.name;
	return undefined;
}

/**
 * The extension, built around the decision its session bound with.
 *
 * A session that is not using provider search registers no handler at all,
 * which keeps every other room on the runtime's existing fast path: the payload
 * hook is skipped entirely when nothing is listening for it.
 */
export function createNativeProviderSearchExtension(decision: NativeProviderSearchDecision) {
	return function (pi: ExtensionAPI) {
		if (!decision.active) return;
		pi.on("before_provider_request", (event) => applyNativeProviderSearch(event.payload, decision.providerId));
	};
}
