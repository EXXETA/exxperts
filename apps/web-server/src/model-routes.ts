import { type ModelRegistry, AuthStorage, listGitHubCopilotModels, defaultModelPerProvider, ANTHROPIC_API_KEY_PROVIDER, isApiKeyLoginProvider } from "@exxeta/exxperts-runtime";
import { isReservedCustomProfileProvider, writeCustomAiProfile } from "./custom-ai-profiles.js";
import { viewerOf } from "./persistent-agent-status.js";
import { createRoomModelCatalog, resolveAiDefault, taggedRecommendation, memoryModelTooSmallSentence, writeAiDefaults, type RoomModelTask } from "./room-models.js";
import { type PersistentAgentModelLock, getAvailablePersistentAgentAiProfiles, isPersistentAgentAiProfileId } from "./persistent-agent-ai-profiles.js";
import { MODELS_RUN_IN_REFUSAL, savedModelsRunIn, startGatewayProviderId } from "./openai-compatible-gateways.js";
import { type PersistentAgentAiProfileStateSource, readPersistentAgentAiProfileState, writePersistentAgentAiProfileState } from "./persistent-agent-ai-profile-state.js";
import { app } from "./server-app.js";
import { getLoginProviderCatalog } from "./provider-auth-routes.js";
import { aiDefaultsPayload, memoryBudgetsOnDefault, getWebChatModelRegistry, modelContextWindow, modelStatusPayload, parseRoomModelPatch, persistentAgentRoomCuratedModels, webChatModelLabel, type PersistentAgentAiProfileSelectionStatus, type WebChatModelOption } from "./ai-models.js";
import { buildPersistentAgentAiProfileDiagnostic, buildPersistentAgentAiProfileSelectionStatus, curatedModelOptions, refuseMemoryModelTooSmall } from "./ai-profile-models.js";
import { isSharedServer } from "./server-hooks.js";
import { normalizeDomain } from "@exxeta/exxperts-ai/oauth";
import { COPILOT_ACCOUNT_MODELS_NOTE, COPILOT_PROVIDER_ID } from "./provider-auth.js";
import { logProviderCallFailed } from "./usage-recording.js";

// A shared server runs no subscription, so with no profile chosen it names none,
// not the subscription profile the state falls back to.
function namesNoProfile(source: PersistentAgentAiProfileStateSource): boolean {
	return isSharedServer() && (source === "default" || source === "invalid");
}

function getWebChatModelStatus() {
	const registry = getWebChatModelRegistry();
	const activeProfileState = readPersistentAgentAiProfileState();
	const activeProfile = activeProfileState.profile;
	const available = registry.getAvailable();
	const roomOptions = curatedModelOptions(available, persistentAgentRoomCuratedModels(activeProfileState.profileId));
	// Legacy fields (models/recommended/selected/roomRecommended) now mirror the
	// conversation default for new rooms; the per-provider lists the pickers
	// read are in `providers`.
	const options = roomOptions;
	const catalog = createRoomModelCatalog();
	const conversationDefault = resolveAiDefault("conversation", catalog).effective;
	const defaultModel = conversationDefault ? registry.find(conversationDefault.provider, conversationDefault.model) : undefined;
	const selected = modelStatusPayload(defaultModel && registry.hasConfiguredAuth(defaultModel) ? defaultModel : undefined);
	const recommended = options.find((option) => option.recommended) ?? options[0] ?? null;
	const namesNone = namesNoProfile(activeProfileState.source);
	return {
		ready: Boolean(selected),
		selected,
		recommended,
		models: options,
		providers: roomModelProvidersPayload(registry, catalog),
		activeProfileId: namesNone ? null : activeProfile.id,
		activeProfileLabel: namesNone ? null : activeProfile.label,
		roomRecommended: selected ?? recommended,
		roomModels: roomOptions,
		message: selected ? null : "Connect a provider first.",
	};
}

/**
 * Every provider AI setup knows, in its order, with the models its rooms may
 * talk with and the models their memory work may use: the lists the Model
 * pickers show. A model the registry does not know is left out.
 */
