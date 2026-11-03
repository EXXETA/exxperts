import fs from "node:fs";
import { renderMemoryContext } from "./memory-entries.js";
import { analyzeRecentContextIds } from "./recent-context-entries.js";
import path from "node:path";
import { CHECKPOINT_COMPRESSION_WORKER_TYPE } from "./checkpoint-compression.js";
import { clearRememberWork } from "./remember-parts-cache.js";
import { persistentAgentModelLocksEqual } from "./persistent-agent-ai-profiles.js";
import { writeCommitIntent, clearCommitIntent, registerCommitSettler } from "./memory-commit.js";
import { type CheckpointTranscriptSourceMetadata, type PersistentAgentModelLock, type PersistentAgentPiSessionJsonlThreadRuntime, type PersistentAgentThreadRecord, REQUIRED_L1B_SECTIONS } from "./persistent-agent-types.js";
import type { CheckpointApprovalAcceptedRequest, CheckpointApprovalResponse, CheckpointEventRecord, L1bEventStateMetrics, L1bSourceFingerprint, PersistentAgentCheckpointRuntimeBoundary } from "./persistent-agent-memory-types.js";
import { type AgentJson, agentRootRelativePath, assertPersistentAgentThreadNotInFlight, checkpointEventRecordPath, createPersistentAgentInstance, ensureDir, getPersistentAgentRuntimeState, normalizePersistentAgentRootRelativePath, normalizeRuntimeModel, persistentAgentConflictError, type PersistentAgentInstance, requestBodyModelLock, safeRuntimeThreadId, shortRandomId, slugTimestamp, writeCheckpointEventRecord, writeFileAtomic } from "./persistent-agent-store.js";
import { closePersistentAgentThreadForCheckpoint, getPersistentAgentThread, normalizeL1bSourceFingerprint, normalizePersistentAgentRuntimeString, normalizeSha256Hex, writePersistentAgentThread } from "./persistent-agent-threads.js";
import { rememberGenerationKey, rememberGenerations } from "./persistent-agent-turns.js";
import { appendRecentContextEntry, approvedRecentContextFrom, extractMarkdownSections, isCheckpointDensity, l1bStateMetrics, proposedRecentContextEventMetrics, recentContextEntryEventMetrics, stableRecentContextEntry, updateChronosForCheckpoint, validateApprovedRecentContextDraft } from "./persistent-agent-memory-files.js";
import { createPersistentAgentPiSessionJsonlThreadRuntime, modelSwitchLineItem, openPersistentAgentPiSessionManager } from "./persistent-agent-conversation-model.js";
import { assertPersistentAgentAcceptsCheckpoint, getPersistentAgentStatus } from "./persistent-agent-status.js";
import { buildPersistentAgentCheckpointTranscriptSource } from "./persistent-agent-transcript.js";

function parseCheckpointSourceFingerprint(raw: unknown, label: string): L1bSourceFingerprint {
	const fingerprint = normalizeL1bSourceFingerprint(raw);
	if (!fingerprint) throw new Error(`${label} fingerprint is required`);
	return fingerprint;
}

