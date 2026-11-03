import { getAgentDir } from "@exxeta/exxperts-runtime";
import { beginRememberGeneration, buildCheckpointProposal, REMEMBER_WORKER_MAX_OUTPUT_TOKENS, assertRememberReadsOpenConversation, checkpointProposalStillFresh, REMEMBER_ALREADY_GENERATING_MESSAGE, getPersistentAgentThread, createPersistentAgentInstance, getRememberGeneration, estimateCheckpointRead, parseCheckpointApprovalRequest, writeApprovedCheckpoint, buildConsultAnswer } from "./persistent-agents.js";
import { resolvePersistentRoomEffectiveWorkspacePolicy, persistentRoomRuntimeCwdForEffectiveWorkspacePolicy } from "./persistent-room-workspace-policy.js";
import { createRoomModelCatalog, parseModelLock, rememberSaveMemoryModels, type RoomModelCatalog } from "./room-models.js";
import fs from "node:fs";
import path from "node:path";
import { persistentAgentModelLocksEqual } from "./persistent-agent-ai-profiles.js";
import { estimateTokens } from "./token-estimate.js";
import { rememberSentenceModelName } from "./checkpoint-compression.js";
import { freshConversationFits } from "./room-thread-routes.js";
import type { PersistentAgentModelLock } from "./persistent-agent-ai-profiles.js";
import { runIsolatedPersistentAgentWorker } from "./persistent-agent-worker-runtime.js";
import { usageMovedNothing } from "./usage-log.js";
import { withRoomSaveLock } from "./memory-commit.js";
import { cancelRememberJob, startRememberJob, rememberJobSettled, getRememberJob, dropKeptProposal, rememberCancelledReply, takeRestartedRemember, discardRememberJob } from "./remember-job.js";
import { countRememberPartNotes, rememberWorkDir, writeRememberFile } from "./remember-parts-cache.js";
import { MODEL_CALL_IDLE_TIMEOUT_MS } from "./model-call-causes.js";
import { REPO_ROOT } from "./server-install-root.js";
import { app } from "./server-app.js";
import { browserSafeCheckpointApprovalResponse, getPersistentAgentStatusForCheckpoint, getPersistentAgentStatusForMaintenance, persistentAgentNormalUseErrorReply } from "./room-status.js";
import { getWebChatModelRegistry, roomModelLockPayload, webChatModelLabel } from "./ai-models.js";
import { CONSULT_TRIGGER_PROMPT, consultModelWindow, MAINTENANCE_WORKER_TIMEOUT_MS, memoryModelProbe, resolveBoundaryFreshThreadModel, resolveConfiguredWorkerModel, resolveConsultModel, roomMemoryModelSelection, runIsolatedLifecycleWorker } from "./ai-profile-models.js";
import { logProviderCallFailed, recordWorkerUsage } from "./usage-recording.js";

/** The room's memory model for Remember, with the name a person reads. */
function rememberMemoryModel(agentId: string): PersistentAgentModelLock & { label?: string } {
	const { modelLock } = roomMemoryModelSelection(agentId);
	const model = getWebChatModelRegistry().find(modelLock.provider, modelLock.model);
	return model ? { ...modelLock, label: webChatModelLabel(modelLock.provider, model) } : modelLock;
}

/** The window Remember plans against: the model's context window and its declared output ceiling. */
function rememberModelWindow(modelLock: { provider: string; model: string }) {
	const registry = getWebChatModelRegistry();
	const model = registry.find(modelLock.provider, modelLock.model);
	if (!model) throw new Error(`model not found: ${modelLock.provider}/${modelLock.model}`);
	return { contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens };
}

/**
 * One Remember of a conversation, run as a job (remember-job.ts): the room's
 * memory model, every call patient, the conversation held still while it
 * reads (a prompt frame for it is refused), and its signal stopped only by
 * Cancel, Save or Forget. A closed tab or a dropped connection no longer stops it.
 */
