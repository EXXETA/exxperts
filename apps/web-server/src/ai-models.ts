import { ANTHROPIC_API_KEY_PROVIDER, ModelRegistry, clampThinkingLevel, getThinkingLevelLadder, resolveThinkingLevelRung, AuthStorage } from "@exxeta/exxperts-runtime";
import { listPersistentAgents } from "./persistent-agents.js";
import { readPersistentRoomMaintenanceSettings } from "./persistent-room-maintenance-settings.js";
import { rememberSentenceModelName } from "./checkpoint-compression.js";
import { type RoomModelResolution, type RoomModelCatalog, type RoomModelNames, type RoomModelTask, type RoomModelUnavailableError, roomModelUnavailableError, providerSignsIn, memoryModelHoldsBudget, createRoomModelCatalog, resolveAiDefault, resolveRoomModel, readRoomModels, ROOM_MODEL_TASKS, parseModelLock } from "./room-models.js";
import { providerCredentialClause, credentialGoneWords, sharedCredentialState } from "./model-not-offered.js";
import { isSharedServer } from "./server-hooks.js";
import { type RoomEffortLevel, effectiveConversationEffortChoice, writeConversationEffortChoice, writePersistentRoomEffortChoice } from "./persistent-room-effort-settings.js";
import { type PersistentAgentAiProfileId, getPersistentRoomModelLocks, OPENAI_COMPATIBLE_PROVIDER_ID, type PersistentAgentModelLock } from "./persistent-agent-ai-profiles.js";
import { GATEWAY_PROVIDER_ID_PREFIX } from "./openai-compatible-gateways.js";
import type { PersistentAgentAiProfileStateSource } from "./persistent-agent-ai-profile-state.js";
import type { KeyRefusal } from "./model-call-causes.js";
import { app } from "./server-app.js";

function modelLocksToCuratedModels(modelLocks: Array<{ provider: string; model: string }>): Record<string, string[]> {
	const curatedModels: Record<string, string[]> = {};
	for (const modelLock of modelLocks) {
		curatedModels[modelLock.provider] ??= [];
		curatedModels[modelLock.provider].push(modelLock.model);
	}
	return curatedModels;
}

function persistentAgentRoomCuratedModels(profileId: PersistentAgentAiProfileId): Record<string, string[]> {
	return modelLocksToCuratedModels(getPersistentRoomModelLocks(profileId));
}

const WEB_CHAT_PROVIDER_LABELS: Record<string, string> = {
	"openai-codex": "ChatGPT Plus/Pro",
	openai: "OpenAI",
	anthropic: "Anthropic / Claude",
	[ANTHROPIC_API_KEY_PROVIDER]: "Claude API key",
	"github-copilot": "GitHub Copilot",
	"openai-compatible": "OpenAI-compatible gateway",
	google: "Google / Gemini",
	openrouter: "OpenRouter",
};

const WEB_CHAT_MODEL_LABELS: Record<string, Record<string, string>> = {
	anthropic: {
		"claude-opus-5-5": "Opus 5.5",
		"claude-fable-5-1": "Fable 5.1",
		"claude-sonnet-5-5": "Sonnet 5.5",
		"claude-haiku-5-5": "Haiku 5.5",
		"claude-sonnet-5": "Sonnet 5",
		"claude-haiku-4-5": "Haiku 4.5",
		"claude-opus-5": "Opus 5",
		"claude-opus-4-8": "Opus 4.8",
		"claude-fable-5": "Fable 5",
		"claude-sonnet-4-6": "Sonnet 4.6",
		"claude-opus-4-7": "Opus 4.7",
		"claude-opus-4-6": "Opus 4.6",
	},
};

// The key provider serves the Anthropic list, so it shows the same names.
WEB_CHAT_MODEL_LABELS[ANTHROPIC_API_KEY_PROVIDER] = WEB_CHAT_MODEL_LABELS.anthropic;

const DEFAULT_AGENT_SESSION_MAX_TOKENS_CAP = 32000;

type WebChatModelSelection = { provider: string; model: string };

type WebChatModelOption = WebChatModelSelection & { label: string; recommended?: boolean; contextWindow?: number };

type RegistryModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

type ContextHealthZone = "green" | "yellow" | "red" | "unknown";

