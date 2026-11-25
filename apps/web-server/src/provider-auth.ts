/**
 * In-app provider sign-in: drives the runtime OAuth flows (the same ones the
 * CLI /login runs) from the web UI. One login may be in flight at a time; the
 * start call returns the browser URL, the login completes through the
 * provider's local callback server, and credentials land in the shared local
 * auth store. The UI polls /api/auth/login/status plus the profile status
 * until the provider reports configured.
 */
import { ANTHROPIC_API_KEY_PROVIDER, AuthStorage, AuthStorageNotSavedError, isApiKeyLoginProvider, ModelRegistry } from "@exxeta/exxperts-runtime";
import { normalizeDomain } from "@exxeta/exxperts-ai/oauth";
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

/** Why auth.json's change was not saved, for the operator's line; never the failure's own message, which may quote the file. */
export type AuthFileNotSavedKind = "not-json" | "not-readable" | "value-does-not-open" | "not-written";

/** A sign-in change refused because auth.json cannot be read or written: the person's sentence, and why for the operator's line. */
export class AuthFileNotSavedError extends ProviderAuthError {
	readonly kind: AuthFileNotSavedKind;
	constructor(notSaved: AuthStorageNotSavedError) {
		super(AUTH_FILE_NOT_SAVED, 503);
		const cause = notSaved.cause;
		this.kind =
			notSaved.stage === "write"
				? "not-written"
				: cause instanceof SyntaxError
					? "not-json"
					: typeof (cause as NodeJS.ErrnoException | undefined)?.code === "string"
						? "not-readable"
						: "value-does-not-open";
	}
}

/** The operator's line for a change refused with AuthFileNotSavedError, as pino's fields and message: why, never the failure's own message, which may quote the file. */
export function authFileNotSavedLine(provider: string, error: unknown): [{ code: string; provider: string; kind: AuthFileNotSavedKind }, string] | null {
	return error instanceof AuthFileNotSavedError ? [{ code: AUTH_FILE_UNREADABLE_CODE, provider, kind: error.kind }, "auth.json cannot be read or written, so the change was refused"] : null;
}

/** One change of the stored credentials, refused with AuthFileNotSavedError when auth.json cannot be read or written. */
export function changeCredentials(change: (storage: AuthStorage) => void, storage: AuthStorage = AuthStorage.create()): void {
	try {
		change(storage);
	} catch (error) {
		if (error instanceof AuthStorageNotSavedError) throw new AuthFileNotSavedError(error);
		throw error;
	}
}

type PendingLogin = {
	provider: string;
	/** Copilot's company GitHub, null for github.com and for every other provider. */
	companyDomain: string | null;
	url: string | null;
	instructions: string | null;
	abort: AbortController;
	timeout: ReturnType<typeof setTimeout>;
	error: string | null;
	done: boolean;
};

let pending: PendingLogin | null = null;

/**
 * GitHub Copilot can sign in at a company's own GitHub (an address like
 * yourcompany.ghe.com) instead of github.com: the runtime asks for it with an
 * optional prompt, which the address answers. The words below are the page's
 * lines for that sign-in's failures; github.com keeps the runtime's own.
 */
export const COPILOT_PROVIDER_ID = "github-copilot";
const GITHUB_COM_HOSTS = new Set(["github.com", "www.github.com"]);
export const COMPANY_ADDRESS_REFUSED = "This isn't a web address. Type it like yourcompany.ghe.com, or leave it empty for github.com.";
/** Why a sign-in at a company's GitHub failed, as far as the runtime's error tells. */
type CompanySignInFailure = "not-started" | "refused" | "unfinished";
export const COMPANY_SIGN_IN_FAILED: Record<CompanySignInFailure, (address: string) => string> = {
	"not-started": (address) => `Can't start a GitHub sign-in at ${address}. Check the address, then try again.`,
	refused: (address) => `GitHub at ${address} turned this sign-in away. If your account there should have Copilot, ask your GitHub admin.`,
	unfinished: (address) => `Signing in at ${address} didn't finish. Try again.`,
};

