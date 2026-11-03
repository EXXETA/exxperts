import fs from "node:fs";
import path from "node:path";
import { readConsultHandoffQueue, validateConsultHandoffQueue } from "./consult-handoff.js";
import { persistentAgentModelLocksEqual } from "./persistent-agent-ai-profiles.js";
import type { PersistentAgentActiveThreadSummary, PersistentAgentId, PersistentAgentPiSessionJsonlThreadRuntime, PersistentAgentRuntimeBoundaryReason, PersistentAgentRuntimeState, PersistentAgentRuntimeStateValue, PersistentAgentThreadClosedReason, PersistentAgentThreadModelHistoryEntry, PersistentAgentThreadOrigin, PersistentAgentThreadRecord, PersistentAgentThreadRuntime, PersistentAgentThreadStateValue, PersistentAgentThreadWriteInput, PersistentAgentThreadWriteOptions } from "./persistent-agent-types.js";
import type { L1bSourceFingerprint } from "./persistent-agent-memory-types.js";
import { heldMessageFiles } from "./held-messages-store.js";
import { applyCuts, isShared } from "./thread-items-by-id.js";
import { assertOfferedRoomModel, assertPersistentAgentThreadNotInFlight, createPersistentAgentInstance, ensureDir, getPersistentAgentActiveTurnState, getPersistentAgentRuntimeState, normalizePersistentAgentRootRelativePath, normalizeRuntimeModel, PERSISTENT_AGENT_THREAD_EARLIER_ITEMS_NOTICE, PERSISTENT_AGENT_THREAD_EARLIER_ITEMS_NOTICE_ID, PERSISTENT_AGENT_THREAD_ITEM_CAP, persistentAgentConflictError, persistentAgentModelLockLabel, readJson, safePersistentAgentEventRecordId, safeRuntimeThreadId, writeFileAtomic } from "./persistent-agent-store.js";

export interface PersistentAgentRuntimeStateWriteOptions {
	allowInFlightActiveThread?: boolean;
	/**
	 * Skip the active-AI-profile model approval gate. ONLY for
	 * runtime-boundary-only writes that never invoke a model (Memento): the
	 * fresh thread inherits the old thread's immutable model lock, which may
	 * legitimately belong to a profile that is no longer active. Prompting,
	 * checkpoints, scheduled runs and room entry keep full enforcement.
	 */
	allowInactiveProfileModel?: boolean;
}

export function writePersistentAgentRuntimeState(agentIdRaw: string, input: Partial<PersistentAgentRuntimeState> & { state: PersistentAgentRuntimeStateValue }, options: PersistentAgentRuntimeStateWriteOptions = {}): PersistentAgentRuntimeState {
	const instance = createPersistentAgentInstance(agentIdRaw);
	if (input.state !== "idle" && input.state !== "active" && input.state !== "standby") throw new Error("runtime state must be idle, active, or standby");
	const existing = getPersistentAgentRuntimeState(instance.agentId);
	const activeThreadId = input.state === "idle" ? null : safeRuntimeThreadId(input.activeThreadId ?? existing.activeThreadId);
	if (input.state !== "idle" && !activeThreadId) throw new Error("activeThreadId is required for active or standby runtime state");
	const model = input.state === "idle" ? null : normalizeRuntimeModel(input.model ?? existing.model);
	if (!options.allowInFlightActiveThread && existing.state !== "idle" && existing.activeThreadId) {
		const changingCurrentRuntime = input.state === "idle"
			|| activeThreadId !== existing.activeThreadId
			|| input.state !== existing.state
			|| (model && existing.model ? !persistentAgentModelLocksEqual(model, existing.model) : model !== existing.model);
		if (changingCurrentRuntime) assertPersistentAgentThreadNotInFlight(instance.agentId, existing.activeThreadId);
	}
	if (input.state !== "idle") {
		if (!model) throw new Error("runtime model is required for active or standby runtime state");
		// No curated-list check here: the model must equal the active thread's
		// immutable lock (below), and that lock was gated when the thread was
		// created. A conversation keeps its model after the model leaves the list.
		const thread = getPersistentAgentThread(instance.agentId, activeThreadId!);
		if (!thread || thread.state === "closed") throw persistentAgentConflictError("persistent-agent runtime activeThread is missing or closed");
		if (!persistentAgentModelLocksEqual(model, thread.model)) {
			throw persistentAgentConflictError(`persistent-agent runtime model ${persistentAgentModelLockLabel(model)} does not match activeThread model ${persistentAgentModelLockLabel(thread.model)}`);
		}
	}
	const next: PersistentAgentRuntimeState = {
		schemaVersion: 1,
		agentId: instance.agentId,
		state: input.state,
		activeThreadId,
		model,
		updatedAt: Date.now(),
	};
	const file = instance.runtimeStatePath();
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "w" });
	return next;
}

