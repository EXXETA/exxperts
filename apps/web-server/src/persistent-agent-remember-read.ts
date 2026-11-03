import type { MemoryCallKind } from "./memory-call-cache.js";
import fs from "node:fs";
import { modelTokenFactor, estimateTokens } from "./token-estimate.js";
import { parseCheckpointCompressionFields, type CheckpointCompressionFields, withRetryNotice, nextLowerDensity, CHECKPOINT_CUT_WORD_TARGET, salvageCutCheckpointFields, type CheckpointCompressionPromptTelemetry, CHECKPOINT_PROMPT_TOOL_RESULT_TEXT_CAP, repairCheckpointFields, assembleProposedRecentContext, CHECKPOINT_PAGE_MAX_CHARS, fitCheckpointFields, buildCheckpointProposalPreview, CHECKPOINT_COMPRESSION_WORKER_TYPE, type CheckpointCompressionPromptInput, buildCheckpointCompressionPrompt, CheckpointPromptOverflowError } from "./checkpoint-compression.js";
import { type RememberPromptContext, RememberTooLargeError, rememberShortMemoryView, planRememberParts, withHighLevelLines, buildRememberPageFromNotes, rememberTitleFromWords, rememberDatedTitle, type RememberPartsPlan, buildRememberFinalPrompt, rememberPartsTelemetry, countPartNoteMustKeeps, countBodyMustKeeps, missingKeepRequests, rememberPartCapTokens, type RememberUnreadRange, REMEMBER_PART_TRIGGER, type RememberStretch, buildRememberPartPrompt, rememberPartKeyPrompt, rememberNoLineMessage, REMEMBER_SPLIT_DEPTH, splitRememberStretch, REMEMBER_PART_NOTE_CEILING_TOKENS, buildRememberPartShortenPrompt, REMEMBER_PART_PARALLELISM } from "./remember-two-stage.js";
import { rememberPartKey, readRememberPartNote, keepRememberPartNote } from "./remember-parts-cache.js";
import { conversationForgotten } from "./forget-erase.js";
import { WaitLine, callWithPatience, classifyModelFailure, patienceSpent, failureWords, ModelUnreachableError, unreachableError } from "./model-call-causes.js";
import type { PersistentAgentModelLock } from "./persistent-agent-types.js";
import type { CheckpointCompressionGenerateResult, CheckpointModelWindow, CheckpointProposalOptions, CheckpointProposalResponse, CheckpointRememberRead } from "./persistent-agent-memory-types.js";
import { createPersistentAgentInstance, requestBodyModelLock, validatePersistentAgentId } from "./persistent-agent-store.js";
import { getPersistentAgentThread } from "./persistent-agent-threads.js";
import { isCheckpointDensity, validateApprovedRecentContextDraft } from "./persistent-agent-memory-files.js";
import { CHECKPOINT_PROMPT_MIN_TOKEN_BUDGET, CHECKPOINT_PROMPT_OUTPUT_RESERVE_TOKENS, checkpointPromptRealTokenBudget } from "./persistent-agent-boot.js";
import { assertPersistentAgentAcceptsCheckpoint, getPersistentAgentStatus } from "./persistent-agent-status.js";
import { buildPersistentAgentCheckpointTranscriptSource } from "./persistent-agent-transcript.js";
import { maintenanceDiagnosticsRecorder, mergeCheckpointCompressionUsage } from "./persistent-agent-maintenance-worker.js";

/**
 * The output Remember asks its worker for. Low thinking spends up to 2,048
 * tokens and a rich multi-part entry about 1,800, so 16k is ample, and asking
 * for the model's full ceiling (64k or 128k) would leave a prompt near the
 * budget no room under the window on a provider that adds the two up.
 * Memorize and Review keep the full ceiling: their output scales with memory.
 */
export const REMEMBER_WORKER_MAX_OUTPUT_TOKENS = 16_000;

/**
 * Remember's own prompt budget: the shared one, and never more than what
 * leaves the requested output (plus the same 4k margin) under the window.
 * On every window of 100k and more the shared term is the smaller one, so
 * the budget is unchanged there; the second term binds on small windows.
 * checkpointPromptTokenBudget itself stays as it is: the boot gate, the
 * maintenance checks and consult share it.
 */
export function rememberPromptTokenBudget(window: CheckpointModelWindow, model?: { provider: string; model: string } | null): number {
	const requestedOutput = rememberWorkerMaxOutputTokens(window);
	const underTheWindow = window.contextWindow - requestedOutput - CHECKPOINT_PROMPT_OUTPUT_RESERVE_TOKENS;
	return Math.max(CHECKPOINT_PROMPT_MIN_TOKEN_BUDGET, Math.floor(Math.min(checkpointPromptRealTokenBudget(window), underTheWindow) / modelTokenFactor(model)));
}

