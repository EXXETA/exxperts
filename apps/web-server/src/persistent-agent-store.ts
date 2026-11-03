import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRoomModelOffered } from "./room-models.js";
import { maintenanceDiagnosticsDir } from "./maintenance-diagnostics.js";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";
import type { PersistentAgentActiveTurnState, PersistentAgentActiveTurnTerminalReason, PersistentAgentId, PersistentAgentModelLock, PersistentAgentRuntimeState, PersistentAgentStatus } from "./persistent-agent-types.js";
import type { CheckpointEventRecord, MementoEventRecord } from "./persistent-agent-memory-types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = process.env.EXXETA_HOME ? path.resolve(process.env.EXXETA_HOME) : path.resolve(__dirname, "..", "..", "..");

const persistentRoomLock = createRequire(import.meta.url)(path.join(REPO_ROOT, "bin", "lib", "room-lock.cjs")) as {
	readLock: (agentId: string) => { surface?: string; acquiredAt?: number; lastSeen?: number; pid?: number; host?: string; lockId?: string | null; runId?: string | null; label?: string | null } | null;
	isActive: (lock: unknown) => boolean;
	tryAcquire: (agentId: string, owner: { surface: string; pid?: number; connectionId?: string; lockId?: string; label?: string }) => { ok: boolean; heldBy?: { surface?: string } | null };
	release: (agentId: string, owner: { surface: string; pid?: number; connectionId?: string; lockId?: string }) => void;
};

export const PERSISTENT_AGENTS_ROOT = process.env.EXXETA_PERSISTENT_AGENTS_ROOT || productAppStatePath("personalized-agents");

const RECENT_CONTEXT_SOFT_CAP = 7;

// The hard cap means "Memorize is due": the room says so, the card says so, and
// automatic maintenance takes it as its cue. It does NOT mean "stop saving
// sessions" — a room whose memory is too large for one Memorize run would then
// have no way out at all: no session could be saved until a Memorize succeeded,
// and no Memorize could succeed. Saving a session is cheap, bounded and never
// touches stable memory, so it stays allowed well past the due mark.
const RECENT_CONTEXT_HARD_CAP = 10;

// Twice the hard cap is where saving another session stops being harmless: the
// backlog is now large enough that folding it costs real time, and every
// further entry is context the room carries on every turn. Refusing here names
// Memorize as the way out instead of leaving the room to grow unbounded.
export const RECENT_CONTEXT_BLOCK_CAP = 20;

// A saved conversation keeps its newest items; the browser draws every item it
// holds, so the count stays bounded. The bytes are bounded separately by the
// thread save's body limit (64 MB): 2000 items of about 32 KB each fill it, so
// a conversation of very large items is refused at the save (in one plain
// sentence) before it reaches this count.
const PERSISTENT_AGENT_THREAD_ITEM_CAP = 2000;

// Stands at the head of a conversation whose oldest items were cut. Its id is
// fixed, so the copy a reloaded browser sends back is recognised and replaced,
// never doubled. A resumed room's context reads only user and assistant items,
// so the room never takes it for part of the conversation.
const PERSISTENT_AGENT_THREAD_EARLIER_ITEMS_NOTICE_ID = "thread-earlier-items-omitted";

const PERSISTENT_AGENT_THREAD_EARLIER_ITEMS_NOTICE = "Earlier messages are not shown here; they are still part of this conversation.";

interface AgentJson {
	schemaVersion: number;
	id: string;
	agentId?: string;
	displayName: string;
	description: string;
	role: string;
	templateId?: string;
	mode?: string;
	user?: {
		displayName: string;
		preferredAddress: string;
	};
	/** Optional legacy/status display hint only. Active execution uses thread/runtime locks resolved through the global active AI profile. */
	model?: { provider: string; model: string };
	status: string;
	archivedAt?: number;
	archivedBy?: string;
	archivedReason?: string;
	createdAt: number;
	updatedAt: number;
	l1aPath: string;
	l1bCurrentPath: string;
	l1bArchiveDir: string;
	sectionRegistryPath: string;
	currentSessionId: string | null;
	lastCheckpointId: string | null;
	recentContextSoftCap: number;
	recentContextHardCap: number;
	memoryTokenBudget: number;
}

const MAX_PERSISTENT_AGENT_ID_LENGTH = 120;

const PERSISTENT_AGENT_ACTIVE_TURN_TOKEN_PATTERN = /^[a-zA-Z0-9_.:-]{1,200}$/;

