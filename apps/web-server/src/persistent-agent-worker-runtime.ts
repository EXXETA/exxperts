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
	const created = await createAgentSession({
		cwd: input.cwd,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(input.cwd),
		modelRegistry: registry,
		model,
		...(workerMaxTokens ? { maxTokens: workerMaxTokens } : {}),
		noTools: "all",
		customTools: [],
		rawSystemPrompt: input.workerSystemPrompt,
	});

	let text = "";
	let usage: IsolatedPersistentAgentWorkerResult["usage"];
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let truncated = false;
	try {
		if (created.session.systemPrompt !== input.workerSystemPrompt) {
			throw new Error(`${workerLabel} isolated worker system prompt was not exact`);
		}
		const activeToolNames = created.session.getActiveToolNames();
		if (activeToolNames.length > 0) {
			throw new Error(`${workerLabel} isolated worker has active tools: ${activeToolNames.join(", ")}`);
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
		try {
			await created.session.prompt(input.triggerPrompt);
		} finally {
			input.signal?.removeEventListener("abort", onAbort);
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
