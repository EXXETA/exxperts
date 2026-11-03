import { type UsageRow, appendUsage, type UsageKind, resolveUsageAuthType } from "./usage-log.js";
import type { MemoryCallKind } from "./memory-call-cache.js";
import { providerFailureLogFields } from "./model-call-causes.js";
import { app } from "./server-app.js";
import { getWebChatModelRegistry, webChatModelLabel, webChatProviderLabel } from "./ai-models.js";

// --- usage tracking -----------------------------------------------------
//
// Every assistant message_end event carries a `usage` object
// ({input, output, cacheRead, cacheWrite, cost}). We append one line per
// turn to ~/.exxperts/app/usage.jsonl with the agent + persona context, then
// expose aggregations on /api/usage for the dashboard.

// Row shape + append/load live in usage-log.ts so background spend paths
// (upkeep workers, HiveMind, scheduled runs) share the same ledger.

/** Ledger write with the server log attached for append failures. */
function recordUsage(row: UsageRow): void {
	appendUsage(row, (message) => app.log.warn(message));
}

/** One log line per failed provider call, codes only (providerFailureLogFields); none for a cancelled one. */
function logProviderCallFailed(call: { room?: string; callKind?: string; provider: string; model?: string }, error: unknown): void {
	const fields = providerFailureLogFields(error, call.provider);
	if (fields) app.log.warn({ ...call, ...fields }, "provider call failed");
}

/**
 * Account a background worker turn (memory upkeep, HiveMind) to the ledger.
 * The worker just completed against modelLock, so the provider was
 * necessarily authenticated — authType resolution can assume configured.
 */
function recordWorkerUsage(
	agent: string,
	kind: UsageKind,
	modelLock: { provider: string; model: string },
	usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number } | undefined,
	callKind?: MemoryCallKind,
): void {
	if (!usage) return;
	let modelLabel: string | undefined;
	try {
		const model = getWebChatModelRegistry().find(modelLock.provider, modelLock.model);
		modelLabel = model ? webChatModelLabel(modelLock.provider, model) : `${webChatProviderLabel(modelLock.provider)} — ${modelLock.model}`;
	} catch {
		modelLabel = undefined;
	}
	recordUsage({
		ts: Date.now(),
		agent,
		persona: "business",
		model: modelLock.model,
		modelLabel,
		provider: modelLock.provider,
		authType: resolveUsageAuthType(modelLock.provider, true),
		kind,
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		cost: usage.cost ?? 0,
		...(callKind ? { callKind } : {}),
	});
}

function safeConversationId(raw: string): string | null {
	const id = String(raw || "").trim();
	return /^[a-zA-Z0-9_-]{8,80}$/.test(id) ? id : null;
}

export { logProviderCallFailed, recordUsage, recordWorkerUsage, safeConversationId };
