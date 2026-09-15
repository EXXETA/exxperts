// The Review's first read and its discussion, over HTTP.
//
// Three routes, the same three Memorize has and in the same order: one read of
// the room's notes, one discussion turn, one sign-off that hands the run what
// the person agreed. None of them writes anything — the notes are read, never
// migrated and never saved, so a person can look at what a tidy would do and
// walk away leaving the room exactly as they found it.
//
// The room's own plumbing comes in as deps, the way the entries API takes
// them: the usable-room check, the error envelope, the maintenance model and
// the one worker seam every maintenance call goes through. That keeps this
// file about the Review and leaves index.ts with one registration line.

import type { FastifyInstance } from "fastify";
import {
	archiveIndex,
	entryTokens,
	isMigratedMemoryDocument,
	MEMORY_SECTIONS,
	parseMemoryDocument,
	renderMemoryDocument,
	reviewTargetTokens,
	type MemoryDocument,
} from "./memory-entries.js";
import { loadMemoryDocument, memoryRoomBusy, readArchive } from "./memory-entries-store.js";
import { createPersistentAgentInstance, fingerprintL1bSource, refuseOversizedMaintenancePrompt } from "./persistent-agents.js";
import {
	buildReviewAssessmentPrompt,
	buildReviewAssessmentRetryPrompt,
	buildReviewDiscussionTurnPrompt,
	buildReviewSignoffPrompt,
	parseReviewAssessment,
	parseReviewGuidance,
	parseReviewRetryFeedback,
	recommendedReviewDepth,
	reviewAvailability,
	reviewMachineFindings,
	withMachineFindings,
	type ReviewAssessmentPromptInput,
	type ReviewDiscussionMessage,
	type ReviewModelLock,
	type ReviewTopicRow,
} from "./review-assess.js";

/** The one sentence a room hears when its notes are too large for the model reading them. */
const REVIEW_OVERFLOW_GUIDANCE =
	"This room's notes are the material being read and cannot be shortened behind the person's back: choose a larger maintenance model in AI setup, then read the notes again.";

const NOTHING_WAS_WRITTEN = "no memory has been written";
const ASSESSMENT_MAX_CHARS = 20_000;
const MESSAGE_MAX_CHARS = 12_000;
const TRANSCRIPT_MAX_CHARS = 80_000;
const TRANSCRIPT_MAX_MESSAGES = 40;

export interface ReviewWorkerOptions {
	thinkingLevel?: "low";
}

export interface ReviewGenerateResult {
	text: string;
	usage?: Record<string, number | undefined>;
}

export interface ReviewAssessRouteDeps {
	/** The room's own maintenance-status check, so these routes refuse exactly like their neighbours. */
	room(idRaw: string): { id: string };
	/** The room routes' error envelope: `{ error, code? }` at the error's own status. */
	errorReply(reply: any, error: unknown): unknown;
	/** The maintenance model, the same one Memorize reads its notes with. */
	modelLock(): ReviewModelLock;
	/** The one isolated worker seam every maintenance call goes through. */
	generate(agentId: string, prompt: string, model: ReviewModelLock, options?: ReviewWorkerOptions): Promise<ReviewGenerateResult>;
	/** The locked model's window, so an oversized read refuses with a remedy instead of a provider error. */
	resolveModelWindow?(model: ReviewModelLock): { contextWindow: number; maxOutputTokens: number } | undefined;
	/**
	 * Whether a tidy is already running in this room. Supplied where the run
	 * lives; without it the first read only refuses for the room's own reasons.
	 */
	reviewRunActive?(agentId: string): boolean;
}

/** Every topic of the room, as the first read and the run both name them. */
function topicRows(doc: MemoryDocument): ReviewTopicRow[] {
	return doc.topics.map((topic) => ({
		title: topic.title,
		section: topic.section,
		notes: topic.entries.length,
		tokens: topic.entries.reduce((total, entry) => total + entryTokens(entry), 0),
	}));
}

