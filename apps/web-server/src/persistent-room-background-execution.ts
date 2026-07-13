import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	type CreateAgentSessionOptions,
	type ExtensionUIContext,
} from "@exxeta/exxperts-runtime";
import type { BackgroundRunModelLock, BackgroundRunTarget } from "./background-runs.js";
import {
	beginPersistentAgentTurn,
	buildPersistentAgentBootContext,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	finishPersistentAgentTurn,
	getPersistentAgentThread,
	openPersistentAgentPiSessionManager,
	readPersistentAgentBootPromptSnapshot,
	writePersistentAgentThread,
	type PersistentAgentModelLock,
	type PersistentAgentThreadRecord,
} from "./persistent-agents.js";
import { buildPersistentRoomRestoredLiveThreadContext } from "./persistent-room-resume-context.js";
import {
	getPersistentRoomToolPolicy,
} from "./persistent-room-tool-policy.js";
import {
	ensurePersistentRoomThreadEffectiveWorkspacePolicySnapshot,
	persistentRoomRuntimeCwdForEffectiveWorkspacePolicy,
} from "./persistent-room-workspace-policy.js";
import {
	createPersistentRoomWorkspaceTools,
} from "./persistent-room-workspace-tools.js";

import contentPolicyExt from "../../../pi-package/extensions/content-policy/index.js";
import permissionsExt from "../../../pi-package/extensions/permissions/index.js";
import kbExt from "../../../pi-package/extensions/kb/index.js";
import artifactsExt from "../../../pi-package/extensions/artifacts/index.js";
import mcpExt from "../../../pi-package/extensions/mcp/index.js";
import webSearchExt from "../../../pi-package/extensions/web-search/index.js";
import fetchUrlExt from "../../../pi-package/extensions/fetch_url/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.EXXETA_HOME ? path.resolve(process.env.EXXETA_HOME) : path.resolve(__dirname, "..", "..", "..");
const SCHEDULED_ITEM_ID_PATTERN = /[^a-zA-Z0-9_-]+/g;
const LEGACY_RUNTIME_NOT_SUPPORTED = "legacy_runtime_not_supported";

type RuntimeModel = NonNullable<CreateAgentSessionOptions["model"]>;

export interface PersistentRoomBackgroundExecutionInput {
	roomId: string;
	target: BackgroundRunTarget;
	prompt: string;
	executionId: string;
	turnId?: string;
	connectionId?: string;
	cwd?: string;
	agentDir?: string;
	modelRegistry?: ModelRegistry;
	allowLegacyTranscriptRecap?: boolean;
}

export interface PersistentRoomBackgroundExecutionResult {
	roomId: string;
	threadId: string;
	targetKind: "resume-thread" | "fresh-thread";
	model: BackgroundRunModelLock;
	assistantText: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: number;
	};
	items: {
		userItemId: string;
		assistantItemId: string;
	};
	thread: PersistentAgentThreadRecord;
}

interface PreparedPersistentRoomBackgroundExecution {
	roomId: string;
	threadId: string;
	targetKind: "resume-thread" | "fresh-thread";
	modelLock: PersistentAgentModelLock;
	thread: PersistentAgentThreadRecord;
	sessionManager: SessionManager;
	rawSystemPrompt?: string;
	promptPrefix?: string;
	runtimeCwd: string;
	workspaceCapability?: {
		workspaceAccessMode?: "bounded" | "localFiles";
		workspaceLabel: string;
		rootCount: number;
		pathAccess?: "workspace-only" | "local-files";
		availableToolNames: string[];
		writeEnabled: boolean;
		bashEnabled: boolean;
		nativePiFilesystemToolsEnabled?: boolean;
	};
}

function safeExecutionId(value: unknown): string {
	const normalized = String(value ?? "").trim().replace(SCHEDULED_ITEM_ID_PATTERN, "_").slice(0, 96);
	if (!normalized) throw new Error("persistent-room background execution id is required");
	return normalized;
}

export function scheduledPromptBackgroundUserItemId(executionId: string): string {
	return `scheduled-user-${safeExecutionId(executionId)}`;
}

export function scheduledPromptBackgroundAssistantItemId(executionId: string): string {
	return `scheduled-assistant-${safeExecutionId(executionId)}`;
}

export function scheduledPromptBackgroundFailureItemId(executionId: string): string {
	return `scheduled-failure-${safeExecutionId(executionId)}`;
}

export function scheduledPromptBackgroundThreadId(executionId: string): string {
	return `sched_${safeExecutionId(executionId)}`.slice(0, 120);
}