function roomModelProvidersPayload(registry: ModelRegistry, catalog = createRoomModelCatalog()) {
	const options = (locks: PersistentAgentModelLock[], recommended: PersistentAgentModelLock | undefined): WebChatModelOption[] => locks.flatMap((lock) => {
		const model = registry.find(lock.provider, lock.model);
		if (!model) return [];
		const contextWindow = modelContextWindow(model);
		return [{ provider: lock.provider, model: lock.model, label: webChatModelLabel(lock.provider, model), recommended: Boolean(recommended && recommended.provider === lock.provider && recommended.model === lock.model), ...(contextWindow ? { contextWindow } : {}) }];
	});
	return catalog.providers.map((provider) => {
		// "Recommended" only where the release curates the list, the Claude key taking the sign-in's.
		const tagged = taggedRecommendation(provider, catalog);
		return {
			id: provider.providerId,
			label: provider.label,
			ready: provider.ready,
			conversation: options(provider.conversation, tagged.conversation),
			memory: options(provider.memory, tagged.memory),
			...(isSharedServer() ? { runsIn: provider.runsIn ?? "unknown" } : {}),
		};
	});
}

const getPersistentAgentRoomModelStatusHandler = async () => getWebChatModelStatus();

app.get("/api/persistent-agent-room/model-status", getPersistentAgentRoomModelStatusHandler);

app.get("/api/web-chat/model-status", getPersistentAgentRoomModelStatusHandler);

// The defaults for new rooms: the rows a room inherits until it sets its own.
app.get("/api/ai/defaults", async (req) => ({ defaults: aiDefaultsPayload(await viewerOf(req)) }));

app.put("/api/ai/defaults", async (req, reply) => {
	try {
		const viewer = await viewerOf(req);
		const catalog = createRoomModelCatalog();
		const patch = parseRoomModelPatch(req.body ?? {}, catalog, { allowClear: false });
		// A Memory default must hold the memory of every room on the default; the first that it does not hold is named when the viewer sees it.
		const memory = patch.memory;
		if (memory) {
			for (const { budgetTokens, room } of memoryBudgetsOnDefault(viewer)) {
				refuseMemoryModelTooSmall(memory, budgetTokens, catalog, 400, (model) => memoryModelTooSmallSentence(model, { room }));
			}
		}
		writeAiDefaults(patch as Partial<Record<RoomModelTask, PersistentAgentModelLock>>);
		return { defaults: aiDefaultsPayload(viewer, catalog) };
	} catch (e) {
		const statusCode = (e as any)?.statusCode ?? 500;
		return reply.code(statusCode).send({ error: (e as Error).message });
	}
});

// AI setup's rows. A shared server lists no profile that only a subscription reaches, and gives each row where
// its models run and whether the install set it up.
function profileSelectionPayload(status: PersistentAgentAiProfileSelectionStatus) {
	if (!isSharedServer()) return status;
	const oauthProviderIds = new Set(AuthStorage.create().getOAuthProviders().map((provider) => provider.id));
	const runsIn = new Map(getAvailablePersistentAgentAiProfiles().map((profile) => [profile.id, profile.runsIn]));
	const startProviderId = startGatewayProviderId();
	const profiles = status.profiles
		.filter((profile) => isApiKeyLoginProvider(profile.provider.id, oauthProviderIds))
		.map((profile) => ({ ...profile, runsIn: runsIn.get(profile.id) ?? "unknown", setByInstall: profile.provider.id === startProviderId }));
	return namesNoProfile(status.state.source) ? { ...status, profiles, activeProfileId: null, activeProfile: null } : { ...status, profiles };
}

app.get("/api/persistent-agent-ai-profile", async () => profileSelectionPayload(buildPersistentAgentAiProfileSelectionStatus()));

app.put("/api/persistent-agent-ai-profile", async (req, reply) => {
	const body = (req.body ?? {}) as any;
	const requestedProfileId = String(body.profileId ?? body.id ?? "").trim();
	if (!requestedProfileId) return reply.code(400).send({ error: "profileId is required" });
	if (!isPersistentAgentAiProfileId(requestedProfileId)) return reply.code(400).send({ error: `unknown persistent-agent AI profile: ${requestedProfileId}` });
	const registry = getWebChatModelRegistry();
	const diagnostic = buildPersistentAgentAiProfileDiagnostic(registry, requestedProfileId, requestedProfileId);
	if (!diagnostic.ready) {
		return reply.code(409).send({
			error: `${diagnostic.label} must be connected before selecting it.`,
			profile: diagnostic,
		});
	}
	writePersistentAgentAiProfileState(requestedProfileId);
	return reply.send(buildPersistentAgentAiProfileSelectionStatus(registry));
});

// Copilot's one suggestion, which pre-ticks a room model and picks the Memory model: the first of these the list holds, else the list's first.
const COPILOT_SUGGESTION_ORDER = ["claude-sonnet-5.5", "claude-opus-5.5", "gpt-6.1-sol"];

