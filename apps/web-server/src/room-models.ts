// Which model a room talks with, and which model does its memory work.
//
// Two picks per room, each optional: `conversation` (what the room answers
// with) and `memory` (what runs Remember, Memorize and Review for it). A pick
// the room has not made inherits the default, kept next to the saved AI
// profile pointer. A chosen model is never substituted: a pick whose provider
// is signed out, or whose model is no longer offered, is kept as it was stored
// and the room waits for it (every caller refuses with the reason and the way
// out) until it is ready again or another is chosen. The same holds for a row
// on the default. Only when nothing was ever chosen (a first run, before any
// default is stored) does the first model of the first ready provider serve,
// and it is then stored as the default.
//
// "Offered" is the list AI setup lets rooms use for a provider: the curated
// list of a built-in provider, the room models of a gateway or a custom
// provider. The memory row may also use the models a provider names for
// Memorize and Review, so a gateway whose maintenance model is not a room model
// keeps working. A model no list offers is never accepted, whatever a client
// sends.

import fs from "node:fs";
import path from "node:path";
import { ANTHROPIC_API_KEY_PROVIDER, AuthStorage, getAgentDir, ModelRegistry } from "@exxeta/exxperts-runtime";
import { getAvailablePersistentAgentAiProfiles, getPersistentAgentAiProfile, isBuiltInPersistentAgentAiProfileId, isPersistentAgentAiProfileId, isPersistentRoomModelForProfile, persistentAgentModelLocksEqual, type PersistentAgentAiProfile, type PersistentAgentModelLock } from "./persistent-agent-ai-profiles.js";
import { PERSISTENT_AGENT_AI_PROFILE_FILE, readPersistentAgentAiProfileState, readSavedPersistentAgentAiProfileId } from "./persistent-agent-ai-profile-state.js";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";
import { formatTokenLimit } from "./persistent-room-maintenance-settings.js";
import { minimumMemoryWindow } from "./token-estimate.js";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";
import { canonicalModelName, modelOnProvider } from "../../web-ui/src/model-names.js";
import { roomModelUnavailableLine, type RoomModelRefusalOf } from "./model-not-offered.js";

export type RoomModelTask = "conversation" | "memory";
export const ROOM_MODEL_TASKS: readonly RoomModelTask[] = ["conversation", "memory"];

export interface RoomModelsRecord {
	schemaVersion: 1;
	conversation?: PersistentAgentModelLock;
	memory?: PersistentAgentModelLock;
	updatedAt: string;
}

export type AiDefaults = Partial<Record<RoomModelTask, PersistentAgentModelLock>>;

export interface RoomModelsStorageOptions {
	persistentAgentsRoot?: string;
}

/** The global last pick an older version kept for new rooms; read once, by the migration and the derived default. */
export const LEGACY_ROOM_MODEL_SELECTION_FILE = productAppStatePath("web-chat-model.json");

// --- Locks -----------------------------------------------------------------------

function lockField(raw: unknown, label: string): string {
	if (typeof raw !== "string") throw new Error(`${label} must be a string`);
	const value = raw.trim();
	if (!value) throw new Error(`${label} is required`);
	if (value.length > 200) throw new Error(`${label} is too long`);
	if (/[\r\n\t]/.test(value)) throw new Error(`${label} must be a single line`);
	return value;
}

/** A {provider, model} pair from a request body; throws a plain sentence on anything else. */
export function parseModelLock(raw: unknown): PersistentAgentModelLock {
	const input = raw as { provider?: unknown; model?: unknown; modelId?: unknown } | null;
	return { provider: lockField(input?.provider, "provider"), model: lockField(input?.model ?? input?.modelId, "model") };
}

function readLock(raw: unknown): PersistentAgentModelLock | undefined {
	try {
		return raw && typeof raw === "object" ? parseModelLock(raw) : undefined;
	} catch {
		return undefined;
	}
}

// --- The room's own picks ---------------------------------------------------------

function safeRoomId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("invalid persistent-room agent id");
	return id;
}

