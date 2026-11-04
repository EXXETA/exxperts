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
	buildPersistentAgentCurrentIdentitySection,
	buildPersistentRoomCurrentWorkspaceSection,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	createPersistentRoomAutoDeclinedQuestionLog,
	finishPersistentAgentTurn,
	getPersistentAgentThread,
	openPersistentAgentPiSessionManager,
	readPersistentAgentBootPromptSnapshot,
	writePersistentAgentThread,
	type PersistentAgentModelLock,
	type PersistentAgentThreadRecord,
} from "./persistent-agents.js";
import { rememberSentenceModelName } from "./checkpoint-compression.js";
import { modelNotOnAccount, modelNotOnAccountSentence } from "./model-not-on-account.js";
import { buildPersistentRoomRestoredLiveThreadContext } from "./persistent-room-resume-context.js";
import { createTurnStepLog, landedTextAfter } from "./persistent-room-turn-steps.js";
import { readPersistentRoomInstructionsNow } from "./persistent-room-instructions.js";
import { nextRoomStateMessage } from "./room-state-message.js";
import {
	getPersistentRoomToolPolicy,
	PERSISTENT_ROOM_MEMORY_TOOL_NAMES,
	PERSISTENT_ROOM_SHELF_TOOL_NAMES,
} from "./persistent-room-tool-policy.js";
import {
	resolvePersistentRoomEffectiveWorkspacePolicy,
	persistentRoomRuntimeCwdForEffectiveWorkspacePolicy,
} from "./persistent-room-workspace-policy.js";
import {
	createPersistentRoomWorkspaceTools,
} from "./persistent-room-workspace-tools.js";

import contentPolicyExt from "../../../pi-package/extensions/content-policy/index.js";
import permissionsExt from "../../../pi-package/extensions/permissions/index.js";
import artifactsExt from "../../../pi-package/extensions/artifacts/index.js";
import { createRoomScopedMcpExtension } from "../../../pi-package/extensions/mcp/index.js";
import webSearchExt from "../../../pi-package/extensions/web-search/index.js";
import { createNativeProviderSearchExtension, resolveNativeProviderSearchDecision, shouldRegisterClientWebSearch } from "../../../pi-package/extensions/web-search/native-provider-search.js";
import fetchUrlExt from "../../../pi-package/extensions/fetch_url/index.js";
import toolResultAgingExt from "../../../pi-package/extensions/tool-result-aging/index.js";
import { keepAppTurnFailure } from "./failed-prompt-step-back.js";
import { SERVER_STOPPED_REASON, STOP_SCHEDULED_RUN_SENTENCE, answerAlreadyEnded, trackRunningWork } from "./server-stop.js";
import { callCacheRetention } from "./memory-call-cache.js";
import { roomLoaderSettings } from "./room-loader-settings.js";
import { serverHooks } from "./server-hooks.js";
import { settleConversationEffortChoice } from "./persistent-room-effort-settings.js";

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
	/** Ends the turn as a server stop does; its reason, an Error with a code, is the run's line and code. */
	signal?: AbortSignal;
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
	/** Titles of the dialogs the headless context answered for the user, deduplicated, in the order they came up. */
	declinedQuestions?: string[];
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

const SCHEDULED_USER_ITEM_PREFIX = "scheduled-user-";

export function scheduledPromptBackgroundUserItemId(executionId: string): string {
	return `${SCHEDULED_USER_ITEM_PREFIX}${safeExecutionId(executionId)}`;
}

