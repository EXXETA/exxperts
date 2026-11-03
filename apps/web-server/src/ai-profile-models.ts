import { type ModelRegistry, getAgentDir } from "@exxeta/exxperts-runtime";
import { isCustomAiProfileId, readCustomAiProfiles } from "./custom-ai-profiles.js";
import { getPersistentAgentThread } from "./persistent-agents.js";
import { MEMORY_BUDGET_MIN_TOKENS, MEMORY_BUDGET_MAX_TOKENS, readPersistentRoomMaintenanceSettings } from "./persistent-room-maintenance-settings.js";
import { resolveRoomModel, createRoomModelCatalog, providerSignsIn, RoomModelUnavailableError, type RoomModelCatalog, memoryModelHoldsBudget, MemoryModelTooSmallError, memoryBudgetNeedsLargerModelSentence, memoryModelTooSmallSentence } from "./room-models.js";
import { providerCredentialClause, credentialGoneWords, sharedCredentialState } from "./model-not-offered.js";
import { isSharedServer } from "./server-hooks.js";
import { type PersistentAgentAiProfile, type PersistentAgentAiProfileId, DEFAULT_PERSISTENT_AGENT_AI_PROFILE_ID, getPersistentAgentAiProfile, getAvailablePersistentAgentAiProfiles, type PersistentAgentModelLock } from "./persistent-agent-ai-profiles.js";
import { readOpenAiCompatibleGateways } from "./openai-compatible-gateways.js";
import { runIsolatedPersistentAgentWorker } from "./persistent-agent-worker-runtime.js";
import { readPersistentAgentAiProfileState } from "./persistent-agent-ai-profile-state.js";
import { browserSafeLocalPath } from "./status-diagnostics.js";
import { stripProviderSearchFromModel } from "../../../pi-package/extensions/web-search/native-provider-search.js";
import { type UsageKind, usageMovedNothing } from "./usage-log.js";
import { type CallKind, isMemoryCallKind, type MemoryCallKind } from "./memory-call-cache.js";
import { ABSORB_PROBE_PROMPT, ABSORB_PROBE_TIMEOUT_MS } from "./absorb-run.js";
import { keyRefusalOf, keyRefusedSetupSentence, ModelUnreachableError, MODEL_CALL_IDLE_TIMEOUT_MS, type PatienceWait, callWithPatience } from "./model-call-causes.js";
import { REPO_ROOT } from "./server-install-root.js";
import { app } from "./server-app.js";
import { effectiveDefaultMaxTokens, getWebChatModelRegistry, memoryModelWindow, modelContextWindow, type PersistentAgentAiProfileDiagnostic, type PersistentAgentAiProfileSelectionStatus, type ProfileModelDiagnostic, type RegistryModel, roomModelLockPayload, roomModelNames, roomModelRefusal, webChatModelLabel, type WebChatModelOption, webChatProviderLabel } from "./ai-models.js";
import { logProviderCallFailed, recordWorkerUsage } from "./usage-recording.js";

function profileModelCompatPayload(model: RegistryModel | undefined): ProfileModelDiagnostic["compat"] | undefined {
	const compat = model?.compat as any;
	if (!compat) return undefined;
	return {
		supportsStore: typeof compat.supportsStore === "boolean" ? compat.supportsStore : undefined,
		supportsDeveloperRole: typeof compat.supportsDeveloperRole === "boolean" ? compat.supportsDeveloperRole : undefined,
		supportsOpenAIPromptCacheRetention: typeof compat.supportsOpenAIPromptCacheRetention === "boolean" ? compat.supportsOpenAIPromptCacheRetention : undefined,
		supportsAnthropicCacheControlTtl: typeof compat.supportsAnthropicCacheControlTtl === "boolean" ? compat.supportsAnthropicCacheControlTtl : undefined,
		supportsLongCacheRetention: typeof compat.supportsLongCacheRetention === "boolean" ? compat.supportsLongCacheRetention : undefined,
		cacheControlFormat: typeof compat.cacheControlFormat === "string" ? compat.cacheControlFormat : undefined,
		maxTokensField: typeof compat.maxTokensField === "string" ? compat.maxTokensField : undefined,
	};
}