export function roomModelsPath(agentIdRaw: string, options: RoomModelsStorageOptions = {}): string {
	return path.join(persistentAgentRootPath(safeRoomId(agentIdRaw), options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "models.json");
}

/** The room's stored picks, or null when it has none (a missing or unreadable file reads as none). */
export function readRoomModels(agentIdRaw: string, options: RoomModelsStorageOptions = {}): RoomModelsRecord | null {
	try {
		const file = roomModelsPath(agentIdRaw, options);
		if (!fs.existsSync(file)) return null;
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return null;
		const conversation = readLock(raw.conversation);
		const memory = readLock(raw.memory);
		return { schemaVersion: 1, ...(conversation ? { conversation } : {}), ...(memory ? { memory } : {}), updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "" };
	} catch {
		return null;
	}
}

function writeJsonReadBack(file: string, payload: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const text = `${JSON.stringify(payload, null, 2)}\n`;
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, text, { mode: 0o600 });
	fs.renameSync(tmp, file);
	if (fs.readFileSync(file, "utf-8") !== text) throw new Error(`${path.basename(file)} did not read back as written`);
}

/**
 * Sets or clears the room's picks: a lock sets that row, null clears it (the
 * row inherits the default again), an absent key leaves it as it is.
 */
export function writeRoomModels(agentIdRaw: string, patch: Partial<Record<RoomModelTask, PersistentAgentModelLock | null>>, options: RoomModelsStorageOptions = {}, now = new Date()): RoomModelsRecord {
	const current = readRoomModels(agentIdRaw, options);
	const next: RoomModelsRecord = { schemaVersion: 1, updatedAt: now.toISOString() };
	for (const task of ROOM_MODEL_TASKS) {
		const value = task in patch ? patch[task] : current?.[task];
		if (value) next[task] = { provider: value.provider, model: value.model };
	}
	writeJsonReadBack(roomModelsPath(agentIdRaw, options), next);
	return next;
}

// --- Defaults for new rooms -------------------------------------------------------

function readProfileStateFile(): Record<string, unknown> {
	try {
		if (!fs.existsSync(PERSISTENT_AGENT_AI_PROFILE_FILE)) return {};
		const raw = JSON.parse(fs.readFileSync(PERSISTENT_AGENT_AI_PROFILE_FILE, "utf-8"));
		return raw && typeof raw === "object" ? raw : {};
	} catch {
		return {};
	}
}

/** The defaults as stored; a row missing here is derived from the saved AI profile (see resolveAiDefault). */
export function readStoredAiDefaults(): AiDefaults {
	const raw = readProfileStateFile().defaults as Record<string, unknown> | undefined;
	const defaults: AiDefaults = {};
	for (const task of ROOM_MODEL_TASKS) {
		const lock = readLock(raw?.[task]);
		if (lock) defaults[task] = lock;
	}
	return defaults;
}

/** Sets the defaults; the saved profile pointer in the same file is kept as it is. */
export function writeAiDefaults(patch: AiDefaults): AiDefaults {
	const file = readProfileStateFile();
	const defaults = { ...readStoredAiDefaults(), ...patch };
	writeJsonReadBack(PERSISTENT_AGENT_AI_PROFILE_FILE, { ...file, defaults });
	return readStoredAiDefaults();
}

function readLegacyRoomModelSelection(): PersistentAgentModelLock | undefined {
	try {
		if (!fs.existsSync(LEGACY_ROOM_MODEL_SELECTION_FILE)) return undefined;
		return readLock(JSON.parse(fs.readFileSync(LEGACY_ROOM_MODEL_SELECTION_FILE, "utf-8")));
	} catch {
		return undefined;
	}
}

/** The profile the saved pointer names, signed in or not; undefined when there is no pointer or it names no known profile. */
function savedAiProfile(): PersistentAgentAiProfile | undefined {
	const saved = readSavedPersistentAgentAiProfileId();
	return saved && isPersistentAgentAiProfileId(saved) ? getPersistentAgentAiProfile(saved) : undefined;
}

/**
 * What a default row would be if it had never been set: the pick the app made
 * for new rooms before this version (the global last pick when the profile
 * offers it, else the profile's recommended room model) for the conversation,
 * and the profile's Memorize model for memory. The profile is the saved one,
 * even when its provider is signed out: that was the person's choice, and it
 * is never traded for another provider that happens to be signed in. Without
 * a saved pointer it is the signed-in profile, and `chosen` is false unless a
 * last pick names the model. The startup migration writes these once.
 */