/** The line under the Copilot model list when it shows only the account's own models. */
export const COPILOT_ACCOUNT_MODELS_NOTE = "Showing the models your Copilot account can use.";

/**
 * Before the runtime hands back the code page, nothing tells a wrong address
 * from one whose GitHub turns this sign-in away: nothing answered there, or not
 * as GitHub does, so the person checks the address. After it, an HTTP refusal
 * (the runtime's HTTP errors start with the status) comes from that GitHub,
 * either while the person signs in or from the Copilot token request once they
 * have; nothing tells the two apart, and the second, an account without
 * Copilot there, is its admin's to fix. Anything else is a sign-in that did not
 * finish (declined on GitHub's page, the code expired, the network).
 */
function companySignInFailure(error: unknown, codeShown: boolean): CompanySignInFailure {
	if (!codeShown) return "not-started";
	const status = /^(\d{3}) /.exec(error instanceof Error ? error.message : "")?.[1];
	return status === "401" || status === "403" || status === "404" ? "refused" : "unfinished";
}

/** The company address a Copilot sign-in asks at, or null for github.com; other providers take none. */
function companyGitHubDomain(providerId: string, companyAddress: string | undefined): string | null {
	if (providerId !== COPILOT_PROVIDER_ID || !companyAddress?.trim()) return null;
	const domain = normalizeDomain(companyAddress);
	if (!domain) throw new ProviderAuthError(COMPANY_ADDRESS_REFUSED, 400);
	// github.com typed out is the empty field: as a company domain the runtime would store it and use another API address for it.
	return GITHUB_COM_HOSTS.has(domain) ? null : domain;
}

export function knownOAuthProviderIds(): string[] {
	return AuthStorage.create().getOAuthProviders().map((provider) => provider.id);
}

export function providerLoginState(): { pending: boolean; provider?: string; url?: string | null; instructions?: string | null; error?: string | null } {
	if (!pending) return { pending: false };
	if (pending.done) return { pending: false, provider: pending.provider, error: pending.error };
	return { pending: true, provider: pending.provider, url: pending.url, instructions: pending.instructions };
}