function modelLockKey(lock: { provider: string; model: string }): string {
	return `${lock.provider}/${lock.model}`;
}

function buildProfileRequiredModelLocks(profile: PersistentAgentAiProfile): Array<{ provider: string; model: string; purpose: string }> {
	const purposeByModel = new Map<string, { provider: string; model: string; purposes: Set<string> }>();
	const addPurpose = (lock: { provider: string; model: string }, purpose: string) => {
		const key = modelLockKey(lock);
		let entry = purposeByModel.get(key);
		if (!entry) {
			entry = { provider: lock.provider, model: lock.model, purposes: new Set<string>() };
			purposeByModel.set(key, entry);
		}
		entry.purposes.add(purpose);
	};

	for (const model of profile.processes.persistentRoom) addPurpose(model, "persistent-room");
	addPurpose(profile.processes.absorb, "absorb");
	addPurpose(profile.processes.structuralReview, "structural-review");

	return Array.from(purposeByModel.values()).map((entry) => ({
		provider: entry.provider,
		model: entry.model,
		purpose: Array.from(entry.purposes).join("/"),
	}));
}

function profileModelDiagnostic(registry: ModelRegistry, lock: { provider: string; model: string; key?: string; purpose?: string }): ProfileModelDiagnostic {
	const model = registry.find(lock.provider, lock.model);
	return {
		key: lock.key,
		provider: lock.provider,
		model: lock.model,
		label: model ? webChatModelLabel(model.provider, model) : `${webChatProviderLabel(lock.provider)} — ${lock.model}`,
		purpose: lock.purpose,
		present: Boolean(model),
		authConfigured: model ? registry.hasConfiguredAuth(model) : false,
		api: model?.api,
		contextWindow: model?.contextWindow,
		maxTokens: model?.maxTokens,
		effectiveDefaultMaxTokens: effectiveDefaultMaxTokens(model),
		compat: profileModelCompatPayload(model),
	};
}

function profileModelReady(model: ProfileModelDiagnostic): boolean {
	return model.present && model.authConfigured;
}

function profileDiagnosticForModel(models: ProfileModelDiagnostic[], lock: { provider: string; model: string }): ProfileModelDiagnostic {
	return models.find((candidate) => candidate.provider === lock.provider && candidate.model === lock.model) ?? {
		provider: lock.provider,
		model: lock.model,
		label: `${webChatProviderLabel(lock.provider)} — ${lock.model}`,
		present: false,
		authConfigured: false,
	};
}

function savedGatewayIds(): Set<string> {
	return new Set(readOpenAiCompatibleGateways().gateways.map((gateway) => gateway.id));
}