function modelLocksEqual(a: Pick<PersistentAgentModelLock, "provider" | "model">, b: Pick<PersistentAgentModelLock, "provider" | "model">): boolean {
	return a.provider === b.provider && a.model === b.model;
}

function cloneModelLock(model: BackgroundRunModelLock | PersistentAgentModelLock): PersistentAgentModelLock {
	return { provider: model.provider, model: model.model, ...(model.label ? { label: model.label } : {}) };
}

function resolveRuntimeModel(registry: ModelRegistry, modelLock: PersistentAgentModelLock): RuntimeModel {
	const model = registry.find(modelLock.provider, modelLock.model);
	if (!model) throw new Error(`scheduled persistent-room model not found: ${modelLock.provider}/${modelLock.model}`);
	if (!registry.hasConfiguredAuth(model)) throw new Error(`scheduled persistent-room model provider not connected: ${modelLock.provider}`);
	return model;
}

function runtimeModelLock(modelLock: PersistentAgentModelLock, model: RuntimeModel): PersistentAgentModelLock {
	return { provider: modelLock.provider, model: modelLock.model, ...(model.name ? { label: model.name } : modelLock.label ? { label: modelLock.label } : {}) };
}

function textFromMessageParts(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

function usageFromMessageUsage(usage: any): PersistentRoomBackgroundExecutionResult["usage"] | undefined {
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

export function createHeadlessUiContext(rejectMessage = "scheduled background room work cannot answer interactive UI requests"): ExtensionUIContext {
	const rejectInteractive = async () => {
		throw new Error(rejectMessage);
	};
	return {
		select: rejectInteractive,
		confirm: rejectInteractive,
		input: rejectInteractive,
		notify() {},
		setStatus() {},
		setWorkingMessage() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget() {},
		onTerminalInput() { return () => {}; },
	} as unknown as ExtensionUIContext;
}

function upsertItem(items: unknown[], item: Record<string, unknown>): unknown[] {
	const id = String(item.id ?? "");
	if (!id) return [...items, item];
	let replaced = false;
	const next = items.map((existing: any) => {
		if (String(existing?.id ?? "") !== id) return existing;
		replaced = true;
		return { ...existing, ...item };
	});
	return replaced ? next : [...next, item];
}

function appendFailureItem(items: unknown[], executionId: string, message: string): unknown[] {
	return upsertItem(items, {
		kind: "system",
		id: scheduledPromptBackgroundFailureItemId(executionId),
		text: message,
		level: "error",
	});
}

function promptWithRestoredLegacyContext(prompt: string, thread: PersistentAgentThreadRecord): string {
	const restored = buildPersistentRoomRestoredLiveThreadContext(thread.items ?? []);
	if (!restored) return prompt;
	return [restored.block, "", prompt].join("\n");
}

function backgroundBashUnavailablePromptPrefix(bashEnabled: boolean): string | undefined {
	return bashEnabled ? "Background scheduled execution does not have Bash/shell access in this release. Do not use shell commands for this run." : undefined;
}

function backgroundWorkspaceCapability(effectiveWorkspacePolicy: ReturnType<typeof ensurePersistentRoomThreadEffectiveWorkspacePolicySnapshot>) {
	const capability = effectiveWorkspacePolicy.capability;
	if (!capability || capability.availableToolNames.length === 0) return undefined;
	return { ...capability, bashEnabled: false };
}

function preparePersistentRoomBackgroundExecution(input: PersistentRoomBackgroundExecutionInput, modelLock: PersistentAgentModelLock): PreparedPersistentRoomBackgroundExecution {
	const roomId = String(input.roomId ?? "").trim();
	if (!roomId) throw new Error("persistent-room background execution room id is required");
	const fallbackCwd = input.cwd ?? REPO_ROOT;
	if (input.target.kind === "fresh-thread") {
		const threadId = scheduledPromptBackgroundThreadId(input.executionId);
		const effectiveWorkspacePolicy = ensurePersistentRoomThreadEffectiveWorkspacePolicySnapshot(roomId, threadId);
		const runtimeCwd = persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectiveWorkspacePolicy, fallbackCwd);
		const workspaceCapability = backgroundWorkspaceCapability(effectiveWorkspacePolicy);
		const promptPrefix = backgroundBashUnavailablePromptPrefix(effectiveWorkspacePolicy.bashEnabled);
		const write = writePersistentAgentThread(roomId, threadId, {
			state: "standby",
			origin: "home",
			model: modelLock,
			items: [],
		}, {
			createRuntime: ({ instance, threadId: createdThreadId, model }) => createPersistentAgentPiSessionJsonlThreadRuntime({
				agentId: instance.agentId,
				threadId: createdThreadId,
				model,
				cwd: runtimeCwd,
				...(workspaceCapability ? { workspaceCapability } : {}),
			}),
		});
		if (write.thread.runtime.kind !== "pi-session-jsonl") throw new Error("fresh scheduled persistent-room runtime must use Pi session JSONL");
		return {
			roomId,
			threadId,
			targetKind: "fresh-thread",
			modelLock,
			thread: write.thread,
			runtimeCwd,
			sessionManager: openPersistentAgentPiSessionManager(roomId, write.thread.runtime, runtimeCwd),
			rawSystemPrompt: readPersistentAgentBootPromptSnapshot(roomId, write.thread.runtime),
			...(promptPrefix ? { promptPrefix } : {}),
			...(workspaceCapability ? { workspaceCapability } : {}),
		};
	}

	if (input.target.kind !== "resume-thread") throw new Error(`unsupported persistent-room background target: ${input.target.kind}`);
	const threadId = String(input.target.threadId ?? "").trim();
	if (!threadId) throw new Error("resume scheduled persistent-room target is missing thread id");
	const thread = getPersistentAgentThread(roomId, threadId);
	if (!thread || thread.state === "closed") throw new Error(`persistent-room background target thread is missing or closed: ${threadId}`);
	if (!modelLocksEqual(thread.model, modelLock)) {
		throw new Error(`scheduled persistent-room target model mismatch: expected ${thread.model.provider}/${thread.model.model}, got ${modelLock.provider}/${modelLock.model}`);
	}
	const effectiveWorkspacePolicy = ensurePersistentRoomThreadEffectiveWorkspacePolicySnapshot(roomId, threadId);
	const runtimeCwd = persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectiveWorkspacePolicy, fallbackCwd);
	const workspaceCapability = backgroundWorkspaceCapability(effectiveWorkspacePolicy);
	const promptPrefix = backgroundBashUnavailablePromptPrefix(effectiveWorkspacePolicy.bashEnabled);
	if (thread.runtime.kind === "pi-session-jsonl") {
		return {
			roomId,
			threadId,
			targetKind: "resume-thread",
			modelLock: cloneModelLock(thread.model),
			thread,
			runtimeCwd,
			sessionManager: openPersistentAgentPiSessionManager(roomId, thread.runtime, runtimeCwd),
			rawSystemPrompt: readPersistentAgentBootPromptSnapshot(roomId, thread.runtime),
			...(promptPrefix ? { promptPrefix } : {}),
			...(workspaceCapability ? { workspaceCapability } : {}),
		};
	}
	if (thread.runtime.kind === "transcript-recap-v1") {
		if (input.allowLegacyTranscriptRecap === false) {
			const error = new Error("Legacy transcript-recap persistent-room runtime is not supported for scheduled background execution in this worker configuration.");
			(error as any).code = LEGACY_RUNTIME_NOT_SUPPORTED;
			throw error;
		}
		const bootContext = buildPersistentAgentBootContext({
			agentId: roomId,
			conversationId: threadId,
			sessionId: null,
			model: modelLock,
			...(workspaceCapability ? { workspaceCapability } : {}),
		});
		return {
			roomId,
			threadId,
			targetKind: "resume-thread",
			modelLock: cloneModelLock(thread.model),
			thread,
			runtimeCwd,
			sessionManager: SessionManager.inMemory(runtimeCwd),
			rawSystemPrompt: bootContext.systemPrompt,
			promptPrefix: [promptWithRestoredLegacyContext("", thread).trim(), promptPrefix].filter(Boolean).join("\n\n"),
			...(workspaceCapability ? { workspaceCapability } : {}),
		};
	}
	throw new Error(`unsupported persistent-room runtime kind: ${(thread.runtime as any)?.kind ?? "unknown"}`);
}

