import fs from "node:fs";
import path from "node:path";
import { settleCommits } from "./memory-commit.js";
import { eraseAgainIfForgotten } from "./forget-erase.js";
import { recordPersistentRoomLastUsed, type PersistentRoomLastUsed, recordPersistentRoomLastUsedIfAbsent } from "./persistent-room-last-used.js";
import type { PatienceWait } from "./model-call-causes.js";
import { isSharedServer } from "./server-hooks.js";
import type { PersistentAgentActiveTurnState, PersistentAgentActiveTurnTerminalReason, PersistentAgentRuntimeState, PersistentAgentUnseenLandedAnswer, PersistentAgentUnseenLandedAnswerOrigin } from "./persistent-agent-types.js";
import { createPersistentAgentInstance, ensureDir, getPersistentAgentActiveTurnState, getPersistentAgentRuntimeState, idlePersistentAgentTurnState, normalizePersistentAgentActiveTurnToken, persistentAgentActiveTurnKey, persistentAgentActiveTurns, type PersistentAgentInstance, persistentAgentTurnConflictError, readJson, safeRuntimeThreadId, shortRandomId, writeFileAtomic } from "./persistent-agent-store.js";
import { getPersistentAgentThread, normalizePersistentAgentThreadRecord, threadHasUserVisibleTurns } from "./persistent-agent-threads.js";
import { declinedQuestionNoteText, notesOfKeptCards } from "./thread-items-by-id.js";

// Remember reading a conversation. While a proposal is being generated the
// conversation must not move: a message sent meanwhile (from another device,
// or a scheduled run) would make the paid proposal stale at approval. In
// memory on purpose: a server restart ends every generation with it, and the
// client's progress poll then reads "gone" instead of spinning forever.
const rememberGenerations = new Map<string, { read: number; of: number; startedAt: number; wait: PatienceWait | null; stop?: (reason?: "saved" | "forgotten") => void }>();

export const REMEMBER_GENERATING_MESSAGE = "Remember is reading this conversation. Send your message when it has finished, or cancel it.";

export const REMEMBER_ALREADY_GENERATING_MESSAGE = "Remember is already reading this conversation, on this or another device. Wait for it to finish, or cancel it.";

function rememberGenerationKey(agentIdRaw: string, threadIdRaw: string): string {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	return persistentAgentActiveTurnKey(instance.agentId, threadId);
}

/**
 * Marks a Remember as reading this conversation; refuses a second one with
 * 409. Returns the function that ends it. `stop` is how Save and Forget of
 * the conversation stop it, so nothing it reads outlives them.
 */
export function beginRememberGeneration(agentIdRaw: string, threadIdRaw: string, stop?: (reason?: "saved" | "forgotten") => void): { update: (progress: { read: number; of: number }) => void; wait: (wait: PatienceWait | null) => void; end: () => void } {
	const key = rememberGenerationKey(agentIdRaw, threadIdRaw);
	if (rememberGenerations.has(key)) {
		const error = new Error(REMEMBER_ALREADY_GENERATING_MESSAGE);
		(error as any).statusCode = 409;
		throw error;
	}
	const entry = { read: 0, of: 1, startedAt: Date.now(), wait: null as PatienceWait | null, stop };
	rememberGenerations.set(key, entry);
	return {
		update: (progress) => { entry.read = progress.read; entry.of = progress.of; },
		// A busy model being waited out: the dialog shows the next try's time.
		wait: (wait) => { entry.wait = wait; },
		end: () => { if (rememberGenerations.get(key) === entry) rememberGenerations.delete(key); },
	};
}

/** How far a running Remember has read this conversation, or null when none is running. */
export function getRememberGeneration(agentIdRaw: string, threadIdRaw: string): { read: number; of: number; wait?: PatienceWait } | null {
	const entry = rememberGenerations.get(rememberGenerationKey(agentIdRaw, threadIdRaw));
	return entry ? { read: entry.read, of: entry.of, ...(entry.wait ? { wait: entry.wait } : {}) } : null;
}

/** A window still showing a conversation the room has moved on from (another window saved, forgot or started fresh). */
export const CONVERSATION_MOVED_MESSAGE = "This room went on in another window. Reload to continue there.";