function normalizePersistentAgentThreadOrigin(raw: unknown): PersistentAgentThreadOrigin {
	return raw === "launcher" || raw === "home" || raw === "sidequest" || raw === "checkpoint" || raw === "memento" || raw === "unknown" ? raw : "unknown";
}

function normalizePersistentAgentThreadState(raw: unknown): PersistentAgentThreadStateValue | null {
	return raw === "active" || raw === "standby" || raw === "closed" ? raw : null;
}

function normalizePersistentAgentThreadItems(raw: unknown): unknown[] {
	if (!Array.isArray(raw)) return [];
	// The newest items are the ones that matter: what the person reads last, the
	// answer the room just landed, and what a reconnect compares against.
	// A thread cut once stays cut, so a notice it already carries is kept (once).
	const items = raw.filter((item) => !(item && typeof item === "object" && (item as { id?: unknown }).id === PERSISTENT_AGENT_THREAD_EARLIER_ITEMS_NOTICE_ID));
	const capped = items.length > PERSISTENT_AGENT_THREAD_ITEM_CAP || items.length < raw.length
		? [{ kind: "system", id: PERSISTENT_AGENT_THREAD_EARLIER_ITEMS_NOTICE_ID, text: PERSISTENT_AGENT_THREAD_EARLIER_ITEMS_NOTICE, level: "info" }, ...items.slice(-PERSISTENT_AGENT_THREAD_ITEM_CAP)]
		: items;
	try {
		return dropDoubledLandedAnswers(JSON.parse(JSON.stringify(capped)) as unknown[]);
	} catch {
		throw new Error("thread items must be JSON-serializable");
	}
}

// Threads saved before the client save learned to merge with a landing can hold
// one answer twice in a turn: the client's copy and the server's landed one.
// The landed one is whole, so the other copy, equal to it or a piece of it
// once spaces are evened out, goes. An item both sides name alike is never
// such a copy: it is merged by its id.
function dropDoubledLandedAnswers(items: unknown[]): unknown[] {
	const words = (text: unknown) => String(text ?? "").replace(/\s+/g, " ").trim();
	const drop = new Set<number>();
	let turnStart = 0;
	for (let i = 0; i <= items.length; i++) {
		if (i < items.length && (items[i] as any)?.kind !== "user") continue;
		const turn = items.slice(turnStart, i).map((item: any, offset) => ({ item, index: turnStart + offset })).filter(({ item }) => item?.kind === "assistant");
		for (const landed of turn.filter(({ item }) => String(item.id ?? "").startsWith("detached-assistant-"))) {
			const whole = words(landed.item.text);
			for (const other of turn) if (other !== landed && !isShared(other.item) && !String(other.item.id ?? "").startsWith("detached-assistant-") && words(other.item.text) && whole.includes(words(other.item.text))) drop.add(other.index);
		}
		turnStart = i + 1;
	}
	return drop.size ? items.filter((_, index) => !drop.has(index)) : items;
}

/**
 * Nothing is in flight when nothing is running: neither a streaming answer nor
 * a tool call waiting for its result.
 *
 * The `streaming` mark is written by the browser as an answer arrives, and the
 * save that clears it again is a debounced one that can be dropped: navigate at
 * the wrong moment and the finished answer stays marked mid-flight on disk
 * forever. That is not cosmetic. The restored-context reader treats a streaming
 * assistant item as an unfinished one and leaves it out, so a room that comes
 * back later resumes without the answer it just gave, and a scheduled run does
 * the same.
 *
 * The write path is the one place every producer passes through, and whether a
 * turn is running is knowable right here, so the invariant is enforced where it
 * cannot be forgotten. A save that lands mid-answer still keeps the mark, which
 * is what lets a reload draw the caret in the right place.
 */