export function derivedAiDefault(task: RoomModelTask): { lock: PersistentAgentModelLock | undefined; from: "last-pick" | "recommended" | "memorize"; chosen: boolean } {
	const saved = savedAiProfile();
	const profile = saved ?? readPersistentAgentAiProfileState().profile;
	if (task === "memory") return { lock: { ...profile.processes.absorb }, from: "memorize", chosen: Boolean(saved) };
	const lastPick = readLegacyRoomModelSelection();
	if (lastPick && isPersistentRoomModelForProfile(profile.id, lastPick.provider, lastPick.model)) return { lock: lastPick, from: "last-pick", chosen: true };
	const first = profile.processes.persistentRoom[0];
	return { lock: first ? { ...first } : undefined, from: "recommended", chosen: Boolean(saved) };
}

// --- What can run -----------------------------------------------------------------

export type RoomModelUnavailableReason = "signed-out" | "not-offered";

export interface RoomModelProvider {
	providerId: string;
	/** The name AI setup shows for it (its first profile's label). */
	label: string;
	/** Signed in or holding a key. */
	ready: boolean;
	/** The models rooms may talk with, in the provider's own order; on a curated provider the first is its recommendation. */
	conversation: PersistentAgentModelLock[];
	/** The models the memory row may use: the conversation list plus the provider's Memorize and Review models. */
	memory: PersistentAgentModelLock[];
	recommended: Record<RoomModelTask, PersistentAgentModelLock | undefined>;
	/** A built-in provider whose list the release curates: only its recommendation is a real one the pickers may tag. A gateway's or a custom provider's first model is only the first in its list. */
	curated: boolean;
}

export interface RoomModelCatalog {
	/** Every provider AI setup knows, in AI setup's order, ready or not. */
	providers: RoomModelProvider[];
	/** The model registry the catalog read, for names and windows; it never creates auth state. */
	registry: ModelRegistry;
	availability(lock: PersistentAgentModelLock, task: RoomModelTask): { ok: true } | { ok: false; reason: RoomModelUnavailableReason };
	firstAvailable(task: RoomModelTask): PersistentAgentModelLock | undefined;
}

export interface RoomModelCatalogOptions {
	profiles?: PersistentAgentAiProfile[];
	hasAuth?: (providerId: string) => boolean;
	hasModel?: (lock: PersistentAgentModelLock) => boolean;
}

function defaultAuthProbes(registryIn?: ModelRegistry): Pick<RoomModelCatalogOptions, "hasAuth" | "hasModel"> & { registry: ModelRegistry } {
	// No auth file means nothing is signed in; checked first because creating
	// the store writes one, and this runs on read-only paths too.
	let authStorage: AuthStorage | null = null;
	try {
		if (fs.existsSync(path.join(getAgentDir(), "auth.json"))) authStorage = AuthStorage.create();
	} catch {
		authStorage = null;
	}
	let registry: ModelRegistry;
	try {
		registry = registryIn ?? ModelRegistry.create(authStorage ?? AuthStorage.inMemory());
	} catch {
		registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	}
	return {
		registry,
		hasAuth: (providerId) => {
			try { return authStorage?.hasAuth(providerId) ?? false; } catch { return false; }
		},
		hasModel: (lock) => {
			try { return Boolean(registry.find(lock.provider, lock.model)); } catch { return false; }
		},
	};
}

function pushUnique(list: PersistentAgentModelLock[], lock: PersistentAgentModelLock): void {
	if (!list.some((candidate) => persistentAgentModelLocksEqual(candidate, lock))) list.push({ provider: lock.provider, model: lock.model });
}

/**
 * The model each picker tags Recommended for a provider: a curated provider's
 * recommendation, and on the Claude key the sign-in's, as it serves the same
 * models. Only a tag: what a default resolves to stays the key's own choice.
 */