function createPersistentRoomPermissionsExtension(roomId: string, workspaceToolNames: string[], workspaceToolsEnabled: boolean, workspaceAccessMode: "bounded" | "localFiles") {
	return async (pi: any) => {
		const previousPersistentRoomSession = process.env.EXXETA_PERSISTENT_ROOM_SESSION;
		const previousPersistentRoomAgent = process.env.EXXETA_PERSISTENT_ROOM_AGENT;
		const previousPersistentRoomWorkspaceAccessMode = process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE;
		const previousPersistentRoomWorkspaceTools = process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS;
		const previousPersistentRoomBashEnabled = process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED;
		const previousPersistentRoomExecutionContext = process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT;
		if (workspaceToolsEnabled) {
			process.env.EXXETA_PERSISTENT_ROOM_SESSION = "1";
			process.env.EXXETA_PERSISTENT_ROOM_AGENT = roomId;
			process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE = workspaceAccessMode;
			process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = workspaceToolNames.join(",");
			delete process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED;
			process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT = "background";
		} else {
			delete process.env.EXXETA_PERSISTENT_ROOM_SESSION;
			delete process.env.EXXETA_PERSISTENT_ROOM_AGENT;
			delete process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE;
			delete process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS;
			delete process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED;
			delete process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT;
		}
		try {
			await (permissionsExt as any)(pi);
		} finally {
			if (previousPersistentRoomSession === undefined) delete process.env.EXXETA_PERSISTENT_ROOM_SESSION;
			else process.env.EXXETA_PERSISTENT_ROOM_SESSION = previousPersistentRoomSession;
			if (previousPersistentRoomAgent === undefined) delete process.env.EXXETA_PERSISTENT_ROOM_AGENT;
			else process.env.EXXETA_PERSISTENT_ROOM_AGENT = previousPersistentRoomAgent;
			if (previousPersistentRoomWorkspaceAccessMode === undefined) delete process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE;
			else process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE = previousPersistentRoomWorkspaceAccessMode;
			if (previousPersistentRoomWorkspaceTools === undefined) delete process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS;
			else process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = previousPersistentRoomWorkspaceTools;
			if (previousPersistentRoomBashEnabled === undefined) delete process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED;
			else process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED = previousPersistentRoomBashEnabled;
			if (previousPersistentRoomExecutionContext === undefined) delete process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT;
			else process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT = previousPersistentRoomExecutionContext;
		}
	};
}