function clearStaleStreamingMarks(items: unknown[], turnInFlight: boolean): unknown[] {
	if (turnInFlight) return items;
	let changed = false;
	const cleared = items.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return item;
		const record = item as Record<string, unknown>;
		if (record.kind === "assistant" && record.streaming === true) {
			changed = true;
			const { streaming: _streaming, ...rest } = record;
			return rest;
		}
		// A tool call is the same problem wearing a different field. One that was
		// in flight when the turn ended never gets its result, so it stays
		// "running" in the transcript, spins forever in the room, and is read back
		// later as a live call: the checkpoint prompt says "Status: running" about
		// a tool that stopped days ago. Stopped rather than error, because being
		// interrupted is not a failure.
		if (record.kind === "tool" && record.status === "running") {
			changed = true;
			return { ...record, status: "stopped" };
		}
		return item;
	});
	return changed ? cleared : items;
}

function defaultPersistentAgentThreadRuntime(): PersistentAgentThreadRuntime {
	return { kind: "transcript-recap-v1" };
}

function normalizeSha256Hex(raw: unknown): string | null {
	const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function normalizeL1bSourceFingerprint(raw: unknown): L1bSourceFingerprint | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const algorithm = (raw as { algorithm?: unknown }).algorithm;
	const value = normalizeSha256Hex((raw as { value?: unknown }).value);
	return algorithm === "sha256" && value ? { algorithm: "sha256", value } : null;
}

function normalizePersistentAgentRuntimeString(raw: unknown): string | null {
	const value = typeof raw === "string" ? raw.trim() : "";
	return /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) ? value : null;
}

function normalizePersistentAgentThreadRuntime(raw: unknown): PersistentAgentThreadRuntime {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultPersistentAgentThreadRuntime();
	const runtime = raw as Record<string, unknown>;
	if (runtime.kind === "transcript-recap-v1") return { kind: "transcript-recap-v1" };
	if (runtime.kind === "pi-session-jsonl") {
		const sessionId = normalizePersistentAgentRuntimeString(runtime.sessionId);
		const sessionFileRelPath = normalizePersistentAgentRootRelativePath(runtime.sessionFileRelPath);
		const bootPromptSnapshotRelPath = normalizePersistentAgentRootRelativePath(runtime.bootPromptSnapshotRelPath);
		const bootPromptSha256 = normalizeSha256Hex(runtime.bootPromptSha256);
		const l1bFingerprint = normalizeL1bSourceFingerprint(runtime.l1bFingerprint);
		// Absent on records from before the field existed (→ undefined, the
		// prose fallback); null means "booted without instructions"; a value
		// the code cannot read is unknown too, never a claim about the boot.
		const instructionsFingerprint = !("instructionsFingerprint" in runtime) ? undefined : (runtime.instructionsFingerprint === null ? null : (normalizeSha256Hex(runtime.instructionsFingerprint) ?? undefined));
		const createdAt = Number.isFinite(runtime.createdAt) && Number(runtime.createdAt) > 0 ? Math.floor(Number(runtime.createdAt)) : 0;
		const leafId = runtime.leafId == null ? undefined : normalizePersistentAgentRuntimeString(runtime.leafId);
		if (
			sessionId &&
			sessionFileRelPath &&
			bootPromptSnapshotRelPath &&
			sessionFileRelPath.startsWith("runtime/pi-sessions/") &&
			bootPromptSnapshotRelPath.startsWith("runtime/pi-sessions/") &&
			sessionFileRelPath.endsWith(".jsonl") &&
			bootPromptSnapshotRelPath.endsWith(".boot-prompt.txt") &&
			bootPromptSha256 &&
			l1bFingerprint &&
			createdAt > 0 &&
			(runtime.leafId == null || leafId)
		) {
			return {
				kind: "pi-session-jsonl",
				sessionId,
				sessionFileRelPath,
				bootPromptSnapshotRelPath,
				bootPromptSha256,
				l1bFingerprint,
				...(instructionsFingerprint !== undefined ? { instructionsFingerprint } : {}),
				createdAt,
				...(leafId ? { leafId } : {}),
			};
		}
		throw new Error("invalid persistent-agent pi-session-jsonl runtime metadata");
	}
	return defaultPersistentAgentThreadRuntime();
}

