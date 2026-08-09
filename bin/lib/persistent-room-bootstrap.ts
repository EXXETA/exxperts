import fs from "node:fs";

import {
	buildPersistentAgentBootContext,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	getPersistentAgentRuntimeState,
	getPersistentAgentStatus,
	getPersistentAgentThread,
	isPersistentAgentArchived,
	openPersistentAgentPiSessionManager,
	readPersistentAgentBootPromptSnapshot,
	writePersistentAgentThread,
} from "../../apps/web-server/src/persistent-agents.js";
import { buildPersistentRoomRestoredLiveThreadContext } from "../../apps/web-server/src/persistent-room-resume-context.js";
import {
	assertPersistentRoomModelForActiveProfile,
	getPersistentRoomModelLocks,
	persistentAgentModelLocksEqual,
} from "../../apps/web-server/src/persistent-agent-ai-profiles.js";
import { readPersistentAgentAiProfileState } from "../../apps/web-server/src/persistent-agent-ai-profile-state.js";
import {
	getPersistentRoomToolPolicy,
} from "../../apps/web-server/src/persistent-room-tool-policy.js";
import {
	resolvePersistentRoomEffectiveWorkspacePolicy,
	persistentRoomRuntimeCwdForEffectiveWorkspacePolicy,
} from "../../apps/web-server/src/persistent-room-workspace-policy.js";
import { productAppStatePath } from "../../pi-package/product-state-paths.js";

type ModelLock = { provider: string; model: string; label?: string };

const MODEL_SELECTION_FILE = productAppStatePath("web-chat-model.json");

function readStdinJson(): any {
	const raw = fs.readFileSync(0, "utf-8").trim();
	return raw ? JSON.parse(raw) : {};
}

function readPersistentRoomModelSelection(): ModelLock | null {
	try {
		if (!fs.existsSync(MODEL_SELECTION_FILE)) return null;
		const raw = JSON.parse(fs.readFileSync(MODEL_SELECTION_FILE, "utf-8"));
		const provider = String(raw?.provider ?? "").trim();
		const model = String(raw?.model ?? raw?.modelId ?? "").trim();
		return provider && model ? { provider, model } : null;
	} catch {
		return null;
	}
}

function inputModelLock(raw: any): ModelLock | null {
	const provider = String(raw?.provider ?? raw?.modelProvider ?? "").trim();
	const model = String(raw?.model ?? raw?.modelId ?? "").trim();
	const label = String(raw?.label ?? "").trim();
	return provider && model ? { provider, model, ...(label ? { label } : {}) } : null;
}

function selectedRoomModel(threadModel: ModelLock | null, requestedModel: ModelLock | null): { model: ModelLock; source: "thread" | "requested" | "selection" | "profile-default" } {
	const activeProfileId = readPersistentAgentAiProfileState().profileId;
	const locks = getPersistentRoomModelLocks(activeProfileId);
	if (locks.length === 0) throw new Error(`active persistent-agent AI profile ${activeProfileId} has no persistent-room models`);

	if (threadModel) {
		assertPersistentRoomModelForActiveProfile(activeProfileId, threadModel.provider, threadModel.model, "persistent-agent saved thread");
		return { model: threadModel, source: "thread" };
	}

	if (requestedModel) {
		assertPersistentRoomModelForActiveProfile(activeProfileId, requestedModel.provider, requestedModel.model, "persistent-agent requested room model");
		return { model: requestedModel, source: "requested" };
	}

	const saved = readPersistentRoomModelSelection();
	if (saved && locks.some((candidate) => persistentAgentModelLocksEqual(candidate, saved))) {
		return { model: saved, source: "selection" };
	}

	return { model: locks[0], source: "profile-default" };
}

function makeThreadId(): string {
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `cli_${stamp}_${Math.random().toString(36).slice(2, 10)}`;
}

function getDisplayName(status: ReturnType<typeof getPersistentAgentStatus>): string {
	return String(status.displayName || status.id).trim() || status.id;
}

