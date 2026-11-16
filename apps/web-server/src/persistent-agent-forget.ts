import fs from "node:fs";
import path from "node:path";
import { clearRememberWork } from "./remember-parts-cache.js";
import { writeCommitIntent, clearCommitIntent, registerCommitSettler } from "./memory-commit.js";
import { eraseConversationWords } from "./forget-erase.js";
import { abortConversationSpecialistTasks } from "./persistent-room-specialist-registry.js";
import { fingerprintL1bSource, type PersistentAgentModelLock, type PersistentAgentThreadRecord } from "./persistent-agent-types.js";
import type { MementoEventRecord, PersistentAgentMementoBoundaryResponse, PersistentAgentMementoRuntimeBoundary } from "./persistent-agent-memory-types.js";
import { agentRootRelativePath, assertPersistentAgentThreadNotInFlight, createPersistentAgentInstance, getPersistentAgentRuntimeState, mementoEventRecordPath, normalizeRuntimeModel, type PersistentAgentInstance, readJson, safeRuntimeThreadId, shortRandomId, slugTimestamp, writeMementoEventRecord } from "./persistent-agent-store.js";
import { closePersistentAgentThreadForMemento, getPersistentAgentThread, piSessionHasNoMessages, threadHasUserVisibleTurns, writePersistentAgentThread } from "./persistent-agent-threads.js";
import { clearPersistentAgentUnseenLandedAnswerForClosedThread, getPersistentAgentUnseenLandedAnswer, rememberGenerationKey, rememberGenerations } from "./persistent-agent-turns.js";
import { createPersistentAgentPiSessionJsonlThreadRuntime, persistentRoomConversationCwd } from "./persistent-agent-conversation-model.js";
import { getPersistentAgentStatus } from "./persistent-agent-status.js";
import type { PersistentAgentMementoBoundaryWriteOptions } from "./persistent-agent-remember-save.js";
import { serverHooks } from "./server-hooks.js";

export function writePersistentAgentMementoBoundary(agentIdRaw: string, conversationIdRaw: string, now = new Date(), options: PersistentAgentMementoBoundaryWriteOptions = {}): PersistentAgentMementoBoundaryResponse {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const status = getPersistentAgentStatus(instance.agentId);
	// Memento never writes memory (runtime_boundary_only), so a room that is
	// due for Memorize (needs_absorb) may still be reset.
	if (status.status !== "ready" && status.status !== "needs_absorb") throw new Error(`persistent agent scaffold is not ready: ${status.status}`);
	const conversationId = safeRuntimeThreadId(conversationIdRaw);
	if (!conversationId) throw new Error("invalid persistent-agent thread id");
	const runtime = getPersistentAgentRuntimeState(instance.agentId);
	if ((runtime.state !== "active" && runtime.state !== "standby") || !runtime.activeThreadId) throw new Error("forgetting a conversation requires the room's current open conversation");
	if (runtime.activeThreadId !== conversationId) throw new Error("the request is stale; the room has a different conversation open now");
	const oldThread = getPersistentAgentThread(instance.agentId, conversationId);
	if (!oldThread) throw new Error("the room's open conversation is missing; the request is stale");
	const alreadyForgotten = forgetThatMade(instance, oldThread);
	if (alreadyForgotten) return alreadyForgotten;
	// A crashed or previously-failed Memento can leave the boundary half
	// applied: the old thread already closed with closedReason "memento" but
	// the fresh thread never created, so the runtime pointer targets a closed
	// thread and the room dead-ends on resume. Clicking Memento again
	// completes that boundary instead of refusing. Threads closed by anything
	// other than a Memento are still refused (genuinely stale request).
	const completingHalfAppliedBoundary = oldThread.state === "closed";
	if (completingHalfAppliedBoundary && oldThread.closedReason !== "memento") throw new Error("the room's open conversation is already closed; the request is stale");
	if (!completingHalfAppliedBoundary) assertPersistentAgentThreadNotInFlight(instance.agentId, conversationId);

	const meta = instance.readAgentJson();
	if (!meta) throw new Error("agent.json is missing or invalid JSON");
	if (!fs.existsSync(instance.l1bCurrentPath(meta))) throw new Error("L1b/current.md is missing");
	const runtimeCwd = typeof options.runtimeCwd === "string" && options.runtimeCwd.trim() ? options.runtimeCwd : process.cwd();
	const stamp = slugTimestamp(now);
	const suffix = shortRandomId();
	const intent: ForgetCommitIntent = {
		oldThreadId: conversationId,
		mementoId: `mm_${stamp}_${suffix}`,
		freshThreadId: `postmem_${stamp}_${suffix}`,
		freshModel: normalizeRuntimeModel(options.freshModel) ?? oldThread.model,
		at: now.toISOString(),
	};

	// Forget is one step (memory-commit.ts): the intent, then the conversation
	// closed as forgotten, which is the commit point. A crash before it leaves
	// the conversation open and untouched; a crash after it is finished by the
	// next request (the fresh conversation, the pointer, the record). It stays
	// synchronous from the intent to its clear: the settle runs outside the
	// save lock, so an await in between would let a status request finish or
	// drop this save mid-flight. Keep it synchronous, or take the lock in the
	// settle.
	writeCommitIntent(instance.rootDir, "forget", intent);
	if (!completingHalfAppliedBoundary) closePersistentAgentThreadForMemento(instance.agentId, conversationId, intent.mementoId, now.getTime());
	const finished = finishForgetCommit(instance, intent, runtimeCwd);
	clearCommitIntent(instance.rootDir, "forget");
	return {
		agentId: instance.agentId,
		conversationId,
		mementoId: finished.eventRecord.mementoId,
		writesMemory: false,
		eventRecordPath: finished.eventRecordPath,
		eventRelPath: finished.eventRecord.paths.eventRelPath,
		runtimeBoundary: finished.runtimeBoundary,
		postMemento: { canContinue: true, canRest: true, activeThreadId: finished.runtimeBoundary.newThreadId, runtime: finished.runtimeBoundary.newRuntime },
		memory: finished.eventRecord.memory,
		warnings: [],
	};
}