export function conversationMovedError(): Error {
	return Object.assign(new Error(CONVERSATION_MOVED_MESSAGE), { statusCode: 409, code: "conversation_moved" });
}

/** The room's own files can't be read, which says nothing about another window. */
export function roomFilesUnreadableError(sharedServer = isSharedServer(), refused: "message" | "remember" = "message"): Error {
	const message = refused === "remember"
		? `The room could not read its own files, so Remember did not start. Nothing was saved. ${sharedServer ? "Generate again in a moment; if it repeats, tell your admin." : "Generate again; if it repeats, restart exxperts."}`
		: `The room could not read its own files, so your message was not sent. Nothing was lost. ${sharedServer ? "Try again in a moment; if it repeats, tell your admin." : "Try again; if it repeats, restart exxperts."}`;
	return Object.assign(new Error(message), { statusCode: 409, code: "room_files_unreadable" });
}

function roomStateUnreadable(instance: PersistentAgentInstance): boolean {
	return fs.existsSync(instance.runtimeStatePath()) && readJson(instance.runtimeStatePath()) === null;
}

/** Remember reads only the room's open conversation: a room that can't read its own files says so, and a window the room moved on from is told so. */
export function assertRememberReadsOpenConversation(agentIdRaw: string, conversationId: string): void {
	const instance = createPersistentAgentInstance(agentIdRaw);
	if (roomStateUnreadable(instance)) throw roomFilesUnreadableError(isSharedServer(), "remember");
	if (getPersistentAgentRuntimeState(instance.agentId).activeThreadId !== conversationId) throw conversationMovedError();
	if (!getPersistentAgentThread(instance.agentId, conversationId)) throw roomFilesUnreadableError(isSharedServer(), "remember");
}

export function assertNoRememberGeneration(agentIdRaw: string, threadIdRaw: string): void {
	if (!rememberGenerations.has(rememberGenerationKey(agentIdRaw, threadIdRaw))) return;
	const error = new Error(REMEMBER_GENERATING_MESSAGE);
	(error as any).statusCode = 409;
	throw error;
}

/**
 * What a conversation's keyed turns leave in memory (thread-items-by-id.ts):
 * the latest-turn marker, the keys of recent turns in start order and the
 * ids removed on purpose lately (accepted cuts: persistent-agent-threads.ts).
 * In memory on purpose: a restart forgets them, a stated gap
 * of the design (a late Stop then cuts nothing).
 */
type ConversationItemMemory = { marker?: string; keys: string[]; removed: string[] };
const conversationItemMemories = new Map<string, ConversationItemMemory>();
const RECENT_KEYS_KEPT = 50;
const REMOVED_IDS_KEPT = 50;
/** Starts the marker of a turn without a key: no key can hold it. */
const UNKEYED_MARKER = "\u0000";

function conversationItemMemory(agentIdRaw: string, threadIdRaw: string): ConversationItemMemory {
	const key = rememberGenerationKey(agentIdRaw, threadIdRaw);
	let memory = conversationItemMemories.get(key);
	if (!memory) {
		memory = { keys: [], removed: [] };
		conversationItemMemories.set(key, memory);
	}
	return memory;
}

/** The key of the conversation's newest turn; undefined after a turn without one or a restart. A late Stop cuts only this turn's parts. */
export function latestTurnKey(agentIdRaw: string, threadIdRaw: string): string | undefined {
	const marker = conversationItemMemory(agentIdRaw, threadIdRaw).marker;
	return marker && !marker.startsWith(UNKEYED_MARKER) ? marker : undefined;
}

/** The keys of the conversation's recent turns, oldest first: where a landing puts a question the file lacks. */
export function recentTurnKeys(agentIdRaw: string, threadIdRaw: string): string[] {
	return [...conversationItemMemory(agentIdRaw, threadIdRaw).keys];
}

/** Ids the page or the server took out on purpose: no later save brings them back while the server runs. */
export function rememberRemovedIds(agentIdRaw: string, threadIdRaw: string, ids: readonly string[]): void {
	if (ids.length === 0) return;
	const memory = conversationItemMemory(agentIdRaw, threadIdRaw);
	memory.removed = [...memory.removed.filter((id) => !ids.includes(id)), ...ids].slice(-REMOVED_IDS_KEPT);
}

