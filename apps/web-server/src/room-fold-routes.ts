import { getAbsorbAvailability, createPersistentAgentInstance, parseAssessmentRetryFeedback, fingerprintL1bSource, buildAbsorbAssessment, buildAbsorbDiscussionTurn, buildAbsorbDiscussionSignoff, saveWithOpenConversationCheck } from "./persistent-agents.js";
import { waitForMemoryRoomTurn } from "./memory-entries-store.js";
import { registerReviewAssessRoutes } from "./review-assess-routes.js";
import { withRoomSaveLock } from "./memory-commit.js";
import { cancelFirstRead, firstReadAsk, clearKeptDiscussion, firstReadOnce, askerLeftSignal, keepDiscussionTurns } from "./memorize-discussion-keep.js";
import { absorbRunStatusFields, startAbsorbRun, parseAbsorbRunProposeRequest, getAbsorbRun, keepAbsorbRunEntries, editAbsorbRunEntry, moveAbsorbRunSortedNote, chooseAbsorbRunBeside, setAbsorbRunBudget, cancelAbsorbRun, resumeAbsorbRun, approveAbsorbRun } from "./absorb-run.js";
import { roomCallWait, withRoomCallWait } from "./model-call-causes.js";
import { FOLD_TRIGGER_PROMPT } from "./absorb-ops.js";
import { registerReviewRunRoutes } from "./review-run-routes.js";
import { hasActiveReviewRun } from "./review-run.js";
import { REVIEW_TRIGGER_PROMPT } from "./review-ops.js";
import { app } from "./server-app.js";
import { browserSafeAbsorbApprovalResponse, getPersistentAgentStatusForMaintenance, persistentAgentNormalUseErrorReply } from "./room-status.js";
import { getWebChatModelRegistry, modelStatusPayload } from "./ai-models.js";
import { consultModelWindow, profileStatusPayload, refuseMemoryBudgetRaise, resolveAbsorbModel, resolveStructuralReviewModel, roomMemoryModelForUpkeep, roomMemoryModelSelection, runIsolatedLifecycleWorker, runPatientMemoryWorker } from "./ai-profile-models.js";

