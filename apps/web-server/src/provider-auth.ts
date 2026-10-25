/**
 * In-app provider sign-in: drives the runtime OAuth flows (the same ones the
 * CLI /login runs) from the web UI. One login may be in flight at a time; the
 * start call returns the browser URL, the login completes through the
 * provider's local callback server, and credentials land in the shared local
 * auth store. The UI polls /api/auth/login/status plus the profile status
 * until the provider reports configured.
 */
import { ANTHROPIC_API_KEY_PROVIDER, AuthStorage, isApiKeyLoginProvider, ModelRegistry } from "@exxeta/exxperts-runtime";
import { anthropicKeyNeedsWorkspace } from "./model-not-offered.js";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const URL_WAIT_TIMEOUT_MS = 15 * 1000;

export class ProviderAuthError extends Error {
	statusCode: number;
	constructor(message: string, statusCode = 400) {
		super(message);
		this.statusCode = statusCode;
	}
}

type PendingLogin = {
	provider: string;
	url: string | null;
	instructions: string | null;
	abort: AbortController;
	timeout: ReturnType<typeof setTimeout>;
	error: string | null;
	done: boolean;
};

let pending: PendingLogin | null = null;

export function knownOAuthProviderIds(): string[] {
	return AuthStorage.create().getOAuthProviders().map((provider) => provider.id);
}

export function providerLoginState(): { pending: boolean; provider?: string; url?: string | null; instructions?: string | null; error?: string | null } {
	if (!pending) return { pending: false };
	if (pending.done) return { pending: false, provider: pending.provider, error: pending.error };
	return { pending: true, provider: pending.provider, url: pending.url, instructions: pending.instructions };
}

/** `onSignedIn` runs once the new credentials are stored. */
export async function startProviderLogin(providerId: string, onSignedIn?: () => void): Promise<{ url: string; instructions?: string | null }> {
	if (!knownOAuthProviderIds().includes(providerId)) {
		throw new ProviderAuthError(`Unknown OAuth provider: ${providerId}`, 400);
	}
	if (pending && !pending.done) {
		// Re-requesting the same provider is a retry from the UI: hand back the URL.
		if (pending.provider === providerId && pending.url) return { url: pending.url, instructions: pending.instructions };
		throw new ProviderAuthError("Another sign-in is already in progress. Cancel it first.", 409);
	}

	const abort = new AbortController();
	const entry: PendingLogin = {
		provider: providerId,
		url: null,
		instructions: null,
		abort,
		timeout: setTimeout(() => {
			// The runtime flow does not observe the abort signal; settle here.
			abort.abort();
			if (!entry.done) {
				entry.done = true;
				entry.error = "Sign-in timed out. Try again.";
			}
		}, LOGIN_TIMEOUT_MS),
		error: null,
		done: false,
	};
	pending = entry;

	let resolveUrl!: (url: string) => void;
	let rejectUrl!: (error: Error) => void;
	const urlReady = new Promise<string>((resolve, reject) => {
		resolveUrl = resolve;
		rejectUrl = reject;
	});
	const urlTimeout = setTimeout(() => rejectUrl(new Error("The sign-in flow did not produce a login URL in time.")), URL_WAIT_TIMEOUT_MS);

	AuthStorage.create()
		.login(providerId, {
			onAuth: (info) => {
				entry.url = info.url;
				// Device-code flows (GitHub Copilot) deliver a user code here that
				// the person must type on the provider's page — surface it.
				entry.instructions = info.instructions ?? null;
				resolveUrl(info.url);
			},
			// Optional prompts (e.g. Copilot's GitHub Enterprise domain) take
			// their default; there is no interactive input in the web flow, so
			// a required prompt ends the flow with the reason instead of hanging.
			onPrompt: async (prompt) => {
				if (prompt.allowEmpty) return "";
				throw new Error(`Sign-in needs input that is not available here (${prompt.message}). Use "exxperts cli" and /login instead.`);
			},
			// The flows race the callback server against this promise and tear
			// the server down when it rejects — the only cancellation hook they
			// honor (the abort signal itself is ignored, and Anthropic's
			// callback port is fixed, so an orphaned server blocks retries).
			onManualCodeInput: () =>
				new Promise<string>((_, reject) => {
					const rejectCancelled = () => reject(new Error("Sign-in was cancelled."));
					if (abort.signal.aborted) return rejectCancelled();
					abort.signal.addEventListener("abort", rejectCancelled, { once: true });
				}),
			signal: abort.signal,
		})
		.then(() => {
			entry.done = true;
			onSignedIn?.();
		})
		.catch((error: unknown) => {
			entry.done = true;
			entry.error = abort.signal.aborted ? "Sign-in was cancelled." : (error as Error).message;
			rejectUrl(new Error(entry.error));
		})
		.finally(() => {
			clearTimeout(entry.timeout);
		});

	try {
		const url = await urlReady;
		return { url, instructions: entry.instructions };
	} finally {
		clearTimeout(urlTimeout);
	}
}