function parseCheckpointTranscriptSourceMetadata(raw: any): CheckpointTranscriptSourceMetadata {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("checkpoint proposal source metadata is required");
	const activeThreadId = safeRuntimeThreadId(raw.activeThreadId);
	if (!activeThreadId) throw new Error("checkpoint proposal source activeThreadId is required");
	const runtimeKind = raw.runtimeKind;
	const l1bFingerprint = parseCheckpointSourceFingerprint(raw.l1bFingerprint, "checkpoint proposal source L1b");
	const transcriptFingerprint = parseCheckpointSourceFingerprint(raw.transcriptFingerprint, "checkpoint proposal transcript");
	const transcriptItemCount = Number.isFinite(raw.transcriptItemCount) && Number(raw.transcriptItemCount) >= 0 ? Math.floor(Number(raw.transcriptItemCount)) : -1;
	if (transcriptItemCount < 1) throw new Error("checkpoint proposal source transcriptItemCount is required");
	if (runtimeKind === "transcript-recap-v1") {
		return { activeThreadId, runtimeKind, l1bFingerprint, transcriptFingerprint, transcriptItemCount };
	}
	if (runtimeKind === "pi-session-jsonl") {
		const sessionId = normalizePersistentAgentRuntimeString(raw.sessionId);
		const sessionFileRelPath = normalizePersistentAgentRootRelativePath(raw.sessionFileRelPath);
		const bootPromptSnapshotRelPath = normalizePersistentAgentRootRelativePath(raw.bootPromptSnapshotRelPath);
		const bootPromptSha256 = normalizeSha256Hex(raw.bootPromptSha256);
		const leafId = raw.leafId == null ? null : normalizePersistentAgentRuntimeString(raw.leafId);
		const runtimeL1bFingerprint = parseCheckpointSourceFingerprint(raw.runtimeL1bFingerprint, "checkpoint proposal runtime L1b");
		if (!sessionId) throw new Error("checkpoint proposal source sessionId is required");
		if (!sessionFileRelPath) throw new Error("checkpoint proposal source sessionFileRelPath is required");
		if (!bootPromptSnapshotRelPath) throw new Error("checkpoint proposal source bootPromptSnapshotRelPath is required");
		if (!bootPromptSha256) throw new Error("checkpoint proposal source bootPromptSha256 is required");
		if (raw.leafId != null && !leafId) throw new Error("checkpoint proposal source leafId is invalid");
		return {
			activeThreadId,
			runtimeKind,
			l1bFingerprint,
			transcriptFingerprint,
			transcriptItemCount,
			sessionId,
			sessionFileRelPath,
			bootPromptSnapshotRelPath,
			bootPromptSha256,
			leafId,
			runtimeL1bFingerprint,
		};
	}
	throw new Error("checkpoint proposal source runtimeKind is required");
}

function assertCheckpointFingerprintMatches(actual: L1bSourceFingerprint, expected: L1bSourceFingerprint, label: string): void {
	if (actual.algorithm === expected.algorithm && actual.value === expected.value) return;
	throw new Error(`${label} fingerprint changed; this memory proposal is stale`);
}

/** Whether a kept proposal still fits its conversation (a memory change does not make it stale). */
export function checkpointProposalStillFresh(agentId: string, conversationId: string, proposal: { source?: CheckpointTranscriptSourceMetadata } | null | undefined, runtimeCwd?: string): boolean {
	if (!proposal?.source) return false;
	try {
		assertCheckpointSourceFresh({ agentId, conversationId, source: proposal.source, ...(runtimeCwd ? { runtimeCwd } : {}) });
		return true;
	} catch {
		return false;
	}
}

function assertCheckpointSourceFresh(input: {
	agentId: string;
	conversationId: string;
	source: CheckpointTranscriptSourceMetadata;
	currentL1b?: string;
	runtimeCwd?: string;
}): void {
	if (input.source.activeThreadId !== input.conversationId) throw new Error("checkpoint proposal source activeThreadId does not match approval request");
	const currentL1b = input.currentL1b ?? (() => {
		const instance = createPersistentAgentInstance(input.agentId);
		const meta = instance.readAgentJson();
		const l1bPath = instance.l1bCurrentPath(meta);
		if (!fs.existsSync(l1bPath)) throw new Error("L1b/current.md is missing");
		return fs.readFileSync(l1bPath, "utf-8");
	})();
	const currentSource = buildPersistentAgentCheckpointTranscriptSource({
		agentId: input.agentId,
		conversationId: input.conversationId,
		l1b: currentL1b,
		runtimeCwd: input.runtimeCwd,
	});
	if (currentSource.source.runtimeKind !== input.source.runtimeKind) throw new Error("the conversation's runtime changed; this memory proposal is stale");
	// The memory itself is not checked: a page is appended to it whatever else
	// it holds, and its Recent Context id is chosen at write time, so a Memorize,
	// a Review or an edit saved since the proposal leaves the proposal valid.
	// What the proposal summarized is the conversation, and that is checked.
	assertCheckpointFingerprintMatches(currentSource.source.transcriptFingerprint, input.source.transcriptFingerprint, "checkpoint proposal transcript");
	if (currentSource.source.transcriptItemCount !== input.source.transcriptItemCount) throw new Error("the conversation gained or lost messages; this memory proposal is stale");
	if (input.source.runtimeKind === "pi-session-jsonl" && currentSource.source.runtimeKind === "pi-session-jsonl") {
		if (currentSource.source.sessionId !== input.source.sessionId) throw new Error("the conversation's session id changed; this memory proposal is stale");
		if (currentSource.source.sessionFileRelPath !== input.source.sessionFileRelPath) throw new Error("the conversation's session path changed; this memory proposal is stale");
		if (currentSource.source.bootPromptSnapshotRelPath !== input.source.bootPromptSnapshotRelPath) throw new Error("the conversation's boot snapshot path changed; this memory proposal is stale");
		if (currentSource.source.bootPromptSha256 !== input.source.bootPromptSha256) throw new Error("the conversation's boot snapshot changed; this memory proposal is stale");
		if (currentSource.source.leafId !== input.source.leafId) throw new Error("the conversation's session leaf changed; this memory proposal is stale");
		assertCheckpointFingerprintMatches(currentSource.source.runtimeL1bFingerprint, input.source.runtimeL1bFingerprint, "checkpoint proposal runtime L1b");
	}
}

