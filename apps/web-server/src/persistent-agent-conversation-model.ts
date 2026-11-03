import crypto from "node:crypto";
import fs from "node:fs";
import { estimateTokensFromChars, estimateTokens } from "./token-estimate.js";
import path from "node:path";
import { SessionManager } from "@exxeta/exxperts-runtime";
import { persistentAgentModelLocksEqual } from "./persistent-agent-ai-profiles.js";
import { resolvePersistentRoomEffectiveWorkspacePolicy } from "./persistent-room-workspace-policy.js";
import { parsePersistentRoomInstructionsLayerFingerprint } from "./persistent-room-instructions-text.js";
import type { PersistentAgentModelLock, PersistentAgentPiSessionJsonlThreadRuntime, PersistentAgentThreadRecord } from "./persistent-agent-types.js";
import type { L1bSourceFingerprint } from "./persistent-agent-memory-types.js";
import { assertPersistentAgentThreadNotInFlight, createPersistentAgentInstance, ensureDir, getPersistentAgentActiveTurnState, getPersistentAgentRuntimeState, persistentAgentConflictError, safeRuntimeThreadId, writeFileAtomic } from "./persistent-agent-store.js";
import { getPersistentAgentThread, piSessionHasNoMessages, threadHasUserVisibleTurns, writePersistentAgentRuntimeState } from "./persistent-agent-threads.js";
import { assertNoRememberGeneration } from "./persistent-agent-turns.js";
import { SWITCH_WHILE_ANSWERING_MESSAGE } from "./room-live-sessions.js";
import { buildPersistentAgentBootContext, buildPersistentAgentPiSessionJsonlThreadRuntime, type CreatePersistentAgentPiSessionJsonlThreadRuntimeInput, emptyPersistentAgentThread, fingerprintPersistentAgentBootContextL1b, persistentAgentPiSessionJsonlPaths, writePersistentAgentBootPromptSnapshot } from "./persistent-agent-boot.js";

export interface PersistentAgentBootSnapshotRefresh {
	thread: PersistentAgentThreadRecord;
	/** Set when the snapshot was rebuilt: the memory fingerprints it moved between. */
	rebuilt: { before: L1bSourceFingerprint; after: L1bSourceFingerprint } | null;
}

/**
 * A prepared conversation (the fresh thread Remember or Forget leaves behind)
 * boots from a frozen prompt snapshot that carries the room's memory as it
 * was when the thread was prepared. While nobody has said anything in it yet,
 * that freeze protects nothing: when the memory has moved on since (Memorize,
 * Review, a rename, a hand edit), the snapshot is rebuilt in place from the
 * memory as it is now, under the same thread id and runtime paths, and the
 * record's fingerprints follow so the next bind finds nothing to do. A thread
 * with anything in it (a message in the transcript or in the Pi session, or a
 * turn in flight) keeps its snapshot frozen, by design. Call it with the room
 * held (the bind path holds the room lock).
 *
 * Order matters for a crash mid-way: the snapshot is replaced atomically
 * first, then the record. A crash between the two leaves the record's old
 * fingerprint behind, which still differs from the memory, so the next bind
 * simply rebuilds again.
 */