type ContextHealthStatus = {
	tokens: number | null;
	contextWindow: number | null;
	checkpointTokens: number;
	checkpointPercent: number | null;
	zone: ContextHealthZone;
	source: "runtime-context-usage" | "unknown";
};

// The meter's 100%, after which Remember is advised: two fifths of the model's
// window, so a 1M model is not called full at an eighth of what it reads and a
// 128K one is called full before the runtime shortens the conversation (at the
// window minus its reserve). A reading with no window keeps the fixed size.
const CONTEXT_CHECKPOINT_SHARE_OF_WINDOW = 0.4;
const CONTEXT_CHECKPOINT_TOKENS_WITHOUT_WINDOW = 125_000;

function contextCheckpointTokens(contextWindow: number | null): number {
	return contextWindow == null ? CONTEXT_CHECKPOINT_TOKENS_WITHOUT_WINDOW : Math.round(contextWindow * CONTEXT_CHECKPOINT_SHARE_OF_WINDOW);
}

type ProfileModelDiagnostic = {
	key?: string;
	provider: string;
	model: string;
	label: string;
	purpose?: string;
	present: boolean;
	authConfigured: boolean;
	api?: string;
	contextWindow?: number;
	maxTokens?: number;
	effectiveDefaultMaxTokens?: number;
	compat?: {
		supportsStore?: boolean;
		supportsDeveloperRole?: boolean;
		supportsOpenAIPromptCacheRetention?: boolean;
		supportsAnthropicCacheControlTtl?: boolean;
		supportsLongCacheRetention?: boolean;
		cacheControlFormat?: string;
		maxTokensField?: string;
	};
};

type PersistentAgentAiProfileDiagnostic = {
	id: PersistentAgentAiProfileId;
	label: string;
	kind: "builtin" | "gateway" | "custom";
	provider: {
		id: string;
		configured: boolean;
		source?: string;
		label?: string;
		/** The service refused the saved key, or found the sign-in gone, at the last call; `ready` still says only that it is set up. */
		keyRefused?: KeyRefusal;
	};
	active: boolean;
	ready: boolean;
	message: string | null;
	issues: string[];
	requiredModels: ProfileModelDiagnostic[];
	processes: {
		persistentRoom: { ready: boolean; models: ProfileModelDiagnostic[] };
		absorb: { ready: boolean; model: ProfileModelDiagnostic };
		structuralReview: { ready: boolean; model: ProfileModelDiagnostic };
	};
};

type PersistentAgentAiProfileSelectionStatus = {
	activeProfileId: PersistentAgentAiProfileId;
	activeProfile: PersistentAgentAiProfileDiagnostic;
	profiles: PersistentAgentAiProfileDiagnostic[];
	state: {
		path: string;
		source: PersistentAgentAiProfileStateSource;
		message: string | null;
	};
	customProfiles: {
		path: string;
		errors: string[];
	};
};

function isGatewayProviderId(provider: string): boolean {
	return provider === OPENAI_COMPATIBLE_PROVIDER_ID || provider.startsWith(GATEWAY_PROVIDER_ID_PREFIX);
}

const providerDisplayNameCache = new Map<string, string>();

function webChatProviderLabel(provider: string): string {
	// A gateway carries the name the person gave it, so the registered name
	// wins for gateway providers; the curated table only speaks for them when
	// the gateway is gone and nothing is registered under the id any more.
	const curated = isGatewayProviderId(provider) ? undefined : WEB_CHAT_PROVIDER_LABELS[provider];
	if (curated) return curated;
	let displayName = providerDisplayNameCache.get(provider);
	if (!displayName) {
		displayName = getWebChatModelRegistry().getProviderDisplayName(provider);
		// The raw-id fallback means the provider is not registered (yet) — don't
		// pin it, so a name set by a later gateway/custom setup is picked up.
		if (displayName !== provider) providerDisplayNameCache.set(provider, displayName);
	}
	return displayName === provider ? WEB_CHAT_PROVIDER_LABELS[provider] ?? displayName : displayName;
}

function webChatModelLabel(provider: string, model: any): string {
	const modelName = WEB_CHAT_MODEL_LABELS[provider]?.[model?.id] ?? String(model?.name ?? model?.id ?? "").trim();
	return `${webChatProviderLabel(provider)} — ${modelName || model.id}`;
}

function modelContextWindow(model: any): number | undefined {
	const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
	return contextWindow && contextWindow > 0 ? contextWindow : undefined;
}