async function runRememberJob(id: string, conversationId: string, request: Record<string, unknown>, runtimeCwd: string, signal: AbortSignal) {
	// Save and Forget of this conversation stop the job through its reading mark.
	const generation = beginRememberGeneration(id, conversationId, (reason) => cancelRememberJob(id, conversationId, reason));
	// Whatever ends the job (a signed-out memory model before any call included) ends the reading mark with it.
	try {
		const memoryModel = rememberMemoryModel(id);
		return await buildCheckpointProposal({ ...request, agentId: id, conversationId, runtimeCwd }, async (prompt, modelLock, call) => {
			const registry = getWebChatModelRegistry();
			const callKind = call?.callKind ?? "remember-single";
			let workerResult: Awaited<ReturnType<typeof runIsolatedPersistentAgentWorker>>;
			try {
				workerResult = await runIsolatedPersistentAgentWorker({
					workerSystemPrompt: prompt,
					// A part of a long conversation is read for notes; the single pass
					// and the final call produce the fields.
					triggerPrompt: call?.trigger ?? "Produce the checkpoint compression fields now.",
					modelLock,
					// Checkpoint compression inherits the ROOM model, so this is the one
					// restricted worker most likely to be handed a model marked for
					// provider search. Same resolver as the other workers, same removal.
					resolveExpectedModel: (workerRegistry, expectedModelLock) =>
						resolveConfiguredWorkerModel(workerRegistry, expectedModelLock, "checkpoint compression model"),
					workerLabel: call?.workerLabel ?? "checkpoint compression worker",
					emptyTextError: "checkpoint compression worker produced no text",
					cwd: runtimeCwd,
					agentDir: getAgentDir(),
					modelRegistry: registry,
					// A single-shot transform: reasoning tokens would count against the
					// output cap and starve the compression fields themselves.
					thinkingLevel: "low",
					// Remember's own cap, not the model's full ceiling: see
					// REMEMBER_WORKER_MAX_OUTPUT_TOKENS.
					maxTokens: REMEMBER_WORKER_MAX_OUTPUT_TOKENS,
					// A part's own signal also stops it when Cancel stopped the job.
					signal: call?.signal ?? signal,
					// The same ceilings every Memory model call gets: eight minutes,
					// and 90 seconds of silence.
					timeoutMs: MAINTENANCE_WORKER_TIMEOUT_MS,
					idleTimeoutMs: MODEL_CALL_IDLE_TIMEOUT_MS,
					callKind,
				});
			} catch (error) {
				// A failed call is paid for too, when it moved tokens.
				logProviderCallFailed({ room: id, callKind, provider: modelLock.provider, model: modelLock.model }, error);
				const usage = (error as { usage?: Parameters<typeof recordWorkerUsage>[3] })?.usage;
				if (usage && !usageMovedNothing(usage)) recordWorkerUsage(id, "upkeep", modelLock, usage, callKind);
				throw error;
			}
			recordWorkerUsage(id, "upkeep", modelLock, workerResult.usage, callKind);
			return workerResult;
		}, {
			model: memoryModel,
			resolveModelWindow: rememberModelWindow,
			signal,
			onProgress: generation.update,
			patience: {
				onWait: generation.wait,
				probe: (signal?: AbortSignal) => memoryModelProbe(id, memoryModel, (workerRegistry, expectedModelLock) => resolveConfiguredWorkerModel(workerRegistry, expectedModelLock, "checkpoint compression model"), signal),
			},
		});
	} finally {
		generation.end();
	}
}

// Remember with a switch: the model the new conversation continues on
// (`continueOn`), kept beside the job's other files in a file of its own, so a
// reload finds it and Save, Discard and Forget clear it with the rest. Cancel
// drops it: a cancelled Remember switches nothing. The pick belongs to the job
// it was made for: a proposal another job kept (one a restart brought back
// after a newer job failed) never carries it.
type ContinueOn = { jobId: string; lock: PersistentAgentModelLock };

function continueOnPath(agentId: string, conversationId: string): string {
	return path.join(rememberWorkDir(createPersistentAgentInstance(agentId).rootDir, conversationId), "continue-on.json");
}

function readContinueOn(agentId: string, conversationId: string): ContinueOn | null {
	try {
		const raw = JSON.parse(fs.readFileSync(continueOnPath(agentId, conversationId), "utf-8"));
		return typeof raw?.jobId === "string" && raw.jobId ? { jobId: raw.jobId, lock: parseModelLock(raw) } : null;
	} catch {
		return null;
	}
}

function keepContinueOn(agentId: string, conversationId: string, kept: ContinueOn | null): void {
	const file = continueOnPath(agentId, conversationId);
	if (kept) writeRememberFile(file, { jobId: kept.jobId, provider: kept.lock.provider, model: kept.lock.model });
	else fs.rmSync(file, { force: true });
}