const PERSISTENT_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/;

const persistentAgentActiveTurns = new Map<string, PersistentAgentActiveTurnState>();

const PERSISTENT_AGENT_EVENT_ID_PATTERN = /^[a-zA-Z0-9_.-]{1,180}$/;

const PERSISTENT_AGENT_SIDECAR_ID_PATTERN = /^[a-zA-Z0-9_-]{1,160}$/;

export function isValidPersistentAgentId(value: unknown): value is PersistentAgentId {
	const id = String(value ?? "").trim();
	return id !== "." && id !== ".." && PERSISTENT_AGENT_ID_PATTERN.test(id);
}

export function validatePersistentAgentId(value: unknown): PersistentAgentId {
	const id = String(value ?? "").trim();
	if (!isValidPersistentAgentId(id)) throw new Error(`invalid persistent agent id: ${id || "(empty)"}`);
	return id;
}

function safePersistentAgentEventRecordId(raw: string, label: string): string {
	const id = String(raw ?? "").trim();
	if (!PERSISTENT_AGENT_EVENT_ID_PATTERN.test(id) || id === "." || id === "..") throw new Error(`invalid persistent-agent ${label}`);
	return id;
}

function safePersistentAgentSidecarId(raw: string, label: string): string {
	const id = String(raw ?? "").trim();
	if (!PERSISTENT_AGENT_SIDECAR_ID_PATTERN.test(id)) throw new Error(`invalid persistent-agent ${label}`);
	return id;
}

export class PersistentAgentInstance {
	readonly agentId: PersistentAgentId;
	readonly rootDir: string;

	constructor(agentId: string) {
		this.agentId = validatePersistentAgentId(agentId);
		this.rootDir = path.join(PERSISTENT_AGENTS_ROOT, this.agentId);
	}

	agentJsonPath(): string {
		return path.join(this.rootDir, "agent.json");
	}

	l1aPath(meta?: Partial<AgentJson> | null): string {
		return this.objectPath(meta?.l1aPath, "L1a.md", "L1a path");
	}

	l1bCurrentPath(meta?: Partial<AgentJson> | null): string {
		return this.objectPath(meta?.l1bCurrentPath, path.join("L1b", "current.md"), "L1b current path");
	}

	l1bArchiveDir(meta?: Partial<AgentJson> | null): string {
		return this.objectPath(meta?.l1bArchiveDir, path.join("L1b", "archive"), "L1b archive dir");
	}

	sectionRegistryPath(meta?: Partial<AgentJson> | null): string {
		return this.objectPath(meta?.sectionRegistryPath, "section_registry.json", "section registry path");
	}

	runtimeDir(): string {
		return path.join(this.rootDir, "runtime");
	}

	runtimeStatePath(): string {
		return path.join(this.runtimeDir(), "state.json");
	}

	runtimeThreadsDir(): string {
		return path.join(this.runtimeDir(), "threads");
	}

	runtimeUnseenLandedAnswerPath(): string {
		return path.join(this.runtimeDir(), "unseen-landed-answer.json");
	}

	runtimePiSessionsDir(): string {
		return path.join(this.runtimeDir(), "pi-sessions");
	}

	runtimePiSessionPath(threadIdRaw: string): string {
		const threadId = safeRuntimeThreadId(threadIdRaw);
		if (!threadId) throw new Error("invalid persistent-agent thread id");
		return path.join(this.runtimePiSessionsDir(), `${threadId}.jsonl`);
	}

	runtimeBootPromptSnapshotPath(threadIdRaw: string): string {
		const threadId = safeRuntimeThreadId(threadIdRaw);
		if (!threadId) throw new Error("invalid persistent-agent thread id");
		return path.join(this.runtimePiSessionsDir(), `${threadId}.boot-prompt.txt`);
	}

	runtimeThreadPath(threadIdRaw: string): string {
		const threadId = safeRuntimeThreadId(threadIdRaw);
		if (!threadId) throw new Error("invalid persistent-agent thread id");
		return path.join(this.runtimeThreadsDir(), `${threadId}.json`);
	}

	workspacePolicyPath(conversationIdRaw: string): string {
		const conversationId = safePersistentAgentSidecarId(conversationIdRaw, "workspace-policy conversation id");
		return path.join(this.runtimeDir(), "workspace-policies", `${conversationId}.json`);
	}

	workspaceDefaultPath(): string {
		return path.join(this.runtimeDir(), "workspace-default.json");
	}