export function taggedRecommendation(provider: RoomModelProvider, catalog: RoomModelCatalog): Record<RoomModelTask, PersistentAgentModelLock | undefined> {
	if (provider.curated) return provider.recommended;
	const signIn = provider.providerId === ANTHROPIC_API_KEY_PROVIDER ? catalog.providers.find((candidate) => candidate.providerId === "anthropic" && candidate.curated) : undefined;
	const onKey = (lock: PersistentAgentModelLock | undefined) => lock && { provider: ANTHROPIC_API_KEY_PROVIDER, model: lock.model };
	return { conversation: onKey(signIn?.recommended.conversation), memory: onKey(signIn?.recommended.memory) };
}

/** One read of the profiles and the sign-ins, for everything resolved in one request. */
export function createRoomModelCatalog(options: RoomModelCatalogOptions = {}): RoomModelCatalog {
	const profiles = options.profiles ?? getAvailablePersistentAgentAiProfiles();
	const defaults = defaultAuthProbes();
	const hasAuth = options.hasAuth ?? defaults.hasAuth!;
	const hasModel = options.hasModel ?? defaults.hasModel!;
	const byId = new Map<string, RoomModelProvider>();
	for (const profile of profiles) {
		let provider = byId.get(profile.providerId);
		if (!provider) {
			provider = { providerId: profile.providerId, label: profile.label, ready: hasAuth(profile.providerId), conversation: [], memory: [], recommended: { conversation: undefined, memory: undefined }, curated: isBuiltInPersistentAgentAiProfileId(profile.id) };
			byId.set(profile.providerId, provider);
		}
		for (const lock of profile.processes.persistentRoom) pushUnique(provider.conversation, lock);
		provider.recommended.conversation ??= profile.processes.persistentRoom[0] ? { ...profile.processes.persistentRoom[0] } : undefined;
		provider.recommended.memory ??= { ...profile.processes.absorb };
	}
	for (const profile of profiles) {
		const provider = byId.get(profile.providerId)!;
		for (const lock of provider.conversation) pushUnique(provider.memory, lock);
		pushUnique(provider.memory, profile.processes.absorb);
		pushUnique(provider.memory, profile.processes.structuralReview);
	}
	const providers = [...byId.values()];
	const availability: RoomModelCatalog["availability"] = (lock, task) => {
		const provider = byId.get(lock.provider);
		const offered = Boolean(provider && provider[task].some((candidate) => persistentAgentModelLocksEqual(candidate, lock)));
		if (!offered || !hasModel(lock)) return { ok: false, reason: "not-offered" };
		if (!provider!.ready) return { ok: false, reason: "signed-out" };
		return { ok: true };
	};
	const firstAvailable: RoomModelCatalog["firstAvailable"] = (task) => {
		for (const provider of providers) {
			if (!provider.ready) continue;
			const candidates = [provider.recommended[task], ...provider[task]].filter((lock): lock is PersistentAgentModelLock => Boolean(lock));
			const found = candidates.find((lock) => availability(lock, task).ok);
			if (found) return { ...found };
		}
		return undefined;
	};
	return { providers, registry: defaults.registry, availability, firstAvailable };
}

/**
 * Whether some provider's list offers this model for the task, whatever is
 * signed in: the floor under a stored conversation lock. Which model runs is
 * the resolver's call; whether it can run now is the catalog's.
 */
export function isRoomModelOffered(lock: PersistentAgentModelLock, task: RoomModelTask, profiles: PersistentAgentAiProfile[] = getAvailablePersistentAgentAiProfiles()): boolean {
	return profiles.some((profile) => {
		if (profile.providerId !== lock.provider) return false;
		const locks = task === "conversation"
			? profile.processes.persistentRoom
			: [...profile.processes.persistentRoom, profile.processes.absorb, profile.processes.structuralReview];
		return locks.some((candidate) => persistentAgentModelLocksEqual(candidate, lock));
	});
}

// --- Resolution -------------------------------------------------------------------