/** What every route here reads: the notes as the room reads them, and nothing written back. */
function readNotes(agentId: string, model: ReviewModelLock, deps: ReviewAssessRouteDeps) {
	const l1b = createPersistentAgentInstance(agentId).readL1b();
	// A memory that has never carried note ids is read with them given IN
	// MEMORY, the way the run reads it: a room upgraded from an older version
	// gets its first read like any other, and nothing is written until a save.
	const loaded = loadMemoryDocument(agentId, { migrate: "in-memory" });
	const doc = loaded.doc;
	const topics = topicRows(doc);
	const budget = loaded.budget;
	const availability = reviewAvailability({
		roomBusy: memoryRoomBusy(agentId),
		migrated: true,
		runActive: deps.reviewRunActive?.(agentId) === true,
		topics,
		budgetTokens: budget.budgetTokens,
		reviewTargetTokens: reviewTargetTokens(doc),
	});
	const index = archiveIndex(readArchive(agentId));
	const contextRender = renderMemoryDocument(doc, "context", { entryIds: true, sections: MEMORY_SECTIONS, archiveIndex: index }).trim();
	// What the machine finds on its own, from the memory as loaded: the notes
	// that say one thing and the topics that name one subject. Computed on every
	// read, so a "Read again" and every discussion turn see the memory as it is.
	// The model is never asked to find them.
	const findings = reviewMachineFindings(doc);
	return {
		l1b,
		availability,
		findings,
		promptInput: {
			agentId,
			model,
			contextRender,
			topics,
			budgetTokens: availability.budgetTokens,
			reviewTargetTokens: availability.reviewTargetTokens,
		} satisfies ReviewAssessmentPromptInput,
	};
}

function assertAvailable(availability: { available: boolean; message: string }): void {
	if (availability.available) return;
	const error = new Error(availability.message);
	(error as any).statusCode = 409;
	(error as any).code = "review_unavailable";
	throw error;
}

function parseDiscussionMessages(raw: unknown): ReviewDiscussionMessage[] {
	const messages = Array.isArray(raw) ? raw : [];
	if (messages.length > TRANSCRIPT_MAX_MESSAGES) throw new Error("discussion messages are too large");
	let totalChars = 0;
	return messages.map((message: any, index: number) => {
		const role = String(message?.role ?? "").trim();
		if (role !== "user" && role !== "assistant") throw new Error(`discussion message ${index + 1} role must be user or assistant`);
		const content = String(message?.content ?? "").trim();
		if (!content) throw new Error(`discussion message ${index + 1} content is required`);
		if (content.length > MESSAGE_MAX_CHARS) throw new Error(`discussion message ${index + 1} content is too large`);
		totalChars += content.length;
		if (totalChars > TRANSCRIPT_MAX_CHARS) throw new Error("discussion transcript is too large");
		return { role, content };
	});
}

/**
 * The discussion request: the first read it is about, and the transcript. The
 * last message is the person's latest when they wrote it, so a turn reads the
 * conversation the screen shows rather than a second copy of the same text.
 */
function parseDiscussionRequest(raw: any): { assessmentMarkdown: string; messages: ReviewDiscussionMessage[]; userMessage?: string } {
	const assessmentMarkdown = String(raw?.assessmentMarkdown ?? "").trim();
	if (!assessmentMarkdown) throw new Error("assessmentMarkdown is required");
	if (assessmentMarkdown.length > ASSESSMENT_MAX_CHARS) throw new Error("assessmentMarkdown is too large");
	const messages = parseDiscussionMessages(raw?.messages);
	const last = messages[messages.length - 1];
	if (last?.role === "user") return { assessmentMarkdown, messages: messages.slice(0, -1), userMessage: last.content };
	return { assessmentMarkdown, messages };
}

