import { type ModelRegistry, AuthStorage, listGitHubCopilotModels, defaultModelPerProvider, ANTHROPIC_API_KEY_PROVIDER } from "@exxeta/exxperts-runtime";
import { isReservedCustomProfileProvider, writeCustomAiProfile } from "./custom-ai-profiles.js";
import { listPersistentAgents } from "./persistent-agents.js";
import { readPersistentRoomMaintenanceSettings } from "./persistent-room-maintenance-settings.js";
import { createRoomModelCatalog, resolveAiDefault, taggedRecommendation, readRoomModels, memoryModelTooSmallSentence, writeAiDefaults, type RoomModelTask } from "./room-models.js";
import { type PersistentAgentModelLock, isPersistentAgentAiProfileId } from "./persistent-agent-ai-profiles.js";
import { readPersistentAgentAiProfileState, writePersistentAgentAiProfileState } from "./persistent-agent-ai-profile-state.js";
import { app } from "./server-app.js";
import { getLoginProviderCatalog } from "./provider-auth-routes.js";
import { aiDefaultsPayload, getWebChatModelRegistry, modelContextWindow, modelStatusPayload, parseRoomModelPatch, persistentAgentRoomCuratedModels, webChatModelLabel, type WebChatModelOption } from "./ai-models.js";
import { buildPersistentAgentAiProfileDiagnostic, buildPersistentAgentAiProfileSelectionStatus, curatedModelOptions, refuseMemoryModelTooSmall } from "./ai-profile-models.js";

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
	return {
		ready: Boolean(selected),
		selected,
		recommended,
		models: options,
		providers: roomModelProvidersPayload(registry, catalog),
		activeProfileId: activeProfile.id,
		activeProfileLabel: activeProfile.label,
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
		};
	});
}

const getPersistentAgentRoomModelStatusHandler = async () => getWebChatModelStatus();

app.get("/api/persistent-agent-room/model-status", getPersistentAgentRoomModelStatusHandler);

app.get("/api/web-chat/model-status", getPersistentAgentRoomModelStatusHandler);

// The defaults for new rooms: the rows a room inherits until it sets its own.
app.get("/api/ai/defaults", async () => ({ defaults: aiDefaultsPayload() }));

app.put("/api/ai/defaults", async (req, reply) => {
	try {
		const catalog = createRoomModelCatalog();
		const patch = parseRoomModelPatch(req.body ?? {}, catalog, { allowClear: false });
		// A Memory default must hold the memory of every room on the default; the first that it does not hold is named.
		const memory = patch.memory;
		if (memory) {
			for (const room of listPersistentAgents()) {
				if (readRoomModels(room.id)?.memory) continue;
				refuseMemoryModelTooSmall(memory, readPersistentRoomMaintenanceSettings(room.id).memoryBudgetTokens, catalog, 400, (model) => memoryModelTooSmallSentence(model, { room: room.displayName || room.id }));
			}
		}
		writeAiDefaults(patch as Partial<Record<RoomModelTask, PersistentAgentModelLock>>);
		return { defaults: aiDefaultsPayload(catalog) };
	} catch (e) {
		const statusCode = (e as any)?.statusCode ?? 500;
		return reply.code(statusCode).send({ error: (e as Error).message });
	}
});

app.get("/api/persistent-agent-ai-profile", async () => buildPersistentAgentAiProfileSelectionStatus());

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
	if (providerId === "github-copilot") {
		try {
			const token = await AuthStorage.create().getApiKey(providerId);
			if (token) {
				const available = new Set(await listGitHubCopilotModels(token));
				const filtered = models.filter((model) => available.has(model.id));
				if (filtered.length > 0 && filtered.length < models.length) {
					models = filtered;
					note = "Showing the models enabled for your Copilot account. Enable more in your GitHub Copilot settings; premium models also need available premium requests.";
				}
			}
		} catch {}
	}
	// The key provider serves the Anthropic list, so it suggests the sign-in's default.
	const defaultModelId = (defaultModelPerProvider as Record<string, string>)[providerId === ANTHROPIC_API_KEY_PROVIDER ? "anthropic" : providerId];
	const suggested = models.find((model) => model.id === defaultModelId)?.id ?? models[0].id;
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
	try {
		writeCustomAiProfile({ providerId, label: typeof body.label === "string" ? body.label : undefined, roomModels, learnModel });
	} catch (e) {
		return reply.code(400).send({ error: (e as Error).message });
	}
	return buildPersistentAgentAiProfileSelectionStatus(registry);
});