function modelStatusPayload(model: any) {
	if (!model) return null;
	const contextWindow = modelContextWindow(model);
	return { provider: model.provider, model: model.id, label: webChatModelLabel(model.provider, model), ...(contextWindow ? { contextWindow } : {}) };
}

// --- Model per room: payloads ------------------------------------------------------
// The same shapes for a room's rows, the defaults' rows and the status payload:
// what is stored, what the row is set to, what runs, and why nothing does, with
// the names a person reads and the refusal every surface shows.

type RoomModelLockPayload = { provider: string; model: string; label: string; name: string; providerLabel: string; contextWindow?: number };

type RoomModelRowPayload = { stored: RoomModelLockPayload | null; chosen: RoomModelLockPayload | null; effective: RoomModelLockPayload | null; source: RoomModelResolution["source"]; reason?: RoomModelResolution["reason"]; keyGone?: true; refusal?: string; tooSmall?: MemoryModelTooSmallPayload[]; default?: RoomModelLockPayload | null };

/** A Memory model the picker greys out: too small for this room's memory, or (on the defaults) for the room named. */
type MemoryModelTooSmallPayload = { provider: string; model: string; room?: string };

/** A provider's name as AI setup shows it; the curated table when the catalog does not know it. */
function roomModelProviderLabel(providerId: string, catalog?: RoomModelCatalog): string {
	return catalog?.providers.find((provider) => provider.providerId === providerId)?.label ?? webChatProviderLabel(providerId);
}

function roomModelLockPayload(lock: PersistentAgentModelLock | null, registry: ModelRegistry, catalog?: RoomModelCatalog): RoomModelLockPayload | null {
	if (!lock) return null;
	const model = registry.find(lock.provider, lock.model);
	const contextWindow = modelContextWindow(model);
	// A model the registry no longer knows keeps its bare id as the label;
	// the provider rides beside it, so nothing has to be split back apart.
	const label = model ? webChatModelLabel(lock.provider, model) : lock.model;
	return {
		provider: lock.provider,
		model: lock.model,
		label,
		// The name the Model pickers show, so every notice spells the model one way.
		name: rememberSentenceModelName({ provider: lock.provider, model: lock.model, label }),
		providerLabel: roomModelProviderLabel(lock.provider, catalog),
		...(contextWindow ? { contextWindow } : {}),
	};
}

/** The names a room model refusal reads, as the Model pickers show them. */
function roomModelNames(catalog: RoomModelCatalog, registry: ModelRegistry = catalog.registry): RoomModelNames {
	return { model: (lock) => roomModelLockPayload(lock, registry, catalog)!.name, provider: (providerId) => roomModelProviderLabel(providerId, catalog) };
}

/** The refusal when a room's row cannot run its chosen model (another room's, by name); nothing else runs in its place. */
function roomModelRefusal(resolution: RoomModelResolution, task: RoomModelTask, catalog: RoomModelCatalog, roomName?: string): RoomModelUnavailableError | null {
	return roomModelUnavailableError(resolution, task, roomModelNames(catalog), roomName ? { room: roomName } : "room");
}

function roomModelRowPayload(resolution: RoomModelResolution, task: RoomModelTask, registry: ModelRegistry, catalog: RoomModelCatalog, of: "room" | "defaults"): RoomModelRowPayload {
	const refusal = roomModelUnavailableError(resolution, task, roomModelNames(catalog, registry), of);
	return {
		stored: roomModelLockPayload(resolution.stored, registry, catalog),
		chosen: roomModelLockPayload(resolution.chosen, registry, catalog),
		effective: roomModelLockPayload(resolution.effective, registry, catalog),
		source: resolution.source,
		...(resolution.reason ? { reason: resolution.reason } : {}),
		...(resolution.reason === "signed-out" && resolution.chosen && !providerSignsIn(resolution.chosen.provider) ? { keyGone: true } : {}),
		...(refusal ? { refusal: refusal.message } : {}),
	};
}