/**
 * A Forget that landed after the copy this room was restored from, run again
 * on the restored room, whole: the conversation the room has open is forgotten
 * as the person's Forget does it (a fresh conversation opens); any other is
 * closed as forgotten. Either way its words go. A conversation the copy does
 * not hold is "absent". The restored server's start runs it before anyone can
 * sign in, so nothing is in flight.
 */
export function forgetConversationAgain(agentId: string, conversationId: string, now = new Date()): "forgotten" | "absent" {
	const instance = createPersistentAgentInstance(agentId);
	const thread = getPersistentAgentThread(instance.agentId, conversationId);
	if (!thread) return "absent";
	const runtime = getPersistentAgentRuntimeState(instance.agentId);
	if (thread.state !== "closed" && runtime.activeThreadId === thread.threadId) {
		writePersistentAgentMementoBoundary(instance.agentId, thread.threadId, now, { runtimeCwd: persistentRoomConversationCwd(instance.agentId, thread.threadId) });
		return "forgotten";
	}
	if (thread.state !== "closed") closePersistentAgentThreadForMemento(instance.agentId, thread.threadId, `mm_${slugTimestamp(now)}_${shortRandomId()}`, now.getTime());
	eraseConversationWords(instance.agentId, instance.rootDir, thread.threadId);
	removeSessionRewriteLeftovers(instance.rootDir, thread.threadId);
	return "forgotten";
}

/**
 * The same Forget sent again after a kill took its answer. The room already
 * moved to the empty conversation that Forget made, so the route aims the retry
 * there; forgetting that one would write a second record for one Forget. Its
 * own record answers instead. A conversation anyone has spoken in, or with an
 * answer waiting, is never this.
 */