/** The sentence an approval gets when the room's memory model changed after its proposal was written. */
export const REMEMBER_MEMORY_MODEL_CHANGED_MESSAGE = "The Memory model changed after this entry was written. Nothing was saved. Generate again.";

export function parseCheckpointApprovalRequest(raw: any, agentIdRaw: string, options: { expectedMemoryModel?: PersistentAgentModelLock | null; movedFromMemoryModel?: PersistentAgentModelLock } = {}): { request: CheckpointApprovalAcceptedRequest; warnings: string[] } {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const status = getPersistentAgentStatus(instance.agentId);
	assertPersistentAgentAcceptsCheckpoint(status);

	const conversationId = String(raw?.conversationId ?? "").trim();
	if (!conversationId) throw new Error("conversationId is required");

	const densityRaw = String(raw?.density ?? raw?.proposal?.density ?? "").trim();
	if (!isCheckpointDensity(densityRaw)) throw new Error("density must be compact, standard, or rich");

	const proposal = raw?.proposal ?? {};
	if (String(proposal?.agentId ?? instance.agentId).trim() !== instance.agentId) throw new Error("proposal agentId does not match persistent agent");
	if (String(proposal?.conversationId ?? conversationId).trim() !== conversationId) throw new Error("proposal conversationId does not match approval request");
	if (proposal?.sessionId != null) throw new Error("proposal must be pre-approval and must not already have a sessionId");
	if (proposal?.writesMemory !== false) throw new Error("proposal must be non-mutating before approval");
	const proposalSource = parseCheckpointTranscriptSourceMetadata(proposal?.source);
	if (proposalSource.activeThreadId !== conversationId) throw new Error("proposal source activeThreadId does not match approval request");
	// The model that read the conversation is the proposal's own; the event
	// records it. A proposal written on another memory model than the room's
	// row now is not saved: it was paid for on a model the room no longer uses,
	// unless an update moved the room's default away from it.
	const proposalProcessModel = normalizeRuntimeModel(proposal?.process?.model);
	const model = proposalProcessModel
		? { ...proposalProcessModel, ...(typeof proposal?.process?.model?.label === "string" && proposal.process.model.label.trim() ? { label: proposal.process.model.label.trim() } : {}) }
		: requestBodyModelLock(raw);
	if (options.expectedMemoryModel && !persistentAgentModelLocksEqual(model, options.expectedMemoryModel) && !(options.movedFromMemoryModel && persistentAgentModelLocksEqual(model, options.movedFromMemoryModel))) {
		throw persistentAgentConflictError(REMEMBER_MEMORY_MODEL_CHANGED_MESSAGE);
	}

	const approvedRecentContext = approvedRecentContextFrom(raw, proposal);
	validateApprovedRecentContextDraft(approvedRecentContext);
	const warnings: string[] = [];
	return {
		request: {
			agentId: instance.agentId,
			conversationId,
			model,
			density: densityRaw,
			proposal: { ...proposal, source: proposalSource },
			approvedRecentContext,
		},
		warnings,
	};
}