/** The pick of this job, as progress and result answer it: with the job's id, which Save sends back in the proposal. */
function continueOnOfJob(agentId: string, conversationId: string, jobId: string): { provider: string; model: string; jobId: string } | null {
	const kept = readContinueOn(agentId, conversationId);
	return kept && kept.jobId === jobId ? { provider: kept.lock.provider, model: kept.lock.model, jobId } : null;
}

function continueOnName(lock: PersistentAgentModelLock, catalog: RoomModelCatalog): string {
	return rememberSentenceModelName(roomModelLockPayload(lock, catalog.registry, catalog) ?? { ...lock, label: lock.model });
}

/** A `continueOn` from a request body: offered for rooms, and one a new conversation of this room can start on. Throws the sentence the person reads. */
function parseContinueOn(raw: unknown, id: string, conversationId: string): PersistentAgentModelLock | null {
	if (raw === undefined || raw === null) return null;
	const lock = parseModelLock(raw);
	const catalog = createRoomModelCatalog();
	if (!catalog.availability(lock, "conversation").ok) throw Object.assign(new Error(`${lock.model} is not offered for rooms. Choose another model.`), { statusCode: 400, code: "continue_on_not_offered" });
	if (!freshConversationFits(id, conversationId, lock, catalog)) {
		const name = continueOnName(lock, catalog);
		throw Object.assign(new Error(`This room's memory and setup do not fit ${name}, so a new conversation cannot start on it. Choose a model that can read more at once.`), { statusCode: 409, code: "continue_on_too_small" });
	}
	return lock;
}

function rememberRoomAndConversation(req: any, conversationRaw: unknown) {
	const status = getPersistentAgentStatusForCheckpoint(String((req.params as any).id ?? "").trim());
	const conversationId = String(conversationRaw ?? "").trim();
	if (!conversationId) throw Object.assign(new Error("conversationId is required"), { statusCode: 400 });
	const effectiveWorkspacePolicy = resolvePersistentRoomEffectiveWorkspacePolicy(status.id, conversationId);
	return { id: status.id, conversationId, runtimeCwd: persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectiveWorkspacePolicy, REPO_ROOT) };
}