export interface RoomModelResolution {
	/** What was stored (the room's pick, or for a default row the default); null when nothing is. */
	stored: PersistentAgentModelLock | null;
	/** The model the row is set to: the room's pick, else the default. Null only when nothing was ever chosen. */
	chosen: PersistentAgentModelLock | null;
	/** What runs: the chosen model when it can run, else null (see `reason`); when nothing was chosen, the first ready model, or null when no provider is ready. */
	effective: PersistentAgentModelLock | null;
	/** Where the row's model comes from: the room's pick, the default, the first ready model (nothing chosen), or nothing at all. */
	source: "room" | "default" | "fallback" | "none";
	/** Why the chosen model cannot run; the row then has no effective model. */
	reason?: RoomModelUnavailableReason;
}

/**
 * The default on one row: stored, or derived from a choice an older version
 * kept, and whether it can run. A default that cannot run is not replaced.
 * When nothing was ever chosen the first ready model serves, and is stored as
 * the default right away, so a later sign-in elsewhere moves nothing.
 */
export function resolveAiDefault(task: RoomModelTask, catalog: RoomModelCatalog = createRoomModelCatalog()): RoomModelResolution & { derived: boolean } {
	const stored = readStoredAiDefaults()[task];
	const derived = stored ? undefined : derivedAiDefault(task);
	const lock = stored ?? (derived?.chosen ? derived.lock : undefined);
	if (lock) {
		const available = catalog.availability(lock, task);
		if (available.ok) return { stored: lock, chosen: lock, effective: { ...lock }, source: "default", derived: !stored };
		return { stored: lock, chosen: lock, effective: null, source: "default", reason: available.reason, derived: !stored };
	}
	const first = catalog.firstAvailable(task) ?? null;
	if (!first) return { stored: null, chosen: null, effective: null, source: "none", derived: true };
	try {
		writeAiDefaults({ [task]: first });
	} catch {
		// Unwritable app state: it serves this time and is tried again next time.
	}
	return { stored: null, chosen: null, effective: first, source: "fallback", derived: true };
}

/**
 * The model a room runs a task on: its own pick, else the default, and only
 * when it can run. A pick or a default that cannot run leaves the row with no
 * effective model and the reason: the room waits for it rather than run on
 * another. The stored pick is reported either way.
 */
export function resolveRoomModel(agentId: string, task: RoomModelTask, catalog: RoomModelCatalog = createRoomModelCatalog(), options: RoomModelsStorageOptions = {}): RoomModelResolution {
	const stored = readRoomModels(agentId, options)?.[task] ?? null;
	if (!stored) {
		const byDefault = resolveAiDefault(task, catalog);
		return { stored: null, chosen: byDefault.chosen, effective: byDefault.effective, source: byDefault.source, ...(byDefault.reason ? { reason: byDefault.reason } : {}) };
	}
	const available = catalog.availability(stored, task);
	if (available.ok) return { stored, chosen: stored, effective: { ...stored }, source: "room" };
	return { stored, chosen: stored, effective: null, source: "room", reason: available.reason };
}

// --- A default an update moved ---------------------------------------------------

/**
 * Defaults a release moved. The 0.14 migration wrote each install's defaults
 * from its profile once, so a profile's new model reaches an install only by
 * moving the stored default, once, unless something on disk shows the person
 * chose it (room-models-migration.ts). 0.14.3: ChatGPT's went from GPT-6 Sol
 * to GPT-6.1 Sol, the memory default and the conversation default both.
 */
export const DEFAULT_MOVES: Record<RoomModelTask, ReadonlyArray<{ from: PersistentAgentModelLock; to: PersistentAgentModelLock }>> = {
	conversation: [{ from: { provider: "openai-codex", model: "gpt-6-sol" }, to: { provider: "openai-codex", model: "gpt-6.1-sol" } }],
	memory: [{ from: { provider: "openai-codex", model: "gpt-6-sol" }, to: { provider: "openai-codex", model: "gpt-6.1-sol" } }],
};

/** The record of the move this install made on a row, kept apart from the migration report a later start may rewrite. */
export function defaultMoveFile(task: RoomModelTask): string {
	return productAppStatePath(`${task}-default-move.json`);
}

export interface DefaultMove {
	from: PersistentAgentModelLock;
	to: PersistentAgentModelLock;
	at: string;
	/** Set once the default read back as moved: the move is never made again, so a default picked again stays. */
	done?: boolean;
}