/** The output cap Remember's worker asks for: 16k, or the model's own ceiling when that is lower. */
export function rememberWorkerMaxOutputTokens(window: Pick<CheckpointModelWindow, "maxOutputTokens">): number {
	return window.maxOutputTokens > 0 ? Math.min(window.maxOutputTokens, REMEMBER_WORKER_MAX_OUTPUT_TOKENS) : REMEMBER_WORKER_MAX_OUTPUT_TOKENS;
}

/** What one worker call is for, when it is not the single pass or the final call: its trigger line, its label, and the signal that stops it. */
export interface CheckpointWorkerCall {
	trigger?: string;
	workerLabel?: string;
	signal?: AbortSignal;
	/** Which Remember call it is: its prompt cache and its usage row follow it (memory-call-cache.ts). */
	callKind?: MemoryCallKind;
}

export type CheckpointCompressionGenerate = (prompt: string, model: PersistentAgentModelLock, call?: CheckpointWorkerCall) => Promise<CheckpointCompressionGenerateResult>;

export async function buildCheckpointProposal(raw: any, generate: CheckpointCompressionGenerate, options?: CheckpointProposalOptions): Promise<CheckpointProposalResponse> {
	const instance = createPersistentAgentInstance(validatePersistentAgentId(raw?.agentId));
	const status = getPersistentAgentStatus(instance.agentId);
	assertPersistentAgentAcceptsCheckpoint(status);
	const meta = instance.readAgentJson();
	const l1bPath = instance.l1bCurrentPath(meta);
	if (!fs.existsSync(l1bPath)) throw new Error("L1b/current.md is missing");
	const l1b = fs.readFileSync(l1bPath, "utf-8");

	const conversationId = String(raw?.conversationId ?? "").trim();
	if (!conversationId) throw new Error("conversationId is required");

	const model = options?.model ?? requestBodyModelLock(raw);
	// Every call this Remember makes, the single pass, each part and the
	// final call, waits out a busy model the same way, and ends in the one
	// notice (ModelUnreachableError) when the model cannot be reached.
	// Parts read side by side: each keeps its own wait on the dialog's one line.
	const unpatientGenerate = generate;
	const sharedWait = options?.patience?.onWait;
	const waits = sharedWait ? new WaitLine((wait) => sharedWait(wait ?? null)) : null;
	generate = (prompt, modelLock, call) => callWithPatience(() => unpatientGenerate(prompt, modelLock, call), {
		...options?.patience,
		...(waits ? { onWait: waits.call() } : {}),
		model: modelLock,
		...(call?.signal ?? options?.signal ? { signal: call?.signal ?? options?.signal } : {}),
	});

	const densityRaw = String(raw?.density ?? "").trim();
	if (!isCheckpointDensity(densityRaw)) throw new Error("density must be compact, standard, or rich");

	const rememberText = raw?.rememberText == null ? "" : String(raw.rememberText);
	if (rememberText.length > 500) throw new Error("rememberText must be 500 characters or fewer");

	const transcriptSource = buildPersistentAgentCheckpointTranscriptSource({
		agentId: instance.agentId,
		conversationId,
		l1b,
		legacyItems: Array.isArray(raw?.items) ? raw.items : [],
		runtimeCwd: typeof raw?.runtimeCwd === "string" && raw.runtimeCwd.trim() ? raw.runtimeCwd : typeof raw?.cwd === "string" && raw.cwd.trim() ? raw.cwd : process.cwd(),
	});

	const window = options?.resolveModelWindow ? options.resolveModelWindow(model) : undefined;
	const budget = window ? rememberPromptTokenBudget(window, model) : undefined;
	// The room's memory goes in whole when it fits beside the conversation,
	// else as its short view: the read only compares against it, so the page
	// stays correct and may at most repeat a fact.
	const readContext = (memory: string): RememberPromptContext => ({ agentId: instance.agentId, conversationId, model, density: densityRaw, rememberText, l1b: memory });
	let context = readContext(l1b);
	let read: ReturnType<typeof planRememberRead>;
	try {
		read = planRememberRead(context, transcriptSource.items, budget);
	} catch (error) {
		if (!(error instanceof RememberTooLargeError)) throw error;
		context = readContext(rememberShortMemoryView(l1b));
		read = planRememberRead(context, transcriptSource.items, budget);
	}
	const { assembly } = read;
	let plan = read.plan;
	// Parts again, smaller, after the provider refused or counted a call too long.
	const replan = (limits: { maxPartTokens?: number; maxTailTokens?: number }) => planRememberParts(context, transcriptSource.items, budget!, limits);
	options?.onProgress?.({ read: 0, of: plan ? plan.readCount : 1 });
	// The single pass and the final call share this recorder; the kind says which one a call is.
	let compressKind: MemoryCallKind = "remember-single";
	const diagnostics = maintenanceDiagnosticsRecorder(instance.agentId, "remember-compression", (prompt: string, modelLock: PersistentAgentModelLock) => generate(prompt, modelLock, { callKind: compressKind }), { roomText: l1b });

	// The four fields, and a page whatever the model does while it answers.
	// A refused single pass is read in parts instead (below); a refused final
	// call is asked once more at a high level, then the page is put together
	// from the notes. A reply cut at the output cap (or with no BODY) climbs
	// the ladder: the next lower density, a named word target, then what came
	// complete; when no reply held a BODY at all (an answer in prose), a
	// single pass is read in parts and a final call's BODY comes from the
	// notes. A missing TITLE comes from the reply's own words, then the day.
	const now = new Date();
	const refused = (error: unknown) => classifyModelFailure(error).cause === "refused";
	// A prompt the provider counts too long though the estimate let it through.
	const tooLarge = (error: unknown) => classifyModelFailure(error).cause === "too-large";
	// A call the patience gave up on while the model answers the probe, or an
	// empty reply (a reasoning model that spent its output on thinking): a
	// smaller prompt may land, so either goes the way of a too-long one.
	const spentOrEmpty = (error: unknown) => patienceSpent(error) || /produced no text/.test(failureWords(error));
	// Whether the model still answers, by the probe every Remember call's patience gets: no probe
	// keeps the failure as it came, and no answer is the one notice.
	const modelAnswersProbe = async (error: unknown) => {
		const probe = options?.patience?.probe;
		if (!probe) throw error;
		try {
			await probe(options?.signal);
		} catch (probeError) {
			if (options?.signal?.aborted) throw error;
			const probeFailure = classifyModelFailure(probeError, { provider: model.provider });
			if (probeFailure.cause !== "unreachable") throw new ModelUnreachableError("not-answering", model, error);
			const unreachable = await unreachableError(probeFailure.detail, model, probeError);
			// Cancelled while the gateway's list was read: the cancel wins.
			if (options?.signal?.aborted) throw error;
			throw unreachable;
		}
		throwIfRememberCancelled(options?.signal);
	};
	const compress = async (prompt: string, notes: string[] | null) => {
		let usage: CheckpointCompressionGenerateResult["usage"];
		let attempts = 0;
		const retryWarnings: string[] = [];
		const ask = async (text: string) => {
			throwIfRememberCancelled(options?.signal);
			attempts += 1;
			const generated = await diagnostics.generate(text, model);
			usage = mergeCheckpointCompressionUsage(usage, generated.usage);
			return generated;
		};
		let generated: CheckpointCompressionGenerateResult;
		try {
			generated = await ask(prompt);
		} catch (error) {
			if (!notes || !refused(error)) throw error;
			try {
				generated = await ask(withHighLevelLines(prompt));
			} catch (again) {
				if (!refused(again)) throw again;
				retryWarnings.push("the model declined twice to write the entry, so it was put together from the notes");
				return { fields: buildRememberPageFromNotes(notes, now), usage, attempts, retryWarnings, fromNotes: true };
			}
		}
		let fields = parseCheckpointCompressionFields(generated.text).fields;
		let fromNotes = false;
		const isCut = (reply: CheckpointCompressionGenerateResult, parsedFields: CheckpointCompressionFields) => reply.truncated === true || !parsedFields.body;
		if (isCut(generated, fields)) {
			if (generated.truncated) console.warn(`[worker-truncated] agent=${instance.agentId} process=Remember model=${model.provider}/${model.model} outputTokens=${generated.usage?.output ?? "unknown"} maxOutputTokens=${generated.modelMaxOutputTokens ?? "unknown"}`);
			let last = generated;
			let landed = false;
			const earlier = [fields];
			const rungs = [...(densityRaw !== "compact" ? [withRetryNotice(prompt, "cut", nextLowerDensity(densityRaw))] : []), withRetryNotice(prompt, "still-cut", CHECKPOINT_CUT_WORD_TARGET)];
			for (const rung of rungs) {
				try {
					last = await ask(rung);
				} catch (error) {
					// An optional shorter ask: what came complete is kept below.
					if (isAbortError(error) || error instanceof ModelUnreachableError) throw error;
					break;
				}
				fields = parseCheckpointCompressionFields(last.text).fields;
				earlier.push(fields);
				if (!isCut(last, fields)) {
					landed = true;
					break;
				}
			}
			const noBody = !earlier.some((reply) => reply.body.trim());
			if (landed) retryWarnings.push("the first reply was cut off, so the model was asked for a shorter one");
			else if (noBody && !notes && budget != null) throw new RememberNoBodyError();
			else {
				// What the last reply holds, its empty fields taken from an earlier reply that had them.
				const kept = salvageCutCheckpointFields(last.text, last.truncated === true);
				const from = (key: "title" | "sessionArc" | "parked") => kept[key] || earlier.map((reply) => reply[key]).find(Boolean) || "";
				fields = { ...kept, title: from("title"), sessionArc: from("sessionArc"), parked: from("parked") };
				if (noBody && notes) {
					const page = buildRememberPageFromNotes(notes, now);
					fields = { title: fields.title || page.title, sessionArc: fields.sessionArc || page.sessionArc, body: page.body, parked: fields.parked || page.parked };
					fromNotes = true;
				}
				retryWarnings.push(noBody && notes ? "no reply held the entry's body, so it was put together from the notes" : "no reply came complete, so the entry keeps what did");
			}
		}
		// No TITLE: the reply's own words, its arc's first words, its first point's, the day last.
		if (!fields.title) fields.title = rememberTitleFromWords(fields.sessionArc) || rememberTitleFromWords(fields.body) || rememberDatedTitle(now);
		return { fields, usage, attempts, retryWarnings, fromNotes };
	};

	let result: Awaited<ReturnType<typeof compress>> | null = null;
	let finalPrompt = "";
	let targetTokens: { min?: number; max: number } = { max: 0 };
	let telemetry!: CheckpointCompressionPromptTelemetry;
	let rememberRead!: CheckpointRememberRead;
	let unread = 0;
	// The part notes, when the conversation was read in parts.
	let readNotes: string[] = [];
	if (assembly) {
		try {
			result = await compress(assembly.prompt, null);
			finalPrompt = assembly.prompt;
			targetTokens = assembly.targetTokens;
			telemetry = assembly.telemetry;
			rememberRead = {
				mode: "one-pass",
				reads: 1,
				model,
				trimmedToolOutputs: assembly.telemetry.elidedItemCount,
				toolOutputCapChars: CHECKPOINT_PROMPT_TOOL_RESULT_TEXT_CAP,
			};
		} catch (error) {
			// A refused single pass, one the provider calls too long, one that
			// timed out or came back empty, or one answered with no BODY three
			// times, is read again in parts of at most half the transcript.
			// Any other failure is too, once the model answers the probe: a
			// gateway may count the prompt too long in words no rule knows.
			if (budget == null || isAbortError(error) || error instanceof ModelUnreachableError) throw error;
			if (!(refused(error) || tooLarge(error) || spentOrEmpty(error) || error instanceof RememberNoBodyError)) await modelAnswersProbe(error);
			const transcriptTokens = estimateTokens(transcriptSource.items.map((item) => String(item.text ?? "")).join("\n"));
			const limits = { maxPartTokens: Math.ceil(transcriptTokens / 2) };
			try {
				plan = replan(limits);
			} catch (tooSmall) {
				// The parts' note slots do not fit beside the whole memory: its short view, as the final call does.
				if (!(tooSmall instanceof RememberTooLargeError) || context.l1b !== l1b) throw tooSmall;
				context = readContext(rememberShortMemoryView(l1b));
				plan = replan(limits);
			}
			options?.onProgress?.({ read: 0, of: plan.readCount });
		}
	}
	if (!result) {
		let parts = plan!;
		let partsUsage: CheckpointCompressionGenerateResult["usage"];
		// The notes on every part and the final call over them; notes and end
		// too long for the budget by our own count go with the memory's short view.
		const readAndPlan = async (readPlan: RememberPartsPlan) => {
			const notes = await readRememberParts({ agentId: instance.agentId, roomDir: instance.rootDir, conversationId, context, plan: readPlan, generate, model, onProgress: options?.onProgress, signal: options?.signal });
			partsUsage = mergeCheckpointCompressionUsage(partsUsage, notes.usage);
			const input = { notes: notes.notes, parts: readPlan.parts, tail: readPlan.tail, readCount: readPlan.readCount, unread: notes.unread };
			let finalCall = buildRememberFinalPrompt(context, input);
			if (estimateTokens(finalCall.prompt) > readPlan.budget) finalCall = buildRememberFinalPrompt({ ...context, l1b: rememberShortMemoryView(l1b) }, input);
			return { notes, finalCall, fits: estimateTokens(finalCall.prompt) <= readPlan.budget };
		};
		let partsRead = await readAndPlan(parts);
		compressKind = "remember-final";
		// Too long, by our count or the provider's, timed out or empty: once
		// more with the verbatim end halved (the rest read as parts), then the
		// page put together from the notes. Never a failed Remember.
		for (let round = 0; !result; round++) {
			if (partsRead.fits) {
				try {
					result = await compress(partsRead.finalCall.prompt, partsRead.notes.notes);
					break;
				} catch (error) {
					if (!(tooLarge(error) || spentOrEmpty(error))) throw error;
				}
			}
			let smaller: RememberPartsPlan | null = null;
			try {
				if (round === 0) smaller = replan({ maxTailTokens: Math.floor(parts.tailTokens / 2) });
			} catch (error) {
				if (!(error instanceof RememberTooLargeError)) throw error;
			}
			if (!smaller) {
				result = { fields: buildRememberPageFromNotes(partsRead.notes.notes, now), usage: undefined, attempts: 0, retryWarnings: ["the notes and the last part of the conversation were too long for the model together, so this entry was put together from the notes"], fromNotes: true };
				break;
			}
			parts = smaller;
			partsRead = await readAndPlan(parts);
		}
		const { notes: partNotes, finalCall: final } = partsRead;
		unread = partNotes.unread.length;
		readNotes = partNotes.notes;
		finalPrompt = final.prompt;
		result.usage = mergeCheckpointCompressionUsage(partsUsage, result.usage);
		targetTokens = final.targetTokens;
		const trimmedToolOutputs = transcriptSource.items.filter((item) => item.kind === "toolResult" && String(item.text ?? "").trim().length > CHECKPOINT_PROMPT_TOOL_RESULT_TEXT_CAP).length;
		telemetry = rememberPartsTelemetry({ l1b, prompt: final.prompt, tailTranscript: final.tailTranscript, targetTokens, budget: parts.budget, elidedItemCount: trimmedToolOutputs });
		const partMustKeeps = partNotes.notes.reduce((sum, note) => sum + countPartNoteMustKeeps(note), 0);
		const bodyMustKeeps = countBodyMustKeeps(result.fields.body);
		rememberRead = {
			mode: "parts",
			reads: parts.readCount,
			model,
			trimmedToolOutputs,
			toolOutputCapChars: CHECKPOINT_PROMPT_TOOL_RESULT_TEXT_CAP,
			mustKeep: { partNotes: partMustKeeps, body: bodyMustKeeps },
			...(result.fromNotes && unread > 0 && partNotes.notes.every((note) => !note.trim()) ? { refusedWhole: true as const } : {}),
		};
	}
	options?.onProgress?.({ read: rememberRead.reads, of: rememberRead.reads });

	// What Save would refuse is repaired here, before the preview, with no
	// call; only a page over 8,000 characters is asked once more, shorter,
	// then cut at a paragraph end.
	let fields = repairCheckpointFields(result.fields);
	// A title the repair emptied (only markup) is filled as a missing one is, never with a placeholder.
	const titled = (repaired: typeof fields) => (repaired.title ? repaired : { ...repaired, title: rememberTitleFromWords(repaired.sessionArc) || rememberTitleFromWords(repaired.body) || rememberDatedTitle(now) });
	fields = titled(fields);
	if (!result.fromNotes && assembleProposedRecentContext(fields, now).length > CHECKPOINT_PAGE_MAX_CHARS) {
		try {
			throwIfRememberCancelled(options?.signal);
			const shorter = await diagnostics.generate(withRetryNotice(finalPrompt, "too-long", nextLowerDensity(densityRaw)), model);
			result.usage = mergeCheckpointCompressionUsage(result.usage, shorter.usage);
			result.attempts += 1;
			const shorterFields = parseCheckpointCompressionFields(shorter.text).fields;
			if (!shorter.truncated && shorterFields.body) fields = titled(repairCheckpointFields({ ...shorterFields, title: shorterFields.title || fields.title }));
		} catch (error) {
			// An optional shorter ask: the page it had is fitted below.
			if (isAbortError(error) || error instanceof ModelUnreachableError) throw error;
		}
	}
	// Keep-requests the notes quote that the entry lost, put back word for word
	// (at most 2,000 characters of them); they close BODY after the fit, so it never cuts them.
	// How the page was made goes to the diagnostics only, never into the page.
	const keepRequests = missingKeepRequests(readNotes, fields.body).filter((line, index, lines) => lines.slice(0, index + 1).join("\n").length <= 2_000);
	const restored = keepRequests.join("\n");
	const shortened = assembleProposedRecentContext({ ...fields, body: `${fields.body.trimEnd()}${restored ? `\n\n${restored}` : ""}` }, now).length > CHECKPOINT_PAGE_MAX_CHARS;
	fields = fitCheckpointFields(fields, now, restored || undefined);
	const { usage, attempts, retryWarnings } = result;
	const proposedRecentContext = assembleProposedRecentContext(fields, now);
	// The checks Save makes, made now: a page that would fail them is a bug here, not the person's to fix.
	validateApprovedRecentContextDraft(proposedRecentContext);
	const preview = buildCheckpointProposalPreview(fields);
	diagnostics.annotate({ outcome: "accepted", validatorWarnings: [...retryWarnings, ...(unread > 0 ? ["refused-net"] : []), ...(shortened ? ["shortened"] : []), ...(keepRequests.length ? [`keep-requests-restored:${keepRequests.length}`] : [])] });
	return {
		agentId: instance.agentId,
		conversationId,
		sessionId: null,
		writesMemory: false,
		process: {
			type: CHECKPOINT_COMPRESSION_WORKER_TYPE,
			parentConversationId: conversationId,
			model,
		},
		density: densityRaw,
		targetTokens,
		fields,
		preview,
		proposedRecentContext,
		estimatedTokens: estimateTokens(proposedRecentContext),
		compressionTelemetry: telemetry,
		compressionUsage: usage,
		compressionAttempts: attempts,
		rememberRead,
		source: transcriptSource.source,
		// How the entry was made is in the diagnostics (validatorWarnings), never on screen.
		warnings: ["no memory has been written"],
	};
}