/** `onSignedIn` runs once the new credentials are stored. `companyAddress` is Copilot's company GitHub, empty for github.com. */
export async function startProviderLogin(
	providerId: string,
	companyAddress: string | undefined,
	onSignedIn?: () => void,
	onNotSaved?: (error: AuthFileNotSavedError) => void,
): Promise<{ url: string; instructions?: string | null }> {
	if (!knownOAuthProviderIds().includes(providerId)) {
		throw new ProviderAuthError(`Unknown OAuth provider: ${providerId}`, 400);
	}
	const companyDomain = companyGitHubDomain(providerId, companyAddress);
	if (pending && !pending.done) {
		const sameProvider = pending.provider === providerId;
		// Re-requesting the same sign-in is a retry from the UI: hand back the URL.
		if (sameProvider && pending.companyDomain === companyDomain && pending.url) return { url: pending.url, instructions: pending.instructions };
		// Copilot at another address is a new sign-in: the one in flight gives way to it.
		if (sameProvider && pending.companyDomain !== companyDomain) cancelProviderLogin();
		else throw new ProviderAuthError("Another sign-in is already in progress. Cancel it first.", 409);
	}

	const abort = new AbortController();
	const entry: PendingLogin = {
		provider: providerId,
		companyDomain,
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
	// An address that takes the request and never answers would otherwise hold
	// this sign-in, and refuse every retry, until the login deadline.
	const urlTimeout = setTimeout(() => {
		if (!entry.done) {
			abort.abort();
			entry.done = true;
			entry.error = companyDomain ? COMPANY_SIGN_IN_FAILED["not-started"](companyDomain) : "The sign-in flow did not produce a login URL in time.";
			clearTimeout(entry.timeout);
		}
		rejectUrl(new Error(entry.error ?? "Sign-in was cancelled."));
	}, URL_WAIT_TIMEOUT_MS);

	// The flow signs in to a store of its own; only a sign-in still current when it
	// ends reaches the shared one. One cancelled, settled past a deadline or replaced
	// by another address ends unseen rather than overwriting what came after it.
	const signedIn = AuthStorage.inMemory();
	signedIn
		.login(providerId, {
			onAuth: (info) => {
				entry.url = info.url;
				// Device-code flows (GitHub Copilot) deliver a user code here that
				// the person must type on the provider's page — surface it.
				entry.instructions = info.instructions ?? null;
				resolveUrl(info.url);
			},
			// Optional prompts take their default, except Copilot's GitHub
			// Enterprise domain, which the company address answers; there is no
			// interactive input in the web flow, so a required prompt ends the
			// flow with the reason instead of hanging.
			onPrompt: async (prompt) => {
				if (prompt.allowEmpty) return companyDomain ?? "";
				throw new Error(`Sign-in needs input that is not available here (${prompt.message}).`);
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
			const credentials = signedIn.get(providerId);
			if (entry.done || pending !== entry || !credentials) return;
			changeCredentials((storage) => storage.set(providerId, credentials));
			entry.done = true;
			onSignedIn?.();
		})
		.catch((error: unknown) => {
			// A sign-in already settled (cancelled, or past a deadline) keeps its line.
			if (!entry.done) {
				entry.done = true;
				if (error instanceof AuthFileNotSavedError) onNotSaved?.(error);
				entry.error = abort.signal.aborted
					? "Sign-in was cancelled."
					: error instanceof AuthFileNotSavedError
						? error.message
						: companyDomain
						? COMPANY_SIGN_IN_FAILED[companySignInFailure(error, entry.url !== null)](companyDomain)
						: (error as Error).message;
			}
			rejectUrl(new Error(entry.error ?? "Sign-in was cancelled."));
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
	// tracked state here; a late completion then stores nothing.
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

// No real key comes near this; a key over 1 MiB would stop a shared server's next start as an unreadable file.
const API_KEY_MAX_BYTES = 8 * 1024;

/**
 * Why the save refuses a trimmed key, or null. A line break or other control
 * character reaches an error sentence through a header's error, so neither the
 * save nor the check below takes such a key. The Anthropic provider treats any
 * key holding "sk-ant-oat" as a sign-in token, so one pasted under either Claude
 * id would send a subscription through the key.
 */
export function apiKeyRefusal(providerId: string, trimmedKey: string): string | null {
	if (Buffer.byteLength(trimmedKey) > API_KEY_MAX_BYTES || /[\p{Cc}\u2028\u2029]/u.test(trimmedKey)) {
		return "This doesn't look like an API key: it's too long or holds a line break or other hidden character. Copy the key again and paste only the key.";
	}
	if ((providerId === ANTHROPIC_API_KEY_PROVIDER || providerId === "anthropic") && trimmedKey.includes("sk-ant-oat")) {
		return "This looks like a Claude sign-in token, not an API key. Create an API key at console.anthropic.com.";
	}
	return null;
}

export function saveProviderApiKey(providerId: string, key: string): void {
	const trimmedKey = key.trim();
	if (!trimmedKey) throw new ProviderAuthError("API key is required.", 400);
	if (!knownApiKeyProviderIds().includes(providerId)) {
		throw new ProviderAuthError(`Provider does not support API-key sign-in: ${providerId}`, 400);
	}
	const refusal = apiKeyRefusal(providerId, trimmedKey);
	if (refusal) throw new ProviderAuthError(refusal, 400);
	changeCredentials((storage) => storage.set(providerId, { type: "api_key", key: trimmedKey }));
}

/** The sentence when auth.json cannot be read or written, so a sign-in, a key or a sign-out is refused rather than lost. */
export const AUTH_FILE_NOT_SAVED = "This change wasn't saved, because the saved keys and sign-ins can't be read or written right now.";
/** The code of the operator's line for that refusal. */
export const AUTH_FILE_UNREADABLE_CODE = "auth_file_unreadable";

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
	if (providerId !== ANTHROPIC_API_KEY_PROVIDER || !trimmedKey || apiKeyRefusal(providerId, trimmedKey)) return null;
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
	changeCredentials((storage) => storage.logout(providerId), authStorage);
}