export function readDefaultMove(task: RoomModelTask): DefaultMove | null {
	try {
		const raw = JSON.parse(fs.readFileSync(defaultMoveFile(task), "utf-8"));
		const from = readLock(raw?.from);
		const to = readLock(raw?.to);
		return from && to && typeof raw?.at === "string" ? { from, to, at: raw.at, ...(raw.done === true ? { done: true } : {}) } : null;
	} catch {
		return null;
	}
}

/** Written before the default moves, so a start cut short between the two moves it again. */
export function writeDefaultMove(task: RoomModelTask, move: DefaultMove): void {
	writeJsonReadBack(defaultMoveFile(task), move);
}

/**
 * The Memory models a Remember page may be saved on: the room's own, and, for
 * a room on the default that an update moved, the model it moved from, so a
 * page written before the update still saves.
 */
export function rememberSaveMemoryModels(agentId: string, catalog: RoomModelCatalog = createRoomModelCatalog()): { expectedMemoryModel: PersistentAgentModelLock | null; movedFromMemoryModel?: PersistentAgentModelLock } {
	const resolution = resolveRoomModel(agentId, "memory", catalog);
	const move = resolution.stored ? null : readDefaultMove("memory");
	const moved = move && resolution.effective && persistentAgentModelLocksEqual(resolution.effective, move.to) ? move.from : undefined;
	return { expectedMemoryModel: resolution.effective, ...(moved ? { movedFromMemoryModel: moved } : {}) };
}

// --- Refusals ---------------------------------------------------------------------

/** The names a refusal reads: the model's and its provider's, as the surface shows them. */
export interface RoomModelNames {
	model(lock: PersistentAgentModelLock): string;
	provider(providerId: string): string;
}

/** Names from the catalog: the model's name as the Model pickers show it and AI setup's provider name, the bare ids when they are unknown. */
export function catalogModelNames(catalog: RoomModelCatalog): RoomModelNames {
	return {
		model: (lock) => {
			let registered = "";
			try {
				registered = String(catalog.registry.find(lock.provider, lock.model)?.name ?? "").trim();
			} catch {}
			return canonicalModelName({ model: lock.model, modelLabel: registered || undefined, provider: lock.provider }).name || lock.model;
		},
		provider: (providerId) => catalog.providers.find((provider) => provider.providerId === providerId)?.label ?? providerId,
	};
}

/**
 * Refused because a row's chosen model cannot run. A signed-out provider
 * carries the code the room's socket already stands down on (and redials
 * after the sign-in); a model no longer offered has its own.
 */
export class RoomModelUnavailableError extends Error {
	readonly statusCode = 409;
	readonly code: "provider_signed_out" | "room_model_unavailable";
	/** The provider, for the notice's Sign in button; `key` when a key connection has no key saved. */
	readonly details: { provider: string; key?: "missing" };
	constructor(message: string, readonly reason: RoomModelUnavailableReason, readonly provider: string) {
		super(message);
		this.name = "RoomModelUnavailableError";
		this.code = reason === "signed-out" ? "provider_signed_out" : "room_model_unavailable";
		this.details = { provider, ...(reason === "signed-out" && !providerSignsIn(provider) ? { key: "missing" as const } : {}) };
	}
}

/**
 * The refusal for a row whose chosen model cannot run: the model, its
 * provider, why, and the way out. Null when the row can run, or when nothing
 * was chosen (each caller keeps its own "no provider is signed in" line).
 * `of` is "room" for the room at hand, `{ room }` for another room by name (a
 * consult), "defaults" for AI setup's Default models.
 */
export function roomModelUnavailableError(resolution: RoomModelResolution, task: RoomModelTask, names: RoomModelNames, of: RoomModelRefusalOf = "room"): RoomModelUnavailableError | null {
	const chosen = resolution.chosen;
	if (resolution.effective || !chosen || !resolution.reason) return null;
	return new RoomModelUnavailableError(roomModelUnavailableSentence(chosen, resolution.reason, task, names, of), resolution.reason, chosen.provider);
}

export type { RoomModelRefusalOf };