function normalizePersistentAgentThreadRecord(raw: any, agentId: PersistentAgentId, threadId: string): PersistentAgentThreadRecord | null {
	if (!raw || raw.threadId !== threadId) return null;
	const state = normalizePersistentAgentThreadState(raw.state);
	const model = normalizeRuntimeModel(raw.model);
	if (!state || !model) return null;
	const createdAt = Number.isFinite(raw.createdAt) && raw.createdAt > 0 ? Math.floor(raw.createdAt) : Date.now();
	const updatedAt = Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? Math.floor(raw.updatedAt) : createdAt;
	const closedAt = Number.isFinite(raw.closedAt) && raw.closedAt > 0 ? Math.floor(raw.closedAt) : undefined;
	const closedByCheckpointId = typeof raw.closedByCheckpointId === "string" && raw.closedByCheckpointId.trim() ? safePersistentAgentEventRecordId(raw.closedByCheckpointId, "closed checkpoint id") : undefined;
	const closedByMementoId = typeof raw.closedByMementoId === "string" && raw.closedByMementoId.trim() ? safePersistentAgentEventRecordId(raw.closedByMementoId, "closed memento id") : undefined;
	const closedReason = raw.closedReason === "checkpoint" || raw.closedReason === "memento" ? raw.closedReason as PersistentAgentThreadClosedReason : undefined;
	return {
		schemaVersion: 1,
		threadId,
		agentId,
		state,
		...(state === "closed" && closedReason ? { closedReason } : {}),
		...(state === "closed" && closedAt ? { closedAt } : {}),
		...(state === "closed" && closedByCheckpointId ? { closedByCheckpointId } : {}),
		...(state === "closed" && closedByMementoId ? { closedByMementoId } : {}),
		origin: normalizePersistentAgentThreadOrigin(raw.origin),
		model,
		...((): { modelHistory?: PersistentAgentThreadModelHistoryEntry[] } => {
			const history = Array.isArray(raw.modelHistory)
				? raw.modelHistory.flatMap((entry: any) => {
					const lock = normalizeRuntimeModel(entry);
					const until = Number(entry?.until);
					return lock && Number.isFinite(until) && until > 0 ? [{ provider: lock.provider, model: lock.model, until: Math.floor(until) }] : [];
				})
				: [];
			return history.length ? { modelHistory: history } : {};
		})(),
		...(raw.modelChosen === true ? { modelChosen: true as const } : {}),
		runtime: normalizePersistentAgentThreadRuntime(raw.runtime),
		items: normalizePersistentAgentThreadItems(raw.items),
		...(readConsultHandoffQueue(raw.pendingHandoffs).length ? { pendingHandoffs: readConsultHandoffQueue(raw.pendingHandoffs) } : {}),
		...(readEditedAway(raw.editedAway).length ? { editedAway: readEditedAway(raw.editedAway) } : {}),
		createdAt,
		updatedAt,
	};
}

export function getPersistentAgentThread(agentIdRaw: string, threadIdRaw: string): PersistentAgentThreadRecord | null {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	const file = instance.runtimeThreadPath(threadId);
	if (!fs.existsSync(file)) return null;
	const thread = normalizePersistentAgentThreadRecord(readJson(file), instance.agentId, threadId);
	return thread ? { ...thread, items: withAcceptedCuts(cutsKey(instance.agentId, threadId), thread.items) } : null;
}

/**
 * Stops the socket accepted for landed answer parts, by conversation (part id
 * to the characters kept). Every read of the conversation applies them, and
 * every writer builds its record from a read, so a cut whose own write failed
 * is not lost and a writer that keeps the stored items keeps the cut; a save
 * of the page's items is cut again on its way in. They are kept after a
 * write, so a later save that brings the whole part back is cut again. The
 * newest 50 per conversation, in memory: a restart forgets them.
 */
const acceptedAnswerCuts = new Map<string, Map<string, number>>();
const ACCEPTED_CUTS_KEPT = 50;
const cutsKey = (agentId: string, threadId: string) => `${agentId}\u0000${threadId}`;