	checkpointEventDir(): string {
		return path.join(this.rootDir, "events", "checkpoint");
	}

	checkpointEventRecordPath(checkpointIdRaw: string): string {
		const checkpointId = safePersistentAgentEventRecordId(checkpointIdRaw, "checkpoint event id");
		return path.join(this.checkpointEventDir(), `${checkpointId}.json`);
	}

	mementoEventDir(): string {
		return path.join(this.rootDir, "events", "memento");
	}

	mementoEventRecordPath(mementoIdRaw: string): string {
		const mementoId = safePersistentAgentEventRecordId(mementoIdRaw, "memento event id");
		return path.join(this.mementoEventDir(), `${mementoId}.json`);
	}

	absorbEventDir(): string {
		return path.join(this.rootDir, "events", "absorb");
	}

	absorbEventRecordPath(absorbIdRaw: string): string {
		const absorbId = safePersistentAgentEventRecordId(absorbIdRaw, "absorb event id");
		return path.join(this.absorbEventDir(), `${absorbId}.json`);
	}

	memoryEditEventDir(): string {
		return path.join(this.rootDir, "events", "memory-edit");
	}

	memoryEditEventRecordPath(memoryEditIdRaw: string): string {
		const memoryEditId = safePersistentAgentEventRecordId(memoryEditIdRaw, "memory-edit event id");
		return path.join(this.memoryEditEventDir(), `${memoryEditId}.json`);
	}

	/**
	 * Review v2's own event directory. The note-level Review is a different
	 * write from the whole-rewrite one it replaces — different record, different
	 * undo branch — so it keeps its own directory rather than sharing
	 * `events/structural-review` and leaving a reader to guess which shape a
	 * file holds.
	 */
	reviewEventDir(): string {
		return path.join(this.rootDir, "events", "review");
	}

	reviewEventRecordPath(reviewIdRaw: string): string {
		const reviewId = safePersistentAgentEventRecordId(reviewIdRaw, "review event id");
		return path.join(this.reviewEventDir(), `${reviewId}.json`);
	}

	/**
	 * Where the Review that came before the run left its saves. A new room never
	 * gets this directory; the rooms that ran that Review still have it, and
	 * their history and their undo still read it.
	 */
	structuralReviewEventDir(): string {
		return path.join(this.rootDir, "events", "structural-review");
	}

	structuralReviewEventRecordPath(structuralReviewIdRaw: string): string {
		const structuralReviewId = safePersistentAgentEventRecordId(structuralReviewIdRaw, "structural-review event id");
		return path.join(this.structuralReviewEventDir(), `${structuralReviewId}.json`);
	}

	rootRelativePath(file: string): string {
		const relativePath = path.relative(this.rootDir, file);
		if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error("persistent-agent path must be inside persistent agent root");
		return relativePath.split(path.sep).join("/");
	}

	resolveRootRelativePath(relPathRaw: string, label = "persistent-agent relative path"): string {
		const relPath = normalizePersistentAgentRootRelativePath(relPathRaw);
		if (!relPath) throw new Error(`${label} must be a safe relative path inside persistent agent root`);
		const file = path.join(this.rootDir, ...relPath.split("/"));
		this.rootRelativePath(file);
		return file;
	}

	readAgentJson(): Partial<AgentJson> | null {
		return readJson(this.agentJsonPath()) as Partial<AgentJson> | null;
	}

	readL1a(meta: Partial<AgentJson> | null = this.readAgentJson()): string {
		return fs.readFileSync(this.l1aPath(meta), "utf-8");
	}

	readL1b(meta: Partial<AgentJson> | null = this.readAgentJson()): string {
		return fs.readFileSync(this.l1bCurrentPath(meta), "utf-8");
	}

	readSectionRegistry(meta: Partial<AgentJson> | null = this.readAgentJson()): unknown {
		return readJson(this.sectionRegistryPath(meta));
	}

	private objectPath(rawPath: unknown, fallback: string, label: string): string {
		const relPath = String(rawPath ?? fallback).trim() || fallback;
		if (path.isAbsolute(relPath)) throw new Error(`persistent-agent ${label} must be relative`);
		const file = path.join(this.rootDir, relPath);
		this.rootRelativePath(file);
		return file;
	}
}

export function createPersistentAgentInstance(agentId: string): PersistentAgentInstance {
	return new PersistentAgentInstance(agentId);
}

function persistentAgentInstanceFrom(input: PersistentAgentInstance | string): PersistentAgentInstance {
	return input instanceof PersistentAgentInstance ? input : createPersistentAgentInstance(input);
}