function forgetThatMade(instance: PersistentAgentInstance, fresh: PersistentAgentThreadRecord): PersistentAgentMementoBoundaryResponse | null {
	if (fresh.origin !== "memento" || fresh.runtime.kind !== "pi-session-jsonl") return null;
	if (threadHasUserVisibleTurns(fresh.items) || !piSessionHasNoMessages(instance.agentId, fresh.runtime)) return null;
	if (getPersistentAgentUnseenLandedAnswer(instance.agentId)?.threadId === fresh.threadId) return null;
	const eventRecordPath = mementoEventRecordPath(instance, fresh.threadId.replace(/^postmem_/, "mm_"));
	const record = readJson(eventRecordPath) as MementoEventRecord | null;
	if (record?.runtimeBoundary.newThreadId !== fresh.threadId) return null;
	const closed = getPersistentAgentThread(instance.agentId, record.conversationId);
	if (!closed) return null;
	return {
		agentId: instance.agentId,
		conversationId: closed.threadId,
		mementoId: record.mementoId,
		writesMemory: false,
		eventRecordPath,
		eventRelPath: record.paths.eventRelPath,
		runtimeBoundary: {
			closedThreadId: closed.threadId,
			closedReason: "memento",
			closedAt: record.runtimeBoundary.closedAt,
			closedByMementoId: record.mementoId,
			oldRuntime: closed.runtime,
			newThreadId: fresh.threadId,
			newRuntime: fresh.runtime,
		},
		postMemento: { canContinue: true, canRest: true, activeThreadId: fresh.threadId, runtime: fresh.runtime },
		memory: record.memory,
		warnings: [],
	};
}

/** A Forget in flight: ids and times only. One an older version left also holds `runtimeCwd`, which nothing reads. */
interface ForgetCommitIntent {
	oldThreadId: string;
	mementoId: string;
	freshThreadId: string;
	freshModel: PersistentAgentModelLock;
	at: string;
}

/**
 * Everything a Forget does after the conversation is closed, each step safe
 * to run twice: the fresh conversation and the pointer to it, the unseen
 * marker cleared, the memento record. The Forget itself and the crash
 * recovery both run it.
 */