export function acceptAnswerCut(agentIdRaw: string, threadIdRaw: string, partId: string, kept: number): void {
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) return;
	const key = cutsKey(createPersistentAgentInstance(agentIdRaw).agentId, threadId);
	const cuts = acceptedAnswerCuts.get(key) ?? new Map<string, number>();
	const next = Math.min(kept, cuts.get(partId) ?? kept);
	cuts.delete(partId);
	cuts.set(partId, next);
	for (const oldest of cuts.keys()) {
		if (cuts.size <= ACCEPTED_CUTS_KEPT) break;
		cuts.delete(oldest);
	}
	acceptedAnswerCuts.set(key, cuts);
}

export function writePersistentAgentThread(agentIdRaw: string, threadIdRaw: string, input: PersistentAgentThreadWriteInput, options: PersistentAgentThreadWriteOptions = {}): { thread: PersistentAgentThreadRecord; runtime: PersistentAgentRuntimeState } {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	const state = normalizePersistentAgentThreadState(input.state);
	if (!state || state === "closed") throw new Error("thread state must be active or standby");
	const existing = getPersistentAgentThread(instance.agentId, threadId);
	if (existing?.state === "closed") throw new Error(`persistent-agent thread is closed and non-resumable: ${threadId}`);
	// Preserve-if-absent (Consult MR-5 §2.3): an omitted pendingHandoffs keeps the
	// stored queue (so unrelated saves never clobber it); a provided value (incl.
	// []) replaces it. Validated up-front, before any runtime side effect, so junk
	// is rejected cleanly without materialising a boot/session artifact.
	const pendingHandoffs = input.pendingHandoffs !== undefined
		? validateConsultHandoffQueue(input.pendingHandoffs)
		: readConsultHandoffQueue(existing?.pendingHandoffs);
	const model = normalizeRuntimeModel(input.model ?? existing?.model);
	if (!model) throw new Error("thread model is required");
	// The curated list gates a NEW lock only. An existing thread keeps the
	// model it started on even after that model left the list (its lock is
	// immutable below anyway); a fresh thread must start on a curated model.
	if (!existing && !options.allowInactiveProfileModel) assertOfferedRoomModel(model, "persistent-agent thread writes");
	if (existing && !persistentAgentModelLocksEqual(model, existing.model)) {
		throw persistentAgentConflictError(`persistent-agent thread model lock is immutable; create a fresh runtime boundary to change ${persistentAgentModelLockLabel(existing.model)} to ${persistentAgentModelLockLabel(model)}`);
	}
	const existingRuntime = getPersistentAgentRuntimeState(instance.agentId);
	if (existingRuntime.state !== "idle" && existingRuntime.activeThreadId === threadId && existing && state !== existing.state) {
		assertPersistentAgentThreadNotInFlight(instance.agentId, threadId);
	}
	const now = Date.now();
	const threadRuntime = existing?.runtime ?? options.createRuntime?.({ instance, threadId, model, now }) ?? defaultPersistentAgentThreadRuntime();
	const editedAway = existing?.editedAway ?? [];
	const thread: PersistentAgentThreadRecord = {
		schemaVersion: 1,
		threadId,
		agentId: instance.agentId,
		state,
		// "unknown" keeps what is known: the client's debounced and pagehide saves do not know the origin.
		origin: normalizePersistentAgentThreadOrigin(input.origin === undefined || input.origin === "unknown" ? existing?.origin ?? input.origin : input.origin),
		model,
		...(existing?.modelHistory ? { modelHistory: existing.modelHistory } : {}),
		...((existing ? existing.modelChosen : input.modelChosen) ? { modelChosen: true as const } : {}),
		runtime: threadRuntime,
		items: clearStaleStreamingMarks(
			normalizePersistentAgentThreadItems(withoutEditedAway(withAcceptedCuts(cutsKey(instance.agentId, threadId), input.items ?? existing?.items ?? []), editedAway)),
			(() => {
				const turn = getPersistentAgentActiveTurnState(instance.agentId, threadId);
				return turn.state === "running" || turn.state === "cancelling";
			})(),
		),
		...(pendingHandoffs.length ? { pendingHandoffs } : {}),
		...(editedAway.length ? { editedAway } : {}),
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
	const file = instance.runtimeThreadPath(threadId);
	ensureDir(path.dirname(file));
	writeFileAtomic(file, JSON.stringify(thread, null, 2) + "\n");
	// The room moved on to another conversation while this one was being
	// written (a turn that landed after the switch, a late standby save):
	// the answer is kept in the conversation it belongs to and the pointer
	// stays where the person went, so the next message there is not refused.
	if (options.keepRuntimeIfMoved && existingRuntime.state !== "idle" && existingRuntime.activeThreadId !== threadId) {
		return { thread, runtime: existingRuntime };
	}
	const runtime = writePersistentAgentRuntimeState(instance.agentId, { state, activeThreadId: threadId, model }, { allowInFlightActiveThread: true, ...(options.allowInactiveProfileModel ? { allowInactiveProfileModel: true } : {}) });
	return { thread, runtime };
}

function readEditedAway(raw: unknown): string[] {
	return Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === "string" && id !== ""))] : [];
}