function buildPersistentAgentAiProfileDiagnostic(registry: ModelRegistry, profileId: PersistentAgentAiProfileId, activeProfileId: PersistentAgentAiProfileId = DEFAULT_PERSISTENT_AGENT_AI_PROFILE_ID, resolvedProfile?: PersistentAgentAiProfile, gatewayIds?: ReadonlySet<string>): PersistentAgentAiProfileDiagnostic {
	// Resolve once and thread through: profile resolution hits the profile
	// files on disk, and this builder runs for every profile per status call.
	const profile: PersistentAgentAiProfile = resolvedProfile ?? getPersistentAgentAiProfile(profileId);
	const providerAuth = registry.getProviderAuthStatus(profile.providerId);
	const requiredModels = buildProfileRequiredModelLocks(profile).map((lock) => profileModelDiagnostic(registry, lock));
	const persistentRoomModels = profile.processes.persistentRoom.map((modelLock) =>
		profileModelDiagnostic(registry, { ...modelLock, purpose: "persistent-room" }),
	);
	const absorbModel = profileDiagnosticForModel(requiredModels, profile.processes.absorb);
	const structuralReviewModel = profileDiagnosticForModel(requiredModels, profile.processes.structuralReview);
	const persistentRoomReady = persistentRoomModels.length > 0 && persistentRoomModels.every(profileModelReady);
	const absorbReady = profileModelReady(absorbModel);
	const structuralReviewReady = profileModelReady(structuralReviewModel);
	const issues: string[] = [];

	if (!providerAuth.configured) issues.push(`${profile.label} provider is not connected.`);
	// A sign-in gone is shown only on a stored sign-in: the same provider can hold a key instead.
	const refusal = providerAuth.configured ? keyRefusalOf(profile.providerId) : undefined;
	const keyRefused = refusal === "signed-out" && registry.authStorage.get(profile.providerId)?.type !== "oauth" ? undefined : refusal;
	const keyRefusedSentence = keyRefused ? keyRefusedSetupSentence(keyRefused) : null;
	if (keyRefusedSentence) issues.push(keyRefusedSentence);
	for (const model of requiredModels) {
		if (!model.present) issues.push(`Mapped model not found: ${model.provider}/${model.model}.`);
		else if (!model.authConfigured) issues.push(`Mapped model provider is not connected: ${model.provider}/${model.model}.`);
	}
	if (!persistentRoomReady) issues.push(`${profile.label} persistent-room models are not ready.`);
	if (!absorbReady) issues.push(`${profile.label} absorb model is not ready.`);
	if (!structuralReviewReady) issues.push(`${profile.label} structural-review model is not ready.`);

	const ready = providerAuth.configured && requiredModels.every(profileModelReady) && persistentRoomReady && absorbReady && structuralReviewReady;
	// Gateway-ness is a fact of the store now, not of one reserved id: any
	// saved gateway is a gateway, and the row menu offers the gateway actions
	// for whichever one it belongs to.
	const kind = isCustomAiProfileId(profile.id) ? "custom" : (gatewayIds ?? savedGatewayIds()).has(profile.id) ? "gateway" : "builtin";
	return {
		id: profile.id,
		label: profile.label,
		kind,
		provider: {
			id: profile.providerId,
			configured: providerAuth.configured,
			source: providerAuth.source,
			label: providerAuth.label,
			...(keyRefused ? { keyRefused } : {}),
		},
		active: profileId === activeProfileId,
		ready,
		message: keyRefusedSentence ?? (ready ? null : `${profile.label} profile setup needed`),
		issues,
		requiredModels,
		processes: {
			persistentRoom: { ready: persistentRoomReady, models: persistentRoomModels },
			absorb: { ready: absorbReady, model: absorbModel },
			structuralReview: { ready: structuralReviewReady, model: structuralReviewModel },
		},
	};
}

function buildPersistentAgentAiProfileSelectionStatus(registry = getWebChatModelRegistry()): PersistentAgentAiProfileSelectionStatus {
	const state = readPersistentAgentAiProfileState();
	const customProfileRead = readCustomAiProfiles();
	// One gateway-store read for the whole status, not one per profile row.
	const gatewayIds = savedGatewayIds();
	const profiles = getAvailablePersistentAgentAiProfiles().map((profile) =>
		buildPersistentAgentAiProfileDiagnostic(registry, profile.id, state.profileId, profile, gatewayIds),
	);
	const activeProfile = profiles.find((profile) => profile.id === state.profileId) ?? buildPersistentAgentAiProfileDiagnostic(registry, DEFAULT_PERSISTENT_AGENT_AI_PROFILE_ID, state.profileId, undefined, gatewayIds);
	return {
		activeProfileId: state.profileId,
		activeProfile,
		profiles,
		state: {
			path: browserSafeLocalPath(state.path),
			source: state.source,
			message: state.message,
		},
		customProfiles: {
			path: browserSafeLocalPath(customProfileRead.path),
			errors: customProfileRead.errors,
		},
	};
}

/**
 * Model lock for the fresh thread after a Forget or a Remember: the room's
 * conversation model as it resolves now, so a pick made while the old
 * conversation ran is the one the next conversation starts on. Null inherits
 * the old thread's lock, when the room's model cannot run. Best-effort by
 * design: neither boundary may fail on this. The prepared conversation
 * re-resolves at its first boot (see refreshEmptyPersistentAgentThreadModel),
 * and refuses there while the room's model cannot run.
 */
function resolveBoundaryFreshThreadModel(agentId: string, _conversationId: string): PersistentAgentModelLock | null {
	try {
		return resolveRoomModel(agentId, "conversation").effective;
	} catch {
		return null;
	}
}