export interface CheckpointApprovalWriteOptions {
	runtimeCwd?: string;
	/**
	 * Model lock for the fresh post-checkpoint thread. Callers pass this when
	 * the old thread's lock is no longer on the active profile's curated list,
	 * so the next conversation starts on a current model. When omitted the
	 * fresh thread inherits the old thread's model.
	 */
	freshModel?: PersistentAgentModelLock;
	/** Remember continuing on a model the person picked: the fresh thread's first line, and whether it is on that model. */
	freshContinuation?: RememberFreshContinuation;
}

/**
 * How a Remember with a switch opened its new conversation. `continued`: on
 * the picked model (`freshModel`), marked as chosen so it keeps that model
 * instead of following the room's pick, with its "Continued on" line.
 * `fell-back`: on the model it would have had, with a line saying why.
 */
export type RememberFreshContinuation = { kind: "continued"; line: string } | { kind: "fell-back"; line: string };

export interface PersistentAgentMementoBoundaryWriteOptions {
	runtimeCwd?: string;
	/**
	 * Model lock for the fresh post-Memento thread. Callers pass this when the
	 * old thread's lock is no longer provided by the active AI profile, so the
	 * room comes back on a currently-available model instead of staying stuck.
	 * When omitted the fresh thread inherits the old thread's model.
	 */
	freshModel?: PersistentAgentModelLock;
}