function withoutEditedAway(items: unknown[], editedAway: readonly string[]): unknown[] {
	if (editedAway.length === 0 || !Array.isArray(items)) return items;
	const gone = new Set(editedAway);
	return items.filter((item) => !gone.has(String((item as { id?: unknown } | null)?.id ?? "")));
}

/**
 * An edit of the last message took these items out: the conversation is
 * written without them, and keeps their ids so that every later write leaves
 * them out too, however many there were and however late an older copy
 * arrives. Only the items and that list change. Run twice, it writes the
 * same file.
 */
export function removeEditedAwayItems(agentIdRaw: string, threadIdRaw: string, ids: readonly string[]): void {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId || ids.length === 0) return;
	const existing = getPersistentAgentThread(instance.agentId, threadId);
	if (!existing || existing.state === "closed") return;
	const editedAway = readEditedAway([...(existing.editedAway ?? []), ...ids]);
	const next: PersistentAgentThreadRecord = { ...existing, items: withoutEditedAway(existing.items, editedAway), editedAway, updatedAt: Date.now() };
	const file = instance.runtimeThreadPath(threadId);
	ensureDir(path.dirname(file));
	writeFileAtomic(file, JSON.stringify(next, null, 2) + "\n");
}

function withAcceptedCuts<T>(key: string, items: T): T {
	const cuts = acceptedAnswerCuts.get(key);
	return cuts?.size && Array.isArray(items) ? applyCuts(items, cuts).items as T : items;
}

/**
 * Consult MR-5 hardening: clear the pending-transfer queue the instant a prompt
 * consumes it. The client prepends any queued handoff blocks to the outgoing
 * prompt text, so the moment the WS prompt handler receives a prompt the queue
 * is logically consumed — clearing it here, in the same handler, makes consume
 * and clear atomic server-side. Without this the clear rode a separate debounced
 * client PUT, so a crash (or a reordered client save) between the two could leave
 * an already-sent block queued to be injected into the room's context a second
 * time. No-op when the queue is already empty; only the `pendingHandoffs` field
 * is touched — items, state, model, and runtime are preserved verbatim.
 */
export function clearPersistentAgentThreadPendingHandoffs(agentIdRaw: string, threadIdRaw: string): void {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) return;
	const existing = getPersistentAgentThread(instance.agentId, threadId);
	if (!existing || !existing.pendingHandoffs || existing.pendingHandoffs.length === 0) return;
	const { pendingHandoffs: _consumed, ...rest } = existing;
	const cleared: PersistentAgentThreadRecord = { ...rest, updatedAt: Date.now() };
	const file = instance.runtimeThreadPath(threadId);
	ensureDir(path.dirname(file));
	writeFileAtomic(file, JSON.stringify(cleared, null, 2) + "\n");
}

/**
 * The handoff flip (revise-in-place slice): a finished specialist task
 * announces itself by enqueuing its slimmed §2.2 block on the pending-transfer
 * queue, where it rides the user's NEXT prompt — no click, no interruption
 * (exactly how transferred consults are delivered; the click was the only
 * part that retired). Append-one with the queue's own validation as the gate:
 * a full queue (or an over-cap block) refuses rather than evicting a block the
 * user explicitly transferred — honest degradation, because the manifest still
 * lists the file either way. Returns whether the block is now queued, so the
 * caller only mirrors it to a live client when it is truly persisted. A
 * missing or closed thread refuses: closed threads are immutable history.
 */