/**
 * The single pass's prompt budget: everything but the transcript (the
 * constitution, the memory, the steering), plus at most a part's worth of
 * transcript, and never more than the budget. The cap is on the conversation:
 * a large memory never pushes a short conversation into parts.
 */
function rememberOnePassBudget(context: Omit<CheckpointCompressionPromptInput, "items" | "promptTokenBudget">, budget: number): number {
	const fixed = estimateTokens(buildCheckpointCompressionPrompt({ ...context, items: [] }).prompt);
	return Math.min(budget, fixed + rememberPartCapTokens(budget));
}

/**
 * One pass whenever it fits, parts when it does not (remember-two-stage.ts).
 * A Remember and its estimate both plan here, so the dialog says what Generate does.
 */
function planRememberRead(context: RememberPromptContext, items: CheckpointCompressionPromptInput["items"], budget: number | undefined): { assembly: ReturnType<typeof buildCheckpointCompressionPrompt> | null; plan: RememberPartsPlan | null } {
	try {
		return { assembly: buildCheckpointCompressionPrompt({ ...context, items, ...(budget != null ? { promptTokenBudget: rememberOnePassBudget(context, budget) } : {}) }), plan: null };
	} catch (error) {
		if (!(error instanceof CheckpointPromptOverflowError) || budget == null) throw error;
		return { assembly: null, plan: planRememberParts(context, items, budget) };
	}
}