type PersistentAgentPathContext = PersistentAgentInstance | string;

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function runtimeWorkspacePoliciesDir(root: PersistentAgentPathContext): string {
	return root instanceof PersistentAgentInstance ? path.join(root.runtimeDir(), "workspace-policies") : path.join(runtimeDir(root), "workspace-policies");
}

function eventsDir(root: PersistentAgentPathContext): string {
	return root instanceof PersistentAgentInstance ? path.join(root.rootDir, "events") : path.join(root, "events");
}

function ensurePersistentAgentCanonicalScaffoldDirs(root: PersistentAgentPathContext): void {
	for (const dir of [
		runtimeDir(root),
		runtimeThreadsDir(root),
		runtimePiSessionsDir(root),
		runtimeWorkspacePoliciesDir(root),
		eventsDir(root),
		checkpointEventDir(root),
		mementoEventDir(root),
		absorbEventDir(root),
		reviewEventDir(root),
		maintenanceDiagnosticsDir(root instanceof PersistentAgentInstance ? root.rootDir : root),
	]) {
		ensureDir(dir);
	}
}

function readJson(file: string): any | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

function runtimeDir(root: PersistentAgentPathContext): string {
	return root instanceof PersistentAgentInstance ? root.runtimeDir() : path.join(root, "runtime");
}

function runtimeThreadsDir(root: PersistentAgentPathContext): string {
	return root instanceof PersistentAgentInstance ? root.runtimeThreadsDir() : path.join(runtimeDir(root), "threads");
}

function runtimePiSessionsDir(root: PersistentAgentPathContext): string {
	return root instanceof PersistentAgentInstance ? root.runtimePiSessionsDir() : path.join(runtimeDir(root), "pi-sessions");
}

function safeRuntimeThreadId(raw: unknown): string | null {
	if (raw == null) return null;
	const id = String(raw).trim();
	return /^[a-zA-Z0-9_-]{8,120}$/.test(id) ? id : null;
}

function persistentAgentActiveTurnKey(agentId: PersistentAgentId, threadId: string): string {
	return `${agentId}\u0000${threadId}`;
}

function idlePersistentAgentTurnState(updatedAt = 0, lastTerminalReason?: PersistentAgentActiveTurnTerminalReason): PersistentAgentActiveTurnState {
	return {
		state: "idle",
		...(lastTerminalReason ? { lastTerminalReason } : {}),
		updatedAt,
	};
}

function normalizePersistentAgentActiveTurnToken(raw: unknown, label: string): string | undefined {
	if (raw == null || raw === "") return undefined;
	const value = String(raw).trim();
	if (!PERSISTENT_AGENT_ACTIVE_TURN_TOKEN_PATTERN.test(value)) throw new Error(`invalid persistent-agent ${label}`);
	return value;
}

function persistentAgentTurnConflictError(agentId: PersistentAgentId, threadId: string, state: PersistentAgentActiveTurnState): Error {
	const verb = state.state === "cancelling" ? "is cancelling" : "is still running";
	const error = new Error(`persistent-agent activeThread ${verb}; stop it or wait for completion before changing runtime boundaries: ${agentId}/${threadId}`);
	(error as any).statusCode = 409;
	(error as any).code = "turn_running";
	return error;
}

export function getPersistentAgentActiveTurnState(agentIdRaw: string, threadIdRaw: string): PersistentAgentActiveTurnState {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	return persistentAgentActiveTurns.get(persistentAgentActiveTurnKey(instance.agentId, threadId)) ?? idlePersistentAgentTurnState();
}

export function assertPersistentAgentThreadNotInFlight(agentIdRaw: string, threadIdRaw: string): void {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	const state = getPersistentAgentActiveTurnState(instance.agentId, threadId);
	if (state.state === "running" || state.state === "cancelling") throw persistentAgentTurnConflictError(instance.agentId, threadId, state);
}

function normalizePersistentAgentRootRelativePath(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const relPath = raw.trim();
	if (!relPath || relPath.includes("\0") || relPath.includes("\\")) return null;
	if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath) || path.posix.isAbsolute(relPath)) return null;
	const normalized = path.posix.normalize(relPath);
	if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
	return normalized;
}