export function writeApprovedCheckpoint(request: CheckpointApprovalAcceptedRequest, validationWarnings: string[] = [], now = new Date(), options: CheckpointApprovalWriteOptions = {}): CheckpointApprovalResponse {
	const instance = createPersistentAgentInstance(request.agentId);
	const status = getPersistentAgentStatus(instance.agentId);
	assertPersistentAgentAcceptsCheckpoint(status);
	const root = instance.rootDir;
	const meta = instance.readAgentJson();
	if (!meta) throw new Error("agent.json is missing or invalid JSON");
	const l1bPath = instance.l1bCurrentPath(meta);
	const archiveDir = instance.l1bArchiveDir(meta);
	if (!fs.existsSync(l1bPath)) throw new Error("L1b/current.md is missing");
	ensureDir(archiveDir);

	const runtimeCwd = typeof options.runtimeCwd === "string" && options.runtimeCwd.trim() ? options.runtimeCwd : process.cwd();
	const currentL1b = fs.readFileSync(l1bPath, "utf-8");
	const sourceMetrics = l1bStateMetrics(renderMemoryContext(currentL1b));
	const proposalSource = parseCheckpointTranscriptSourceMetadata(request.proposal.source);
	const oldThread = getPersistentAgentThread(instance.agentId, request.conversationId);
	if (!oldThread) throw new Error("the conversation this proposal came from is missing; this memory proposal is stale");
	// A conversation a save already closed was remembered: Save again (after a
	// crash the room finished, or a second tab) answers with that save, and
	// never writes a second page.
	if (oldThread.state === "closed" && oldThread.closedReason === "checkpoint" && oldThread.closedByCheckpointId) {
		const landed = checkpointApprovalResponseFromRecord(instance, request.conversationId, oldThread.closedByCheckpointId);
		if (landed) return landed;
	}
	if (oldThread.state === "closed") throw new Error("the conversation this proposal came from is already closed; this memory proposal is stale");
	assertPersistentAgentThreadNotInFlight(instance.agentId, request.conversationId);
	assertCheckpointSourceFresh({ agentId: instance.agentId, conversationId: request.conversationId, source: proposalSource, runtimeCwd });
	const sections = extractMarkdownSections(currentL1b);
	const missingSections = REQUIRED_L1B_SECTIONS.filter((section) => !sections.includes(section));
	if (missingSections.length > 0) throw new Error(`L1b missing mandatory section(s): ${missingSections.join(", ")}`);

	const recentContextIds = analyzeRecentContextIds(currentL1b);
	if (recentContextIds.duplicateIds.length > 0) throw new Error(`L1b Recent Context contains duplicate id(s): ${recentContextIds.duplicateIds.join(", ")}`);
	if (recentContextIds.malformedHeadings.length > 0) throw new Error(`L1b Recent Context contains malformed RC heading(s): ${recentContextIds.malformedHeadings.join("; ")}`);

	const stamp = slugTimestamp(now);
	const suffix = shortRandomId();
	const sessionId = `s_${stamp}_${suffix}`;
	const checkpointId = `cp_${stamp}_${suffix}`;
	const freshThreadId = `postcp_${stamp}_${suffix}`;
	const nextRcNumber = recentContextIds.numericIds.length > 0 ? Math.max(...recentContextIds.numericIds) + 1 : 1;
	const rcId = `RC-${String(nextRcNumber).padStart(4, "0")}`;
	const stableEntry = stableRecentContextEntry(request.approvedRecentContext, rcId, checkpointId, sessionId, request, now);
	// The identity the write stamps: the heading and the metadata line, never the person's words.
	const stampedIdentity = stableEntry.split("\n\n", 2).join("\n");
	if (/RC-DRAFT|checkpoint_id\s*=\s*(?:null|none)|session_id\s*=\s*(?:null|none)/i.test(stampedIdentity)) throw new Error("canonical Recent Context entry still contains draft or null durable identity metadata");

	const archivedL1bPath = path.join(archiveDir, `${stamp}-before-${checkpointId}.md`);
	const intent: RememberCommitIntent = {
		checkpointId,
		sessionId,
		rcId,
		conversationId: request.conversationId,
		freshThreadId,
		freshModel: normalizeRuntimeModel(options.freshModel) ?? oldThread.model,
		...(options.freshContinuation ? { freshContinuation: options.freshContinuation } : {}),
		runtimeCwd,
		approvedAt: now.toISOString(),
		leafId: proposalSource.runtimeKind === "pi-session-jsonl" ? proposalSource.leafId ?? null : null,
		archivedL1bRelPath: agentRootRelativePath(instance, archivedL1bPath),
		density: request.density,
		model: request.model,
		warnings: validationWarnings,
		metrics: {
			source: sourceMetrics,
			approvedEntry: recentContextEntryEventMetrics(stableEntry),
			...(typeof request.proposal.proposedRecentContext === "string" && request.proposal.proposedRecentContext.trim()
				? { proposedEntry: proposedRecentContextEventMetrics(request.proposal.proposedRecentContext) }
				: {}),
		},
	};

	// The save is one step (memory-commit.ts): the intent first, then the
	// archive copy, then the memory file, which is the commit point. Everything
	// after it is finished by the same code a crash recovery runs, so a save
	// that stops anywhere after the memory file is completed by the next
	// request, and one that stops before it saved nothing. It stays
	// synchronous from the intent to its clear: the settle runs outside the
	// save lock, so an await in between would let a status request finish or
	// drop this save mid-flight. Keep it synchronous, or take the lock in the
	// settle.
	writeCommitIntent(root, "remember", intent);
	fs.writeFileSync(archivedL1bPath, currentL1b, { mode: 0o600, flag: "wx" });
	let updatedL1b = appendRecentContextEntry(currentL1b, stableEntry);
	updatedL1b = updateChronosForCheckpoint(updatedL1b, checkpointId, sessionId, now);
	writeFileAtomic(l1bPath, updatedL1b);

	// The conversation was just checked against the proposal, so its leaf is the proposal's.
	const finished = finishRememberCommit(instance, intent, { leafChecked: true });
	clearCommitIntent(root, "remember");
	if (!finished.runtimeBoundary || !finished.freshThread) throw new Error("the remembered conversation could not be closed");
	if (finished.freshThread.runtime.kind !== "pi-session-jsonl") throw new Error("fresh post-checkpoint runtime must be Pi-backed");
	return {
		agentId: instance.agentId,
		conversationId: request.conversationId,
		sessionId,
		checkpointId,
		writesMemory: true,
		archivedL1bPath,
		updatedL1bPath: l1bPath,
		eventRecordPath: finished.eventRecordPath,
		eventRelPath: agentRootRelativePath(instance, finished.eventRecordPath),
		recentContextEntryCount: finished.recentContextEntryCount,
		runtimeBoundary: finished.runtimeBoundary,
		postCheckpoint: { canContinue: true, canRest: true, activeThreadId: finished.freshThread.threadId, runtime: finished.freshThread.runtime },
		warnings: validationWarnings,
	};
}