// A session-backed conversation is read from its session file, so the client
// sends no transcript; an older recap conversation still sends its display
// transcript, which a long conversation can take past the default 1 MiB.
// `background: true` answers 202 with the job at once; without it the request
// waits for the job, as before, but closing it no longer cancels the job. A
// second start on the same conversation attaches to the running job.
app.post("/api/persistent-agents/:id/checkpoint/propose", { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
	try {
		const body = (req.body ?? {}) as any;
		const { id, conversationId, runtimeCwd } = rememberRoomAndConversation(req, body.conversationId);
		// Only the room's open conversation is remembered: a window the room moved on from is told so.
		assertRememberReadsOpenConversation(id, conversationId);
		// Remember runs on the room's memory model; a model the client names is ignored.
		const { model: _clientModel, background, continueOn: continueOnRaw, ...request } = body;
		const continueOn = parseContinueOn(continueOnRaw, id, conversationId);
		const started = startRememberJob(id, conversationId, (signal) => runRememberJob(id, conversationId, request, runtimeCwd, signal));
		// A start that attached to the running job keeps that job's own.
		if (!started.attached) keepContinueOn(id, conversationId, continueOn ? { jobId: started.jobId, lock: continueOn } : null);
		if (background === true) return reply.code(202).send(started);
		await rememberJobSettled(id, conversationId);
		return rememberJobResultReply(reply, id, conversationId, runtimeCwd);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

/** The job's outcome as the old propose answered it: the proposal, or the error envelope. */
function rememberJobResultReply(reply: any, id: string, conversationId: string, runtimeCwd: string) {
	const job = getRememberJob(id, conversationId);
	if (job?.state === "done") {
		// A kept proposal is shown again only while its conversation still holds; a memory change does not make it stale.
		if (checkpointProposalStillFresh(id, conversationId, job.proposal as any, runtimeCwd)) {
			const continueOn = continueOnOfJob(id, conversationId, job.jobId);
			return continueOn ? { ...(job.proposal as object), continueOn } : job.proposal;
		}
		dropKeptProposal(id, conversationId);
		return reply.code(404).send({ error: "This conversation changed after Remember read it. Generate again." });
	}
	if (job?.state === "failed") return persistentAgentNormalUseErrorReply(reply, job.error);
	if (job?.state === "cancelled") return reply.code(409).send(rememberCancelledReply(job));
	if (job?.state === "reading") return reply.code(409).send({ error: REMEMBER_ALREADY_GENERATING_MESSAGE, code: "remember_reading", jobId: job.jobId });
	return reply.code(404).send({ error: "Remember stopped unexpectedly. Nothing was saved. Generate again." });
}

// How a Remember of this conversation stands, polled by the dialog from any
// tab: reading (with "part 2 of 4" and the wait line), done, failed or
// cancelled. A 404 means none: it was saved or discarded, or the server
// restarted and ended it; then `keptParts` says how many parts it had read,
// which Generate again does not pay for.
app.get("/api/persistent-agents/:id/checkpoint/progress", async (req, reply) => {
	try {
		const { id, conversationId } = rememberRoomAndConversation(req, (req.query as any)?.conversationId);
		const job = getRememberJob(id, conversationId);
		// A conversation a Remember saved says so: a page whose Save lost its answer finds out here, without saving again.
		const saved = getPersistentAgentThread(id, conversationId)?.closedReason === "checkpoint" ? { saved: true as const } : {};
		// A restart cut a Remember of this conversation: said to every tab, with the parts it had read, until it is read again or discarded.
		if (!job && takeRestartedRemember(id, conversationId)) return { state: "restarted", keptParts: countRememberPartNotes(createPersistentAgentInstance(id).rootDir, conversationId), ...saved };
		// No Remember is the normal answer (every room open asks), not an error.
		if (!job) return { state: "none", keptParts: countRememberPartNotes(createPersistentAgentInstance(id).rootDir, conversationId), ...saved };
		const progress = job.state === "reading" ? getRememberGeneration(id, conversationId) : null;
		const continueOn = continueOnOfJob(id, conversationId, job.jobId);
		return { jobId: job.jobId, state: job.state, ...(progress ?? {}), ...(continueOn ? { continueOn } : {}), ...saved };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// The finished job's proposal (or its notice), for the dialog after a poll
// said done or failed, or after a reload.
app.get("/api/persistent-agents/:id/checkpoint/result", async (req, reply) => {
	try {
		const { id, conversationId, runtimeCwd } = rememberRoomAndConversation(req, (req.query as any)?.conversationId);
		return rememberJobResultReply(reply, id, conversationId, runtimeCwd);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// Cancel, from any tab: stops a running job; the parts it read stay kept.
// Discard (`discard: true`) also deletes the kept proposal and parts.
app.post("/api/persistent-agents/:id/checkpoint/cancel", async (req, reply) => {
	try {
		const body = (req.body ?? {}) as any;
		const { id, conversationId } = rememberRoomAndConversation(req, body.conversationId);
		const cancelled = cancelRememberJob(id, conversationId);
		keepContinueOn(id, conversationId, null);
		if (body.discard === true) discardRememberJob(id, conversationId);
		return { cancelled };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// One pass or N parts, before anything is generated: the Remember dialog and
// the context chip's popover ask when they open. Read-only, no model call.
app.get("/api/persistent-agents/:id/checkpoint/estimate", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForCheckpoint(idRaw);
		const conversationId = String((req.query as any)?.conversationId ?? "").trim();
		const effectiveWorkspacePolicy = conversationId ? resolvePersistentRoomEffectiveWorkspacePolicy(status.id, conversationId) : null;
		const runtimeCwd = persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectiveWorkspacePolicy, REPO_ROOT);
		return estimateCheckpointRead({ agentId: status.id, conversationId, runtimeCwd }, { model: rememberMemoryModel(status.id), resolveModelWindow: rememberModelWindow });
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.post("/api/persistent-agents/:id/checkpoint/approve", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForCheckpoint(idRaw);
		// A proposal written on another memory model than the room's row now is refused: generate again.
		const parsed = parseCheckpointApprovalRequest(req.body ?? {}, status.id, rememberSaveMemoryModels(status.id));
		const effectiveWorkspacePolicy = resolvePersistentRoomEffectiveWorkspacePolicy(status.id, parsed.request.conversationId);
		const runtimeCwd = persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectiveWorkspacePolicy, REPO_ROOT);
		// The fresh post-checkpoint thread starts on a curated model when the old
		// lock has left the list; the old conversation itself keeps its lock.
		const defaultFreshModel = resolveBoundaryFreshThreadModel(status.id, parsed.request.conversationId);
		const result = await withRoomSaveLock(status.id, () => {
			const continuation = rememberContinuation(status.id, parsed.request.conversationId, (req.body as any)?.proposal?.continueOn, parsed.request.approvedRecentContext, defaultFreshModel);
			const freshModel = continuation?.kind === "continued" ? continuation.model : defaultFreshModel;
			return writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date(), { runtimeCwd, ...(freshModel ? { freshModel } : {}), ...(continuation ? { freshContinuation: { kind: continuation.kind, line: continuation.line } } : {}) });
		});
		return browserSafeCheckpointApprovalResponse(result);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

/**
 * The new conversation a Remember with a switch opens: on the picked model,
 * chosen, with its "Continued on" line. Checked again here, counting the entry
 * this save adds to the memory: when the picked model no longer fits a new
 * conversation, the memory still saves and the new conversation starts where
 * it would have without the switch, its first line saying why. Null without a
 * switch, or when the room's default is the picked model anyway.
 *
 * The pick belongs to the job that made the proposal: the proposal Save sends
 * back carries it (`continueOn` with that job's id, from result or progress),
 * and it must be the pick kept for that same job. A proposal of another job
 * (an earlier generation, or one a restart brought back after a newer job
 * failed) or a pick Cancel dropped continues on neither.
 */
function rememberContinuation(agentId: string, conversationId: string, proposalContinueOn: unknown, approvedEntry: string, defaultFreshModel: PersistentAgentModelLock | null | undefined): { kind: "continued"; model: PersistentAgentModelLock; line: string } | { kind: "fell-back"; line: string } | null {
	const kept = readContinueOn(agentId, conversationId);
	if (!kept) return null;
	let shown: PersistentAgentModelLock | null = null;
	try { shown = proposalContinueOn ? parseModelLock(proposalContinueOn) : null; } catch { shown = null; }
	const shownJobId = (proposalContinueOn as { jobId?: unknown } | null)?.jobId;
	if (!shown || shownJobId !== kept.jobId || !persistentAgentModelLocksEqual(shown, kept.lock)) return null;
	const continueOn = kept.lock;
	const catalog = createRoomModelCatalog();
	const name = continueOnName(continueOn, catalog);
	const available = catalog.availability(continueOn, "conversation").ok;
	if (available && freshConversationFits(agentId, conversationId, continueOn, catalog, estimateTokens(approvedEntry))) {
		return { kind: "continued", model: continueOn, line: `Continued on ${name}` };
	}
	const fallback = defaultFreshModel ?? getPersistentAgentThread(agentId, conversationId)?.model;
	const fallbackName = fallback ? continueOnName(fallback, catalog) : "the room's model";
	if (fallback && persistentAgentModelLocksEqual(fallback, continueOn)) return null;
	const why = available ? `With this save the room's memory no longer fits ${name}` : `${name} can't be used here any more`;
	return { kind: "fell-back", line: `${why}, so this conversation started on ${fallbackName}.` };
}

app.post("/api/persistent-agents/:targetId/consult", async (req, reply) => {
	const idRaw = String((req.params as any).targetId ?? "").trim();
	try {
		// Maintenance guard: `needs_absorb` rooms stay consultable (their memory
		// is valid; a warning notes it may lag). Read-only, so no room-lock check.
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		const id = status.id;
		const body = (req.body ?? {}) as any;
		// A consult reads the consulted room's memory, so it runs on that room's memory model.
		const selection = roomMemoryModelSelection(id, status.displayName || id);
		// Consult usage bills to the asking room (room A) when one is named;
		// a direct consult with no asking room bills to the consulted room.
		const usageAgent = String(body.fromRoomId ?? "").trim() || id;
		return await buildConsultAnswer(
			{ ...body, targetAgentId: id, targetLifecycleStatus: status.status },
			selection.modelLock,
			async (prompt, modelLock) => runIsolatedLifecycleWorker(prompt, modelLock, resolveConsultModel, "consult worker", CONSULT_TRIGGER_PROMPT, "consult worker produced no text", { agent: usageAgent, kind: "consult" }, { callKind: "consult" }),
			{ resolveModelWindow: consultModelWindow },
		);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});
