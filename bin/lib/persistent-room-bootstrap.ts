import fs from "node:fs";

import {
	assertPersistentAgentAcceptsSession,
	buildPersistentAgentBootContext,
	clearPersistentAgentUnseenLandedAnswerForBind,
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
import { catalogModelNames, createRoomModelCatalog, isRoomModelOffered, resolveRoomModel, roomModelUnavailableError } from "../../apps/web-server/src/room-models.js";
import {
	getPersistentRoomToolPolicy,
} from "../../apps/web-server/src/persistent-room-tool-policy.js";
import {
	resolvePersistentRoomEffectiveWorkspacePolicy,
	persistentRoomRuntimeCwdForEffectiveWorkspacePolicy,
} from "../../apps/web-server/src/persistent-room-workspace-policy.js";

type ModelLock = { provider: string; model: string; label?: string };


function readStdinJson(): any {
	const raw = fs.readFileSync(0, "utf-8").trim();
	return raw ? JSON.parse(raw) : {};
}

function inputModelLock(raw: any): ModelLock | null {
	const provider = String(raw?.provider ?? raw?.modelProvider ?? "").trim();
	const model = String(raw?.model ?? raw?.modelId ?? "").trim();
	const label = String(raw?.label ?? "").trim();
	return provider && model ? { provider, model, ...(label ? { label } : {}) } : null;
}

// The same resolver the web uses, so a room opened from the CLI runs on the
// same model as from the web: a saved conversation keeps its own lock; a new
// one starts on the model the CLI asked for when it can run, else on the
// room's conversation model, and is refused with the web's sentence while
// that cannot run.
function selectedRoomModel(agentId: string, threadModel: ModelLock | null, requestedModel: ModelLock | null): { model: ModelLock; source: "thread" | "requested" | "room" | "default" | "fallback" } {
	if (threadModel) return { model: threadModel, source: "thread" };
	// The same floor as every stored lock: a model some provider offers rooms.
	// The session the CLI then binds checks the sign-in, as the web bind does.
	if (requestedModel) {
		if (!isRoomModelOffered(requestedModel, "conversation")) throw new Error(`model is not offered to rooms by any provider: ${requestedModel.provider}/${requestedModel.model}`);
		return { model: requestedModel, source: "requested" };
	}
	const catalog = createRoomModelCatalog();
	const resolved = resolveRoomModel(agentId, "conversation", catalog);
	const refusal = roomModelUnavailableError(resolved, "conversation", catalogModelNames(catalog));
	if (refusal) throw refusal;
	if (!resolved.effective || resolved.source === "none") throw new Error("no AI provider is signed in; sign in first (exxperts login), then open the room again");
	return { model: resolved.effective, source: resolved.source };
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
	assertPersistentAgentAcceptsSession(status);

	const runtime = getPersistentAgentRuntimeState(status.id);
	const threadId = String(input?.threadId || runtime.activeThreadId || makeThreadId()).trim();
	const existingThread = getPersistentAgentThread(status.id, threadId);
	const { model, source: modelSource } = selectedRoomModel(status.id, existingThread?.model ?? null, inputModelLock(input?.model));
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

	// The CLI is a door onto the same room: opening a conversation here shows
	// whatever landed unseen in it just as the web app does, so the badge that
	// pointed at it has done its job. Without this the Home card would keep
	// advertising an answer the user already read in the terminal.
	try { clearPersistentAgentUnseenLandedAnswerForBind(status.id, threadId); } catch {}

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
				...(threadRuntime.instructionsFingerprint !== undefined ? { instructionsFingerprint: threadRuntime.instructionsFingerprint } : {}),
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