export function cancelProviderLogin(): { cancelled: boolean } {
	if (!pending || pending.done) return { cancelled: false };
	// The runtime login flow does not observe the abort signal, so settle the
	// tracked state here; a late completion still stores credentials, which is
	// harmless (the UI refresh would simply show the profile as signed in).
	pending.abort.abort();
	pending.done = true;
	pending.error = "Sign-in was cancelled.";
	clearTimeout(pending.timeout);
	return { cancelled: true };
}

export function knownApiKeyProviderIds(): string[] {
	const authStorage = AuthStorage.create();
	const registry = ModelRegistry.create(authStorage);
	const oauthProviderIds = new Set(authStorage.getOAuthProviders().map((provider) => provider.id));
	const providerIds = new Set(registry.getAll().map((model) => model.provider));
	return [...providerIds].filter((providerId) => isApiKeyLoginProvider(providerId, oauthProviderIds)).sort();
}

export function saveProviderApiKey(providerId: string, key: string): void {
	const trimmedKey = key.trim();
	if (!trimmedKey) throw new ProviderAuthError("API key is required.", 400);
	if (!knownApiKeyProviderIds().includes(providerId)) {
		throw new ProviderAuthError(`Provider does not support API-key sign-in: ${providerId}`, 400);
	}
	// The Anthropic provider treats any key holding "sk-ant-oat" as a sign-in
	// token, so one pasted here would send a subscription through the key.
	if (providerId === ANTHROPIC_API_KEY_PROVIDER && trimmedKey.includes("sk-ant-oat")) {
		throw new ProviderAuthError("This looks like a Claude sign-in token, not an API key. Create an API key at console.anthropic.com.", 400);
	}
	AuthStorage.create().set(providerId, { type: "api_key", key: trimmedKey });
}

/** Plain words for a Claude key checked at save: Anthropic refused it, it is outside any workspace, or it could not be checked. */
export const ANTHROPIC_KEY_REFUSED = "Anthropic did not accept this key. Check it at console.anthropic.com.";
export const ANTHROPIC_KEY_NO_WORKSPACE = "This key isn't tied to a workspace. In the Anthropic Console, create a key inside a workspace, then add it here.";
export const ANTHROPIC_KEY_UNCHECKED = "The key is saved. It couldn't be checked with Anthropic just now, so your first message will show whether it works.";
const ANTHROPIC_KEY_CHECK_TIMEOUT_MS = 10_000;

/**
 * Asks Anthropic about a Claude key before it is saved, with one cheap call
 * (the models list, which costs nothing). A refused key and a key outside any
 * workspace are refused here with their own words, since every call with them
 * fails; an answer that says neither, or none at all, saves the key with a
 * notice that it could not be checked. Returns that notice, or null. Other
 * providers, and a key the save itself refuses, are not asked. The key goes
 * only into the request's header: never into a message or the log. A check
 * that fails hands its status and Anthropic's words to `onFailed`, for the
 * log's codes.
 */
export async function checkProviderApiKey(providerId: string, key: string, onFailed?: (failure: unknown) => void): Promise<string | null> {
	const trimmedKey = key.trim();
	if (providerId !== ANTHROPIC_API_KEY_PROVIDER || !trimmedKey || trimmedKey.includes("sk-ant-oat")) return null;
	const configured = ModelRegistry.create(AuthStorage.inMemory()).getAll().find((model) => model.provider === ANTHROPIC_API_KEY_PROVIDER)?.baseUrl;
	const baseUrl = (configured || "https://api.anthropic.com").replace(/\/+$/, "");
	let response: Response;
	try {
		response = await fetch(`${baseUrl}/v1/models?limit=1`, {
			headers: { "x-api-key": trimmedKey, "anthropic-version": "2023-06-01" },
			signal: AbortSignal.timeout(ANTHROPIC_KEY_CHECK_TIMEOUT_MS),
		});
	} catch (error) {
		onFailed?.(error);
		return ANTHROPIC_KEY_UNCHECKED;
	}
	if (response.ok) return null;
	const words = await response.text().catch(() => "");
	onFailed?.(new Error(`${response.status} ${words}`));
	if (response.status === 401 || response.status === 403) throw new ProviderAuthError(ANTHROPIC_KEY_REFUSED, 400);
	if (response.status === 400 && anthropicKeyNeedsWorkspace(words)) throw new ProviderAuthError(ANTHROPIC_KEY_NO_WORKSPACE, 400);
	return ANTHROPIC_KEY_UNCHECKED;
}

export function logoutProvider(providerId: string): void {
	const authStorage = AuthStorage.create();
	// Sign-out covers both OAuth credentials and stored API keys.
	if (!knownOAuthProviderIds().includes(providerId) && !authStorage.hasAuth(providerId)) {
		throw new ProviderAuthError(`Unknown provider: ${providerId}`, 400);
	}
	authStorage.logout(providerId);
}