async function createPersistentRoomBackgroundSession(input: {
	roomId: string;
	threadId: string;
	model: RuntimeModel;
	prepared: PreparedPersistentRoomBackgroundExecution;
	cwd: string;
	agentDir: string;
	modelRegistry: ModelRegistry;
}) {
	const effectiveWorkspacePolicy = ensurePersistentRoomThreadEffectiveWorkspacePolicySnapshot(input.roomId, input.threadId);
	const workspaceToolNames = effectiveWorkspacePolicy.allowedToolNames;
	const workspaceToolsEnabled = effectiveWorkspacePolicy.workspaceToolsEnabled;
	const toolPolicy = getPersistentRoomToolPolicy(input.roomId, { workspaceToolsEnabled, workspaceToolNames, workspaceAccessMode: effectiveWorkspacePolicy.workspaceAccessMode, bashEnabled: false, bashRuntimeAllowed: false });
	const customTools = workspaceToolsEnabled && effectiveWorkspacePolicy.policy
		? createPersistentRoomWorkspaceTools(effectiveWorkspacePolicy.policy)
		: [];
	const extensionFactories = [
		contentPolicyExt as any,
		createPersistentRoomPermissionsExtension(input.roomId, workspaceToolNames, workspaceToolsEnabled, effectiveWorkspacePolicy.workspaceAccessMode) as any,
		kbExt as any,
		artifactsExt as any,
		mcpExt as any,
		webSearchExt as any,
		fetchUrlExt as any,
	];
	const loader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir: input.agentDir,
		noExtensions: true,
		noContextFiles: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories,
		appendSystemPromptOverride: (base) => base,
	});
	await loader.reload();
	const created = await createAgentSession({
		cwd: input.cwd,
		resourceLoader: loader,
		sessionManager: input.prepared.sessionManager,
		modelRegistry: input.modelRegistry,
		model: input.model,
		...(input.prepared.rawSystemPrompt ? { rawSystemPrompt: input.prepared.rawSystemPrompt } : {}),
		tools: toolPolicy.allowedToolNames,
		...(customTools.length > 0 ? { customTools } : {}),
	});
	await created.session.bindExtensions({ uiContext: createHeadlessUiContext() });
	return created.session;
}