/** The offered Memory models that cannot hold one of these memory budgets (the same check that refuses them), each with the first room it cannot hold when one is named. */
function memoryModelsTooSmall(catalog: RoomModelCatalog, budgets: Array<{ budgetTokens: number; room?: string }>): MemoryModelTooSmallPayload[] {
	return catalog.providers.flatMap((provider) => provider.memory.flatMap((lock) => {
		const window = memoryModelWindow(lock, catalog.registry);
		const blocked = budgets.find((budget) => !memoryModelHoldsBudget(lock, budget.budgetTokens, window));
		return blocked ? [{ provider: lock.provider, model: lock.model, ...(blocked.room ? { room: blocked.room } : {}) }] : [];
	}));
}

function roomModelsPayload(agentId: string, catalog = createRoomModelCatalog(), registry = catalog.registry): Record<RoomModelTask, RoomModelRowPayload> {
	const tooSmall = memoryModelsTooSmall(catalog, [{ budgetTokens: readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens }]);
	// The default each row goes back to when the room's own pick is cleared.
	const fallback = (task: RoomModelTask) => { const resolved = resolveAiDefault(task, catalog); return roomModelLockPayload(resolved.chosen ?? resolved.effective, registry, catalog); };
	return {
		conversation: { ...roomModelRowPayload(resolveRoomModel(agentId, "conversation", catalog), "conversation", registry, catalog, "room"), default: fallback("conversation") },
		memory: { ...roomModelRowPayload(resolveRoomModel(agentId, "memory", catalog), "memory", registry, catalog, "room"), tooSmall, default: fallback("memory") },
	};
}

function aiDefaultsPayload(catalog = createRoomModelCatalog(), registry = catalog.registry): Record<RoomModelTask, RoomModelRowPayload> {
	// A Memory default must hold the memory of every room on the default, as the save checks.
	const onDefault = listPersistentAgents().filter((room) => !readRoomModels(room.id)?.memory).map((room) => ({ budgetTokens: readPersistentRoomMaintenanceSettings(room.id).memoryBudgetTokens, room: room.displayName || room.id }));
	return {
		conversation: roomModelRowPayload(resolveAiDefault("conversation", catalog), "conversation", registry, catalog, "defaults"),
		memory: { ...roomModelRowPayload(resolveAiDefault("memory", catalog), "memory", registry, catalog, "defaults"), tooSmall: memoryModelsTooSmall(catalog, onDefault) },
	};
}

/** A PUT body's rows: a lock sets the row, null clears it, a missing key leaves it. Every lock set must be able to run now. */
function parseRoomModelPatch(body: any, catalog: RoomModelCatalog, options: { allowClear: boolean }): Partial<Record<RoomModelTask, PersistentAgentModelLock | null>> {
	const patch: Partial<Record<RoomModelTask, PersistentAgentModelLock | null>> = {};
	for (const task of ROOM_MODEL_TASKS) {
		if (!(task in (body ?? {}))) continue;
		const raw = body[task];
		if (raw === null) {
			if (!options.allowClear) throw Object.assign(new Error(`the ${task} default cannot be empty`), { statusCode: 400 });
			patch[task] = null;
			continue;
		}
		const lock = parseModelLock(raw);
		const available = catalog.availability(lock, task);
		if (!available.ok) {
			const gone = providerSignsIn(lock.provider) ? "signed-out" : "key-missing";
			const message = available.reason === "signed-out"
				? isSharedServer()
					? `${webChatProviderLabel(lock.provider)} ${sharedCredentialState(gone)}; choose another model, or tell your admin.`
					: `${providerCredentialClause(webChatProviderLabel(lock.provider), gone)}; ${credentialGoneWords(gone).again.toLowerCase()} in Settings, AI setup, then choose this model.`
				: `${lock.model} is not offered for ${task === "memory" ? "memory work" : "rooms"} by ${webChatProviderLabel(lock.provider)}.`;
			throw Object.assign(new Error(message), { statusCode: 400 });
		}
		patch[task] = lock;
	}
	return patch;
}

/**
 * Apply a room's reasoning effort to a bound session, clamped to what the
 * room's locked model can actually do, and report the level that took effect.
 *
 * Deliberately NOT session.setThinkingLevel: that setter clamps the same way
 * but also writes the chosen level into the shared settings file as the
 * machine-wide default, so a room picking "low" for one question would quietly
 * move the CLI's default for every other session. A room's choice is the
 * room's alone, so the clamped level goes straight onto the bound agent state.
 *
 * Only ever called with a level someone EXPLICITLY chose (the conversation,
 * or Room settings' default). A conversation in a room that never chose is
 * left exactly as the session resolved itself, which is the point of having
 * no stored record rather than a stored default.
 */