export function registerReviewAssessRoutes(app: FastifyInstance, deps: ReviewAssessRouteDeps): void {
	// The first read: one model call over the room's notes, answered in the four
	// sections the screen and the run read. A read that comes back missing one of
	// them is asked once more with the reasons, and the better of the two answers
	// is the one the person sees.
	app.post("/api/persistent-agents/:id/review/assess", async (req, reply) => {
		try {
			const { id } = deps.room(String((req.params as any).id ?? "").trim());
			const model = deps.modelLock();
			const notes = readNotes(id, model, deps);
			assertAvailable(notes.availability);
			const retryFeedback = parseReviewRetryFeedback((req.body as any)?.retryFeedback);
			const basePrompt = buildReviewAssessmentPrompt(notes.promptInput);
			const assembly = retryFeedback ? buildReviewAssessmentPrompt({ ...notes.promptInput, retryFeedback }) : basePrompt;
			refuseOversizedMaintenancePrompt({
				agentId: id,
				processLabel: "Review first read",
				model,
				promptEstimatedTokens: assembly.telemetry.promptEstimatedTokens,
				window: deps.resolveModelWindow?.(model),
				guidance: REVIEW_OVERFLOW_GUIDANCE,
			});
			const titles = notes.promptInput.topics.map((topic) => topic.title);
			const warnings: string[] = [];
			let text = (await deps.generate(id, assembly.prompt, model, { thinkingLevel: "low" })).text.trim();
			let parsed = parseReviewAssessment(text, titles);
			const missing = parsed.warnings.filter((warning) => warning.includes("has no"));
			if (missing.length > 0) {
				const retried = (await deps.generate(id, buildReviewAssessmentRetryPrompt(basePrompt.prompt, missing), model, { thinkingLevel: "low" })).text.trim();
				const reparsed = parseReviewAssessment(retried, titles);
				if (retried && reparsed.warnings.length < parsed.warnings.length) {
					text = retried;
					parsed = reparsed;
					warnings.push(`the first read was asked again once (first attempt: ${missing.join("; ")})`);
				} else {
					warnings.push(`the first read was asked again once (first attempt: ${missing.join("; ")}), but the second was not better, so the first is shown`);
				}
			}
			// The machine's findings are filled in after the model's read is parsed,
			// and their topics join "Topics to tidy" so the tidy is handed them.
			const fields = withMachineFindings(parsed.fields, notes.findings, titles);
			return {
				agentId: id,
				writesMemory: false,
				availability: { ...notes.availability, recommendedDepth: recommendedReviewDepth({ overBudget: notes.availability.overBudget, staleOrContradicts: fields.staleOrContradicts, lookAlikeTopics: fields.lookAlikeTopics.length > 0 }) },
				assessmentMarkdown: text,
				fields,
				warnings: [...parsed.warnings, ...warnings, NOTHING_WAS_WRITTEN],
				source: { l1bFingerprint: fingerprintL1bSource(notes.l1b) },
			};
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	// One turn of the discussion. It can talk about the tidy and nothing else:
	// the prompt says so, and this route has no way to start one.
	app.post("/api/persistent-agents/:id/review/discuss", async (req, reply) => {
		try {
			const { id } = deps.room(String((req.params as any).id ?? "").trim());
			const model = deps.modelLock();
			const notes = readNotes(id, model, deps);
			assertAvailable(notes.availability);
			const request = parseDiscussionRequest(req.body ?? {});
			const assembly = buildReviewDiscussionTurnPrompt({ ...notes.promptInput, ...request, saysTheSameTwice: notes.findings.saysTheSameTwice, topicsThatLookTheSame: notes.findings.topicsThatLookTheSame });
			refuseOversizedMaintenancePrompt({
				agentId: id,
				processLabel: "Review discussion",
				model,
				promptEstimatedTokens: assembly.telemetry.promptEstimatedTokens,
				window: deps.resolveModelWindow?.(model),
				guidance: REVIEW_OVERFLOW_GUIDANCE,
			});
			if (!assembly.tokenBudget.canContinue) throw new Error("This discussion has grown too long to carry on. Press Continue to start the tidy with what you have agreed so far.");
			const generated = await deps.generate(id, assembly.prompt, model, { thinkingLevel: "low" });
			return {
				agentId: id,
				writesMemory: false,
				message: { role: "assistant" as const, content: generated.text.trim() },
				tokenBudget: assembly.tokenBudget,
				warnings: [assembly.tokenBudget.state === "soft_warning" ? "this discussion is approaching the length the tidy can carry" : "", NOTHING_WAS_WRITTEN].filter(Boolean),
			};
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});

	// The sign-off: the discussion read back as the six lists the run honours,
	// plus the markdown it came from, so the card can show what was agreed.
	app.post("/api/persistent-agents/:id/review/discuss/signoff", async (req, reply) => {
		try {
			const { id } = deps.room(String((req.params as any).id ?? "").trim());
			const model = deps.modelLock();
			const notes = readNotes(id, model, deps);
			assertAvailable(notes.availability);
			const request = parseDiscussionRequest(req.body ?? {});
			const assembly = buildReviewSignoffPrompt({ ...notes.promptInput, ...request, saysTheSameTwice: notes.findings.saysTheSameTwice, topicsThatLookTheSame: notes.findings.topicsThatLookTheSame });
			refuseOversizedMaintenancePrompt({
				agentId: id,
				processLabel: "Review discussion summary",
				model,
				promptEstimatedTokens: assembly.telemetry.promptEstimatedTokens,
				window: deps.resolveModelWindow?.(model),
				guidance: REVIEW_OVERFLOW_GUIDANCE,
			});
			const generated = await deps.generate(id, assembly.prompt, model, { thinkingLevel: "low" });
			const signoffMarkdown = generated.text.trim();
			if (!signoffMarkdown) throw new Error("the Review discussion summary came back empty");
			return {
				agentId: id,
				writesMemory: false,
				guidance: parseReviewGuidance(signoffMarkdown),
				signoffMarkdown,
				warnings: [NOTHING_WAS_WRITTEN],
			};
		} catch (e) {
			return deps.errorReply(reply, e);
		}
	});
}
