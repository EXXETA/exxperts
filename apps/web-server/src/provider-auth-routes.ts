import { AuthStorage, ModelRegistry, isApiKeyLoginProvider, getAgentDir } from "@exxeta/exxperts-runtime";
import {
	startProviderLogin,
	ProviderAuthError,
	AuthFileNotSavedError,
	authFileNotSavedLine,
	changeCredentials,
	providerLoginState,
	cancelProviderLogin,
	logoutProvider,
	checkProviderApiKey,
	saveProviderApiKey,
} from "./provider-auth.js";
import { type PersistentAgentAiProfileId, getAvailablePersistentAgentAiProfiles } from "./persistent-agent-ai-profiles.js";
import { builtInProfileIdForProvider, customAiProfileIdForProvider, deleteCustomAiProfile, readCustomAiProfiles } from "./custom-ai-profiles.js";
import { clearSavedPersistentAgentAiProfileState, readSavedPersistentAgentAiProfileId } from "./persistent-agent-ai-profile-state.js";
import { buildPersistentAgentAiProfileSelectionStatus } from "./ai-profile-models.js";
import { forgetGatewayModelFind } from "./gateway-model-find.js";
import { registerKnowledgeApi } from "./knowledge-api.js";
import { browserSafeLocalPath } from "./status-diagnostics.js";
import { forgetKeyRefusal } from "./model-call-causes.js";
import { app } from "./server-app.js";
import { logProviderCallFailed } from "./usage-recording.js";
import { isSharedServer } from "./server-hooks.js";
import { GATEWAY_PROVIDER_ID_PREFIX, OPENAI_COMPATIBLE_PROVIDER_ID, startGatewayProviderId, START_GATEWAY_REFUSAL } from "./openai-compatible-gateways.js";

// The key removal's refusals (draft words).
export const KEY_REMOVAL_GATEWAY = "Remove the gateway instead.";
export const KEY_REMOVAL_NO_KEY = "No key is saved for this provider.";
export const KEY_REMOVAL_FAILED = "The key couldn't be removed. Try again.";

const AUTH_PROVIDER_ORDER = [
	{ id: "anthropic", name: "Anthropic / Claude" },
	{ id: "openai", name: "OpenAI" },
	{ id: "openai-codex", name: "OpenAI / ChatGPT subscription" },
	{ id: "openai-compatible", name: "OpenAI-compatible gateway" },
	{ id: "google", name: "Google / Gemini" },
	{ id: "github-copilot", name: "GitHub Copilot" },
	{ id: "openrouter", name: "OpenRouter" },
];

type LoginProviderCatalogEntry = {
	id: string;
	name: string;
	authTypes: Array<"oauth" | "api_key">;
	configured: boolean;
	profileId: PersistentAgentAiProfileId | null;
};

// Full sign-in surface: every runtime OAuth provider plus every catalog
// provider that accepts API-key login — the same set the Pi /login offers.
function getLoginProviderCatalog(shared?: { authStorage: AuthStorage; registry: ModelRegistry }): LoginProviderCatalogEntry[] {
	const authStorage = shared?.authStorage ?? AuthStorage.create();
	const registry = shared?.registry ?? ModelRegistry.create(authStorage);
	const oauthProviders = authStorage.getOAuthProviders();
	const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
	const providerIds = new Set<string>(registry.getAll().map((model) => model.provider));
	for (const provider of oauthProviders) providerIds.add(provider.id);
	const profileByProvider = new Map(getAvailablePersistentAgentAiProfiles().map((profile) => [profile.providerId, profile.id]));
	const entries = [...providerIds]
		.map((id) => {
			const authTypes: Array<"oauth" | "api_key"> = [];
			// A shared server runs no subscription, so it offers API keys alone.
			if (oauthProviderIds.has(id) && !isSharedServer()) authTypes.push("oauth");
			if (isApiKeyLoginProvider(id, oauthProviderIds)) authTypes.push("api_key");
			return {
				id,
				name: registry.getProviderDisplayName(id),
				authTypes,
				configured: registry.getProviderAuthStatus(id).configured,
				profileId: profileByProvider.get(id) ?? null,
				...(!profileByProvider.has(id) && builtInProfileIdForProvider(id) ? { removeOnly: true } : {}),
			};
		})
		// A built-in profile's provider this server does not offer (Anthropic on a
		// shared server) is listed only while a key is saved under it, for its Remove.
		.filter((entry) => entry.authTypes.length > 0 && (entry.profileId !== null || !builtInProfileIdForProvider(entry.id) || authStorage.get(entry.id)?.type === "api_key"));
	entries.sort((a, b) => {
		const aOauth = a.authTypes.includes("oauth") ? 0 : 1;
		const bOauth = b.authTypes.includes("oauth") ? 0 : 1;
		return aOauth - bOauth || a.name.localeCompare(b.name);
	});
	return entries;
}