/** The room's conversation model for a new conversation, or a plain refusal: its model cannot run, or no provider is ready. */
function roomConversationModelForNewThread(agentId: string, catalog = createRoomModelCatalog()): PersistentAgentModelLock {
	const resolved = resolveRoomModel(agentId, "conversation", catalog);
	const refusal = roomModelRefusal(resolved, "conversation", catalog);
	if (refusal) throw refusal;
	// On a shared server nobody signs in, and only the admin adds a model.
	if (!resolved.effective) throw Object.assign(new Error(isSharedServer() ? "No AI model is set up on this server yet. Ask your admin to add one in Settings, AI setup, then open the room again." : "No AI provider is signed in. Sign in in Settings, AI setup, then open the room again."), { statusCode: 409 });
	return resolved.effective;
}

/**
 * The model a room's session binds on, decided by the server: a saved
 * conversation binds on its own lock; a conversation not saved yet binds on
 * the room's conversation model. A model the client names in the socket query
 * is only a hint and never decides; a differing one is logged. The bound
 * model must be in the registry with its provider signed in.
 */
function resolvePersistentAgentBindModel(registry: ModelRegistry, params: URLSearchParams, options: { agentId: string; conversationId?: string }) {
	const thread = options.conversationId ? getPersistentAgentThread(options.agentId, options.conversationId) : null;
	const lock = thread?.model ?? roomConversationModelForNewThread(options.agentId);
	const hintProvider = String(params.get("modelProvider") ?? params.get("provider") ?? "").trim();
	const hintModel = String(params.get("model") ?? params.get("modelId") ?? "").trim();
	if (hintProvider && hintModel && (hintProvider !== lock.provider || hintModel !== lock.model)) {
		app.log.info({ roomId: options.agentId, conversationId: options.conversationId, hint: `${hintProvider}/${hintModel}`, bound: `${lock.provider}/${lock.model}` }, "room session binds on the server's model, not the one the client named");
	}
	const model = registry.find(lock.provider, lock.model);
	if (!model) throw new Error(`model not found: ${lock.provider}/${lock.model}`);
	if (!registry.hasConfiguredAuth(model)) {
		// Named so the client stops redialing and points to the two ways on.
		const name = roomModelLockPayload(lock, registry)!.name;
		// The refusal class, so every route that binds (the first bind, the
		// rebind before a message, an adopted turn's rebuild) stands down with
		// the one notice instead of a line.
		const gone = providerSignsIn(lock.provider) ? "signed-out" : "key-missing";
		const message = isSharedServer()
			? `${webChatProviderLabel(lock.provider)} ${sharedCredentialState(gone)}, so this conversation cannot continue on ${name}. Continue it on another model in Room settings, Model, or tell your admin.`
			: `${providerCredentialClause(webChatProviderLabel(lock.provider), gone)}, so this conversation cannot continue on ${name}. ${credentialGoneWords(gone).again} in Settings, AI setup, or continue it on another model in Room settings, Model.`;
		throw new RoomModelUnavailableError(message, "signed-out", lock.provider);
	}
	return model;
}

/**
 * The model a restricted worker runs on: Memorize, Review, consult, the
 * file specialists. Every one of them is defined by what it may not reach, so
 * the model arrives here with its web-search permission removed. A gateway may
 * legitimately point its maintenance model at one of its room models, and that
 * model may be marked for provider-side search; the mark belongs to the room,
 * not to a worker that was told to answer from memory.
 */
function resolveConfiguredWorkerModel(registry: ModelRegistry, modelLock: { provider: string; model: string }, label: string) {
	const model = registry.find(modelLock.provider, modelLock.model);
	if (!model) throw new Error(`${label} not found: ${modelLock.provider}/${modelLock.model}`);
	if (!registry.hasConfiguredAuth(model)) throw new Error(`${label} provider not connected: ${modelLock.provider}`);
	return stripProviderSearchFromModel(model);
}

function profileStatusPayload(profile: PersistentAgentAiProfile) {
	return {
		id: profile.id,
		label: profile.label,
		provider: {
			id: profile.providerId,
			label: profile.providerLabel,
		},
	};
}

/**
 * The model a room's memory work runs on (Memorize, Review, and the consults
 * and specialists that read its memory): the room's memory row, resolved. The
 * profile is the one that offers that model, for the status line.
 */