/** A Remember save in flight: ids, times and counts, never the conversation's words. */
interface RememberCommitIntent {
	checkpointId: string;
	sessionId: string;
	rcId: string;
	conversationId: string;
	freshThreadId: string;
	freshModel: PersistentAgentModelLock;
	/** Written into the fresh thread in its one creating write, so a crash recovery makes the same thread. */
	freshContinuation?: RememberFreshContinuation;
	runtimeCwd: string;
	approvedAt: string;
	/** The conversation's last entry when its proposal was read; null for a runtime without one. */
	leafId: string | null;
	archivedL1bRelPath: string;
	density: CheckpointApprovalAcceptedRequest["density"];
	model: CheckpointApprovalAcceptedRequest["model"];
	warnings: string[];
	metrics: {
		source: L1bEventStateMetrics;
		approvedEntry: CheckpointEventRecord["checkpoint"]["approvedEntry"];
		proposedEntry?: CheckpointEventRecord["checkpoint"]["proposedEntry"];
	};
}

/**
 * Everything a Remember save does after its memory file landed, each step
 * safe to run twice: the fresh conversation and the pointer to it, the old
 * conversation closed, agent.json, the event record. The normal save and the
 * crash recovery both run it.
 *
 * A conversation that moved on after its proposal was read (a writer outside
 * the turn gate) keeps the page, which is a true summary up to the proposal's
 * leaf, gets its event record, and stays open: its later turns are
 * remembered next time.
 */
