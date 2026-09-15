import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	type CreateAgentSessionOptions,
} from "@exxeta/exxperts-runtime";

type RuntimeModel = NonNullable<CreateAgentSessionOptions["model"]>;

export interface IsolatedPersistentAgentWorkerInput<TModelLock extends { provider: string; model: string }> {
	workerSystemPrompt: string;
	triggerPrompt: string;
	modelLock: TModelLock;
	resolveExpectedModel: (registry: ModelRegistry, modelLock: TModelLock) => RuntimeModel;
	workerLabel?: string;
	emptyTextError: string;
	cwd: string;
	agentDir: string;
	modelRegistry: ModelRegistry;
	/**
	 * Optional live tap on the worker session's event stream (message_update
	 * text deltas and the rest). Strictly additive: when omitted, worker
	 * behavior is byte-identical to before this hook existed.
	 */
	onEvent?: (event: unknown) => void;
	/** Optional abort hook: aborting the signal aborts the worker session's turn. */
	signal?: AbortSignal;
	/**
	 * Hard ceiling on one worker call. When the turn is still running after
	 * this many milliseconds the session is aborted and the call fails with a
	 * turn error that names the timeout, so a maintenance step costs a bounded
	 * amount of time instead of hanging on a stalled stream.
	 */
	timeoutMs?: number;
	/**
	 * Reasoning level for the worker session; omitted, the session inherits the
	 * configured default. A single-shot transform (a fold, an ops proposal, a
	 * checkpoint compression) passes "off": reasoning tokens count against the
	 * output cap and starve the reply the caller is waiting for.
	 */
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
}

export interface IsolatedPersistentAgentWorkerResult {
	text: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: number;
	};
	/** Stop reason of the last assistant message ("stop", "length", "error", "aborted"). */
	stopReason?: string;
	/**
	 * True when any assistant message in the turn stopped on "length": the
	 * provider cut the response at its output-token ceiling and tail content
	 * is silently missing. Callers must not treat truncated text as a
	 * complete draft.
	 */
	truncated?: boolean;
	/** The resolved model's declared output-token ceiling, when known. */
	modelMaxOutputTokens?: number;
}

function textFromMessageParts(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

function workerUsageFromMessageUsage(usage: any): IsolatedPersistentAgentWorkerResult["usage"] | undefined {
	if (!usage) return undefined;
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		totalTokens: usage.totalTokens ?? 0,
		cost: usage.cost?.total ?? 0,
	};
}

/**
 * The worker turn ended without a usable answer. `providerMessage` is the
 * session's own error text (the provider's HTTP failure, an expired sign-in,
 * a refused request); callers and the client translate it into a remedy.
 * It is never the same story as an empty reply.
 */
export class IsolatedPersistentAgentWorkerTurnError extends Error {
	readonly workerLabel: string;
	readonly stopReason: "error" | "aborted";
	readonly providerMessage: string | undefined;
	constructor(workerLabel: string, stopReason: "error" | "aborted", providerMessage: string | undefined) {
		const detail = providerMessage?.trim() || undefined;
		super(stopReason === "aborted"
			? `${workerLabel} was aborted before it answered${detail ? `: ${detail}` : ""}`
			: `${workerLabel} failed: ${detail ?? "the model returned an error without a message"}`);
		this.name = "IsolatedPersistentAgentWorkerTurnError";
		this.workerLabel = workerLabel;
		this.stopReason = stopReason;
		this.providerMessage = detail;
	}
}

/**
 * The ONE decision of what a finished worker turn means, kept pure so it is
 * testable without a session. Order matters: a turn that stopped on "error"
 * or "aborted" is a failure whatever text it collected (partial text before
 * a provider error is not a draft), and only a turn that stopped normally
 * with nothing to show is an "empty reply". Before this existed the session's
 * error event was discarded and every terminal failure — an expired sign-in
 * included — reached the user as "empty reply. Try again" (F1).
 */
export function isolatedPersistentAgentWorkerFailure(input: {
	workerLabel: string;
	text: string;
	stopReason: string | undefined;
	errorMessage: string | undefined;
	emptyTextError: string;
}): Error | undefined {
	if (input.stopReason === "error" || input.stopReason === "aborted") {
		return new IsolatedPersistentAgentWorkerTurnError(input.workerLabel, input.stopReason, input.errorMessage);
	}
	if (!input.text.trim()) return new Error(input.emptyTextError);
	return undefined;
}