function applyRoomEffortToSession(session: any, level: RoomEffortLevel): RoomEffortLevel {
	const model = session?.model;
	const effective = (model ? clampThinkingLevel(model, level) : level) as RoomEffortLevel;
	if (session?.agent?.state) session.agent.state.thinkingLevel = effective;
	return effective;
}

/**
 * Record a conversation's chosen effort. A choice the page marks `explicit`
 * is always stored, even when it equals the clamp of the stored level: the
 * person picked it. A level without the mark may be a client handing back the
 * clamped level it was shown, so it is skipped when it equals the clamp of
 * what the conversation already runs at; writing it would flatten the stored
 * preference to its own clamp and lose, forever, a level the current model
 * merely cannot reach.
 *
 * An explicit choice also becomes the room's default, so a new conversation
 * starts at the effort last picked in this room; other conversations keep
 * their own. A level without the mark never moves the default: it may be
 * the clamp handed back.
 *
 * A failed write is logged and swallowed, each on its own. The caller still
 * applies the level to the live session, so the room does what the user just
 * asked for; only its survival past this connection is lost.
 */
function recordConversationEffortChoice(agentId: string, threadId: string, session: any, level: RoomEffortLevel, explicit: boolean): void {
	const stored = effectiveConversationEffortChoice(agentId, threadId);
	const model = session?.model;
	if (!explicit && stored && level === (model ? clampThinkingLevel(model, stored) : stored)) return;
	try { writeConversationEffortChoice(agentId, threadId, level); } catch (error) { app.log.warn({ err: error }, "failed to persist the conversation's reasoning effort"); }
	if (!explicit) return;
	try { writePersistentRoomEffortChoice(agentId, level); } catch (error) { app.log.warn({ err: error }, "failed to persist the room's default reasoning effort"); }
}

/**
 * What the composer should show: the level in force, clamped for display, plus
 * the levels the conversation's LOCKED model can actually do.
 *
 * The level shown is the conversation's own choice, else the room's default,
 * else whatever the session is already running at. The clamp here is for the
 * eye only and must never travel back into storage.
 */
function roomEffortStatusPayload(agentId: string, threadId: string, session: any, chosenLevel?: RoomEffortLevel): { level: RoomEffortLevel; supported: RoomEffortLevel[]; ladder: Array<{ level: RoomEffortLevel; label: string }> } {
	const model = session?.model;
	// `supported` stays for clients that predate the ladder: same tokens, same
	// order, just without the labels or the folding.
	const supported = (session?.getAvailableThinkingLevels?.() ?? []) as RoomEffortLevel[];
	const current = chosenLevel ?? effectiveConversationEffortChoice(agentId, threadId) ?? (session?.thinkingLevel as RoomEffortLevel | undefined) ?? "off";
	return { ...effortOnModel(model, current), supported };
}

/**
 * A level as one model would run it: the model's own dial and the rung of it
 * the level lands on, so the level is always one of the ladder's rungs.
 */
function effortOnModel(model: RegistryModel | undefined, current: RoomEffortLevel): { level: RoomEffortLevel; ladder: Array<{ level: RoomEffortLevel; label: string }> } {
	// The dial the model itself describes: one rung per DISTINCT effort it can
	// produce, each labelled with the provider's own name for that effort. On
	// Anthropic this is what removes the second rung that behaved exactly like
	// the first, since "minimal" and "low" both come out as effort "low".
	const ladder = (model ? getThinkingLevelLadder(model) : []) as Array<{ level: RoomEffortLevel; label: string }>;
	const clamped = (model ? clampThinkingLevel(model, current) : current) as RoomEffortLevel;
	// A folded-away token has to land on the rung that replaced it, and the
	// runtime is the only thing that knows which one that is: the fold is often
	// IMPLICIT, decided by the adapter rather than by a map entry, so matching
	// the stored token against the map would miss it and fall to the bottom of
	// the dial. A room thinking at "low" would then read "off", and a user
	// confirming what the pill said would genuinely stop the thinking.
	const shown = (model ? (resolveThinkingLevelRung(model, clamped)?.level ?? clamped) : clamped) as RoomEffortLevel;
	return { level: shown, ladder };
}