function finishRememberCommit(instance: PersistentAgentInstance, intent: RememberCommitIntent, options: { leafChecked: boolean }): {
	runtimeBoundary?: PersistentAgentCheckpointRuntimeBoundary;
	freshThread?: PersistentAgentThreadRecord;
	eventRecordPath: string;
	recentContextEntryCount: number;
} {
	const agentId = instance.agentId;
	const now = new Date(intent.approvedAt);
	const oldThread = getPersistentAgentThread(agentId, intent.conversationId);
	if (!oldThread) throw new Error("the remembered conversation is missing");
	rememberGenerations.get(rememberGenerationKey(agentId, intent.conversationId))?.stop?.("saved");
	clearRememberWork(instance.rootDir, intent.conversationId);
	const moved = !options.leafChecked && oldThread.state !== "closed" && conversationLeafMoved(agentId, oldThread, intent);

	let runtimeBoundary: PersistentAgentCheckpointRuntimeBoundary | undefined;
	let freshThread: PersistentAgentThreadRecord | undefined;
	if (!moved) {
		// The pointer swaps to the fresh conversation inside this write, before
		// the old one closes, so the room never points at a closed conversation.
		const runtime = getPersistentAgentRuntimeState(agentId);
		const existingFresh = getPersistentAgentThread(agentId, intent.freshThreadId);
		if (!existingFresh || runtime.activeThreadId !== intent.freshThreadId) {
			const continuation = intent.freshContinuation;
			const at = now.getTime();
			writePersistentAgentThread(agentId, intent.freshThreadId, {
				state: existingFresh?.state === "active" ? "active" : "standby",
				origin: "checkpoint",
				model: existingFresh?.model ?? intent.freshModel,
				...(continuation?.kind === "continued" ? { modelChosen: true as const } : {}),
				...(existingFresh ? {} : { items: continuation ? [continuation.kind === "continued" ? modelSwitchLineItem(continuation.line, at) : { kind: "system", id: `continue_on_${at.toString(36)}`, text: continuation.line, level: "info" }] : [] }),
			}, {
				createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: intent.freshThreadId, model, cwd: intent.runtimeCwd }),
				// Approval never invokes a model: the fresh thread inherits the old
				// thread's lock, which may belong to a profile that is no longer
				// active. The approved memory must still land; prompting and resume
				// keep full enforcement.
				allowInactiveProfileModel: true,
			});
		}
		freshThread = getPersistentAgentThread(agentId, intent.freshThreadId) ?? undefined;
		if (!freshThread) throw new Error("the fresh conversation could not be written");
		const closedThread = oldThread.state === "closed"
			? oldThread
			: closePersistentAgentThreadForCheckpoint(agentId, oldThread.threadId, intent.checkpointId, now.getTime());
		runtimeBoundary = {
			closedThreadId: closedThread.threadId,
			closedReason: "checkpoint",
			closedAt: closedThread.closedAt ?? now.getTime(),
			closedByCheckpointId: closedThread.closedByCheckpointId ?? intent.checkpointId,
			oldRuntime: oldThread.runtime,
			newThreadId: freshThread.threadId,
			newRuntime: freshThread.runtime as PersistentAgentPiSessionJsonlThreadRuntime,
		};
	}

	const meta = instance.readAgentJson();
	if (!meta) throw new Error("agent.json is missing or invalid JSON");
	if (meta.lastCheckpointId !== intent.checkpointId) {
		writeFileAtomic(instance.agentJsonPath(), JSON.stringify({ ...(meta as AgentJson), currentSessionId: intent.sessionId, lastCheckpointId: intent.checkpointId, updatedAt: now.getTime() }, null, 2) + "\n");
	}

	const l1bPath = instance.l1bCurrentPath(meta);
	const resultMetrics = l1bStateMetrics(renderMemoryContext(fs.readFileSync(l1bPath, "utf-8")));
	const eventRecordPath = checkpointEventRecordPath(instance, intent.checkpointId);
	if (!fs.existsSync(eventRecordPath)) {
		const eventRecord: CheckpointEventRecord = {
			schemaVersion: 1,
			operation: "checkpoint",
			mutation: {
				target: "l1b",
				kind: "recent_context_append",
				sectionsAffected: ["Chronos", "Recent Context"],
				sectionsPreserved: ["Deep Memory", "Active Items"],
			},
			agentId,
			conversationId: intent.conversationId,
			sessionId: intent.sessionId,
			checkpointId: intent.checkpointId,
			recentContextId: intent.rcId,
			approvedAt: intent.approvedAt,
			paths: {
				archivedL1bRelPath: intent.archivedL1bRelPath,
				updatedL1bRelPath: agentRootRelativePath(instance, l1bPath),
				eventRelPath: agentRootRelativePath(instance, eventRecordPath),
			},
			process: {
				type: CHECKPOINT_COMPRESSION_WORKER_TYPE,
				density: intent.density,
				model: intent.model,
			},
			source: intent.metrics.source,
			result: resultMetrics,
			...(runtimeBoundary ? { runtimeBoundary: checkpointEventRuntimeBoundary(runtimeBoundary) } : {}),
			checkpoint: {
				recentContextEntryCountBefore: intent.metrics.source.recentContextEntryCount,
				recentContextEntryCountAfter: resultMetrics.recentContextEntryCount,
				approvedEntry: intent.metrics.approvedEntry,
				proposedEntry: intent.metrics.proposedEntry,
			},
			validation: {
				valid: true,
				warnings: intent.warnings,
				errors: [],
			},
			warnings: intent.warnings,
		};
		writeCheckpointEventRecord(instance, eventRecord);
	}
	return { runtimeBoundary, freshThread, eventRecordPath, recentContextEntryCount: resultMetrics.recentContextEntryCount };
}

function checkpointEventRuntimeBoundary(boundary: PersistentAgentCheckpointRuntimeBoundary): NonNullable<CheckpointEventRecord["runtimeBoundary"]> {
	return {
		closedThreadId: boundary.closedThreadId,
		closedReason: boundary.closedReason,
		closedAt: boundary.closedAt,
		closedByCheckpointId: boundary.closedByCheckpointId,
		oldRuntimeKind: boundary.oldRuntime.kind,
		...(boundary.oldRuntime.kind === "pi-session-jsonl" ? {
			oldRuntimeSessionId: boundary.oldRuntime.sessionId,
			oldSessionFileRelPath: boundary.oldRuntime.sessionFileRelPath,
			oldBootPromptSha256: boundary.oldRuntime.bootPromptSha256,
		} : {}),
		newThreadId: boundary.newThreadId,
		newRuntimeKind: "pi-session-jsonl",
		newRuntimeSessionId: boundary.newRuntime.sessionId,
		newSessionFileRelPath: boundary.newRuntime.sessionFileRelPath,
		newBootPromptSnapshotRelPath: boundary.newRuntime.bootPromptSnapshotRelPath,
		newBootPromptSha256: boundary.newRuntime.bootPromptSha256,
		newRuntimeL1bFingerprint: boundary.newRuntime.l1bFingerprint,
	};
}