export function refreshEmptyPersistentAgentThreadBootSnapshot(agentIdRaw: string, threadIdRaw: string): PersistentAgentBootSnapshotRefresh | null {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) return null;
	const thread = getPersistentAgentThread(instance.agentId, threadId);
	if (!thread || thread.state === "closed") return null;
	const runtime = thread.runtime;
	if (runtime.kind !== "pi-session-jsonl") return { thread, rebuilt: null };
	if (threadHasUserVisibleTurns(thread.items)) return { thread, rebuilt: null };
	const turn = getPersistentAgentActiveTurnState(instance.agentId, threadId);
	if (turn.state === "running" || turn.state === "cancelling") return { thread, rebuilt: null };
	if (!piSessionHasNoMessages(instance.agentId, runtime)) return { thread, rebuilt: null };
	const workspaceCapability = resolvePersistentRoomEffectiveWorkspacePolicy(instance.agentId, threadId)?.capability;
	const bootContext = buildPersistentAgentBootContext({
		agentId: instance.agentId,
		conversationId: threadId,
		sessionId: null,
		model: thread.model,
		...(workspaceCapability ? { workspaceCapability } : {}),
	});
	const l1bFingerprint = fingerprintPersistentAgentBootContextL1b(bootContext);
	if (l1bFingerprint.algorithm === runtime.l1bFingerprint.algorithm && l1bFingerprint.value === runtime.l1bFingerprint.value) return { thread, rebuilt: null };
	const snapshotPath = instance.resolveRootRelativePath(runtime.bootPromptSnapshotRelPath, "persistent-agent boot prompt snapshot path");
	const temporaryPath = `${snapshotPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
	fs.writeFileSync(temporaryPath, bootContext.systemPrompt, { mode: 0o600, flag: "wx" });
	fs.renameSync(temporaryPath, snapshotPath);
	const refreshed: PersistentAgentThreadRecord = {
		...thread,
		runtime: {
			...runtime,
			bootPromptSha256: crypto.createHash("sha256").update(bootContext.systemPrompt, "utf-8").digest("hex"),
			l1bFingerprint,
			instructionsFingerprint: fingerprintPersistentAgentBootContextInstructions(bootContext),
		},
		updatedAt: Date.now(),
	};
	const file = instance.runtimeThreadPath(threadId);
	writeFileAtomic(file, JSON.stringify(refreshed, null, 2) + "\n");
	return { thread: refreshed, rebuilt: { before: runtime.l1bFingerprint, after: l1bFingerprint } };
}

/**
 * A conversation nobody has spoken in yet (the one Remember or Forget
 * prepares, or any other that is still empty) boots on the room's
 * conversation model as it is at its first boot, not as it was when the
 * conversation was prepared: a pick made in Room settings in between is the
 * one it runs on. This is the one place a stored lock changes outside the
 * switch, and only while the conversation is empty (no message in the
 * transcript or the Pi session, no turn in flight). The Pi session follows on
 * its own: the runtime records the model a session binds on while it holds no
 * messages. Returns the thread and, when the lock moved, the old and new lock.
 */
/**
 * The room's pick an empty conversation would move to at a bind now, or null
 * when it stays on its lock: the rule refreshEmptyPersistentAgentThreadModel
 * applies (Pi-backed, no turn anyone can see, no turn running, no message in
 * its session). The pick is resolved only once the conversation is known to
 * be empty, so a conversation with turns costs one thread read.
 */
export function emptyPersistentAgentThreadModelTarget(agentIdRaw: string, threadIdRaw: string, resolvePick: () => PersistentAgentModelLock | null): PersistentAgentModelLock | null {
	const thread = emptyPersistentAgentThread(agentIdRaw, threadIdRaw);
	if (!thread || thread.modelChosen) return null;
	const pick = resolvePick();
	return pick && !persistentAgentModelLocksEqual(thread.model, pick) ? pick : null;
}

/** Whether a conversation still follows the room's pick under the same rule: while the room's model cannot run, such a conversation waits with the room. A model picked for it (its mark) ends the following. */
export function persistentAgentThreadFollowsConversationPick(agentIdRaw: string, threadIdRaw: string): boolean {
	const thread = emptyPersistentAgentThread(agentIdRaw, threadIdRaw);
	return thread !== null && !thread.modelChosen;
}

/** Whether nobody has spoken in a conversation yet (no message in the transcript or its session, no turn running). */
export function persistentAgentThreadIsEmpty(agentIdRaw: string, threadIdRaw: string): boolean {
	return emptyPersistentAgentThread(agentIdRaw, threadIdRaw) !== null;
}

/** Marks the conversation's model as picked for it, with no line and no history: a pick of the model it is already on ends its following the room's pick too. */
export function markPersistentAgentThreadModelChosen(agentIdRaw: string, threadIdRaw: string): void {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) return;
	const thread = getPersistentAgentThread(instance.agentId, threadId);
	if (!thread || thread.state === "closed" || thread.modelChosen) return;
	writeFileAtomic(instance.runtimeThreadPath(threadId), JSON.stringify({ ...thread, modelChosen: true, updatedAt: Date.now() }, null, 2) + "\n");
}

export function refreshEmptyPersistentAgentThreadModel(agentIdRaw: string, threadIdRaw: string, lock: PersistentAgentModelLock): { thread: PersistentAgentThreadRecord; moved: { before: PersistentAgentModelLock; after: PersistentAgentModelLock } | null } | null {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) return null;
	const thread = getPersistentAgentThread(instance.agentId, threadId);
	if (!thread || thread.state === "closed") return null;
	if (persistentAgentModelLocksEqual(thread.model, lock)) return { thread, moved: null };
	if (thread.modelChosen) return { thread, moved: null };
	if (thread.runtime.kind !== "pi-session-jsonl") return { thread, moved: null };
	if (threadHasUserVisibleTurns(thread.items)) return { thread, moved: null };
	const turn = getPersistentAgentActiveTurnState(instance.agentId, threadId);
	if (turn.state === "running" || turn.state === "cancelling") return { thread, moved: null };
	if (!piSessionHasNoMessages(instance.agentId, thread.runtime)) return { thread, moved: null };
	const refreshed: PersistentAgentThreadRecord = { ...thread, model: { provider: lock.provider, model: lock.model }, updatedAt: Date.now() };
	writeFileAtomic(instance.runtimeThreadPath(threadId), JSON.stringify(refreshed, null, 2) + "\n");
	const runtime = getPersistentAgentRuntimeState(instance.agentId);
	if (runtime.state !== "idle" && runtime.activeThreadId === threadId) {
		writePersistentAgentRuntimeState(instance.agentId, { state: runtime.state, activeThreadId: threadId, model: refreshed.model }, { allowInFlightActiveThread: true });
	}
	return { thread: refreshed, moved: { before: thread.model, after: refreshed.model } };
}

/** The sentence a switch refusal gets while a Remember reads the conversation. */
export const SWITCH_WHILE_REMEMBERING_MESSAGE = "Remember is reading this conversation. Switch the model when it has finished, or cancel it.";

/**
 * Moves an open conversation to another model between turns: the
 * conversation's lock becomes the new model (the old one goes to its history),
 * the Pi session gets the model_change entry the runtime reads the model from,
 * the runtime state follows, and the display cache gets one quiet line
 * ("Continued on <model>"). The line is a display item only: it is never a
 * message in the model's context and never a line Remember reads. When the
 * conversation's last item is such a line (a switch right after another, no
 * message between), the new line replaces it, and `replaces` names the one
 * that went. The conversation is marked as chosen, so an empty one keeps this
 * model instead of following the room's pick.
 *
 * The caller has already disposed any live session on this conversation (the
 * session file has one writer at a time), checked the fit, and refuses a turn
 * in flight; this refuses them again, plus a Remember that is reading the
 * conversation, and a conversation that is not Pi-backed.
 */
export function switchPersistentAgentThreadModel(agentIdRaw: string, threadIdRaw: string, lock: PersistentAgentModelLock, options: { notice: string; runtimeCwd?: string; now?: number }): { thread: PersistentAgentThreadRecord; before: PersistentAgentModelLock; replaces: string | null } {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	const thread = getPersistentAgentThread(instance.agentId, threadId);
	if (!thread || thread.state === "closed") throw persistentAgentConflictError("the conversation to switch is missing or closed");
	if (thread.runtime.kind !== "pi-session-jsonl") throw persistentAgentConflictError("this conversation was started by an older version and cannot switch its model; start a new one with Forget or Remember");
	// Refusals before anything is written carry a code, so a caller knows the conversation is unchanged.
	try {
		assertPersistentAgentThreadNotInFlight(instance.agentId, threadId);
	} catch {
		throw Object.assign(persistentAgentConflictError(SWITCH_WHILE_ANSWERING_MESSAGE), { code: "switch_answering" });
	}
	try {
		assertNoRememberGeneration(instance.agentId, threadId);
	} catch {
		throw Object.assign(persistentAgentConflictError(SWITCH_WHILE_REMEMBERING_MESSAGE), { code: "switch_remembering" });
	}
	if (persistentAgentModelLocksEqual(thread.model, lock)) return { thread, before: thread.model, replaces: null };
	const now = options.now ?? Date.now();
	const session = openPersistentAgentPiSessionManager(instance.agentId, thread.runtime, options.runtimeCwd || process.cwd());
	// "No message between" is read from the session, where every message is
	// written as the turn runs; the display items follow the page's saves later.
	const branch = session.getBranch();
	const lastModelChange = branch.map((entry) => entry.type).lastIndexOf("model_change");
	const messageSinceLastSwitch = branch.slice(lastModelChange + 1).some((entry) => entry.type === "message");
	const last = thread.items[thread.items.length - 1];
	const replaces = isModelSwitchLine(last) && !messageSinceLastSwitch ? last.id : null;
	session.appendModelChange(lock.provider, lock.model);
	const switched: PersistentAgentThreadRecord = {
		...thread,
		model: { provider: lock.provider, model: lock.model },
		modelHistory: [...(thread.modelHistory ?? []), { provider: thread.model.provider, model: thread.model.model, until: now }],
		modelChosen: true,
		items: [...(replaces ? thread.items.slice(0, -1) : thread.items), modelSwitchLineItem(options.notice, now)],
		updatedAt: now,
	};
	writeFileAtomic(instance.runtimeThreadPath(threadId), JSON.stringify(switched, null, 2) + "\n");
	const runtime = getPersistentAgentRuntimeState(instance.agentId);
	if (runtime.state !== "idle" && runtime.activeThreadId === threadId) {
		writePersistentAgentRuntimeState(instance.agentId, { state: runtime.state, activeThreadId: threadId, model: switched.model }, { allowInFlightActiveThread: true });
	}
	return { thread: switched, before: thread.model, replaces };
}

/** A switch's line is known by its id, which only a switch (or Remember continuing on a model) writes. */
const MODEL_SWITCH_LINE_ID_PREFIX = "model_switch_";

/** The quiet "Continued on <model>" display line, its id made from when it was written. */
export function modelSwitchLineItem(text: string, at: number): { kind: "system"; id: string; text: string; level: "info" } {
	return { kind: "system", id: `${MODEL_SWITCH_LINE_ID_PREFIX}${at.toString(36)}`, text, level: "info" };
}

export function isModelSwitchLine(item: unknown): item is { id: string } {
	const line = item as { kind?: unknown; id?: unknown } | undefined;
	return line?.kind === "system" && typeof line.id === "string" && line.id.startsWith(MODEL_SWITCH_LINE_ID_PREFIX);
}

/**
 * The conversation's size by the one estimator, for the switch's fit test:
 * chars/4 over every message the model is sent (thinking, tool calls and
 * their results included; an image counts as a fixed allowance) plus the
 * conversation's boot prompt read from its snapshot on disk.
 */
export function estimatePersistentAgentThreadContext(agentIdRaw: string, threadIdRaw: string, runtimeCwd?: string): { messagesTokens: number; systemPromptTokens: number } {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	const thread = getPersistentAgentThread(instance.agentId, threadId);
	if (!thread || thread.runtime.kind !== "pi-session-jsonl") throw persistentAgentConflictError("the conversation to measure is missing or not Pi-backed");
	const session = openPersistentAgentPiSessionManager(instance.agentId, thread.runtime, runtimeCwd || process.cwd());
	let chars = 0;
	let imageTokens = 0;
	for (const message of session.buildSessionContext().messages as any[]) {
		const content = message?.content;
		if (typeof content === "string") chars += content.length;
		else if (Array.isArray(content)) {
			for (const part of content) {
				if (part?.type === "text") chars += String(part.text ?? "").length;
				else if (part?.type === "thinking") chars += String(part.thinking ?? "").length;
				else if (part?.type === "toolCall") chars += JSON.stringify(part.arguments ?? {}).length + String(part.name ?? "").length;
				else if (part?.type === "image") imageTokens += SWITCH_FIT_IMAGE_TOKENS;
			}
		}
		if (typeof message?.summary === "string") chars += message.summary.length;
		if (typeof message?.output === "string") chars += message.output.length;
	}
	const systemPrompt = readPersistentAgentBootPromptSnapshot(instance.agentId, thread.runtime);
	return { messagesTokens: estimateTokensFromChars(chars) + imageTokens, systemPromptTokens: estimateTokens(systemPrompt) };
}

/** What one image in the conversation counts for in the switch's estimate. */
export const SWITCH_FIT_IMAGE_TOKENS = 1_600;

/** The fingerprint of the instructions layer a boot context carries, null when it has none. Read from the layer alone, never from the joined prompt. */
export function fingerprintPersistentAgentBootContextInstructions(bootContext: ReturnType<typeof buildPersistentAgentBootContext>): string | null {
	const layer = bootContext.layers.find((entry) => entry.id === "instructions");
	return layer ? parsePersistentRoomInstructionsLayerFingerprint(layer.content) : null;
}

export function createPersistentAgentPiSessionJsonlThreadRuntime(input: CreatePersistentAgentPiSessionJsonlThreadRuntimeInput): PersistentAgentPiSessionJsonlThreadRuntime {
	const instance = createPersistentAgentInstance(input.agentId);
	const threadId = safeRuntimeThreadId(input.threadId);
	if (!threadId) throw new Error("invalid persistent-agent thread id");
	const paths = persistentAgentPiSessionJsonlPaths(instance.agentId, threadId);
	let wroteBootPromptSnapshot = false;
	let wroteSessionFile = false;
	try {
		const effectiveWorkspacePolicy = input.workspaceCapability ? null : resolvePersistentRoomEffectiveWorkspacePolicy(instance.agentId, threadId);
		const workspaceCapability = input.workspaceCapability ?? effectiveWorkspacePolicy?.capability;
		const bootContext = buildPersistentAgentBootContext({
			agentId: instance.agentId,
			conversationId: threadId,
			sessionId: null,
			model: input.model,
			...(workspaceCapability ? { workspaceCapability } : {}),
		});
		const l1bFingerprint = fingerprintPersistentAgentBootContextL1b(bootContext);
		const instructionsFingerprint = fingerprintPersistentAgentBootContextInstructions(bootContext);
		const bootSnapshot = writePersistentAgentBootPromptSnapshot(instance.agentId, threadId, bootContext.systemPrompt);
		wroteBootPromptSnapshot = true;

		ensureDir(path.dirname(paths.sessionFilePath));
		const sessionManager = SessionManager.open(paths.sessionFilePath, path.dirname(paths.sessionFilePath), input.cwd);
		sessionManager.ensurePersisted();
		wroteSessionFile = true;

		return buildPersistentAgentPiSessionJsonlThreadRuntime(instance.agentId, threadId, {
			sessionId: sessionManager.getSessionId(),
			bootPromptSha256: bootSnapshot.sha256,
			l1bFingerprint,
			instructionsFingerprint,
			createdAt: Date.now(),
			leafId: sessionManager.getLeafId(),
		});
	} catch (error) {
		if (wroteSessionFile && fs.existsSync(paths.sessionFilePath)) fs.rmSync(paths.sessionFilePath, { force: true });
		if (wroteBootPromptSnapshot && fs.existsSync(paths.bootPromptSnapshotPath)) fs.rmSync(paths.bootPromptSnapshotPath, { force: true });
		throw new Error(`failed to create persistent-agent Pi session runtime: ${(error as Error).message}`);
	}
}

export function readPersistentAgentBootPromptSnapshot(agentIdRaw: string, runtime: Pick<PersistentAgentPiSessionJsonlThreadRuntime, "bootPromptSnapshotRelPath" | "bootPromptSha256">): string {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const file = instance.resolveRootRelativePath(runtime.bootPromptSnapshotRelPath, "persistent-agent boot prompt snapshot path");
	if (!fs.existsSync(file)) throw new Error(`persistent-agent boot prompt snapshot is missing: ${runtime.bootPromptSnapshotRelPath}`);
	const text = fs.readFileSync(file, "utf-8");
	const actualSha256 = crypto.createHash("sha256").update(text, "utf-8").digest("hex");
	if (actualSha256 !== runtime.bootPromptSha256) throw new Error("persistent-agent boot prompt snapshot hash mismatch");
	return text;
}

export function openPersistentAgentPiSessionManager(agentIdRaw: string, runtime: Pick<PersistentAgentPiSessionJsonlThreadRuntime, "sessionFileRelPath" | "sessionId">, cwd: string): SessionManager {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const file = instance.resolveRootRelativePath(runtime.sessionFileRelPath, "persistent-agent Pi session path");
	if (!fs.existsSync(file)) throw new Error(`persistent-agent Pi session JSONL is missing: ${runtime.sessionFileRelPath}`);
	const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).filter((line) => line.trim());
	if (lines.length === 0) throw new Error("persistent-agent Pi session JSONL is empty");
	let header: any;
	try {
		const parsed = lines.map((line) => JSON.parse(line));
		header = parsed[0];
	} catch {
		throw new Error("persistent-agent Pi session JSONL contains invalid JSON");
	}
	if (header?.type !== "session" || typeof header.id !== "string") throw new Error("persistent-agent Pi session JSONL header is invalid");
	if (header.id !== runtime.sessionId) throw new Error("persistent-agent Pi session id mismatch");
	const sessionManager = SessionManager.open(file, path.dirname(file), cwd);
	if (sessionManager.getSessionId() !== runtime.sessionId) throw new Error("persistent-agent Pi session id mismatch after open");
	return sessionManager;
}