app.get("/api/persistent-agents/:id/absorb/status", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		const id = status.id;
		const selection = roomMemoryModelSelection(id);
		const availability = getAbsorbAvailability(id);
		// The v2 block: what this room would fold, what its memory costs now, and
		// whether anything has to leave before a single model call is made.
		const v2 = absorbRunStatusFields(id);
		try {
			const registry = getWebChatModelRegistry();
			const model = resolveAbsorbModel(registry, selection.modelLock);
			// A first read or a discussion turn waiting out a busy model: its screen says so.
			const wait = roomCallWait(id, "absorb");
			return { ...availability, ...v2, model: modelStatusPayload(model), profile: profileStatusPayload(selection.profile), writesMemory: false, ...(wait ? { wait } : {}) };
		} catch (e) {
			return reply.code(400).send({ ...availability, ...v2, model: null, profile: profileStatusPayload(selection.profile), writesMemory: false, error: (e as Error).message });
		}
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.post("/api/persistent-agents/:id/absorb/assess", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		const id = status.id;
		// The page's Cancel for its own ask: the one thing that ends a first read.
		if ((req.body as any)?.cancel === true) return { cancelled: cancelFirstRead(createPersistentAgentInstance(id).rootDir, "memorize", firstReadAsk(req.body)) };
		const modelLock = roomMemoryModelForUpkeep(id);
		const retryFeedback = parseAssessmentRetryFeedback((req.body as any)?.retryFeedback);
		const instance = createPersistentAgentInstance(id);
		// Asked again for a new read (Read again): the kept one and its discussion go.
		const fresh = Boolean(retryFeedback) || (req.body as any)?.fresh === true;
		if (fresh) clearKeptDiscussion(instance.rootDir);
		// One first read per memory and model: kept for a reload, joined by a second tab or a reloaded page, ended only by Cancel.
		return await firstReadOnce(instance.rootDir, modelLock, fingerprintL1bSource(instance.readL1b()).value, (signal) => buildAbsorbAssessment(id, modelLock, async (prompt, modelLock) => withRoomCallWait(id, "absorb", (onWait) => runPatientMemoryWorker(id, prompt, modelLock, resolveAbsorbModel, "absorb worker", "Produce the compact absorb assessment now.", "absorb assessment worker produced no text", { callKind: "first-read", onWait, signal }, true)), { resolveModelWindow: consultModelWindow, retryFeedback }), { fresh, ask: firstReadAsk(req.body), signal: askerLeftSignal(reply.raw) });
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.post("/api/persistent-agents/:id/absorb/discuss", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		const id = status.id;
		const modelLock = roomMemoryModelForUpkeep(id);
		const body = (req.body ?? {}) as any;
		const turn = await buildAbsorbDiscussionTurn({ ...body, agentId: id }, modelLock, async (prompt, modelLock) => withRoomCallWait(id, "absorb", (onWait) => runPatientMemoryWorker(id, prompt, modelLock, resolveAbsorbModel, "absorb worker", "Produce the absorb discussion response now.", "absorb discussion worker produced no text", { callKind: "discussion", onWait }, true)), { resolveModelWindow: consultModelWindow });
		// The discussion as it stands, kept beside its first read for a reload.
		keepDiscussionTurns(createPersistentAgentInstance(id).rootDir, String(body?.source?.l1bFingerprint?.value ?? ""), [...(Array.isArray(body?.messages) ? body.messages : []), { role: "user", content: String(body?.userMessage ?? "").trim() }, turn.message], turn.tokenBudget);
		return turn;
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.post("/api/persistent-agents/:id/absorb/discuss/signoff", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		const id = status.id;
		const modelLock = roomMemoryModelForUpkeep(id);
		return await buildAbsorbDiscussionSignoff({ ...(req.body ?? {} as any), agentId: id }, modelLock, async (prompt, modelLock) => withRoomCallWait(id, "absorb", (onWait) => runPatientMemoryWorker(id, prompt, modelLock, resolveAbsorbModel, "absorb worker", "Produce the absorb discussion signoff handoff now.", "absorb discussion signoff worker produced no text", { callKind: "discussion", onWait }, true)), { resolveModelWindow: consultModelWindow });
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// Review v2: the first read of the room's notes and the discussion about it.
// Same three calls Memorize makes, on the same maintenance model, and none of
// them writes anything.
registerReviewAssessRoutes(app, {
	room: (idRaw) => getPersistentAgentStatusForMaintenance(idRaw),
	reviewRunActive: (agentId) => hasActiveReviewRun(agentId),
	errorReply: (reply, error) => persistentAgentNormalUseErrorReply(reply, error),
	modelLock: (agentId) => roomMemoryModelForUpkeep(agentId),
	generate: (agentId, prompt, modelLock, options) => withRoomCallWait(agentId, "review", (onWait) => runPatientMemoryWorker(agentId, prompt, modelLock, resolveAbsorbModel, "review worker", "Produce the Review first read now.", "the Review worker produced no text", { callKind: "first-read", ...options, onWait }, true)),
	resolveModelWindow: (modelLock) => consultModelWindow(modelLock),
});

/** The calls a Memorize run makes; a run a restart left behind gets them again at Continue. */
function absorbRunCalls(id: string): Pick<Parameters<typeof startAbsorbRun>[0], "generate" | "probe" | "resolveModelWindow"> {
	return {
		resolveModelWindow: consultModelWindow,
		// The fold has its own probe for the end of the patience (absorb-run-pages.ts), so a spent failure is handed back to it; a first call that cannot connect asks the probe here.
		generate: (prompt, modelLock, options) => runPatientMemoryWorker(id, prompt, modelLock, resolveAbsorbModel, "memorize fold worker", FOLD_TRIGGER_PROMPT, "the fold worker produced no text", { ...options, callKind: "fold" }, "first-call"),
		// The tiny fixed question that tells a page's failure from an outage.
		probe: (prompt, modelLock, options) => runIsolatedLifecycleWorker(prompt, modelLock, resolveAbsorbModel, "memorize probe worker", prompt, "the probe worker produced no text", { agent: id, kind: "upkeep" }, { ...options, callKind: "probe" }),
	};
}

// Memorize v2: propose no longer drafts. It starts a RUN — the server folds the
// room's sessions one at a time and the client polls what it did — so the
// answer is the run's id, not a document, and the request returns in
// milliseconds instead of minutes.
app.post("/api/persistent-agents/:id/absorb/propose", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		const id = status.id;
		const modelLock = roomMemoryModelForUpkeep(id);
		const availability = getAbsorbAvailability(id);
		if (!availability.available) throw new Error(availability.message);
		const request = parseAbsorbRunProposeRequest(req.body ?? {});
		const run = startAbsorbRun({
			agentId: id,
			assessmentMarkdown: request.assessmentMarkdown,
			guidance: request.guidance,
			...(request.sourceFingerprint ? { sourceFingerprint: request.sourceFingerprint } : {}),
			...(request.limitRaisedFrom === undefined ? {} : { limitRaisedFrom: request.limitRaisedFrom }),
			model: modelLock,
			...absorbRunCalls(id),
		});
		return reply.code(202).send({ runId: run.runId });
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.get("/api/persistent-agents/:id/absorb/runs/:runId", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		return getAbsorbRun(status.id, String((req.params as any).runId ?? "").trim());
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// Keep takes `{ keepIds?, keepTopics? }` — either or both, a missing field
// leaving that set as it was.
app.post("/api/persistent-agents/:id/absorb/runs/:runId/keep", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		const body = (req.body ?? {}) as any;
		return keepAbsorbRunEntries(status.id, String((req.params as any).runId ?? "").trim(), {
			...(body.keepIds === undefined ? {} : { keepIds: body.keepIds }),
			...(body.keepTopics === undefined ? {} : { keepTopics: body.keepTopics }),
		});
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.post("/api/persistent-agents/:id/absorb/runs/:runId/edit", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		return editAbsorbRunEntry(status.id, String((req.params as any).runId ?? "").trim(), (req.body as any)?.entryId, (req.body as any)?.text);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// A note the one-time sort placed, moved to another topic before Save: `{ entryId, topic }`.
app.post("/api/persistent-agents/:id/absorb/runs/:runId/move", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		return moveAbsorbRunSortedNote(status.id, String((req.params as any).runId ?? "").trim(), (req.body as any)?.entryId, (req.body as any)?.topic);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// Keep both or Replace, for a new note shown beside another: `{ entryId, choice }`.
app.post("/api/persistent-agents/:id/absorb/runs/:runId/beside-choice", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		return chooseAbsorbRunBeside(status.id, String((req.params as any).runId ?? "").trim(), (req.body as any)?.entryId, (req.body as any)?.choice);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// The limit on the run only; the room's setting follows on approve.
app.post("/api/persistent-agents/:id/absorb/runs/:runId/budget", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		refuseMemoryBudgetRaise(status.id, (req.body as any)?.budgetTokens);
		return setAbsorbRunBudget(status.id, String((req.params as any).runId ?? "").trim(), (req.body as any)?.budgetTokens);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.post("/api/persistent-agents/:id/absorb/runs/:runId/cancel", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		return cancelAbsorbRun(status.id, String((req.params as any).runId ?? "").trim());
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// Try again after an outage stopped the run: the same run reads the
// conversations still waiting, on top of what already finished, with the
// room's Memory model as it is now. The person may have chosen another one
// from the notice, so the resume checks it the way propose does: a model that
// cannot run refuses here, before any conversation is read.
app.post("/api/persistent-agents/:id/absorb/runs/:runId/resume", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		const modelLock = roomMemoryModelForUpkeep(status.id);
		const availability = getAbsorbAvailability(status.id);
		if (!availability.available) throw new Error(availability.message);
		return resumeAbsorbRun(status.id, String((req.params as any).runId ?? "").trim(), modelLock, new Date(), absorbRunCalls(status.id));
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// Approve is the run's approve. The whole-document approval it replaces is
// retired: a body without a runId has no run to write, and says so.
app.post("/api/persistent-agents/:id/absorb/approve", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getPersistentAgentStatusForMaintenance(idRaw);
		const runId = String((req.body as any)?.runId ?? "").trim();
		if (!runId) throw new Error("runId is required: start Memorize again to build a memory update this room can save.");
		const result = await withRoomSaveLock(status.id, async () => {
			await waitForMemoryRoomTurn(status.id);
			return saveWithOpenConversationCheck(status.id, () => approveAbsorbRun(status.id, runId));
		});
		return browserSafeAbsorbApprovalResponse(result);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// Review v2: the run that tidies a room's notes a group of topics at a time,
// keeping every note's id, date and pin. Registered beside the Memorize run's
// routes, on the same room checks and the same error envelope.
registerReviewRunRoutes(app, {
	maintenanceRoom: (idRaw) => getPersistentAgentStatusForMaintenance(idRaw),
	errorReply: (reply, error) => persistentAgentNormalUseErrorReply(reply, error),
	modelLock: (agentId) => roomMemoryModelForUpkeep(agentId),
	resolveModelWindow: consultModelWindow,
	refuseBudgetRaise: (agentId, budgetTokens) => refuseMemoryBudgetRaise(agentId, budgetTokens),
	generate: (agentId, prompt, modelLock, options) => runPatientMemoryWorker(agentId, prompt, modelLock, resolveStructuralReviewModel, "review tidy worker", REVIEW_TRIGGER_PROMPT, "the review tidy worker produced no text", { ...options, callKind: "review-tidy" }, true),
});