/** A single pass with no BODY in any reply: it is read in parts instead. */
class RememberNoBodyError extends Error {}

/** How a Remember would read the open conversation now, without calling any model. */
export interface CheckpointReadEstimate {
	mode: "one-pass" | "parts";
	reads: number;
	/** The memory beside the conversation: whole, as its short view, or a window too small for any read. */
	fits: "full" | "short-memory" | "no";
	model: PersistentAgentModelLock;
	contextWindow?: number;
}

/**
 * The same decision buildCheckpointProposal takes, on the same estimator and
 * the same budget, before anything is generated: one pass, or how many parts.
 * Read by the Remember dialog and the context chip's popover when they open,
 * never on the turn path.
 */
export function estimateCheckpointRead(raw: any, options?: CheckpointProposalOptions): CheckpointReadEstimate {
	const instance = createPersistentAgentInstance(validatePersistentAgentId(raw?.agentId));
	const meta = instance.readAgentJson();
	const l1bPath = instance.l1bCurrentPath(meta);
	if (!fs.existsSync(l1bPath)) throw new Error("L1b/current.md is missing");
	const l1b = fs.readFileSync(l1bPath, "utf-8");
	const conversationId = String(raw?.conversationId ?? "").trim();
	if (!conversationId) throw new Error("conversationId is required");
	const thread = getPersistentAgentThread(instance.agentId, conversationId);
	if (!thread) throw new Error(`persistent-agent activeThread not found: ${conversationId}`);
	// A direct caller that names no model gets the conversation's own lock.
	const model = options?.model ?? (raw?.model ? requestBodyModelLock(raw) : thread.model);
	const transcriptSource = buildPersistentAgentCheckpointTranscriptSource({
		agentId: instance.agentId,
		conversationId,
		l1b,
		runtimeCwd: typeof raw?.runtimeCwd === "string" && raw.runtimeCwd.trim() ? raw.runtimeCwd : process.cwd(),
	});
	const window = options?.resolveModelWindow ? options.resolveModelWindow(model) : undefined;
	const budget = window ? rememberPromptTokenBudget(window, model) : undefined;
	const base = { model, ...(window ? { contextWindow: window.contextWindow } : {}) };
	if (budget == null) return { mode: "one-pass", reads: 1, fits: "full", ...base };
	// The same plan a Remember makes: the whole memory, else its short view,
	// else a window too small for anything, said in the dialog before Generate.
	for (const [fits, memory] of [["full", l1b], ["short-memory", rememberShortMemoryView(l1b)]] as const) {
		try {
			const { plan } = planRememberRead({ agentId: instance.agentId, conversationId, model, density: "standard", l1b: memory }, transcriptSource.items, budget);
			return { mode: plan ? "parts" : "one-pass", reads: plan ? plan.readCount : 1, fits, ...base };
		} catch (error) {
			if (!(error instanceof RememberTooLargeError)) throw error;
		}
	}
	return { mode: "parts", reads: 0, fits: "no", ...base };
}