function normalizeRuntimeModel(raw: any): PersistentAgentModelLock | null {
	if (raw == null) return null;
	const provider = String(raw?.provider ?? raw?.modelProvider ?? "").trim();
	const model = String(raw?.model ?? raw?.modelId ?? "").trim();
	const label = String(raw?.label ?? "").trim();
	if (!provider || !model) return null;
	return label ? { provider, model, label } : { provider, model };
}

// A new conversation's lock must be a model some provider offers rooms. Only
// the list is checked here, not the sign-in: storage runs where nothing may be
// signed in (tests, a first run), and the bind checks the sign-in before any
// turn. Which model a new conversation gets is decided by the server
// (resolveRoomModel); this is the floor under every writer.
function assertOfferedRoomModel(model: PersistentAgentModelLock, processLabel: string): void {
	if (isRoomModelOffered(model, "conversation")) return;
	throw new Error(`model is not offered to rooms by any provider for ${processLabel}: ${model.provider}/${model.model}`);
}

function persistentAgentConflictError(message: string): Error {
	const error = new Error(message);
	(error as any).statusCode = 409;
	return error;
}

function persistentAgentModelLockLabel(model: PersistentAgentModelLock): string {
	return `${model.provider}/${model.model}`;
}

/** A {provider, model, label?} named in a request body, for direct callers that pass no resolved model. */
function requestBodyModelLock(raw: any): PersistentAgentModelLock & { label?: string } {
	const provider = String(raw?.model?.provider ?? raw?.modelProvider ?? raw?.provider ?? "").trim();
	const model = String(raw?.model?.model ?? raw?.model?.modelId ?? raw?.modelId ?? raw?.model ?? "").trim();
	const label = String(raw?.model?.label ?? "").trim();
	if (!provider || !model) throw new Error("model.provider and model.model are required");
	return { provider, model, ...(label ? { label } : {}) };
}

export function defaultPersistentAgentRuntimeState(agentId: PersistentAgentId): PersistentAgentRuntimeState {
	return { schemaVersion: 1, agentId, state: "idle", activeThreadId: null, model: null, updatedAt: 0 };
}

function normalizeRuntimeState(raw: any, agentId: PersistentAgentId): PersistentAgentRuntimeState {
	const state = raw?.state === "active" || raw?.state === "standby" || raw?.state === "idle" ? raw.state : "idle";
	const activeThreadId = safeRuntimeThreadId(raw?.activeThreadId);
	const model = normalizeRuntimeModel(raw?.model);
	const updatedAt = Number.isFinite(raw?.updatedAt) && raw.updatedAt > 0 ? Math.floor(raw.updatedAt) : 0;
	return {
		schemaVersion: 1,
		agentId,
		state,
		activeThreadId: state === "idle" ? null : activeThreadId,
		model: state === "idle" ? null : model,
		updatedAt,
	};
}

export function getPersistentAgentRuntimeState(agentIdRaw: string): PersistentAgentRuntimeState {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const file = instance.runtimeStatePath();
	if (!fs.existsSync(file)) return defaultPersistentAgentRuntimeState(instance.agentId);
	return normalizeRuntimeState(readJson(file), instance.agentId);
}

export function isPersistentAgentArchived(value: Partial<AgentJson> | PersistentAgentStatus | null | undefined): boolean {
	const archivedAt = Number((value as any)?.archivedAt ?? 0);
	return Number.isFinite(archivedAt) && archivedAt > 0;
}

function activePersistentRoomLock(agentId: PersistentAgentId, options: { expectedSchedulerLockId?: string } = {}): { surface?: string; acquiredAt?: number; lastSeen?: number; pid?: number; host?: string; lockId?: string | null; runId?: string | null; label?: string | null } | null {
	const lock = persistentRoomLock.readLock(agentId);
	if (!lock || !persistentRoomLock.isActive(lock)) return null;
	if (lock.surface === "scheduler" && options.expectedSchedulerLockId && lock.lockId === options.expectedSchedulerLockId) return null;
	return lock;
}

/**
 * The ONE guard for a room-file write from the web process while another
 * process may be reading and writing the same room: a scheduled background
 * run holds the room's files from outside this request, so a
 * write mid-run risks clobbering theirs. A plain open-in-app web lock is not
 * a conflict (web writers share this process and cannot interleave with a
 * synchronous write). `action` is the verb phrase the refusal names, e.g.
 * "rename it" or "save its instructions", so the remedy reads in the user's
 * words wherever the refusal lands.
 */