/** That refusal's sentence (draft wording), also for a call the provider refused because it no longer serves the model. */
export function roomModelUnavailableSentence(chosen: PersistentAgentModelLock, reason: RoomModelUnavailableReason, task: RoomModelTask, names: RoomModelNames, of: RoomModelRefusalOf = "room"): string {
	const bare = { model: names.model(chosen), provider: names.provider(chosen.provider) };
	return roomModelUnavailableLine(modelOnProvider(bare.model, bare.provider), reason, task, of, providerSignsIn(chosen.provider), bare);
}

/**
 * Whether a provider's credential is a sign-in (a subscription): only those
 * are "signed out". Every other provider, a gateway too, holds a key. Read
 * from the runtime's sign-in list, so a removed provider still answers; the
 * in-memory store never touches the auth file.
 */
export function providerSignsIn(providerId: string): boolean {
	return AuthStorage.inMemory().getOAuthProviders().some((provider) => provider.id === providerId);
}

// --- The Memory model's size -------------------------------------------------------

/**
 * Refused because a Memory model's window is too small for a room's memory
 * budget (minimumMemoryWindow): at the Memory pick, the AI defaults, a raised
 * budget, and the start of Memorize and Review, where the screens show it as
 * the model notice with Choose another model.
 */
export class MemoryModelTooSmallError extends Error {
	readonly code = "memory_model_too_small";
	constructor(message: string, readonly statusCode: number) {
		super(message);
		this.name = "MemoryModelTooSmallError";
	}
}

/** Whether a Memory model's window holds Memorize at a memory budget; a window that is not known is never refused. */
export function memoryModelHoldsBudget(lock: PersistentAgentModelLock, budgetTokens: number, contextWindow: number | undefined): boolean {
	return !(typeof contextWindow === "number" && contextWindow > 0) || contextWindow >= minimumMemoryWindow(budgetTokens, lock);
}

/**
 * The refusal for this room's Memory model ("room"), for this room going back
 * to a default too small for it ("default"), or for the AI defaults, naming a
 * room on the default whose own pick is the other way out.
 */
export function memoryModelTooSmallSentence(model: string, of: "room" | "maintenance" | "default" | { room: string } = "room"): string {
	if (of === "default") return `The default, ${model}, is too small for this room's memory. Keep this room's own Memory model, or choose a larger default in Settings, AI setup.`;
	if (typeof of === "object") return `${model} is too small for ${of.room}'s memory. Choose a larger default, or give ${of.room} its own Memory model in its Room settings.`;
	// Memorize, Remember and Review say it outside Room settings, so they say where the budget is.
	return `${model} is too small for this room's memory. Choose another Memory model, or lower the memory budget in ${of === "maintenance" ? "Room settings, Memory" : "Memory"}.`;
}

/** The refusal of a budget raised past what the room's Memory model holds. */
export function memoryBudgetNeedsLargerModelSentence(budgetTokens: number, model: string): string {
	return `A memory budget of ${formatTokenLimit(budgetTokens)} needs a larger Memory model than ${model}. Choose one in Room settings, Model first.`;
}

/**
 * The model a scheduled run starts a fresh conversation on: the room's
 * conversation model, resolved like any other new conversation, and never
 * another. A chosen model no provider's list offers any more is refused
 * here, with the sentence: the registry may still know it, so the run's
 * readiness check would not stop it. Any other chosen model that cannot run
 * (its provider signed out, or a listed model the registry does not know) is
 * named, and the readiness check blocks it with that reason. With nothing
 * chosen and nothing ready the derived default is named for the same check.
 * Throws when there is no model to name at all.
 */
export function resolveScheduledRoomModel(agentId: string, catalog: RoomModelCatalog = createRoomModelCatalog()): PersistentAgentModelLock {
	const resolved = resolveRoomModel(agentId, "conversation", catalog);
	const delisted = resolved.reason === "not-offered" && resolved.chosen && !isRoomModelOffered(resolved.chosen, "conversation");
	const refusal = delisted ? roomModelUnavailableError(resolved, "conversation", catalogModelNames(catalog)) : null;
	if (refusal) throw refusal;
	const lock = resolved.effective ?? resolved.chosen ?? derivedAiDefault("conversation").lock;
	if (!lock) throw new Error("no AI provider is set up, so this room has no model to run on");
	return { provider: lock.provider, model: lock.model };
}