/**
 * Stage A: every part read on its own, at most three at a time, in order of
 * their place in the conversation. A part ends on its own and never stops the
 * others: a reply that fails for no named cause is read once more; a refused
 * one is read again in halves with the high-level lines, and a reply cut at
 * the output limit (or failing twice) in plain halves, down to quarters. A
 * stretch still not read leaves no words in the notes: its messages are
 * returned in `unread`, and the final call is told once that they were not
 * read. Only a cancel or a model that cannot be
 * reached stops every lane, and every note read until then stays in the
 * parts cache, so Generate again pays only for what is missing. A note far
 * over its ceiling is read once more with a shorter instruction; if it is
 * still long, the shorter of the two stays and the final call's budget check
 * decides.
 */
async function readRememberParts(input: {
	agentId: string;
	roomDir: string;
	conversationId: string;
	context: RememberPromptContext;
	plan: RememberPartsPlan;
	generate: CheckpointCompressionGenerate;
	model: PersistentAgentModelLock;
	onProgress?: CheckpointProposalOptions["onProgress"];
	signal?: AbortSignal;
}): Promise<{ notes: string[]; usage: CheckpointCompressionGenerateResult["usage"]; unread: RememberUnreadRange[] }> {
	const { parts, readCount } = input.plan;
	const notes: string[] = new Array(parts.length).fill("");
	let usage: CheckpointCompressionGenerateResult["usage"];
	let done = 0;
	const unread: RememberUnreadRange[] = [];
	const stop = new AbortController();
	// The failure that stopped the parts: the other lanes' aborts race it to the end, and must not pass for a cancel.
	let stoppedBy: unknown;
	const stopParts = (error: unknown): unknown => {
		stoppedBy ??= error;
		stop.abort();
		return error;
	};
	const onCancel = () => stop.abort();
	if (input.signal?.aborted) stop.abort();
	else input.signal?.addEventListener("abort", onCancel, { once: true });
	const call: CheckpointWorkerCall = { trigger: REMEMBER_PART_TRIGGER, workerLabel: "Remember part reader", signal: stop.signal, callKind: "remember-part" };
	// One stretch: a whole part, or a half or quarter of a refused one.
	const readStretch = async (stretch: RememberStretch, partNumber: number, depth: number, highLevel: boolean): Promise<string | null> => {
		const basePrompt = buildRememberPartPrompt(input.context, stretch, partNumber, parts.length);
		const prompt = highLevel ? withHighLevelLines(basePrompt) : basePrompt;
		const key = rememberPartKey({ model: input.model, density: input.context.density, prompt: rememberPartKeyPrompt(input.context, stretch, highLevel) });
		const kept = readRememberPartNote(input.roomDir, input.conversationId, key);
		if (kept) return kept;
		const recorder = maintenanceDiagnosticsRecorder(input.agentId, "remember-part", (text: string, model: PersistentAgentModelLock) => input.generate(text, model, call));
		let note: string | null = null;
		let split: "refused" | "plain" | null = null;
		let cut = "";
		let failed: unknown = new Error("checkpoint compression worker produced no text");
		for (let attempt = 1; attempt <= 2 && note === null && split === null; attempt++) {
			throwIfRememberCancelled(stop.signal);
			try {
				const generated = await recorder.generate(prompt, input.model);
				usage = mergeCheckpointCompressionUsage(usage, generated.usage);
				if (generated.truncated) {
					split = "plain";
					// Its complete lines, kept for a stretch too small to halve.
					cut = generated.text.slice(0, generated.text.lastIndexOf("\n") + 1).trim();
					// Cut before its first line: at the last size this is the stop, and the same model would meet it again.
					if (!cut) failed = new Error(rememberNoLineMessage(input.model));
				} else if (generated.text.trim()) note = generated.text.trim();
			} catch (error) {
				if (isAbortError(error) || stop.signal.aborted) throw error;
				// The model cannot be reached: no part can be read, so the
				// others stop too and the one notice says why.
				if (error instanceof ModelUnreachableError) throw stopParts(error);
				failed = error;
				const failure = classifyModelFailure(error);
				if (failure.cause === "refused") split = "refused";
				// The provider counted it too long (chars/4 undercounts some tokenizers), or the
				// patience already waited a timeout out: halves at once, never the same call again.
				else if (failure.cause === "too-large" || patienceSpent(error) || (failure.cause === "busy" && (failure.detail === "timed-out" || failure.detail === "stalled"))) split = "plain";
			}
		}
		const halves = note === null && depth < REMEMBER_SPLIT_DEPTH ? splitRememberStretch(stretch) : null;
		if (note === null && !halves && cut) note = cut;
		if (note === null) {
			// A refused read that goes on (a high-level read or halves) says so in its record.
			if (split === "refused" && (halves || !highLevel)) recorder.annotate({ outcome: "refused" });
			// A refused stretch with no halves (one short message) is read once more, whole, with the high-level lines.
			if (!halves && split === "refused" && !highLevel) return readStretch(stretch, partNumber, depth, true);
			// Only a refusal may leave a stretch unread; any other failure that outlasts the halves stops Remember.
			if (!halves && split !== "refused") throw stopParts(failed);
			if (!halves) {
				recorder.annotate({ outcome: "refused", validatorWarnings: ["refused-net"] });
				unread.push({ first: stretch.firstIndex + 1, last: stretch.firstIndex + stretch.items.length });
				return null;
			}
			const read: Array<string | null> = [];
			for (const half of halves) read.push(await readStretch(half, partNumber, depth + 1, highLevel || split === "refused"));
			const joined = read.filter((text): text is string => text !== null).join("\n\n") || null;
			// Every half read: the joined notes are kept for the whole stretch too, so Generate again never sends it whole again.
			if (joined && read.every((text) => text !== null)) {
				throwIfRememberCancelled(input.signal);
				if (!conversationForgotten(input.roomDir, input.conversationId)) keepRememberPartNote(input.roomDir, input.conversationId, key, joined);
			}
			return joined;
		}
		const noteTokens = estimateTokens(note);
		if (noteTokens > 2 * REMEMBER_PART_NOTE_CEILING_TOKENS) {
			throwIfRememberCancelled(stop.signal);
			try {
				const shorter = await recorder.generate(buildRememberPartShortenPrompt(prompt, noteTokens), input.model);
				usage = mergeCheckpointCompressionUsage(usage, shorter.usage);
				const text = shorter.text.trim();
				if (!shorter.truncated && text && text.length < note.length) note = text;
			} catch (error) {
				if (isAbortError(error) || stop.signal.aborted) throw error;
				if (error instanceof ModelUnreachableError) throw stopParts(error);
			}
		}
		// A call that answered after Cancel, Save or Forget keeps nothing; one
		// that answered as another lane met an unreachable model is kept.
		throwIfRememberCancelled(input.signal);
		if (conversationForgotten(input.roomDir, input.conversationId)) throw new Error("the conversation was forgotten");
		keepRememberPartNote(input.roomDir, input.conversationId, key, note);
		recorder.annotate({ outcome: "accepted", validatorWarnings: [] });
		return note;
	};
	const readPart = async (index: number): Promise<void> => {
		notes[index] = (await readStretch(parts[index]!, index + 1, 0, false)) ?? "";
		done += 1;
		input.onProgress?.({ read: done, of: readCount });
	};
	let next = 0;
	const lanes = Array.from({ length: Math.min(REMEMBER_PART_PARALLELISM, parts.length) }, async () => {
		while (next < parts.length && !stop.signal.aborted) {
			const index = next;
			next += 1;
			await readPart(index);
		}
		throwIfRememberCancelled(stop.signal);
	});
	try {
		await Promise.all(lanes);
	} catch (error) {
		throw stoppedBy ?? error;
	} finally {
		input.signal?.removeEventListener("abort", onCancel);
	}
	// In the conversation's order, neighbours joined, so the final call reads one span per gap.
	unread.sort((a, b) => a.first - b.first);
	const spans = unread.reduce<RememberUnreadRange[]>((joined, range) => {
		const last = joined.at(-1);
		if (last && range.first <= last.last + 1) last.last = Math.max(last.last, range.last);
		else joined.push({ ...range });
		return joined;
	}, []);
	return { notes, usage, unread: spans };
}

/** Stops a cancelled Remember before its next model call. */
function throwIfRememberCancelled(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const error = new Error("Remember was cancelled. Nothing was saved.");
	error.name = "AbortError";
	throw error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || (error as { stopReason?: string }).stopReason === "aborted");
}