function getAuthOverview() {
	// A shared server holds no subscription sign-in, and its keys are the admin's: it lists no provider, to anyone.
	if (isSharedServer()) return { anyConfigured: false, authDir: "", providers: [] };
	const authStorage = AuthStorage.create();
	const registry = ModelRegistry.create(authStorage);
	const oauthProviders = new Map(authStorage.getOAuthProviders().map((provider) => [provider.id, provider.name]));
	const orderedIds = new Set(AUTH_PROVIDER_ORDER.map((provider) => provider.id));
	const extraConfigured = getLoginProviderCatalog({ authStorage, registry })
		.filter((entry) => entry.configured && !orderedIds.has(entry.id))
		.map((entry) => ({ id: entry.id, name: entry.name }));
	const providers = [...AUTH_PROVIDER_ORDER, ...extraConfigured].map((provider) => {
		const status = registry.getProviderAuthStatus(provider.id);
		return {
			id: provider.id,
			name: oauthProviders.get(provider.id) ?? provider.name,
			configured: status.configured,
			source: status.source,
			label: status.label,
			oauth: oauthProviders.has(provider.id),
			// Whether the stored credential is a subscription sign-in, so its row
			// offers "Sign in again" rather than "Replace API key".
			signedInWithOAuth: authStorage.get(provider.id)?.type === "oauth",
		};
	});
	return {
		anyConfigured: providers.some((provider) => provider.configured),
		authDir: browserSafeLocalPath(getAgentDir()),
		providers,
	};
}

app.get("/api/auth/status", async () => getAuthOverview());

function logAuthFileNotSaved(provider: string, error: unknown): void {
	const line = authFileNotSavedLine(provider, error);
	if (line) app.log.warn(...line);
}

app.post("/api/auth/login", async (req, reply) => {
	const body = (req.body ?? {}) as { provider?: unknown; companyAddress?: unknown };
	const provider = String(body.provider ?? "").trim();
	if (!provider) return reply.code(400).send({ error: "provider is required" });
	const companyAddress = typeof body.companyAddress === "string" ? body.companyAddress : undefined;
	try {
		return await startProviderLogin(
			provider,
			companyAddress,
			() => forgetKeyRefusal(provider),
			(error) => logAuthFileNotSaved(provider, error),
		);
	} catch (e) {
		const statusCode = e instanceof ProviderAuthError ? e.statusCode : 500;
		return reply.code(statusCode).send({ error: (e as Error).message });
	}
});

app.get("/api/auth/login/status", async () => providerLoginState());

app.post("/api/auth/login/cancel", async () => cancelProviderLogin());

app.post("/api/auth/logout", async (req, reply) => {
	const provider = String((req.body as { provider?: unknown } | null)?.provider ?? "").trim();
	if (!provider) return reply.code(400).send({ error: "provider is required" });
	try {
		logoutProvider(provider);
		forgetKeyRefusal(provider);
		return { ok: true };
	} catch (e) {
		logAuthFileNotSaved(provider, e);
		const statusCode = e instanceof ProviderAuthError ? e.statusCode : 500;
		return reply.code(statusCode).send({ error: (e as Error).message });
	}
});