function roomMemoryModelSelection(agentId: string, consultedRoomName?: string): { profile: PersistentAgentAiProfile; modelLock: PersistentAgentModelLock } {
	const catalog = createRoomModelCatalog();
	const resolved = resolveRoomModel(agentId, "memory", catalog);
	const refusal = roomModelRefusal(resolved, "memory", catalog, consultedRoomName);
	// The room's own Memory model: Remember, Memorize and Review show the one shared notice, with its buttons.
	if (refusal && !consultedRoomName && resolved.chosen) throw new ModelUnreachableError(resolved.reason === "signed-out" ? "signed-out" : "not-offered", { provider: resolved.chosen.provider, model: resolved.chosen.model });
	if (refusal) throw refusal;
	if (!resolved.effective) throw Object.assign(new Error(isSharedServer() ? "No AI model is set up on this server yet, so this room's memory work has none. Ask your admin to add one in Settings, AI setup." : "No AI provider is signed in, so this room's memory work has no model. Sign in in Settings, AI setup."), { statusCode: 409 });
	const lock = resolved.effective;
	const profile = getAvailablePersistentAgentAiProfiles().find((candidate) => candidate.providerId === lock.provider) ?? readPersistentAgentAiProfileState().profile;
	return { profile, modelLock: lock };
}

/** Refuses a Memory model too small for a memory budget (minimumMemoryWindow, the fit guards' own formula), with the sentence `refusal` writes from its name. */
function refuseMemoryModelTooSmall(lock: PersistentAgentModelLock, budgetTokens: number, catalog: RoomModelCatalog, statusCode: number, refusal: (model: string) => string): void {
	if (memoryModelHoldsBudget(lock, budgetTokens, memoryModelWindow(lock, catalog.registry))) return;
	throw new MemoryModelTooSmallError(refusal(roomModelNames(catalog).model(lock)), statusCode);
}

/** Refuses raising a room's memory budget past what its Memory model holds; keeping or lowering it never is, and a budget out of range gets the settings' own refusal. */
function refuseMemoryBudgetRaise(agentId: string, budgetTokens: unknown): void {
	if (typeof budgetTokens !== "number" || !Number.isFinite(budgetTokens) || budgetTokens < MEMORY_BUDGET_MIN_TOKENS || budgetTokens > MEMORY_BUDGET_MAX_TOKENS) return;
	if (budgetTokens <= readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens) return;
	const catalog = createRoomModelCatalog();
	const lock = resolveRoomModel(agentId, "memory", catalog).chosen;
	if (lock) refuseMemoryModelTooSmall(lock, budgetTokens, catalog, 400, (model) => memoryBudgetNeedsLargerModelSentence(budgetTokens, model));
}

/** The refusal refuseMemoryBudgetRaise would throw for this budget now, or null when a save would pass it. */
function memoryBudgetRaiseRefusal(agentId: string, budgetTokens: unknown): string | null {
	try {
		refuseMemoryBudgetRaise(agentId, budgetTokens);
		return null;
	} catch (e) {
		if (e instanceof MemoryModelTooSmallError) return e.message;
		throw e;
	}
}

/**
 * The room's Memory model for Memorize and Review, refused at their start when
 * its window no longer holds the room's memory (a gateway whose window changed
 * after the pick): the model notice before any call, instead of pages that
 * climb the ladder one by one.
 */
function roomMemoryModelForUpkeep(agentId: string): PersistentAgentModelLock {
	const { modelLock } = roomMemoryModelSelection(agentId);
	refuseMemoryModelTooSmall(modelLock, readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens, createRoomModelCatalog(), 409, (model) => memoryModelTooSmallSentence(model, "maintenance"));
	return modelLock;
}

function resolveAbsorbModel(registry: ModelRegistry, modelLock: { provider: string; model: string }) {
	return resolveConfiguredWorkerModel(registry, modelLock, "absorb model");
}

function resolveConsultModel(registry: ModelRegistry, modelLock: { provider: string; model: string }) {
	return resolveConfiguredWorkerModel(registry, modelLock, "consult model");
}