export async function runIsolatedPersistentAgentWorker<TModelLock extends { provider: string; model: string }>(
	input: IsolatedPersistentAgentWorkerInput<TModelLock>,
): Promise<IsolatedPersistentAgentWorkerResult> {
	const workerLabel = input.workerLabel ?? "persistent-agent worker";
	const registry = input.modelRegistry;
	const requested = registry.find(input.modelLock.provider, input.modelLock.model);
	const model = input.resolveExpectedModel(registry, input.modelLock);
	if (!requested || requested.provider !== model.provider || requested.id !== model.id) {
		throw new Error(`${workerLabel} must use ${model.provider}/${model.id}`);
	}

	const loader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir: input.agentDir,
		noExtensions: true,
		extensionFactories: [],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();

	// Ask for the model's full declared output ceiling on every request.
	// Without an explicit cap, providers fall back to defaults far below it
	// (Anthropic requests a third of maxTokens; gateways apply their own
	// server default), which is what silently truncated large Memorize/Review
	// rewrites in the field.
	const workerMaxTokens = typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : undefined;
	// A worker session is single-shot: one prompt, one reply, then thrown away.
	// The interactive defaults it would otherwise inherit are all wrong here.
	//
	// autoCompaction: a prompt plus reply that outgrows the window minus the
	// compaction reserve makes the session summarize itself mid-turn — an extra
	// model call whose summary nothing ever reads, because the session is
	// disposed right after. Pure waste, and slow exactly where the room is
	// already struggling.
	//
	// autoRetry / maxRetries: a retry restarts the whole generation from the
	// first token. On a long maintenance reply that is minutes of work paid for
	// again, and the caller above has its own, better-informed retry. One
	// attempt; a failure is reported as a failure.
	//
	// Both switches are session-local: the user's own settings are untouched.
	const created = await createAgentSession({
		cwd: input.cwd,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(input.cwd),
		modelRegistry: registry,
		model,
		...(workerMaxTokens ? { maxTokens: workerMaxTokens } : {}),
		...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
		maxRetries: 0,
		autoCompaction: false,
		autoRetry: false,
		noTools: "all",
		customTools: [],
		rawSystemPrompt: input.workerSystemPrompt,
	});

	let text = "";
	let usage: IsolatedPersistentAgentWorkerResult["usage"];
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let truncated = false;
	let timedOut = false;
	try {
		if (created.session.systemPrompt !== input.workerSystemPrompt) {
			throw new Error(`${workerLabel} isolated worker system prompt was not exact`);
		}
		const activeToolNames = created.session.getActiveToolNames();
		if (activeToolNames.length > 0) {
			throw new Error(`${workerLabel} isolated worker has active tools: ${activeToolNames.join(", ")}`);
		}
		// The single-shot switches are an invariant of this runtime, not a
		// preference: if the plumbing that carries them ever stops arriving,
		// every worker call silently regains a mid-turn summarization pass and
		// a full-generation retry loop. Fail loudly instead.
		if (created.session.autoCompactionEnabled) {
			throw new Error(`${workerLabel} isolated worker session has auto-compaction enabled`);
		}
		if (created.session.autoRetryEnabled) {
			throw new Error(`${workerLabel} isolated worker session has automatic retries enabled`);
		}
		const registeredToolNames = created.session.getAllTools().map((tool) => tool.name);
		if (registeredToolNames.length > 0) {
			throw new Error(`${workerLabel} isolated worker has registered tools: ${registeredToolNames.join(", ")}`);
		}

		created.session.subscribe((event: any) => {
			if (input.onEvent) {
				// A listener failure must never break the worker itself.
				try { input.onEvent(event); } catch {}
			}
			if (event?.type !== "message_end" || event?.message?.role !== "assistant") return;
			if (typeof event.message.stopReason === "string") {
				stopReason = event.message.stopReason;
				if (stopReason === "length") truncated = true;
			}
			// The runtime's error termination is an assistant message with
			// stopReason "error"/"aborted" and the real reason in errorMessage;
			// keep it so the failure can name itself below.
			if (typeof event.message.errorMessage === "string" && event.message.errorMessage.trim()) {
				errorMessage = event.message.errorMessage.trim();
			}
			const partText = textFromMessageParts(event.message.content);
			if (partText) text = [text, partText].filter(Boolean).join("\n\n");
			const messageUsage = workerUsageFromMessageUsage(event.message.usage);
			// Sum across assistant messages so multi-message turns account fully.
			if (messageUsage) {
				usage = usage
					? {
						input: (usage.input ?? 0) + (messageUsage.input ?? 0),
						output: (usage.output ?? 0) + (messageUsage.output ?? 0),
						cacheRead: (usage.cacheRead ?? 0) + (messageUsage.cacheRead ?? 0),
						cacheWrite: (usage.cacheWrite ?? 0) + (messageUsage.cacheWrite ?? 0),
						totalTokens: (usage.totalTokens ?? 0) + (messageUsage.totalTokens ?? 0),
						cost: (usage.cost ?? 0) + (messageUsage.cost ?? 0),
					}
					: messageUsage;
			}
		});
		const onAbort = () => { void Promise.resolve(created.session.abort()).catch(() => {}); };
		if (input.signal) {
			if (input.signal.aborted) onAbort();
			else input.signal.addEventListener("abort", onAbort, { once: true });
		}
		// The hard ceiling rides the same abort path a cancelling user takes, so
		// a stalled provider stream costs one bounded wait instead of hanging the
		// step that is waiting for it.
		const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : undefined;
		const timer = timeoutMs ? setTimeout(() => { timedOut = true; onAbort(); }, timeoutMs) : undefined;
		try {
			await created.session.prompt(input.triggerPrompt);
		} finally {
			if (timer) clearTimeout(timer);
			input.signal?.removeEventListener("abort", onAbort);
		}
		if (timedOut) {
			const seconds = Math.round((timeoutMs ?? 0) / 1000);
			throw new IsolatedPersistentAgentWorkerTurnError(workerLabel, "aborted", `it ran past its ${seconds} second limit and was stopped`);
		}
	} finally {
		try {
			created.session.dispose();
		} catch {
			// Best-effort cleanup only.
		}
	}

	const failure = isolatedPersistentAgentWorkerFailure({ workerLabel, text, stopReason, errorMessage, emptyTextError: input.emptyTextError });
	if (failure) throw failure;
	const modelMaxOutputTokens = typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : undefined;
	return { text, usage, stopReason, truncated, ...(modelMaxOutputTokens ? { modelMaxOutputTokens } : {}) };
}