export function removedIdsOf(agentIdRaw: string, threadIdRaw: string): Set<string> {
	return new Set(conversationItemMemory(agentIdRaw, threadIdRaw).removed);
}

/** Throws what `beginPersistentAgentTurn` would refuse with, and changes nothing: an edit asks before it steps the conversation back. */
export function assertPersistentAgentTurnCanBegin(agentIdRaw: string, threadIdRaw: string): void {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	assertNoRememberGeneration(instance.agentId, threadId);
	if (roomStateUnreadable(instance)) throw roomFilesUnreadableError();
	const runtime = getPersistentAgentRuntimeState(instance.agentId);
	if ((runtime.state !== "active" && runtime.state !== "standby") || runtime.activeThreadId !== threadId) throw conversationMovedError();
	const thread = getPersistentAgentThread(instance.agentId, threadId);
	if (!thread) throw roomFilesUnreadableError();
	if (thread.state === "closed") {
		const error = new Error("persistent-agent activeThread is closed");
		(error as any).statusCode = 409;
		throw error;
	}
	const existing = getPersistentAgentActiveTurnState(instance.agentId, threadId);
	if (existing.state === "running" || existing.state === "cancelling") throw persistentAgentTurnConflictError(instance.agentId, threadId, existing);
}

/** `key`: the turn's key when the page named it (thread-items-by-id.ts). Every turn moves the conversation's latest-turn marker, keyed or not, and the marker outlives the turn. */
export function beginPersistentAgentTurn(agentIdRaw: string, threadIdRaw: string, metadata: { turnId?: string; connectionId?: string; key?: string } = {}): PersistentAgentActiveTurnState {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	// Every turn passes here, the socket's and the scheduler's: a save a crash
	// left half done is finished first, so no turn lands on a conversation
	// whose page is already saved.
	settleCommits(instance.agentId, instance.rootDir);
	assertPersistentAgentTurnCanBegin(instance.agentId, threadId);
	const now = Date.now();
	const turnId = normalizePersistentAgentActiveTurnToken(metadata.turnId, "turn id") ?? `turn_${now.toString(36)}_${shortRandomId()}`;
	const connectionId = normalizePersistentAgentActiveTurnToken(metadata.connectionId, "connection id");
	const state: PersistentAgentActiveTurnState = {
		state: "running",
		turnId,
		startedAt: now,
		...(connectionId ? { connectionId } : {}),
		updatedAt: now,
	};
	persistentAgentActiveTurns.set(persistentAgentActiveTurnKey(instance.agentId, threadId), state);
	const memory = conversationItemMemory(instance.agentId, threadId);
	memory.marker = metadata.key ?? `${UNKEYED_MARKER}${turnId}`;
	if (metadata.key) memory.keys = [...memory.keys.filter((key) => key !== metadata.key), metadata.key].slice(-RECENT_KEYS_KEPT);
	// The turn has started: the room counts as used from here, however the turn
	// ends. Best-effort by construction (the function cannot throw).
	recordPersistentRoomLastUsed(instance.agentId, "server");
	return state;
}

export function markPersistentAgentTurnCancelling(agentIdRaw: string, threadIdRaw: string, reason: PersistentAgentActiveTurnTerminalReason | "abort_requested" = "cancelled"): PersistentAgentActiveTurnState {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	const existing = getPersistentAgentActiveTurnState(instance.agentId, threadId);
	if (existing.state === "idle") return existing;
	const now = Date.now();
	const terminalReason = reason === "abort_requested" ? undefined : reason;
	const state: PersistentAgentActiveTurnState = {
		state: "cancelling",
		...(existing.turnId ? { turnId: existing.turnId } : {}),
		...(existing.startedAt ? { startedAt: existing.startedAt } : {}),
		...(existing.connectionId ? { connectionId: existing.connectionId } : {}),
		...(terminalReason ? { lastTerminalReason: terminalReason } : {}),
		updatedAt: now,
	};
	persistentAgentActiveTurns.set(persistentAgentActiveTurnKey(instance.agentId, threadId), state);
	return state;
}