// Specialists ride the same profile-level lock as consults (visuals contract
// D6); the per-template override slot is reserved, not implemented.
function resolveSpecialistModel(registry: ModelRegistry, modelLock: { provider: string; model: string }) {
	return resolveConfiguredWorkerModel(registry, modelLock, "specialist model");
}

// Fixed worker trigger (house pattern): the question lives in the system
// prompt, so the trigger carries no user content.
const CONSULT_TRIGGER_PROMPT = "Answer the consult question now, from your memory only.";

// Arms the prompt overflow guards (consult + Memorize/Review workers):
// the room's memory is the prompt material and cannot be elided honestly, so
// oversize prompts refuse with guidance instead of running against a
// truncated memory or a provider error.
function consultModelWindow(modelLock: { provider: string; model: string }) {
	const registry = getWebChatModelRegistry();
	const model = registry.find(modelLock.provider, modelLock.model);
	if (!model) throw new Error(`model not found: ${modelLock.provider}/${modelLock.model}`);
	return { contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens };
}

function resolveStructuralReviewModel(registry: ModelRegistry, modelLock: { provider: string; model: string }) {
	return resolveConfiguredWorkerModel(registry, modelLock, "structural review model");
}

// A maintenance call is one prompt and one reply on a model that is generating
// at a few dozen tokens a second; eight minutes is far past the slowest healthy
// run and well short of a user giving up. Past it the step fails with a reason
// instead of holding the room open on a stream that is not coming back.
const MAINTENANCE_WORKER_TIMEOUT_MS = 8 * 60 * 1000;

async function runIsolatedLifecycleWorker<TModelLock extends { provider: string; model: string }>(
	prompt: string,
	modelLock: TModelLock,
	resolveExpectedModel: (registry: ModelRegistry, modelLock: TModelLock) => any,
	workerLabel: string,
	triggerPrompt: string,
	emptyTextError: string,
	attribution?: { agent: string; kind: UsageKind },
	// A step that can be cancelled (the Memorize run) passes its signal, and a
	// step with its own ceiling passes that; everything else keeps the shared
	// maintenance timeout and no abort hook, exactly as before. A mechanical
	// step asks for less reasoning: the fold for low, single-shot transforms whose
	// reasoning tokens would count against the output cap and starve the reply;
	// the probe and the placement calls for none, a few words each.
	// A step with its own output cap (the fold) passes it too.
	// A call names its kind: its prompt cache follows the policy, and a Memory model call's usage row says which call it was.
	options?: { signal?: AbortSignal; timeoutMs?: number; thinkingLevel?: "low" | "off"; maxTokens?: number; callKind?: CallKind },
) {
	const callKind = options?.callKind;
	const memoryCallKind = callKind && isMemoryCallKind(callKind) ? callKind : undefined;
	let result: Awaited<ReturnType<typeof runIsolatedPersistentAgentWorker>>;
	try {
		result = await runIsolatedPersistentAgentWorker({
			workerSystemPrompt: prompt,
			triggerPrompt,
			modelLock,
			resolveExpectedModel,
			workerLabel,
			emptyTextError,
			cwd: REPO_ROOT,
			agentDir: getAgentDir(),
			modelRegistry: getWebChatModelRegistry(),
			timeoutMs: options?.timeoutMs ?? MAINTENANCE_WORKER_TIMEOUT_MS,
			// A stream that stops coming is caught in 90 seconds, not at the ceiling.
			idleTimeoutMs: MODEL_CALL_IDLE_TIMEOUT_MS,
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			...(options?.maxTokens ? { maxTokens: options.maxTokens } : {}),
			...(callKind ? { callKind } : {}),
		});
	} catch (error) {
		// A failed call is paid for too: what it used before it failed is recorded, when it moved tokens.
		logProviderCallFailed({ room: attribution?.agent, callKind, provider: modelLock.provider, model: modelLock.model }, error);
		const usage = (error as { usage?: Parameters<typeof recordWorkerUsage>[3] })?.usage;
		if (attribution && usage && !usageMovedNothing(usage)) recordWorkerUsage(attribution.agent, attribution.kind, modelLock, usage, memoryCallKind);
		throw error;
	}
	if (attribution) recordWorkerUsage(attribution.agent, attribution.kind, modelLock, result.usage, memoryCallKind);
	return result;
}