/** Whether a conversation's last message on the person's side is a scheduled run's prompt: sent by the app, never handed to the person. */
export function lastUserItemIsScheduledPrompt(items: ReadonlyArray<unknown> | undefined): boolean {
	const lastUser = [...(items ?? [])].reverse().find((item) => (item as { kind?: unknown } | null)?.kind === "user") as { id?: unknown } | undefined;
	return typeof lastUser?.id === "string" && lastUser.id.startsWith(SCHEDULED_USER_ITEM_PREFIX);
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

/** A dialog that was answered for the user because the run had nobody watching it. */
export interface HeadlessUiAutoDeclinedQuestion {
	kind: "confirm" | "select" | "input";
	title: string;
}

export function createHeadlessUiContext(
	rejectMessage = "scheduled background room work cannot answer interactive UI requests",
	onAutoDecline?: (question: HeadlessUiAutoDeclinedQuestion) => void,
): ExtensionUIContext {
	// Every dialog kind takes the question title first. Report it before the
	// rejection so the run can write the note into the thread; bookkeeping must
	// never change what the asking tool sees, so a throwing listener is swallowed.
	const rejectInteractive = (kind: HeadlessUiAutoDeclinedQuestion["kind"]) => async (title?: string) => {
		if (onAutoDecline) {
			try { onAutoDecline({ kind, title: String(title ?? "") }); } catch {}
		}
		throw new Error(rejectMessage);
	};
	return {
		select: rejectInteractive("select"),
		confirm: rejectInteractive("confirm"),
		input: rejectInteractive("input"),
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

// A background run has nobody to answer a dialog, so the headless context
// declines it and the asking tool fails. The run itself must say so in the
// transcript, deterministically, instead of hoping the answer mentions it.
export function scheduledPromptBackgroundDeclinedQuestionItemIdPrefix(executionId: string): string {
	return `scheduled-declined-${safeExecutionId(executionId)}`;
}

/**
 * The provider refused the room's model for this account (its plan, its
 * admin): the run fails with the plain sentence and its own code, which the
 * Scheduled tasks pane says in the same words. The raw words stay out.
 */
export class ScheduledModelNotOnAccountError extends Error {
	readonly code = "model_not_on_account";
	constructor(model: { provider: string; model: string; label?: string }) {
		super(modelNotOnAccountSentence(rememberSentenceModelName(model), model.provider));
		this.name = "ScheduledModelNotOnAccountError";
	}
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
	// Never trusts a streaming mark, and not by accident of call ordering. A
	// background run restores a thread written before it started, and the only
	// turn it will ever hold is its own, which has not written any of these
	// items. So every mark in here belongs to a session that stopped writing,
	// whether it finished cleanly or the browser was closed on top of it.
	const restored = buildPersistentRoomRestoredLiveThreadContext(thread.items ?? [], false);
	if (!restored) return prompt;
	return [restored.block, "", prompt].join("\n");
}

function backgroundBashUnavailablePromptPrefix(bashEnabled: boolean): string | undefined {
	return bashEnabled ? "Background scheduled execution does not have Bash/shell access in this release. Do not use shell commands for this run." : undefined;
}

function backgroundWorkspaceCapability(effectiveWorkspacePolicy: ReturnType<typeof resolvePersistentRoomEffectiveWorkspacePolicy>) {
	const capability = effectiveWorkspacePolicy.capability;
	if (!capability || capability.availableToolNames.length === 0) return undefined;
	return { ...capability, bashEnabled: false };
}

export function preparePersistentRoomBackgroundExecution(input: PersistentRoomBackgroundExecutionInput, modelLock: PersistentAgentModelLock): PreparedPersistentRoomBackgroundExecution {
	const roomId = String(input.roomId ?? "").trim();
	if (!roomId) throw new Error("persistent-room background execution room id is required");
	const fallbackCwd = input.cwd ?? REPO_ROOT;
	if (input.target.kind === "fresh-thread") {
		const threadId = scheduledPromptBackgroundThreadId(input.executionId);
		const effectiveWorkspacePolicy = resolvePersistentRoomEffectiveWorkspacePolicy(roomId, threadId);
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
	const effectiveWorkspacePolicy = resolvePersistentRoomEffectiveWorkspacePolicy(roomId, threadId);
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
			// A resumed thread runs on its frozen boot snapshot, as a live turn
			// does; the instructions the user changed since ride the room-state
			// message (createRoomStateExtension), so a scheduled turn follows the
			// current text too.
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

/** Shelf tools and the memory archive read are live-session custom tools; no
 * such tool object is ever registered for a background run, so their names
 * would sit inert in the allowlist. The mcp proxy IS registered here
 * (room-scoped extension), so it stays. */
export function persistentRoomBackgroundSessionToolNames(allowedToolNames: readonly string[]): string[] {
	const liveOnlyToolNames = new Set<string>([...PERSISTENT_ROOM_SHELF_TOOL_NAMES, ...PERSISTENT_ROOM_MEMORY_TOOL_NAMES]);
	return allowedToolNames.filter((toolName) => !liveOnlyToolNames.has(toolName));
}

/**
 * The room-state message a live turn sends (room-state-message.ts), with what
 * a background run can use: who the room is, the instructions in force and
 * its workspace, which never has bash here. It has no skills or Attachments tools,
 * so their parts are left out; the next live turn's copy differs and is sent
 * whole. The run's copy is saved to the thread, so a live turn after it reads
 * the latest state from the session as it does after its own turns.
 */
function createRoomStateExtension(roomId: string, thread: PersistentAgentThreadRecord, workspacePolicy: Parameters<typeof buildPersistentRoomCurrentWorkspaceSection>[0]) {
	const bootedFingerprint = thread.runtime.kind === "pi-session-jsonl" ? thread.runtime.instructionsFingerprint : undefined;
	return (pi: any) => {
		pi.on("before_agent_start", async (event: { systemPrompt: string }, ctx: { sessionManager: SessionManager }) => {
			let workspace: string | null = null;
			try {
				workspace = buildPersistentRoomCurrentWorkspaceSection(workspacePolicy, { scheduled: true });
			} catch (error) {
				console.warn(`scheduled run: current workspace section build failed: ${(error as Error)?.message ?? error}`);
			}
			const message = nextRoomStateMessage({
				identity: buildPersistentAgentCurrentIdentitySection(roomId),
				instructions: readPersistentRoomInstructionsNow(roomId, event.systemPrompt, bootedFingerprint !== undefined ? { bootedFingerprint } : {}),
				workspace,
			}, ctx.sessionManager);
			return message ? { message } : undefined;
		});
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
	onAutoDecline?: (question: HeadlessUiAutoDeclinedQuestion) => void;
}) {
	const effectiveWorkspacePolicy = resolvePersistentRoomEffectiveWorkspacePolicy(input.roomId, input.threadId);
	const workspaceToolNames = effectiveWorkspacePolicy.allowedToolNames;
	const workspaceToolsEnabled = effectiveWorkspacePolicy.workspaceToolsEnabled;
	const toolPolicy = getPersistentRoomToolPolicy(input.roomId, { workspaceToolsEnabled, workspaceToolNames, workspaceAccessMode: effectiveWorkspacePolicy.workspaceAccessMode, bashEnabled: false, bashRuntimeAllowed: false });
	const backgroundToolNames = persistentRoomBackgroundSessionToolNames(toolPolicy.allowedToolNames);
	const customTools = workspaceToolsEnabled && effectiveWorkspacePolicy.policy
		// Same file tools as the live bind, bound to the session cwd this run
		// binds with. It never has bash or the skills folder, and its refusals say so.
		? createPersistentRoomWorkspaceTools(effectiveWorkspacePolicy.policy, { localFilesCwd: input.cwd, background: true })
		: [];
	const customToolNames = new Set(customTools.map((tool) => String(tool.name)));
	if (customToolNames.size !== workspaceToolNames.length || !workspaceToolNames.every((toolName) => customToolNames.has(toolName))) {
		throw new Error("persistent-room workspace tool policy mismatch");
	}
	// One read for the whole run, which is also the whole binding: a background
	// run is a single turn and finishes under the rule it started with.
	const nativeSearchDecision = resolveNativeProviderSearchDecision(input.model.provider);
	const extensionFactories = [
		contentPolicyExt as any,
		createPersistentRoomPermissionsExtension(input.roomId, workspaceToolNames, workspaceToolsEnabled, effectiveWorkspacePolicy.workspaceAccessMode) as any,
		artifactsExt as any,
		// Per-room MCP: scheduled and detached background runs inherit the
		// room's connector grants through the same shared wrapper as live turns.
		createRoomScopedMcpExtension(input.roomId) as any,
		// Same rule as a live turn, and the same reason: the provider's own
		// search is called web_search too, so only one of the two is offered. A
		// background run is a single bind, so reading the setting here is reading
		// it for the whole run.
		...(shouldRegisterClientWebSearch(nativeSearchDecision) ? [webSearchExt as any] : []),
		createNativeProviderSearchExtension(nativeSearchDecision) as any,
		fetchUrlExt as any,
		// A scheduled or detached run replays the same room history a live turn
		// does, so it ages that history by the same rule. Registering it in only
		// one of the two factories would make the two kinds of run send
		// different context for the same room.
		toolResultAgingExt as any,
		createRoomStateExtension(input.roomId, input.prepared.thread, { ...effectiveWorkspacePolicy, capability: backgroundWorkspaceCapability(effectiveWorkspacePolicy) }),
	];
	const loader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir: input.agentDir,
		settingsManager: roomLoaderSettings(input.cwd, input.agentDir),
		noExtensions: true,
		noContextFiles: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories,
		appendSystemPromptOverride: (base) => base,
	});
	await loader.reload();
	// A scheduled answer thinks as a live one would in this conversation: at
	// its own level, else the room's default, which a conversation with no
	// level of its own (a fresh one, its first message) takes as its own here.
	// The session clamps it to the model; with no level anywhere it resolves its
	// own, and the conversation keeps that one.
	const thinkingLevel = settleConversationEffortChoice(input.roomId, input.threadId);
	const created = await createAgentSession({
		cwd: input.cwd,
		resourceLoader: loader,
		sessionManager: input.prepared.sessionManager,
		modelRegistry: input.modelRegistry,
		model: input.model,
		...(thinkingLevel ? { thinkingLevel } : {}),
		cacheRetention: callCacheRetention("scheduled", input.model),
		...(input.prepared.rawSystemPrompt ? { rawSystemPrompt: input.prepared.rawSystemPrompt } : {}),
		tools: backgroundToolNames,
		...(customTools.length > 0 ? { customTools } : {}),
	});
	if (!thinkingLevel) settleConversationEffortChoice(input.roomId, input.threadId, created.session.thinkingLevel);
	await created.session.bindExtensions({ uiContext: createHeadlessUiContext(undefined, input.onAutoDecline) });
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
	// The text before a failed attempt the runtime asks again: the retry's text takes the place of the attempt's.
	let retryFrom: string | undefined;
	let providerRefusal = "";
	let usage: PersistentRoomBackgroundExecutionResult["usage"];
	let terminalReason: "completed" | "failed" = "failed";
	const autoDeclinedQuestions = createPersistentRoomAutoDeclinedQuestionLog();
	const steps = createTurnStepLog();
	// Each step is upserted by its own id, so a run landed twice keeps one copy, before the answer.
	const withSteps = (items: unknown[]): unknown[] => steps.items(`scheduled-step-${executionId}`).reduce<unknown[]>((acc, step) => upsertItem(acc, { ...step }), items);
	const declinedQuestionItemIdPrefix = scheduledPromptBackgroundDeclinedQuestionItemIdPrefix(executionId);
	// Bookkeeping must never cost the answer (or the honest failure note): the
	// landed text is the paid result of this run, the away-notes sit on top of
	// it. A throw in the note pass gives back the items it was handed.
	const noteItemsOrJustTheItems = (items: unknown[]): unknown[] => {
		try {
			return autoDeclinedQuestions.appendItems(items, declinedQuestionItemIdPrefix);
		} catch (error) {
			console.warn(`failed to append auto-declined question notes for scheduled execution ${executionId}: ${(error as Error)?.message ?? error}`);
			return items;
		}
	};
	const session = await createPersistentRoomBackgroundSession({
		roomId: prepared.roomId,
		threadId: prepared.threadId,
		model: resolvedModel,
		prepared,
		cwd: prepared.runtimeCwd,
		agentDir,
		modelRegistry,
		onAutoDecline: (question) => autoDeclinedQuestions.note(question),
	});
	const turnId = input.turnId ?? `scheduled_${executionId}`.slice(0, 120);
	const connectionId = input.connectionId ?? `scheduler:${executionId}`.slice(0, 120);
	let activeTurnId: string | undefined;
	// Set when a server stop or the input's signal ends this turn: the run then ends with that error's line and code.
	let endedBy: Error | undefined;
	let releaseStopWork: (() => void) | undefined;
	// A resumed conversation ends on the last turn's answer, which must not count as this turn's.
	let answeredThisTurn = false;
	const endTurn = (reason: Error) => {
		// An answer that already ended is left to finish while the runtime's post-turn work runs: the run completed.
		if (endedBy || (answeredThisTurn && answerAlreadyEnded(session.agent.state.messages))) return;
		endedBy = reason;
		// The compaction a resumed conversation may run before the prompt is cut too.
		session.abortCompaction();
		void Promise.resolve((session as any)?.abort?.()).catch(() => {});
	};
	const endBySignal = () => endTurn(input.signal!.reason);
	try {
		thread = writePersistentAgentThread(prepared.roomId, prepared.threadId, {
			state: thread.state === "active" ? "active" : "standby",
			origin: thread.origin,
			model: prepared.modelLock,
			items: upsertItem(thread.items ?? [], { kind: "user", id: userItemId, text: prompt, ts: Date.now() }),
		}).thread;
		userItemPersisted = true;
		const startedTurn = beginPersistentAgentTurn(prepared.roomId, prepared.threadId, { turnId, connectionId });
		activeTurnId = startedTurn.turnId;
		releaseStopWork = trackRunningWork("scheduled turn", () => endTurn(Object.assign(new Error(STOP_SCHEDULED_RUN_SENTENCE), { code: SERVER_STOPPED_REASON })));
		input.signal?.addEventListener("abort", endBySignal, { once: true });
		// A signal that fired while the session was being made ends the turn before it asks the model.
		if (input.signal?.aborted) endedBy = input.signal.reason;
		session.subscribe((event: any) => {
			// A turn ended before the model was asked stops as soon as the runtime starts asking it.
			if (event?.type === "agent_start" && endedBy) void Promise.resolve(session.abort()).catch(() => {});
			steps.frame(event);
			if (event?.type === "message_end") steps.note(event.message);
			if (event?.type !== "message_end" || event?.message?.role !== "assistant") return;
			answeredThisTurn = true;
			if (event.message.stopReason === "error") providerRefusal = String(event.message.errorMessage ?? "");
			const text = textFromMessageParts(event.message.content);
			({ text: assistantText, retryFrom } = landedTextAfter({ text: assistantText, retryFrom }, text, event.message.stopReason === "error" && session.retriesAfter(event.message)));
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
		if (!endedBy) await session.prompt(promptText, serverHooks().promptOptions?.());
		if (endedBy) throw endedBy;
		if (!assistantText.trim() && modelNotOnAccount(providerRefusal)) throw new ScheduledModelNotOnAccountError(modelLock);
		if (!assistantText.trim()) throw new Error("scheduled persistent-room execution produced no assistant text");
		terminalReason = "completed";
	} catch (error) {
		if (userItemPersisted) {
			try {
				const current = getPersistentAgentThread(prepared.roomId, prepared.threadId) ?? thread;
				// A run the stop or the signal ended keeps what it had said, above that line.
				const keptPartial = endedBy !== undefined && assistantText.trim() !== "";
				const withAnswer = (items: unknown[]): unknown[] => keptPartial ? upsertItem(items, { kind: "assistant", id: assistantItemId, text: assistantText.trim(), streaming: false, ts: Date.now() }) : items;
				thread = writePersistentAgentThread(prepared.roomId, prepared.threadId, {
					state: current.state === "active" ? "active" : "standby",
					origin: current.origin,
					model: current.model,
					items: appendFailureItem(noteItemsOrJustTheItems(withAnswer(withSteps(current.items ?? []))), executionId, endedBy ? endedBy.message : error instanceof ScheduledModelNotOnAccountError ? error.message : "Scheduled background task failed before an assistant response was saved."),
				}).thread;
			} catch {
				// Preserve the original execution error. Worker finalization records status.
			}
		}
		throw endedBy ?? error;
	} finally {
		releaseStopWork?.();
		input.signal?.removeEventListener("abort", endBySignal);
		// Before the turn ends: a room opened the moment it does must not hand this prompt back.
		try { keepAppTurnFailure(session as any); } catch {}
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
		items: noteItemsOrJustTheItems(upsertItem(withSteps(current.items ?? []), { kind: "assistant", id: assistantItemId, text: assistantText.trim(), streaming: false, ts: Date.now() })),
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
		...(autoDeclinedQuestions.titles().length > 0 ? { declinedQuestions: autoDeclinedQuestions.titles() } : {}),
		thread,
	};
}
