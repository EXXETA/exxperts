// Review v2's run, over HTTP.
//
// One route per thing a person does to a review: see whether the room has
// anything to tidy, start the run, watch it, keep a note the tidy or the budget
// would archive, raise the budget instead, put their own words on a note the
// run rewrote, cancel, and approve. The routes live under
// /api/persistent-agents/:id/review/ beside the room's other maintenance
// routes, share their auth, their `{ error, code? }` envelope and their
// remote-route classification, and are registered from index.ts with one line
// next to the Memorize run's routes.
//
// Nothing here decides anything: every refusal, every number and the one write
// belong to review-run.ts. This file reads request fields and hands them over.

import type { FastifyInstance } from "fastify";
import type { AbsorbGenerateResult, CheckpointModelWindow, PersistentAgentModelLock } from "./persistent-agents.js";
import { reviewGuidanceFromWire } from "./review-guidance.js";
import {
	approveReviewRun,
	cancelReviewRun,
	editReviewRunEntry,
	getReviewRun,
	keepReviewRunEntries,
	parseReviewRunStartRequest,
	reviewRunStatus,
	setReviewRunBudget,
	startReviewRun,
} from "./review-run.js";

export interface ReviewRunRouteDeps {
	/** The room's own maintenance-status check, so these routes refuse exactly like their neighbours. */
	maintenanceRoom(idRaw: string): { id: string };
	/** The room routes' error envelope: `{ error, code? }` at the error's own status. */
	errorReply(reply: any, error: unknown): unknown;
	/** The maintenance model this room's profile locks Review to. */
	modelLock(): PersistentAgentModelLock;
	/** The locked model's window, so an oversized prompt refuses with guidance instead of running truncated. */
	resolveModelWindow(model: PersistentAgentModelLock): CheckpointModelWindow | undefined;
	/** The isolated worker call: one prompt, one reply, cancellable by the run. */
	generate(agentId: string, prompt: string, model: PersistentAgentModelLock, options: { signal: AbortSignal; timeoutMs: number; thinkingLevel: "low" }): Promise<AbsorbGenerateResult>;
}

export function registerReviewRunRoutes(app: FastifyInstance, deps: ReviewRunRouteDeps): void {
	const roomId = (req: any): string => deps.maintenanceRoom(String((req.params as any).id ?? "").trim()).id;
	const runIdOf = (req: any): string => String((req.params as any).runId ?? "").trim();

	// What a room says before a review starts: how much there is to tidy, what
	// it costs now, and which depth to offer first.
	app.get("/api/persistent-agents/:id/review/status", async (req, reply) => {
		try {
			return reviewRunStatus(roomId(req));
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	// Starting a review answers with the run's id in milliseconds; the tidying
	// runs on afterwards and the client polls it.
	app.post("/api/persistent-agents/:id/review/runs", async (req, reply) => {
		try {
			const id = roomId(req);
			const body = (req.body ?? {}) as any;
			const request = parseReviewRunStartRequest(body);
			const run = startReviewRun(id, {
				depth: request.depth,
				topics: request.topics,
				guidance: reviewGuidanceFromWire(body.guidance),
				...(request.sourceFingerprint ? { sourceFingerprint: request.sourceFingerprint } : {}),
				model: deps.modelLock(),
				resolveModelWindow: deps.resolveModelWindow,
				generate: (prompt, modelLock, options) => deps.generate(id, prompt, modelLock, options),
			});
			return reply.code(202).send({ runId: run.runId });
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	app.get("/api/persistent-agents/:id/review/runs/:runId", async (req, reply) => {
		try {
			return getReviewRun(roomId(req), runIdOf(req));
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	// Keep takes `{ keepIds?, keepTopics? }` — either or both, a missing field
	// leaving that set as it was; `entryIds` is the older name for keepIds.
	app.post("/api/persistent-agents/:id/review/runs/:runId/keep", async (req, reply) => {
		try {
			const body = (req.body ?? {}) as any;
			const keepIds = body.entryIds ?? body.keepIds;
			return keepReviewRunEntries(roomId(req), runIdOf(req), {
				...(keepIds === undefined ? {} : { keepIds }),
				...(body.keepTopics === undefined ? {} : { keepTopics: body.keepTopics }),
			});
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	// The limit on the run only; the room's setting follows on approve.
	app.post("/api/persistent-agents/:id/review/runs/:runId/budget", async (req, reply) => {
		try {
			return setReviewRunBudget(roomId(req), runIdOf(req), (req.body as any)?.budgetTokens);
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	app.post("/api/persistent-agents/:id/review/runs/:runId/edit", async (req, reply) => {
		try {
			return editReviewRunEntry(roomId(req), runIdOf(req), (req.body as any)?.entryId, (req.body as any)?.text);
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	app.post("/api/persistent-agents/:id/review/runs/:runId/cancel", async (req, reply) => {
		try {
			return cancelReviewRun(roomId(req), runIdOf(req));
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	// The run's one write. Everything it refuses on — a stale memory, a run that
	// is not ready, a room mid-turn — belongs to the run itself.
	app.post("/api/persistent-agents/:id/review/runs/:runId/approve", async (req, reply) => {
		try {
			return approveReviewRun(roomId(req), runIdOf(req));
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});
}