export function appendPersistentAgentThreadPendingHandoff(agentIdRaw: string, threadIdRaw: string, block: string): boolean {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) return false;
	const existing = getPersistentAgentThread(instance.agentId, threadId);
	if (!existing || existing.state === "closed") return false;
	let pendingHandoffs: string[];
	try {
		pendingHandoffs = validateConsultHandoffQueue([...(existing.pendingHandoffs ?? []), block]);
	} catch {
		return false;
	}
	const next: PersistentAgentThreadRecord = { ...existing, pendingHandoffs, updatedAt: Date.now() };
	const file = instance.runtimeThreadPath(threadId);
	ensureDir(path.dirname(file));
	writeFileAtomic(file, JSON.stringify(next, null, 2) + "\n");
	return true;
}

export function closePersistentAgentThreadForCheckpoint(agentIdRaw: string, threadIdRaw: string, checkpointIdRaw: string, closedAtRaw: number = Date.now()): PersistentAgentThreadRecord {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	const checkpointId = safePersistentAgentEventRecordId(checkpointIdRaw, "checkpoint id");
	const existing = getPersistentAgentThread(instance.agentId, threadId);
	if (!existing) throw new Error(`persistent-agent thread not found: ${threadId}`);
	const closedAt = Number.isFinite(closedAtRaw) && closedAtRaw > 0 ? Math.floor(closedAtRaw) : Date.now();
	const thread: PersistentAgentThreadRecord = {
		...existing,
		state: "closed",
		closedReason: "checkpoint",
		closedAt,
		closedByCheckpointId: checkpointId,
		updatedAt: closedAt,
	};
	const file = instance.runtimeThreadPath(threadId);
	ensureDir(path.dirname(file));
	writeFileAtomic(file, JSON.stringify(thread, null, 2) + "\n");
	return thread;
}

export function closePersistentAgentThreadForMemento(agentIdRaw: string, threadIdRaw: string, mementoIdRaw: string, closedAtRaw: number = Date.now()): PersistentAgentThreadRecord {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	const mementoId = safePersistentAgentEventRecordId(mementoIdRaw, "memento id");
	const existing = getPersistentAgentThread(instance.agentId, threadId);
	if (!existing) throw new Error(`persistent-agent thread not found: ${threadId}`);
	if (existing.state === "closed") throw new Error(`persistent-agent thread is already closed and non-resumable: ${threadId}`);
	const closedAt = Number.isFinite(closedAtRaw) && closedAtRaw > 0 ? Math.floor(closedAtRaw) : Date.now();
	const thread: PersistentAgentThreadRecord = {
		...existing,
		state: "closed",
		closedReason: "memento",
		closedAt,
		closedByMementoId: mementoId,
		updatedAt: closedAt,
	};
	const file = instance.runtimeThreadPath(threadId);
	ensureDir(path.dirname(file));
	writeFileAtomic(file, JSON.stringify(thread, null, 2) + "\n");
	return thread;
}

export function deletePersistentAgentThread(agentIdRaw: string, threadIdRaw: string): { ok: true; runtime: PersistentAgentRuntimeState } {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	const existingRuntime = getPersistentAgentRuntimeState(instance.agentId);
	if (existingRuntime.activeThreadId === threadId) assertPersistentAgentThreadNotInFlight(instance.agentId, threadId);
	const file = instance.runtimeThreadPath(threadId);
	// The transcript goes with the record, unless a Remember closed it: search reads it.
	if (getPersistentAgentThread(instance.agentId, threadId)?.closedReason !== "checkpoint") for (const transcript of [instance.runtimePiSessionPath(threadId), instance.runtimeBootPromptSnapshotPath(threadId)]) fs.rmSync(transcript, { force: true });
	if (fs.existsSync(file)) fs.unlinkSync(file);
	for (const held of heldMessageFiles(instance.rootDir, threadId)) fs.rmSync(held, { force: true });
	const runtime = existingRuntime.activeThreadId === threadId ? writePersistentAgentRuntimeState(instance.agentId, { state: "idle" }, { allowInFlightActiveThread: true }) : existingRuntime;
	return { ok: true, runtime };
}