export function finishPersistentAgentTurn(agentIdRaw: string, threadIdRaw: string, outcome: { turnId?: string; terminalReason: PersistentAgentActiveTurnTerminalReason }): PersistentAgentActiveTurnState {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	// A turn that outlived Forget's stop may have written into the erased transcript.
	eraseAgainIfForgotten(instance.agentId, instance.rootDir, threadId);
	const existing = getPersistentAgentActiveTurnState(instance.agentId, threadId);
	const turnId = normalizePersistentAgentActiveTurnToken(outcome.turnId, "turn id");
	if (existing.state === "idle" && existing.updatedAt > 0) return existing;
	if (existing.state !== "idle" && turnId && existing.turnId && existing.turnId !== turnId) return existing;
	const state = idlePersistentAgentTurnState(Date.now(), outcome.terminalReason);
	persistentAgentActiveTurns.set(persistentAgentActiveTurnKey(instance.agentId, threadId), state);
	return state;
}

export function recordPersistentAgentUnseenLandedAnswer(agentIdRaw: string, marker: { threadId: string; turnId: string; terminalReason: "completed" | "failed"; origin?: PersistentAgentUnseenLandedAnswerOrigin }): void {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(marker.threadId);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	const turnId = String(marker.turnId ?? "").trim();
	if (!turnId) throw new Error("invalid persistent-agent turn id");
	const origin = marker.origin ?? "detached-turn";
	// One file, two producers. A live landing goes into the room's live
	// conversation, which the user walks into by default; a scheduled answer
	// sits in a conversation of its own that has to be opened on purpose. So a
	// live landing must not truncate a scheduled marker for a different
	// conversation: the badge would then clear on the bind that shows the live
	// answer, and the scheduled one would stay unread with nothing pointing at
	// it. The badge the user keeps is the one that is harder to reach; the live
	// answer is waiting in the conversation they open anyway. Same conversation,
	// or a scheduled landing arriving on top: newest wins.
	if (origin === "detached-turn") {
		const existing = getPersistentAgentUnseenLandedAnswer(instance.agentId);
		if (existing && existing.origin === "scheduled-run" && existing.threadId !== threadId) return;
	}
	const file = instance.runtimeUnseenLandedAnswerPath();
	ensureDir(path.dirname(file));
	const record: PersistentAgentUnseenLandedAnswer = { threadId, turnId, terminalReason: marker.terminalReason, landedAt: Date.now(), origin };
	writeFileAtomic(file, JSON.stringify(record, null, 2) + "\n");
}

// A session is binding to a conversation in this room. A detached turn landed
// into the room's live conversation, so any bind puts the user in front of it
// and clears the badge, exactly as before. A scheduled answer lives in its own
// conversation: only a bind that opens THAT conversation actually shows it, so
// a bind that starts a new one has to leave the badge lit.
export function clearPersistentAgentUnseenLandedAnswerForBind(agentIdRaw: string, boundThreadIdRaw: string): void {
	const marker = getPersistentAgentUnseenLandedAnswer(agentIdRaw);
	if (!marker) return;
	if (marker.origin === "scheduled-run" && marker.threadId !== String(boundThreadIdRaw ?? "").trim()) return;
	clearPersistentAgentUnseenLandedAnswer(agentIdRaw);
}

// A conversation is being closed for good. Only the marker that points AT it
// dies with it; a badge for some other conversation in the room is untouched.
export function clearPersistentAgentUnseenLandedAnswerForClosedThread(agentIdRaw: string, closedThreadIdRaw: string): void {
	const marker = getPersistentAgentUnseenLandedAnswer(agentIdRaw);
	if (!marker || marker.threadId !== String(closedThreadIdRaw ?? "").trim()) return;
	clearPersistentAgentUnseenLandedAnswer(agentIdRaw);
}

export function clearPersistentAgentUnseenLandedAnswer(agentIdRaw: string): void {
	const instance = createPersistentAgentInstance(agentIdRaw);
	try { fs.rmSync(instance.runtimeUnseenLandedAnswerPath(), { force: true }); } catch {}
}