app.get("/api/auth/providers", async () => ({ providers: getLoginProviderCatalog() }));

app.post("/api/auth/api-key", async (req, reply) => {
	const body = (req.body ?? {}) as { provider?: unknown; key?: unknown };
	const provider = String(body.provider ?? "").trim();
	const key = typeof body.key === "string" ? body.key : "";
	if (!provider) return reply.code(400).send({ error: "provider is required" });
	// The start's gateway takes its key from the start alone: a saved key would sit in auth.json, unused.
	if (provider === startGatewayProviderId()) return reply.code(403).send({ error: START_GATEWAY_REFUSAL });
	try {
		const notice = await checkProviderApiKey(provider, key, (failure) => logProviderCallFailed({ callKind: "key-check", provider }, failure));
		saveProviderApiKey(provider, key);
		forgetKeyRefusal(provider);
		forgetGatewayModelFind(provider);
		// Never echo the key back.
		return { ok: true, provider, ...(notice ? { notice } : {}) };
	} catch (e) {
		logAuthFileNotSaved(provider, e);
		const statusCode = e instanceof ProviderAuthError ? e.statusCode : 500;
		return reply.code(statusCode).send({ error: (e as Error).message });
	}
});

// Removes one saved API key, and the models approved for it, so they leave
// everyone's list; a room on one keeps its pick and stops until someone there
// picks another. A gateway's key goes with its gateway, and a sign-in is never
// removed here. A removal cut before the profile went finishes on a repeat.
app.delete("/api/auth/api-key/:provider", async (req, reply) => {
	const provider = String((req.params as { provider?: unknown }).provider ?? "").trim();
	if (provider === startGatewayProviderId()) return reply.code(403).send({ error: START_GATEWAY_REFUSAL });
	if (provider === OPENAI_COMPATIBLE_PROVIDER_ID || provider.startsWith(GATEWAY_PROVIDER_ID_PREFIX)) return reply.code(409).send({ error: KEY_REMOVAL_GATEWAY });
	const profileId = customAiProfileIdForProvider(provider);
	const hasProfile = readCustomAiProfiles().entries.some((entry) => entry.id === profileId);
	const storage = AuthStorage.create();
	// A store it could not read says nothing about the key: never a key already gone.
	if (storage.drainErrors().length > 0) return reply.code(500).send({ error: KEY_REMOVAL_FAILED });
	const stored = storage.get(provider)?.type;
	if (stored !== "api_key" && (stored !== undefined || !hasProfile)) return reply.code(404).send({ error: KEY_REMOVAL_NO_KEY });
	if (stored === "api_key") {
		try {
			changeCredentials((credentials) => credentials.logout(provider), storage);
		} catch (e) {
			// auth.json it cannot read or write: the sentence every credential change gives, and the operator's line.
			logAuthFileNotSaved(provider, e);
			if (e instanceof AuthFileNotSavedError) return reply.code(e.statusCode).send({ error: e.message });
			throw e;
		}
		// The file, read again, says whether the key went.
		const readBack = AuthStorage.create();
		if (storage.drainErrors().length > 0 || readBack.drainErrors().length > 0 || readBack.get(provider) !== undefined) return reply.code(500).send({ error: KEY_REMOVAL_FAILED });
		forgetKeyRefusal(provider);
		forgetGatewayModelFind(provider);
	}
	if (hasProfile) {
		deleteCustomAiProfile(profileId);
		if (readSavedPersistentAgentAiProfileId() === profileId) clearSavedPersistentAgentAiProfileState();
	}
	return buildPersistentAgentAiProfileSelectionStatus();
});

registerKnowledgeApi(app);

export { getLoginProviderCatalog };