function finishForgetCommit(instance: PersistentAgentInstance, intent: ForgetCommitIntent, runtimeCwd: string): { runtimeBoundary: PersistentAgentMementoRuntimeBoundary; eventRecord: MementoEventRecord; eventRecordPath: string } {
	const agentId = instance.agentId;
	const now = new Date(intent.at);
	const closedThread = getPersistentAgentThread(agentId, intent.oldThreadId);
	if (!closedThread || closedThread.state !== "closed") throw new Error("the forgotten conversation is not closed");
	serverHooks().deletionLanded?.({ kind: "forget", roomId: agentId, conversationId: intent.oldThreadId, at: intent.at });
	rememberGenerations.get(rememberGenerationKey(agentId, intent.oldThreadId))?.stop?.("forgotten");
	clearRememberWork(instance.rootDir, intent.oldThreadId);
	const existingFresh = getPersistentAgentThread(agentId, intent.freshThreadId);
	if (!existingFresh || getPersistentAgentRuntimeState(agentId).activeThreadId !== intent.freshThreadId) {
		writePersistentAgentThread(agentId, intent.freshThreadId, {
			state: existingFresh?.state === "active" ? "active" : "standby",
			origin: "memento",
			model: existingFresh?.model ?? intent.freshModel,
			...(existingFresh ? {} : { items: [] }),
		}, {
			createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: intent.freshThreadId, model, cwd: runtimeCwd }),
			// Forget never invokes a model (runtime_boundary_only). When no
			// currently-available model was resolved, the fresh thread inherits the
			// old thread's lock, which may belong to a profile that is no longer
			// active: Forget is exactly how a person frees a room stuck on a model
			// they no longer have, so the active-profile gate must not block this
			// write. Prompting and resume keep full enforcement.
			allowInactiveProfileModel: true,
		});
	}
	const freshThread = getPersistentAgentThread(agentId, intent.freshThreadId);
	if (!freshThread || freshThread.runtime.kind !== "pi-session-jsonl") throw new Error("the fresh conversation could not be prepared on a supported runtime");
	// The forgotten conversation takes its unseen-landed-answer marker with it:
	// a fresh-session badge must not point at a transcript Forget just closed.
	// Only that conversation's marker, though: a scheduled answer waiting in
	// another conversation of this room is still there to be read, and a
	// boundary on the live thread is no reason to throw its badge away.
	clearPersistentAgentUnseenLandedAnswerForClosedThread(agentId, closedThread.threadId);
	const mementoId = closedThread.closedByMementoId ?? intent.mementoId;
	const runtimeBoundary: PersistentAgentMementoRuntimeBoundary = {
		closedThreadId: closedThread.threadId,
		closedReason: "memento",
		closedAt: closedThread.closedAt ?? now.getTime(),
		closedByMementoId: mementoId,
		oldRuntime: closedThread.runtime,
		newThreadId: freshThread.threadId,
		newRuntime: freshThread.runtime,
	};
	// Forget is the trash icon: a task still running from the conversation stops, and its result goes.
	abortConversationSpecialistTasks(agentId, closedThread.threadId);
	const eventRecordPath = mementoEventRecordPath(instance, intent.mementoId);
	const eventRelPath = agentRootRelativePath(instance, eventRecordPath);
	// A record a kill cut short before this write was atomic reads as none, and is written whole.
	const stored = readJson(eventRecordPath) as MementoEventRecord | null;
	if (stored) {
		eraseConversationWords(agentId, instance.rootDir, closedThread.threadId);
		removeSessionRewriteLeftovers(instance.rootDir, closedThread.threadId);
		return { runtimeBoundary, eventRecord: stored, eventRecordPath };
	}
	const meta = instance.readAgentJson();
	const l1bPath = meta ? instance.l1bCurrentPath(meta) : path.join(instance.rootDir, "L1b", "current.md");
	const l1bFingerprint = fingerprintL1bSource(fs.existsSync(l1bPath) ? fs.readFileSync(l1bPath, "utf-8") : "");
	const eventRecord: MementoEventRecord = {
		schemaVersion: 1,
		operation: "memento",
		mutation: {
			target: "none",
			kind: "runtime_boundary_only",
		},
		agentId,
		conversationId: closedThread.threadId,
		mementoId: intent.mementoId,
		appliedAt: intent.at,
		paths: { eventRelPath },
		runtimeBoundary: {
			closedThreadId: runtimeBoundary.closedThreadId,
			closedReason: runtimeBoundary.closedReason,
			closedAt: runtimeBoundary.closedAt,
			closedByMementoId: runtimeBoundary.closedByMementoId,
			oldRuntimeKind: runtimeBoundary.oldRuntime.kind,
			...(runtimeBoundary.oldRuntime.kind === "pi-session-jsonl" ? {
				oldRuntimeSessionId: runtimeBoundary.oldRuntime.sessionId,
				oldBootPromptSha256: runtimeBoundary.oldRuntime.bootPromptSha256,
			} : {}),
			newThreadId: runtimeBoundary.newThreadId,
			newRuntimeKind: "pi-session-jsonl",
			newRuntimeSessionId: runtimeBoundary.newRuntime.sessionId,
			newSessionFileRelPath: runtimeBoundary.newRuntime.sessionFileRelPath,
			newBootPromptSnapshotRelPath: runtimeBoundary.newRuntime.bootPromptSnapshotRelPath,
			newBootPromptSha256: runtimeBoundary.newRuntime.bootPromptSha256,
			newRuntimeL1bFingerprint: runtimeBoundary.newRuntime.l1bFingerprint,
		},
		memory: {
			l1bMutated: false,
			l1bFingerprint,
		},
		warnings: [],
	};
	writeMementoEventRecord(instance, eventRecord);
	// Forget means gone: every stored copy of the conversation's words is erased.
	eraseConversationWords(agentId, instance.rootDir, closedThread.threadId);
	removeSessionRewriteLeftovers(instance.rootDir, closedThread.threadId);
	return { runtimeBoundary, eventRecord, eventRecordPath };
}

/** A session rewrite a kill cut short leaves a temporary file holding the whole conversation. One that cannot go now keeps the intent, so the next request tries again. */
function removeSessionRewriteLeftovers(roomDir: string, threadId: string): void {
	const sessions = path.join(roomDir, "runtime", "pi-sessions");
	if (!fs.existsSync(sessions)) return;
	for (const name of fs.readdirSync(sessions)) {
		if (name.startsWith(`${threadId}.jsonl.tmp-`)) fs.rmSync(path.join(sessions, name), { force: true });
	}
}

/**
 * A Forget a crash left pending. The conversation was closed as forgotten:
 * the Forget is finished. It was not: nothing happened, and the intent goes.
 */
function settleForgetCommit(agentId: string, roomDir: string, intent: ForgetCommitIntent): void {
	const instance = createPersistentAgentInstance(agentId);
	const thread = getPersistentAgentThread(instance.agentId, intent.oldThreadId);
	if (thread?.state === "closed" && thread.closedReason === "memento") finishForgetCommit(instance, intent, persistentRoomConversationCwd(instance.agentId, intent.freshThreadId));
	clearCommitIntent(roomDir, "forget");
}

registerCommitSettler("forget", settleForgetCommit);