export function getPersistentAgentUnseenLandedAnswer(agentIdRaw: string): PersistentAgentUnseenLandedAnswer | null {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const file = instance.runtimeUnseenLandedAnswerPath();
	if (!fs.existsSync(file)) return null;
	const raw = readJson(file) as Partial<PersistentAgentUnseenLandedAnswer> | null;
	const threadId = safeRuntimeThreadId(raw?.threadId);
	const turnId = typeof raw?.turnId === "string" && raw.turnId.trim() ? raw.turnId.trim() : null;
	const terminalReason = raw?.terminalReason === "completed" || raw?.terminalReason === "failed" ? raw.terminalReason : null;
	if (!threadId || !turnId || !terminalReason) return null;
	const landedAt = Number.isFinite(raw?.landedAt) && Number(raw?.landedAt) > 0 ? Math.floor(Number(raw?.landedAt)) : 0;
	const origin: PersistentAgentUnseenLandedAnswerOrigin = raw?.origin === "scheduled-run" ? "scheduled-run" : "detached-turn";
	return { threadId, turnId, terminalReason, landedAt, origin };
}

// Is the answer this marker points at still something the user can walk into?
// A detached turn landed INTO the room's live conversation, so the marker only
// means anything while that conversation is still the active one; anything else
// (a CLI bind moved on, a checkpoint retired the thread) makes it stale. A
// scheduled run instead lands into a conversation of its own, which the active
// thread stops naming the moment any other door moves the room on, while the
// answer is still sitting there to be opened. So the active-thread test is not
// the right question for that flavor; whether the landed conversation still
// exists and is not closed is.
function unseenLandedAnswerStillReachable(agentId: string, marker: PersistentAgentUnseenLandedAnswer, runtime: PersistentAgentRuntimeState): boolean {
	if (marker.origin === "detached-turn") return marker.threadId === (runtime.activeThreadId ?? "");
	const thread = getPersistentAgentThread(agentId, marker.threadId);
	return !!thread && thread.state !== "closed";
}

// A question that came up with nobody watching is answered with a safe default
// so the work can keep going. Whichever surface declined it (the detached web
// bridge, a headless background run) writes the same plain note into the turn's
// thread items, so the transcript tells the story instead of leaving it to the
// answer. One note per question, deduplicated by title, in the order they came
// up; the id prefix belongs to the turn, so a re-landed write updates its own
// notes instead of stacking new ones.
export interface PersistentRoomAutoDeclinedQuestionLog {
	note(question: { title: string }): void;
	titles(): string[];
	appendItems(items: unknown[], idPrefix: string): unknown[];
	/** The notes as items of their own, `<idPrefix>-<n>`, for a keyed landing to place by id (it applies the card rule itself). */
	noticeItems(idPrefix: string): Array<{ kind: "system"; id: string; text: string; level: "info" }>;
}

export function createPersistentRoomAutoDeclinedQuestionLog(): PersistentRoomAutoDeclinedQuestionLog {
	const notes: Array<{ title: string; text: string }> = [];
	return {
		// Deduplicated on the note as the user would read it, not on the raw
		// title: two dialogs that would say exactly the same thing are one note
		// (whatever differed lived in a message the note never shows), and two
		// long titles that only differ past the truncation cannot leave a pair
		// of notes that look like a bug.
		note(question) {
			const title = String(question?.title ?? "").trim();
			const text = declinedQuestionNoteText(title);
			if (notes.some((existing) => existing.text === text)) return;
			notes.push({ title, text });
		},
		titles() {
			return notes.map((note) => note.title);
		},
		appendItems(items, idPrefix) {
			let next = [...items];
			// A question whose card this turn kept already says on that card that it ended (Approval.tsx).
			const turnStart = next.map((item) => (item as any)?.kind).lastIndexOf("user");
			const cardNotes = notesOfKeptCards(next.slice(turnStart + 1));
			notes.forEach((note, index) => {
				const id = `${idPrefix}-${index + 1}`;
				const item = { kind: "system", id, text: note.text, level: "info" };
				const existing = next.findIndex((candidate) => String((candidate as any)?.id ?? "") === id);
				if (cardNotes.has(note.text)) {
					if (existing >= 0) next.splice(existing, 1);
				} else if (existing >= 0) next[existing] = { ...(next[existing] as any), ...item };
				else next.push(item);
			});
			return next;
		},
		noticeItems(idPrefix) {
			return notes.map((note, index) => ({ kind: "system" as const, id: `${idPrefix}-${index + 1}`, text: note.text, level: "info" as const }));
		},
	};
}