/** Whether the conversation gained an entry after its proposal was read. A session file that cannot be read has not moved. */
function conversationLeafMoved(agentId: string, thread: PersistentAgentThreadRecord, intent: RememberCommitIntent): boolean {
	if (thread.runtime.kind !== "pi-session-jsonl" || intent.leafId === null) return false;
	try {
		return openPersistentAgentPiSessionManager(agentId, thread.runtime, intent.runtimeCwd).getLeafId() !== intent.leafId;
	} catch {
		return false;
	}
}

/** The answer a save that already landed gives again, read from its own record; null when there is none to read. */
function checkpointApprovalResponseFromRecord(instance: PersistentAgentInstance, conversationId: string, checkpointId: string): CheckpointApprovalResponse | null {
	const eventRecordPath = checkpointEventRecordPath(instance, checkpointId);
	let record: CheckpointEventRecord;
	try {
		record = JSON.parse(fs.readFileSync(eventRecordPath, "utf-8"));
	} catch {
		return null;
	}
	if (record.conversationId !== conversationId || !record.runtimeBoundary) return null;
	const oldThread = getPersistentAgentThread(instance.agentId, conversationId);
	const freshThread = getPersistentAgentThread(instance.agentId, record.runtimeBoundary.newThreadId);
	if (!oldThread || !freshThread || freshThread.runtime.kind !== "pi-session-jsonl") return null;
	const meta = instance.readAgentJson();
	return {
		agentId: instance.agentId,
		conversationId,
		sessionId: record.sessionId,
		checkpointId,
		writesMemory: true,
		archivedL1bPath: path.join(instance.rootDir, record.paths.archivedL1bRelPath),
		updatedL1bPath: instance.l1bCurrentPath(meta),
		eventRecordPath,
		eventRelPath: record.paths.eventRelPath,
		recentContextEntryCount: record.result.recentContextEntryCount,
		runtimeBoundary: {
			closedThreadId: conversationId,
			closedReason: "checkpoint",
			closedAt: oldThread.closedAt ?? Date.parse(record.approvedAt),
			closedByCheckpointId: checkpointId,
			oldRuntime: oldThread.runtime,
			newThreadId: freshThread.threadId,
			newRuntime: freshThread.runtime,
		},
		postCheckpoint: { canContinue: true, canRest: true, activeThreadId: freshThread.threadId, runtime: freshThread.runtime },
		warnings: record.warnings ?? [],
		alreadySaved: true,
	};
}

/**
 * A Remember save a crash left pending. Its page is in the memory file: the
 * save is finished. It is not: nothing was saved, the intent and its archive
 * copy go, and the proposal can be saved again.
 */
function settleRememberCommit(agentId: string, roomDir: string, intent: RememberCommitIntent): void {
	const instance = createPersistentAgentInstance(agentId);
	const meta = instance.readAgentJson();
	const l1bPath = meta ? instance.l1bCurrentPath(meta) : path.join(roomDir, "L1b", "current.md");
	const l1b = fs.existsSync(l1bPath) ? fs.readFileSync(l1bPath, "utf-8") : "";
	if (l1b.includes(`checkpoint_id=${intent.checkpointId}`)) {
		finishRememberCommit(instance, intent, { leafChecked: false });
	} else {
		fs.rmSync(path.join(roomDir, intent.archivedL1bRelPath), { force: true });
	}
	clearCommitIntent(roomDir, "remember");
}

registerCommitSettler("remember", settleRememberCommit);
