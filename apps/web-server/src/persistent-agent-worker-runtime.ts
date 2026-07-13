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

	const created = await createAgentSession({
		cwd: input.cwd,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(input.cwd),
		modelRegistry: registry,
		model,
		noTools: "all",
		customTools: [],
		rawSystemPrompt: input.workerSystemPrompt,
	});

	let text = "";
	let usage: IsolatedPersistentAgentWorkerResult["usage"];
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

	if (!text.trim()) throw new Error(input.emptyTextError);
	return { text, usage };
}