export async function executePersistentRoomBackgroundPrompt(input: PersistentRoomBackgroundExecutionInput): Promise<PersistentRoomBackgroundExecutionResult> {
	const executionId = safeExecutionId(input.executionId);
	const prompt = String(input.prompt ?? "").trim();
	if (!prompt) throw new Error("scheduled persistent-room prompt is empty");
	const targetModel = input.target.model ? cloneModelLock(input.target.model) : null;
	if (!targetModel) throw new Error("scheduled persistent-room execution target is missing model lock");

	const agentDir = input.agentDir ?? getAgentDir();
	const modelRegistry = input.modelRegistry ?? ModelRegistry.create(AuthStorage.create());
	const resolvedModel = resolveRuntimeModel(modelRegistry, targetModel);
	const modelLock = runtimeModelLock(targetModel, resolvedModel);
	const prepared = preparePersistentRoomBackgroundExecution(input, modelLock);
	const userItemId = scheduledPromptBackgroundUserItemId(executionId);
	const assistantItemId = scheduledPromptBackgroundAssistantItemId(executionId);
	let thread = prepared.thread;
	let userItemPersisted = false;
	let assistantText = "";
	let usage: PersistentRoomBackgroundExecutionResult["usage"];
	let terminalReason: "completed" | "failed" = "failed";
	const session = await createPersistentRoomBackgroundSession({
		roomId: prepared.roomId,
		threadId: prepared.threadId,
		model: resolvedModel,
		prepared,
		cwd: prepared.runtimeCwd,
		agentDir,
		modelRegistry,
	});
	const turnId = input.turnId ?? `scheduled_${executionId}`.slice(0, 120);
	const connectionId = input.connectionId ?? `scheduler:${executionId}`.slice(0, 120);
	let activeTurnId: string | undefined;
	try {
		thread = writePersistentAgentThread(prepared.roomId, prepared.threadId, {
			state: thread.state === "active" ? "active" : "standby",
			origin: thread.origin,
			model: prepared.modelLock,
			items: upsertItem(thread.items ?? [], { kind: "user", id: userItemId, text: prompt }),
		}).thread;
		userItemPersisted = true;
		const startedTurn = beginPersistentAgentTurn(prepared.roomId, prepared.threadId, { turnId, connectionId });
		activeTurnId = startedTurn.turnId;
		session.subscribe((event: any) => {
			if (event?.type !== "message_end" || event?.message?.role !== "assistant") return;
			const text = textFromMessageParts(event.message.content);
			if (text) assistantText = [assistantText, text].filter(Boolean).join("\n\n");
			const messageUsage = usageFromMessageUsage(event.message.usage);
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
		const promptText = prepared.promptPrefix ? [prepared.promptPrefix, "", prompt].join("\n") : prompt;
		await session.prompt(promptText);
		if (!assistantText.trim()) throw new Error("scheduled persistent-room execution produced no assistant text");
		terminalReason = "completed";
	} catch (error) {
		if (userItemPersisted) {
			try {
				const current = getPersistentAgentThread(prepared.roomId, prepared.threadId) ?? thread;
				thread = writePersistentAgentThread(prepared.roomId, prepared.threadId, {
					state: current.state === "active" ? "active" : "standby",
					origin: current.origin,
					model: current.model,
					items: appendFailureItem(current.items ?? [], executionId, "Scheduled background task failed before an assistant response was saved."),
				}).thread;
			} catch {
				// Preserve the original execution error. Worker finalization records status.
			}
		}
		throw error;
	} finally {
		if (activeTurnId) {
			try { finishPersistentAgentTurn(prepared.roomId, prepared.threadId, { turnId: activeTurnId, terminalReason }); } catch {}
		}
		try { (session as any)?.dispose?.(); } catch {}
	}

	const current = getPersistentAgentThread(prepared.roomId, prepared.threadId) ?? thread;
	thread = writePersistentAgentThread(prepared.roomId, prepared.threadId, {
		state: "standby",
		origin: current.origin,
		model: current.model,
		items: upsertItem(current.items ?? [], { kind: "assistant", id: assistantItemId, text: assistantText.trim(), streaming: false }),
	}, {
		// The model already ran and its tokens are already spent; this write only lands the paid
		// answer under the thread's existing lock. A profile switch mid-generation must not turn
		// it into a failed run with the answer discarded. Prompting/resume keep full enforcement.
		allowInactiveProfileModel: true,
	}).thread;
	return {
		roomId: prepared.roomId,
		threadId: prepared.threadId,
		targetKind: prepared.targetKind,
		model: cloneModelLock(prepared.modelLock),
		assistantText: assistantText.trim(),
		...(usage ? { usage } : {}),
		items: { userItemId, assistantItemId },
		thread,
	};
}
