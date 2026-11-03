import { type DiscussionTranscriptMessage, type DiscussionTranscriptReduction, DISCUSSION_TRANSCRIPT_REDUCTION_STAGES, reduceDiscussionTranscript, ASSESSMENT_MAX_CHARS, ASSESSMENT_TARGET_WORDS } from "./discussion-handoff.js";
import { type MaintenanceDiagnosticsProcess, recordMaintenanceWorkerCalls } from "./maintenance-diagnostics.js";
import type { AbsorbGenerateResult, CheckpointCompressionGenerateResult, CheckpointModelWindow } from "./persistent-agent-memory-types.js";
import { createPersistentAgentInstance } from "./persistent-agent-store.js";
import { checkpointPromptTokenBudget } from "./persistent-agent-boot.js";

export class MaintenancePromptOverflowError extends Error {
	readonly statusCode = 413;
	readonly promptEstimatedTokens: number;
	readonly promptTokenBudget: number;
	constructor(message: string, promptEstimatedTokens: number, promptTokenBudget: number) {
		super(message);
		this.promptEstimatedTokens = promptEstimatedTokens;
		this.promptTokenBudget = promptTokenBudget;
	}
}

export interface MaintenanceWorkerOptions {
	/**
	 * Assessment builders only: the previous assessment's parse warnings,
	 * sent by the client's "Reassess" action (sanitized like Draft-again
	 * feedback). The assessment prompt repeats them in a Retry Notice.
	 */
	retryFeedback?: string[];
	/**
	 * When provided, the assembled worker prompt is checked against the locked
	 * model's window (same budget formula as the checkpoint/consult workers)
	 * and overflow refuses with guidance instead of running against a provider
	 * error. Custom gateway models may omit window metadata — the guard only
	 * arms on finite numbers; otherwise the worker runs unguarded.
	 */
	resolveModelWindow?: (model: { provider: string; model: string; label?: string }) => CheckpointModelWindow;
}

// Input-side twin of the truncation guard: the room's memory IS the prompt
// material and cannot be elided honestly, so an oversized maintenance prompt
// refuses with guidance instead of erroring at the provider or running
// against a silently degraded read.
/** The prompt budget a maintenance prompt is checked against, or undefined when the window is not known. */
export function maintenancePromptTokenBudget(window: CheckpointModelWindow | undefined, model?: { provider: string; model: string } | null): number | undefined {
	if (window == null || !Number.isFinite(window.contextWindow) || !Number.isFinite(window.maxOutputTokens)) return undefined;
	return checkpointPromptTokenBudget(window, model);
}

export function refuseOversizedMaintenancePrompt(input: {
	agentId: string;
	processLabel: string;
	model: { provider: string; model: string };
	promptEstimatedTokens: number;
	window?: CheckpointModelWindow;
	guidance: string;
}): void {
	const budget = maintenancePromptTokenBudget(input.window, input.model);
	if (budget === undefined || input.promptEstimatedTokens <= budget) return;
	throw new MaintenancePromptOverflowError(
		`the ${input.processLabel} prompt for ${input.agentId} is too large for the locked model ${input.model.provider}/${input.model.model}: ` +
			`~${input.promptEstimatedTokens} estimated tokens exceeds the ~${budget}-token prompt budget. ${input.guidance} No memory has been written.`,
		input.promptEstimatedTokens,
		budget,
	);
}

const ABSORB_OVERFLOW_GUIDANCE =
	"This room's memory is the prompt material and cannot be elided honestly: run Review to shrink stable memory, or choose a Memory model that can read more at once in Room settings, Model, then Memorize again.";