// Any thread of this room mid-turn: purge must refuse while an answer is being
// produced, whatever thread it is riding on.
export function hasPersistentAgentTurnInFlight(agentIdRaw: string): boolean {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const prefix = `${instance.agentId}\u0000`;
	for (const [key, state] of persistentAgentActiveTurns) {
		if (key.startsWith(prefix) && (state.state === "running" || state.state === "cancelling")) return true;
	}
	return false;
}

// Turns not idle across all rooms and threads: what a server stop waits for.
export function countPersistentAgentTurnsInFlight(): number {
	let count = 0;
	for (const state of persistentAgentActiveTurns.values()) if (state.state !== "idle") count += 1;
	return count;
}

/**
 * What this process estimated for each room it was asked about (null: never
 * used), with the listing of the room's conversation files it was made from.
 * The records are read again only when that listing changes (a conversation
 * added or gone), so neither a folder in the write's way nor a room with
 * many silent conversations costs every status; the listing itself is one
 * cheap call.
 */
const lastUsedEstimates = new Map<string, { listing: string; estimate: PersistentRoomLastUsed | null }>();

/**
 * The last-used stamp of a room that has none yet, estimated once from what
 * the room has: the newest change of any conversation somebody spoke in,
 * closed ones included (a room finished with Remember or Forget has no open
 * conversation, and is the room most recently in use as often as not). A
 * conversation nobody spoke in (one that maintenance prepared) says nothing
 * about use. Written as a stamp with door "estimate" so the walk over the
 * conversations happens once, not on every status, and written only if the
 * room still has none: the status is built without holding the room, by the
 * server and by the terminal alike, and a turn stamped meanwhile must win.
 * If the write fails the estimate is still what the status says. Null when
 * the room has no such conversation: never used.
 */
function estimatePersistentRoomLastUsed(instance: PersistentAgentInstance): PersistentRoomLastUsed | null {
	let names: string[];
	try {
		names = fs.readdirSync(instance.runtimeThreadsDir()).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return null;
	}
	const listing = names.join("\n");
	const known = lastUsedEstimates.get(instance.agentId);
	if (known && known.listing === listing) return known.estimate;
	const estimate = computePersistentRoomLastUsedEstimate(instance, names);
	// What is remembered is the estimate itself; what this status says is
	// whatever the room holds after the write, which may be a turn's stamp
	// that landed in between (and is read from disk on the next status).
	lastUsedEstimates.set(instance.agentId, { listing, estimate });
	return estimate ? recordPersistentRoomLastUsedIfAbsent(instance.agentId, estimate) ?? estimate : null;
}

function computePersistentRoomLastUsedEstimate(instance: PersistentAgentInstance, names: readonly string[]): PersistentRoomLastUsed | null {
	let newest = 0;
	for (const name of names) {
		try {
			const file = path.join(instance.runtimeThreadsDir(), name);
			// Only a regular file is read: opening a pipe or a device would block
			// the whole server, synchronously, until something wrote to it (the
			// order's own store reads its file the same way).
			if (!fs.statSync(file).isFile()) continue;
			const record = normalizePersistentAgentThreadRecord(readJson(file), instance.agentId, name.slice(0, -".json".length));
			// A time no Date can hold is no time: that record says nothing, like one that cannot be read.
			if (record && threadHasUserVisibleTurns(record.items) && record.updatedAt > newest && Number.isFinite(new Date(record.updatedAt).getTime())) newest = record.updatedAt;
		} catch {
			// One record that cannot be read says nothing about the others.
		}
	}
	if (!(newest > 0)) return null;
	return { schemaVersion: 1, lastUsedAt: new Date(newest).toISOString(), door: "estimate" };
}

export { estimatePersistentRoomLastUsed, rememberGenerationKey, rememberGenerations, unseenLandedAnswerStillReachable };