/**
 * The tiny fixed question that tells "the model is down" from "this request
 * failed": the same one Memorize asks, on the same model, with its own short
 * ceiling. It answering means the model is up.
 */
function memoryModelProbe<TModelLock extends { provider: string; model: string }>(agentId: string, modelLock: TModelLock, resolveExpectedModel: (registry: ModelRegistry, modelLock: TModelLock) => any, signal?: AbortSignal): Promise<unknown> {
	return runIsolatedLifecycleWorker(ABSORB_PROBE_PROMPT, modelLock, resolveExpectedModel, "memory model probe worker", ABSORB_PROBE_PROMPT, "the probe worker produced no text", { agent: agentId, kind: "upkeep" }, { timeoutMs: ABSORB_PROBE_TIMEOUT_MS, thinkingLevel: "off", callKind: "probe", ...(signal ? { signal } : {}) });
}

/**
 * A Memory model call with the shared patience (model-call-causes.ts): busy is
 * waited out, the wait reported through `onWait`, and a model that cannot be
 * reached ends in the one notice. With `probe`, a failure that outlasts the
 * patience asks the probe; with "first-call" (Memorize's fold, which has its
 * own probe for that) the failure is handed back marked spent, and only a first
 * call that cannot connect asks it.
 */
function runPatientMemoryWorker<TModelLock extends { provider: string; model: string; label?: string }>(
	agentId: string,
	prompt: string,
	modelLock: TModelLock,
	resolveExpectedModel: (registry: ModelRegistry, modelLock: TModelLock) => any,
	workerLabel: string,
	triggerPrompt: string,
	emptyTextError: string,
	options: { signal?: AbortSignal; timeoutMs?: number; thinkingLevel?: "low" | "off"; maxTokens?: number; callKind?: MemoryCallKind; onWait?: (wait: PatienceWait | null) => void } | undefined,
	probe: boolean | "first-call",
) {
	const { onWait, ...workerOptions } = options ?? {};
	return callWithPatience(
		() => runIsolatedLifecycleWorker(prompt, modelLock, resolveExpectedModel, workerLabel, triggerPrompt, emptyTextError, { agent: agentId, kind: "upkeep" }, workerOptions),
		{
			model: modelLock,
			...(onWait ? { onWait } : {}),
			...(workerOptions.signal ? { signal: workerOptions.signal } : {}),
			...(probe === true ? { probe: (signal?: AbortSignal) => memoryModelProbe(agentId, modelLock, resolveExpectedModel, signal) } : {}),
			...(probe === "first-call" ? { connectProbe: (signal?: AbortSignal) => memoryModelProbe(agentId, modelLock, resolveExpectedModel, signal) } : {}),
		},
	);
}

function curatedModelOptions(available: any[], curatedModels: Record<string, string[]>): WebChatModelOption[] {
	const options: WebChatModelOption[] = [];
	for (const [provider, preferredIds] of Object.entries(curatedModels)) {
		for (const modelId of preferredIds) {
			const model = available.find((candidate: any) => candidate.provider === provider && candidate.id === modelId);
			if (!model) continue;
			const contextWindow = modelContextWindow(model);
			options.push({ provider, model: model.id, label: webChatModelLabel(provider, model), recommended: modelId === preferredIds[0], ...(contextWindow ? { contextWindow } : {}) });
		}
	}
	return options;
}

export { CONSULT_TRIGGER_PROMPT, MAINTENANCE_WORKER_TIMEOUT_MS, buildPersistentAgentAiProfileDiagnostic, buildPersistentAgentAiProfileSelectionStatus, consultModelWindow, curatedModelOptions, memoryBudgetRaiseRefusal, memoryModelProbe, profileStatusPayload, refuseMemoryBudgetRaise, refuseMemoryModelTooSmall, resolveAbsorbModel, resolveBoundaryFreshThreadModel, resolveConfiguredWorkerModel, resolveConsultModel, resolvePersistentAgentBindModel, resolveSpecialistModel, resolveStructuralReviewModel, roomConversationModelForNewThread, roomMemoryModelForUpkeep, roomMemoryModelSelection, runIsolatedLifecycleWorker, runPatientMemoryWorker };