// Draft-again feedback is client input bound for a worker prompt: it should
// only ever carry the validator's own reasons, so flatten to short plain
// lines and cap hard — anything beyond that is not validation feedback.
// Reassess feedback is narrower still: the only legitimate content is the
// assessment parser's own "missing section" findings, so anything else is
// dropped before it can reach a worker prompt.
const ASSESSMENT_RETRY_FEEDBACK = /^assessment missing [A-Za-z][A-Za-z /'-]{1,60}$/;

export function parseAssessmentRetryFeedback(raw: unknown): string[] | undefined {
	const items = (parseProposalRetryFeedback(raw) ?? []).filter((value) => ASSESSMENT_RETRY_FEEDBACK.test(value));
	return items.length ? items : undefined;
}

export function parseProposalRetryFeedback(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const items = raw
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.slice(0, 8)
		.map((value) => (value.length > 300 ? `${value.slice(0, 300)}…` : value));
	return items.length ? items : undefined;
}

/**
 * One diagnostics recorder per maintenance run. It wraps the worker's generate
 * function so every call it makes leaves a content-free record under the room's
 * events, and gives the run a way to say how it ended. `roomText` is the room's
 * own memory: it is never written, only used to check that no validator
 * sentence quoted it back.
 */
function maintenanceDiagnosticsRecorder<TModel extends { provider: string; model: string }, TResult extends { text: string }>(
	agentId: string,
	process: MaintenanceDiagnosticsProcess,
	generate: (prompt: string, model: TModel) => Promise<TResult>,
	options?: { markers?: readonly string[]; roomText?: string },
) {
	return recordMaintenanceWorkerCalls<TModel, TResult>({
		roomRootDir: createPersistentAgentInstance(agentId).rootDir,
		agentId,
		process,
		...(options?.markers ? { markers: options.markers } : {}),
		...(options?.roomText ? { roomText: options.roomText } : {}),
	}, generate);
}

// A worker response cut at the provider's output-token ceiling is not a
// draft with flaws — its tail is simply gone, and the candidate validator
// would blame the document structure for what is a size limit. Refuse before
// parsing, with the truth, so the user sees a limit instead of a loop of
// unwinnable "Draft again" retries.
function refuseTruncatedWorkerOutput(input: {
	agentId: string;
	processLabel: string;
	model: { provider: string; model: string };
	generated: { truncated?: boolean; usage?: { output?: number }; modelMaxOutputTokens?: number };
	/** A remedy sentence for the generic lead — every refusal names a way out (light-pass C1). */
	remedy?: string;
}): void {
	if (!input.generated.truncated) return;
	const produced = input.generated.usage?.output;
	const ceiling = input.generated.modelMaxOutputTokens;
	const numbers = produced
		? ` (the model returned ${produced}${ceiling ? ` of a maximum ${ceiling}` : ""} output tokens)`
		: "";
	console.warn(`[worker-truncated] agent=${input.agentId} process=${input.processLabel} model=${input.model.provider}/${input.model.model} outputTokens=${produced ?? "unknown"} maxOutputTokens=${ceiling ?? "unknown"}`);
	const lead = `The ${input.processLabel} response was cut off at the model's output limit${numbers}.${input.remedy ? ` ${input.remedy}` : ""}`;
	throw new WorkerOutputRefusedError(`${lead} No memory has been written.`, "cut-off");
}

/** A worker's reply refused before anything reads it: cut off at the output limit, or longer than the next step accepts. */
export class WorkerOutputRefusedError extends Error {
	constructor(message: string, readonly reason: "cut-off" | "too-long") {
		super(message);
	}
}

// Discussion prompts (turns and signoff alike) carry the room's memory plus
// the whole discussion. The memory is the material and is never elided; the
// transcript is stepped down the reduction ladder until the prompt fits the
// tighter of the locked model's prompt budget and the discussion hard stop.
// The caller still runs the overflow refusal afterwards — if the tightest
// stage does not fit the window, the step refuses with guidance instead of
// failing at the provider. Stages that would not change the transcript are
// skipped, so the failing path does not rebuild an identical prompt.
function assembleDiscussionPromptWithinBudget<TMessage extends DiscussionTranscriptMessage, TAssembly extends { telemetry: { promptEstimatedTokens: number } }>(input: {
	messages: TMessage[];
	hardStopTokens: number;
	window?: CheckpointModelWindow;
	model?: { provider: string; model: string };
	build: (messages: TMessage[]) => TAssembly;
}): { assembly: TAssembly; reduction: DiscussionTranscriptReduction<TMessage> | null } {
	const window = input.window;
	// The target is the tighter of the locked model's prompt budget and the
	// discussion hard stop: the hard stop is a quality bound (a discussion past
	// ~100k tokens degrades the model that reads it back), so it binds even on
	// models whose window would fit more. Without window metadata (gateway
	// models) the hard stop is the only bound.
	const windowKnown = window != null && Number.isFinite(window.contextWindow) && Number.isFinite(window.maxOutputTokens);
	const target = windowKnown ? Math.min(checkpointPromptTokenBudget(window, input.model), input.hardStopTokens) : input.hardStopTokens;
	let assembly = input.build(input.messages);
	if (assembly.telemetry.promptEstimatedTokens <= target) return { assembly, reduction: null };
	// A stage is skipped only when its transcript is literally the one already
	// built — comparing trim/drop counts is not enough: a tighter per-message
	// cap trims the same set of messages to shorter text, and skipping it would
	// refuse where a trim had worked.
	const sameTranscript = (a: readonly TMessage[], b: readonly TMessage[]): boolean => a.length === b.length && a.every((message, index) => message.content === b[index].content);
	let reduction: DiscussionTranscriptReduction<TMessage> | null = null;
	for (const stage of DISCUSSION_TRANSCRIPT_REDUCTION_STAGES.slice(1)) {
		const candidate = reduceDiscussionTranscript(input.messages, stage);
		if (sameTranscript(candidate.messages, reduction ? reduction.messages : input.messages)) continue;
		reduction = candidate;
		assembly = input.build(reduction.messages);
		if (assembly.telemetry.promptEstimatedTokens <= target) break;
	}
	return { assembly, reduction };
}

// Worker drafts the user reads (assessments, proposals) share one retry
// shape — the checkpoint missing-fields shape: truncation refused first,
// capped at two attempts, usage merged, the retry kept only if it is not
// worse, disclosed via a warning. What counts as a problem, how drafts are
// scored, and whether a still-unacceptable final draft throws or degrades to
// a disclosed warning are the caller's — the loop itself never varies.
// Trimming is wrong here: a trimmed draft diverges the parsed fields from
// the markdown a later step reads.
type AssessmentWorkerResult = { text: string; usage?: AbsorbGenerateResult["usage"]; truncated?: boolean; modelMaxOutputTokens?: number };

function assessmentRetryReasons(text: string, parseWarnings: string[]): string[] {
	const reasons: string[] = [];
	if (text.length > ASSESSMENT_MAX_CHARS) reasons.push(`the assessment was ${text.length} characters long; it must stay under ${ASSESSMENT_MAX_CHARS} characters (about ${ASSESSMENT_TARGET_WORDS} words)`);
	reasons.push(...parseWarnings);
	return reasons;
}

function assessmentDraftScore(text: string, parseWarnings: string[]): number {
	return (text.length > ASSESSMENT_MAX_CHARS ? 100 : 0) + parseWarnings.length;
}

async function generateWorkerDraftWithRetry<TResult extends AssessmentWorkerResult, TParsed>(input: {
	agentId: string;
	processLabel: string;
	/** The prompt actually sent first (may already carry a user-requested Retry Notice). */
	prompt: string;
	/** The same prompt without any Retry Notice — the retry is rebuilt from it so two notices never stack. */
	basePrompt: string;
	/** Reasons the user's redo request sent, repeated in the single merged notice. */
	priorReasons?: string[];
	generate: (prompt: string) => Promise<TResult>;
	/** Truncation refusal — always runs before parsing, on both attempts; a cut-off draft is never scored or retried. */
	refuseTruncated: (generated: TResult) => void;
	parse: (text: string) => TParsed;
	/** Deterministic reasons this draft is not acceptable; any reason triggers the single retry. */
	draftProblems: (text: string, parsed: TParsed) => string[];
	/** Lower is better; the retry replaces the first draft only when not worse. */
	draftScore: (text: string, parsed: TParsed) => number;
	/** Whether the first draft may stand if the retry generation itself fails. */
	draftUsable: (text: string, parsed: TParsed) => boolean;
	buildRetryPrompt: (prompt: string, reasons: string[]) => string;
	/** Disclosure copy — the caller owns the noun ("assessment", "proposal") so warnings stay translatable. */
	copy: {
		regenerated: (firstAttemptReasons: string[]) => string;
		notBetter: (firstAttemptReasons: string[]) => string;
		retryFailed: (message: string) => string;
	};
	/** Console tag for the failed-retry warn line; callers keep their pre-refactor tags so log greps stay stable. */
	logTag?: string;
}): Promise<{ text: string; parsed: TParsed; usage: TResult["usage"]; warnings: string[]; attempts: number; firstAttemptReasons: string[]; retryReasons?: string[] }> {
	const first = await input.generate(input.prompt);
	input.refuseTruncated(first);
	let text = first.text.trim();
	let parsed = input.parse(text);
	let usage = first.usage;
	let attempts = 1;
	const warnings: string[] = [];
	let retryReasons: string[] | undefined;
	const reasons = input.draftProblems(text, parsed);
	if (reasons.length > 0) {
		attempts = 2;
		const firstUsable = input.draftUsable(text, parsed);
		try {
			// A client-sent reason (possibly truncated to 300 chars + "…") that the
			// server re-derives verbatim is listed once, not twice (round-3 C8).
			const prior = (input.priorReasons ?? []).filter((p) => !(p.endsWith("…") && reasons.some((r) => r.startsWith(p.slice(0, -1)))));
			const fresh = reasons.filter((r) => !prior.includes(r));
			const retried = await input.generate(input.buildRetryPrompt(input.basePrompt, [...prior, ...fresh]));
			usage = mergeCheckpointCompressionUsage(usage, retried.usage);
			input.refuseTruncated(retried);
			const retriedText = retried.text.trim();
			const retriedParsed = input.parse(retriedText);
			retryReasons = retriedText ? input.draftProblems(retriedText, retriedParsed) : ["the retry returned an empty reply"];
			if (retriedText && input.draftScore(retriedText, retriedParsed) <= input.draftScore(text, parsed)) {
				text = retriedText;
				parsed = retriedParsed;
				warnings.push(input.copy.regenerated(reasons));
			} else {
				warnings.push(input.copy.notBetter(reasons));
			}
		} catch (error) {
			// A failed retry must not destroy a usable first draft: on main this
			// user saw their draft with a warning, and still does.
			if (!firstUsable) throw error;
			console.warn(`[${input.logTag ?? "worker-draft-retry-failed"}] agent=${input.agentId} process=${input.processLabel}: ${(error as Error).message}`);
			warnings.push(input.copy.retryFailed((error as Error).message.replace(/\s+No memory has been written\.?$/, "")));
		}
	}
	return { text, parsed, usage, warnings, attempts, firstAttemptReasons: reasons, retryReasons };
}

async function generateAssessmentWithRetry<TResult extends AssessmentWorkerResult, TParsed extends { warnings: string[] }>(input: {
	agentId: string;
	processLabel: string;
	model: { provider: string; model: string };
	/** The prompt actually sent first (may already carry a Reassess notice). */
	prompt: string;
	/** The same prompt without any Retry Notice — the retry is rebuilt from it so two notices never stack. */
	basePrompt: string;
	/** Reasons the user's Reassess sent, repeated in the single merged notice. */
	priorReasons?: string[];
	generate: (prompt: string) => Promise<TResult>;
	parse: (text: string) => TParsed;
	buildRetryPrompt: (prompt: string, reasons: string[]) => string;
}): Promise<{ text: string; parsed: TParsed; usage: TResult["usage"]; warnings: string[]; attempts: number }> {
	const draft = await generateWorkerDraftWithRetry({
		...input,
		refuseTruncated: (generated) => refuseTruncatedWorkerOutput({ agentId: input.agentId, processLabel: input.processLabel, model: input.model, generated }),
		draftProblems: (text, parsed) => assessmentRetryReasons(text, parsed.warnings),
		draftScore: (text, parsed) => assessmentDraftScore(text, parsed.warnings),
		draftUsable: (text) => text.length <= ASSESSMENT_MAX_CHARS,
		logTag: "assessment-retry-failed",
		copy: {
			regenerated: (reasons) => `the assessment was regenerated once (first attempt: ${reasons.join("; ")})`,
			notBetter: (reasons) => `the assessment was regenerated once (first attempt: ${reasons.join("; ")}), but the second attempt was not better, so the first is shown`,
			retryFailed: (message) => `the assessment could not be regenerated (${message}), so the first attempt is shown`,
		},
	});
	// Terminal for assessments: an oversized assessment cannot flow to the next
	// step, so this path throws where the proposal path degrades to a warning.
	if (draft.text.length > ASSESSMENT_MAX_CHARS) {
		throw new WorkerOutputRefusedError(
			`The ${input.processLabel} came back at ${draft.text.length} characters after ${draft.attempts} attempt(s), over the ${ASSESSMENT_MAX_CHARS}-character limit the next step accepts. ` +
				`Try Reassess or start Maintain again; if this keeps happening, the maintenance model set in AI setup is writing assessments that are too long and a different one will be needed. No memory has been written.`,
			"too-long",
		);
	}
	return draft;
}

function mergeCheckpointCompressionUsage(a: CheckpointCompressionGenerateResult["usage"], b: CheckpointCompressionGenerateResult["usage"]): CheckpointCompressionGenerateResult["usage"] {
	if (!a) return b;
	if (!b) return a;
	return {
		input: (a.input ?? 0) + (b.input ?? 0),
		output: (a.output ?? 0) + (b.output ?? 0),
		cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
		cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
		totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
		cost: (a.cost ?? 0) + (b.cost ?? 0),
	};
}

export { ABSORB_OVERFLOW_GUIDANCE, assembleDiscussionPromptWithinBudget, generateAssessmentWithRetry, maintenanceDiagnosticsRecorder, mergeCheckpointCompressionUsage, refuseTruncatedWorkerOutput };