app.get("/api/persistent-agent-ai-profiles/model-catalog", async (req, reply) => {
	const providerId = String((req.query as any)?.provider ?? "").trim();
	if (!providerId) return reply.code(400).send({ error: "provider query param is required" });
	const registry = getWebChatModelRegistry();
	let models = registry.getAll().filter((model) => model.provider === providerId);
	if (models.length === 0) return reply.code(404).send({ error: `no models known for provider: ${providerId}` });
	// GitHub Copilot gates models by plan and org policy, so the static catalog
	// overpromises; when signed in, keep only what the account can actually use.
	// Any failure falls back to the full catalog rather than blocking the picker.
	let note: string | undefined;
	if (providerId === COPILOT_PROVIDER_ID) {
		try {
			const storage = AuthStorage.create();
			const token = await storage.getApiKey(providerId);
			if (token) {
				// A company sign-in's token names no address: the list is asked at the sign-in's company GitHub, as chat requests are.
				const credential = storage.get(providerId);
				const companyUrl = credential?.type === "oauth" && typeof credential.enterpriseUrl === "string" ? credential.enterpriseUrl : "";
				const available = new Set(await listGitHubCopilotModels(token, normalizeDomain(companyUrl) ?? undefined));
				const filtered = models.filter((model) => available.has(model.id));
				if (filtered.length > 0 && filtered.length < models.length) {
					models = filtered;
					note = COPILOT_ACCOUNT_MODELS_NOTE;
				}
			}
		} catch (error) {
			logProviderCallFailed({ callKind: "model-list", provider: providerId }, error);
		}
	}
	// The key provider serves the Anthropic list, so it suggests the sign-in's default.
	const defaultModelId = (defaultModelPerProvider as Record<string, string>)[providerId === ANTHROPIC_API_KEY_PROVIDER ? "anthropic" : providerId];
	const preferred = providerId === COPILOT_PROVIDER_ID ? COPILOT_SUGGESTION_ORDER : [defaultModelId];
	const suggested = preferred.find((id) => models.some((model) => model.id === id)) ?? models[0].id;
	return {
		provider: providerId,
		providerLabel: registry.getProviderDisplayName(providerId),
		suggested,
		...(note ? { note } : {}),
		models: models.map((model) => ({
			id: model.id,
			name: String((model as any).name ?? model.id).trim() || model.id,
			contextWindow: modelContextWindow(model),
			maxTokens: typeof (model as any).maxTokens === "number" ? (model as any).maxTokens : undefined,
			suggestedDefault: model.id === suggested,
		})),
	};
});

app.put("/api/persistent-agent-ai-profiles/custom", async (req, reply) => {
	const body = (req.body ?? {}) as any;
	const providerId = String(body.providerId ?? "").trim();
	if (!providerId) return reply.code(400).send({ error: "providerId is required" });
	if (isReservedCustomProfileProvider(providerId)) return reply.code(400).send({ error: `provider is managed by a built-in profile: ${providerId}` });
	if (!getLoginProviderCatalog().some((entry) => entry.id === providerId)) return reply.code(400).send({ error: `unknown login provider: ${providerId}` });
	const registry = getWebChatModelRegistry();
	const roomModels: string[] = Array.isArray(body.roomModels) ? body.roomModels.map((value: unknown) => String(value ?? "").trim()).filter(Boolean) : [];
	// One memory model per provider: Memorize and Review both run on it.
	const learnModel = String(body.learnModel ?? "").trim();
	if (roomModels.length === 0) return reply.code(400).send({ error: "at least one room model is required" });
	if (!learnModel) return reply.code(400).send({ error: "learnModel is required" });
	for (const modelId of new Set([...roomModels, learnModel])) {
		if (!registry.find(providerId, modelId)) return reply.code(400).send({ error: `model not found: ${providerId}/${modelId}` });
	}
	// Where its models run is stated only on a shared server; the desktop ignores the field.
	const runsInSave = isSharedServer() ? savedModelsRunIn(body.runsIn) : { ok: true as const, runsIn: undefined };
	if (!runsInSave.ok) return reply.code(400).send({ error: MODELS_RUN_IN_REFUSAL });
	try {
		writeCustomAiProfile({ providerId, label: typeof body.label === "string" ? body.label : undefined, roomModels, learnModel, runsIn: runsInSave.runsIn });
	} catch (e) {
		return reply.code(400).send({ error: (e as Error).message });
	}
	return buildPersistentAgentAiProfileSelectionStatus(registry);
});