function main() {
	const input = readStdinJson();
	const agentId = String(input?.agentId ?? "").trim();
	if (!agentId) throw new Error("agentId is required");

	const status = getPersistentAgentStatus(agentId);
	if (!status.exists) throw new Error(`persistent agent not found: ${agentId}`);
	if (isPersistentAgentArchived(status)) throw new Error(`persistent agent is archived: ${agentId}`);
	if (status.status !== "ready") throw new Error(`persistent agent is not ready: ${status.status}`);

	const runtime = getPersistentAgentRuntimeState(status.id);
	const threadId = String(input?.threadId || runtime.activeThreadId || makeThreadId()).trim();
	const existingThread = getPersistentAgentThread(status.id, threadId);
	const { model, source: modelSource } = selectedRoomModel(existingThread?.model ?? null, inputModelLock(input?.model));
	const fallbackRuntimeCwd = String(input?.cwd || process.cwd()).trim() || process.cwd();

	const effectiveWorkspacePolicy = resolvePersistentRoomEffectiveWorkspacePolicy(status.id, threadId);
	const runtimeCwd = persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectiveWorkspacePolicy, fallbackRuntimeCwd);
	const workspaceToolsEnabled = effectiveWorkspacePolicy.workspaceToolsEnabled;
	const toolPolicy = getPersistentRoomToolPolicy(status.id, {
		workspaceToolsEnabled,
		workspaceToolNames: effectiveWorkspacePolicy.allowedToolNames,
		workspaceAccessMode: effectiveWorkspacePolicy.workspaceAccessMode,
		bashEnabled: effectiveWorkspacePolicy.bashEnabled,
		bashRuntimeAllowed: true,
	});
	const workspaceCapability = effectiveWorkspacePolicy.capability;

	const bootContext = buildPersistentAgentBootContext({
		agentId: status.id,
		conversationId: threadId,
		sessionId: null,
		model,
		...(workspaceCapability ? { workspaceCapability } : {}),
	});
	const writeResult = writePersistentAgentThread(status.id, threadId, {
		state: "active",
		origin: existingThread?.origin ?? "home",
		model,
		items: existingThread?.items ?? [],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({
			agentId: status.id,
			threadId,
			model,
			cwd: runtimeCwd,
			...(workspaceCapability ? { workspaceCapability } : {}),
		}),
	});

	const threadRuntime = writeResult.thread.runtime;
	const runtimeSummary = threadRuntime.kind === "pi-session-jsonl"
		? (() => {
			const instance = createPersistentAgentInstance(status.id);
			const sessionFilePath = instance.resolveRootRelativePath(threadRuntime.sessionFileRelPath, "persistent-agent Pi session path");
			openPersistentAgentPiSessionManager(status.id, threadRuntime, runtimeCwd);
			const bootPromptSnapshot = readPersistentAgentBootPromptSnapshot(status.id, threadRuntime);
			return {
				kind: "pi-session-jsonl" as const,
				sessionId: threadRuntime.sessionId,
				sessionFileRelPath: threadRuntime.sessionFileRelPath,
				sessionFilePath,
				bootPromptSnapshotRelPath: threadRuntime.bootPromptSnapshotRelPath,
				bootPromptSha256: threadRuntime.bootPromptSha256,
				l1bFingerprint: threadRuntime.l1bFingerprint,
				createdAt: threadRuntime.createdAt,
				...(threadRuntime.leafId ? { leafId: threadRuntime.leafId } : {}),
				bootPromptSnapshot,
			};
		})()
		: (() => {
			const restoredContext = buildPersistentRoomRestoredLiveThreadContext(writeResult.thread.items ?? []);
			return {
				kind: "transcript-recap-v1" as const,
				restoredBlock: restoredContext?.block ?? "",
				restoredMetadata: restoredContext?.metadata ?? null,
			};
		})();

	process.stdout.write(JSON.stringify({
		agentId: status.id,
		displayName: getDisplayName(status),
		threadId,
		model,
		modelSource,
		allowedToolNames: toolPolicy.allowedToolNames,
		workspaceToolsEnabled,
		workspaceAccessMode: effectiveWorkspacePolicy.workspaceAccessMode,
		runtimeCwd,
		workspacePolicySource: effectiveWorkspacePolicy.source,
		workspaceCapability,
		systemPrompt: bootContext.systemPrompt,
		promptBudget: bootContext.promptBudget,
		runtime: runtimeSummary,
		restoredBlock: runtimeSummary.kind === "transcript-recap-v1" ? runtimeSummary.restoredBlock : "",
		restoredMetadata: runtimeSummary.kind === "transcript-recap-v1" ? runtimeSummary.restoredMetadata : null,
	}, null, 2));
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