export function discardEmptyPreparedBoundaryThread(agentIdRaw: string, threadIdRaw: string): { ok: true; discarded: true; threadId: string; boundary: PersistentAgentRuntimeBoundaryReason; runtime: PersistentAgentRuntimeState } {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	const runtime = getPersistentAgentRuntimeState(instance.agentId);
	if ((runtime.state !== "active" && runtime.state !== "standby") || runtime.activeThreadId !== threadId) {
		const error = new Error("empty prepared boundary retirement requires the current activeThread");
		(error as any).statusCode = 409;
		throw error;
	}
	const thread = getPersistentAgentThread(instance.agentId, threadId);
	if (!thread || thread.state === "closed") {
		const error = new Error("empty prepared boundary retirement target is missing or closed");
		(error as any).statusCode = 409;
		throw error;
	}
	if (threadHasUserVisibleTurns(thread.items)) {
		const error = new Error("empty prepared boundary retirement cannot discard a thread with user-visible turns");
		(error as any).statusCode = 409;
		throw error;
	}
	const boundary = thread.origin === "checkpoint" || thread.threadId.startsWith("postcp_")
		? "checkpoint"
		: thread.origin === "memento" || thread.threadId.startsWith("postmem_")
			? "memento"
			: null;
	if (!boundary) {
		const error = new Error("retiring an empty prepared conversation requires a checkpoint or forget boundary");
		(error as any).statusCode = 409;
		throw error;
	}
	assertPersistentAgentThreadNotInFlight(instance.agentId, threadId);
	const file = instance.runtimeThreadPath(threadId);
	for (const transcript of [instance.runtimePiSessionPath(threadId), instance.runtimeBootPromptSnapshotPath(threadId)]) fs.rmSync(transcript, { force: true });
	if (fs.existsSync(file)) fs.unlinkSync(file);
	const nextRuntime = writePersistentAgentRuntimeState(instance.agentId, { state: "idle" }, { allowInFlightActiveThread: true });
	return { ok: true, discarded: true, threadId, boundary, runtime: nextRuntime };
}

function threadHasUserVisibleTurns(items: unknown[]): boolean {
	return items.some((item: any) => {
		const kind = item?.kind;
		if (kind !== "user" && kind !== "assistant") return false;
		return typeof item?.text === "string" && item.text.trim().length > 0;
	});
}

function activeThreadSummaryForRuntime(agentId: PersistentAgentId, runtime: PersistentAgentRuntimeState): PersistentAgentActiveThreadSummary | null {
	if ((runtime.state !== "active" && runtime.state !== "standby") || !runtime.activeThreadId) return null;
	try {
		const thread = getPersistentAgentThread(agentId, runtime.activeThreadId);
		if (!thread || thread.state === "closed") return null;
		const hasUserVisibleTurns = threadHasUserVisibleTurns(thread.items);
		const preparedByBoundary = !hasUserVisibleTurns && (thread.origin === "checkpoint" || thread.origin === "memento") ? thread.origin : null;
		const activeTurn = getPersistentAgentActiveTurnState(agentId, thread.threadId);
		const inFlight = activeTurn.state === "running" || activeTurn.state === "cancelling";
		return {
			threadId: thread.threadId,
			state: thread.state,
			origin: thread.origin,
			runtime: thread.runtime,
			itemCount: thread.items.length,
			hasUserVisibleTurns,
			preparedByBoundary,
			preparedByCheckpoint: preparedByBoundary === "checkpoint",
			followsConversationPick: !hasUserVisibleTurns && !inFlight && !thread.modelChosen && thread.runtime.kind === "pi-session-jsonl" && piSessionHasNoMessages(agentId, thread.runtime),
			activeTurn,
			inFlight,
			working: activeTurn.state === "running",
			cancelling: activeTurn.state === "cancelling",
		};
	} catch {
		return null;
	}
}

/** True when the Pi session file holds no conversation entries yet (only its header and bookkeeping). */
function piSessionHasNoMessages(agentIdRaw: string, runtime: PersistentAgentPiSessionJsonlThreadRuntime): boolean {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const file = instance.resolveRootRelativePath(runtime.sessionFileRelPath, "persistent-agent Pi session path");
	if (!fs.existsSync(file)) return false;
	for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "message" || entry?.type === "compaction" || entry?.type === "branch_summary" || entry?.type === "custom_message") return false;
		} catch {
			return false;
		}
	}
	return true;
}

export { activeThreadSummaryForRuntime, normalizeL1bSourceFingerprint, normalizePersistentAgentRuntimeString, normalizePersistentAgentThreadRecord, normalizeSha256Hex, piSessionHasNoMessages, threadHasUserVisibleTurns };