function contextHealthZone(checkpointPercent: number | null): ContextHealthZone {
	if (checkpointPercent == null) return "unknown";
	if (checkpointPercent >= 95) return "red";
	if (checkpointPercent >= 80) return "yellow";
	return "green";
}

function contextHealthFromUsage(usage: { tokens: number | null; contextWindow?: number | null } | undefined, source: ContextHealthStatus["source"]): ContextHealthStatus {
	const tokens = typeof usage?.tokens === "number" && usage.tokens >= 0 ? usage.tokens : null;
	const contextWindow = typeof usage?.contextWindow === "number" && usage.contextWindow > 0 ? usage.contextWindow : null;
	const checkpointTokens = contextCheckpointTokens(contextWindow);
	const checkpointPercent = tokens == null ? null : (tokens / checkpointTokens) * 100;
	return {
		tokens,
		contextWindow,
		checkpointTokens,
		checkpointPercent,
		zone: contextHealthZone(checkpointPercent),
		source,
	};
}

function contextHealthForSession(session: any): ContextHealthStatus {
	const contextUsage = typeof session?.getContextUsage === "function" ? session.getContextUsage() : undefined;
	if (contextUsage) return contextHealthFromUsage(contextUsage, "runtime-context-usage");
	return contextHealthFromUsage({ tokens: null, contextWindow: modelContextWindow(session?.model) ?? null }, "unknown");
}

/**
 * What the chip says the moment a room opens.
 *
 * This used to report an unconditional null, on the belief that a freshly
 * bound session has nothing to measure. It does not: a room's session manager
 * is opened over the thread's own session file AT BIND, so the room's history
 * is in the session's message list before a single frame is sent, and the
 * runtime can size it right there. The chip read "Measuring tokens" purely
 * because nobody asked. Asking is the whole fix.
 *
 * The runtime says two different things with two different values here, and
 * the difference is the whole guard. A room with no history sizes an empty
 * message list and comes back with 0 tokens, which is not a shrug, it is a
 * measurement, and it happens to be the truth: an empty conversation really
 * does hold nothing, and the user pays for the system prompt and the tool
 * definitions only once they send the first message. Showing 0% and letting it
 * jump to the first real reading tells that story honestly.
 *
 * A null is the runtime declining to guess, and the room that has just
 * auto-compacted is why. The only usage it could reuse describes the
 * conversation as it stood BEFORE the compaction, so it offers no count at all
 * until an answer lands on the far side. Passing that silence on as silence is
 * the point: the alternative is a red chip on a room that was just emptied.
 */
function initialContextHealthForSession(session: any): ContextHealthStatus {
	const live = contextHealthForSession(session);
	if (live.tokens != null) return live;
	return contextHealthFromUsage({ tokens: null, contextWindow: modelContextWindow(session?.model) ?? null }, "unknown");
}

function effectiveDefaultMaxTokens(model: RegistryModel | undefined): number | undefined {
	const maxTokens = typeof model?.maxTokens === "number" ? model.maxTokens : undefined;
	return maxTokens && maxTokens > 0 ? Math.min(maxTokens, DEFAULT_AGENT_SESSION_MAX_TOKENS_CAP) : undefined;
}

function getWebChatModelRegistry(): ModelRegistry {
	return ModelRegistry.create(AuthStorage.create());
}

/** A Memory model's window, from the registry the catalog read; undefined when it is not known. */
function memoryModelWindow(lock: PersistentAgentModelLock, registry: ModelRegistry): number | undefined {
	try {
		return modelContextWindow(registry.find(lock.provider, lock.model));
	} catch {
		return undefined;
	}
}

export { aiDefaultsPayload, applyRoomEffortToSession, contextHealthForSession, effectiveDefaultMaxTokens, getWebChatModelRegistry, initialContextHealthForSession, memoryModelWindow, modelContextWindow, modelStatusPayload, parseRoomModelPatch, persistentAgentRoomCuratedModels, providerDisplayNameCache, recordConversationEffortChoice, effortOnModel, roomEffortStatusPayload, roomModelLockPayload, roomModelNames, roomModelRefusal, roomModelsPayload, webChatModelLabel, webChatProviderLabel };
export type { PersistentAgentAiProfileDiagnostic, PersistentAgentAiProfileSelectionStatus, ProfileModelDiagnostic, RegistryModel, WebChatModelOption };