export function assertPersistentRoomNotHeldByAnotherProcess(agentId: PersistentAgentId, action: string): void {
	const lock = activePersistentRoomLock(agentId);
	if (lock?.surface === "scheduler") {
		const error = new Error(`the room is working on a scheduled background task; ${action} when that finishes`);
		(error as any).statusCode = 409;
		throw error;
	}
}

function agentRootRelativePath(root: PersistentAgentPathContext, file: string): string {
	if (root instanceof PersistentAgentInstance) return root.rootRelativePath(file);
	const relativePath = path.relative(root, file);
	if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error("event path must be inside persistent agent root");
	return relativePath.split(path.sep).join("/");
}

function checkpointEventDir(root: PersistentAgentPathContext): string {
	return root instanceof PersistentAgentInstance ? root.checkpointEventDir() : path.join(root, "events", "checkpoint");
}

function checkpointEventRecordPath(root: PersistentAgentPathContext, checkpointId: string): string {
	return root instanceof PersistentAgentInstance
		? root.checkpointEventRecordPath(checkpointId)
		: path.join(checkpointEventDir(root), `${safePersistentAgentEventRecordId(checkpointId, "checkpoint event id")}.json`);
}

function writeCheckpointEventRecord(root: PersistentAgentPathContext, record: CheckpointEventRecord): string {
	const file = checkpointEventRecordPath(root, record.checkpointId);
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
	return file;
}

function mementoEventDir(root: PersistentAgentPathContext): string {
	return root instanceof PersistentAgentInstance ? root.mementoEventDir() : path.join(root, "events", "memento");
}

function mementoEventRecordPath(root: PersistentAgentPathContext, mementoId: string): string {
	return root instanceof PersistentAgentInstance
		? root.mementoEventRecordPath(mementoId)
		: path.join(mementoEventDir(root), `${safePersistentAgentEventRecordId(mementoId, "memento event id")}.json`);
}

function writeMementoEventRecord(root: PersistentAgentPathContext, record: MementoEventRecord): string {
	const file = mementoEventRecordPath(root, record.mementoId);
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
	return file;
}

function absorbEventDir(root: PersistentAgentPathContext): string {
	return root instanceof PersistentAgentInstance ? root.absorbEventDir() : path.join(root, "events", "absorb");
}

function absorbEventRecordPath(root: PersistentAgentPathContext, absorbId: string): string {
	return root instanceof PersistentAgentInstance
		? root.absorbEventRecordPath(absorbId)
		: path.join(absorbEventDir(root), `${safePersistentAgentEventRecordId(absorbId, "absorb event id")}.json`);
}

function reviewEventDir(root: PersistentAgentPathContext): string {
	return root instanceof PersistentAgentInstance ? root.reviewEventDir() : path.join(root, "events", "review");
}

function reviewEventRecordPath(root: PersistentAgentPathContext, reviewId: string): string {
	return root instanceof PersistentAgentInstance
		? root.reviewEventRecordPath(reviewId)
		: path.join(reviewEventDir(root), `${safePersistentAgentEventRecordId(reviewId, "review event id")}.json`);
}

function slugTimestamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function shortRandomId(): string {
	return Math.random().toString(36).slice(2, 8);
}

function writeFileAtomic(file: string, content: string): void {
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, content, { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export { MAX_PERSISTENT_AGENT_ID_LENGTH, PERSISTENT_AGENT_THREAD_EARLIER_ITEMS_NOTICE, PERSISTENT_AGENT_THREAD_EARLIER_ITEMS_NOTICE_ID, PERSISTENT_AGENT_THREAD_ITEM_CAP, RECENT_CONTEXT_HARD_CAP, RECENT_CONTEXT_SOFT_CAP, absorbEventRecordPath, activePersistentRoomLock, agentRootRelativePath, assertOfferedRoomModel, checkpointEventRecordPath, ensureDir, ensurePersistentAgentCanonicalScaffoldDirs, idlePersistentAgentTurnState, mementoEventRecordPath, normalizePersistentAgentActiveTurnToken, normalizePersistentAgentRootRelativePath, normalizeRuntimeModel, persistentAgentActiveTurnKey, persistentAgentActiveTurns, persistentAgentConflictError, persistentAgentInstanceFrom, persistentAgentModelLockLabel, persistentAgentTurnConflictError, persistentRoomLock, readJson, requestBodyModelLock, reviewEventRecordPath, safePersistentAgentEventRecordId, safeRuntimeThreadId, shortRandomId, slugTimestamp, writeCheckpointEventRecord, writeFileAtomic, writeMementoEventRecord };
export type { AgentJson, PersistentAgentPathContext };
