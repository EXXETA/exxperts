import crypto from "node:crypto";
import fs from "node:fs";
import { estimateTokens, PROMPT_OUTPUT_RESERVE_TOKENS, PROMPT_MIN_TOKEN_BUDGET, promptRealTokenBudget, promptTokenBudget } from "./token-estimate.js";
import { parseMemoryDocument, renderMemoryDocument, MEMORY_ARCHIVE_ENTRIES_FILE, stripRecentContextMetadata, renderMemoryContext } from "./memory-entries.js";
import path from "node:path";
import { extractRecentContextForAbsorb } from "./absorb-consolidation.js";
import { rememberSentenceModelName } from "./checkpoint-compression.js";
import type { PersistentRoomEffectiveWorkspacePolicy } from "./persistent-room-workspace-policy.js";
import { composePersistentRoomInstructions, buildPersistentRoomInstructionsLayer, type ComposedPersistentRoomInstructions } from "./persistent-room-instructions.js";
import { fingerprintL1bSource, type PersistentAgentBootContract, type PersistentAgentId, type PersistentAgentModelLock, type PersistentAgentPiSessionJsonlThreadRuntime, type PersistentAgentPromptBudget, type PersistentAgentPromptLayer, type PersistentAgentThreadRecord, type PersistentAgentWorkspaceCapabilitySummary } from "./persistent-agent-types.js";
import type { CheckpointModelWindow, L1bSourceFingerprint } from "./persistent-agent-memory-types.js";
import { type AgentJson, createPersistentAgentInstance, ensureDir, getPersistentAgentActiveTurnState, getPersistentAgentRuntimeState, PERSISTENT_AGENTS_ROOT, type PersistentAgentInstance, safeRuntimeThreadId } from "./persistent-agent-store.js";
import { getPersistentAgentThread, normalizeL1bSourceFingerprint, normalizePersistentAgentRuntimeString, normalizeSha256Hex, piSessionHasNoMessages, threadHasUserVisibleTurns } from "./persistent-agent-threads.js";
import { budgetState } from "./persistent-agent-memory-files.js";
import { localFilesWorkspaceWriteLine, persistentAgentPlatformKernel, persistentAgentRuntimeEnvelope, safeWorkspaceCapabilityLabel } from "./persistent-agent-constitution.js";
import { serverHooks } from "./server-hooks.js";

function buildPromptBudget(l0: string, l1a: string, l1b: string, l2: string): PersistentAgentPromptBudget {
	const l0EstimatedTokens = estimateTokens(l0);
	const l1aEstimatedTokens = estimateTokens(l1a);
	const l1bEstimatedTokens = estimateTokens(l1b);
	const l2EstimatedTokens = estimateTokens(l2);
	const bootEstimatedTokens = l0EstimatedTokens + l1aEstimatedTokens + l1bEstimatedTokens + l2EstimatedTokens;
	return {
		l0EstimatedTokens,
		l1aEstimatedTokens,
		l1bEstimatedTokens,
		l2EstimatedTokens,
		bootEstimatedTokens,
		state: budgetState(bootEstimatedTokens),
		thresholds: { warning: 15000, pressure: 18000, hard: 20000 },
	};
}

// The one unrecoverable room state: memory so large it fills the model's
// window on its own. Chat cannot compact a system prompt, Maintain's workers
// refuse the same memory, and Forget boots the next thread from the same
// file — so the room must refuse to START on this model, loudly and with the
// real remedy, instead of failing as a raw provider error on the first turn.
// Same budget as the maintenance workers (checkpointPromptTokenBudget), same
// rule when the model exposes no window metadata: run unguarded.
export class PersistentAgentMemoryOverflowError extends Error {
	readonly statusCode = 413;
	readonly code = "memory_overflow";
	readonly bootEstimatedTokens: number;
	readonly promptTokenBudget: number;
	constructor(message: string, bootEstimatedTokens: number, promptTokenBudget: number) {
		super(message);
		this.bootEstimatedTokens = bootEstimatedTokens;
		this.promptTokenBudget = promptTokenBudget;
	}
}

export function assertPersistentAgentBootPromptFitsWindow(input: {
	agentId: string;
	/** The conversation that would boot: the refusal's way out depends on whether it has messages. */
	conversationId?: string;
	model: { provider: string; model: string; label?: string };
	systemPrompt: string;
	window?: CheckpointModelWindow;
}): void {
	const window = input.window;
	if (window == null || !Number.isFinite(window.contextWindow) || !Number.isFinite(window.maxOutputTokens)) return;
	const budget = checkpointPromptTokenBudget(window, input.model);
	const bootEstimatedTokens = estimateTokens(input.systemPrompt);
	if (bootEstimatedTokens <= budget) return;
	const modelName = rememberSentenceModelName(input.model);
	// The way out must be reachable from where the person stands, and true for
	// this conversation. An empty one (the one Remember or Forget prepared)
	// boots fresh at the next open: its snapshot is rebuilt on the memory as it
	// is then and it moves to the room's model pick, both before this gate. So
	// Maintain (never locked) or a larger model fixes it, and the Maintain run
	// matches the heavy layer: Review never touches Recent Context, so an
	// intake-heavy room needs Memorize. A conversation with messages keeps the
	// boot it started with, so only a switch to a larger window reaches it.
	const withMessages = input.conversationId !== undefined && persistentAgentThreadBootStaysFrozen(input.agentId, input.conversationId);
	const heavyLayer = persistentAgentHeavyMemoryLayer(input.agentId);
	const maintainRun = heavyLayer === "recent"
		? "Memorize (most of this room's memory is recent conversations)"
		: "Review (most of this room's memory is long-term notes)";
	const wayOut = withMessages
		? "This conversation keeps the memory it started with, so a smaller memory reaches only the next one. To continue here, choose a model that can read more at once in Room settings, Model, and switch the open conversation to it."
		: `To fix it, open Maintain from Home and run ${maintainRun} to make the memory smaller, or choose a model that can read more at once in Room settings, Model. Then open the room again.`;
	// The instructions are part of "setup" and the one part the user can
	// shorten by hand, from the pane, without a model. The refused room holds
	// a standby thread whose frozen boot still carries the long text, so the
	// shorter text reaches the room only through Forget and a fresh boot; the
	// sentence says so instead of promising an immediate effect.
	const instructionsParts = persistentAgentInstructionsSetupParts(input.agentId);
	throw new PersistentAgentMemoryOverflowError(
		`This room's memory and setup (~${bootEstimatedTokens} estimated tokens) do not fit the usable window of ${modelName} (~${budget} tokens), so ${withMessages ? "this conversation cannot continue" : "a conversation cannot start"} on this model. ` +
			`Memory is unchanged and nothing was sent to the model. ${wayOut}` +
			instructionsBootRefusalSentence(instructionsParts, withMessages),
		bootEstimatedTokens,
		budget,
	);
}

/** Whether a conversation boots on its frozen snapshot at the next open: Pi-backed with messages. A legacy thread builds its boot at every connect; on a read failure, the empty case. */
function persistentAgentThreadBootStaysFrozen(agentIdRaw: string, threadIdRaw: string): boolean {
	try {
		const instance = createPersistentAgentInstance(agentIdRaw);
		const threadId = safeRuntimeThreadId(threadIdRaw);
		const thread = threadId ? getPersistentAgentThread(instance.agentId, threadId) : null;
		return thread?.runtime.kind === "pi-session-jsonl" && emptyPersistentAgentThread(instance.agentId, threadId!) === null;
	} catch {
		return false;
	}
}

/** The room's notes and waiting conversations as a conversation reads them, less the Chronos dates every save stamps. */
function persistentAgentReadMemoryFingerprint(agentId: string): string {
	const doc = parseMemoryDocument(createPersistentAgentInstance(agentId).readL1b());
	return crypto.createHash("sha256").update(renderMemoryDocument({ ...doc, chronos: "" }, "context"), "utf-8").digest("hex");
}

/**
 * Runs one Memorize or Review save and says whether it leaves the room's open
 * conversation on the memory it started with: the save changed what a
 * conversation reads, and the open one has started, so its start text stays
 * frozen and the change reaches the next conversation. An empty prepared
 * conversation is never behind: its start text is rebuilt on the memory as it
 * is at its next open. A read that fails here says nothing; the save stands.
 */
export async function saveWithOpenConversationCheck<T extends object>(agentIdRaw: string, save: () => T | Promise<T>): Promise<T & { openConversationKeepsMemory?: true }> {
	const agentId = createPersistentAgentInstance(agentIdRaw).agentId;
	let before: string | null = null;
	try {
		before = persistentAgentReadMemoryFingerprint(agentId);
	} catch {
		before = null;
	}
	const result = await save();
	try {
		if (before === null || persistentAgentReadMemoryFingerprint(agentId) === before) return result;
		const runtime = getPersistentAgentRuntimeState(agentId);
		if ((runtime.state !== "active" && runtime.state !== "standby") || !runtime.activeThreadId) return result;
		return persistentAgentThreadBootStaysFrozen(agentId, runtime.activeThreadId) ? { ...result, openConversationKeepsMemory: true } : result;
	} catch {
		return result;
	}
}

/**
 * What the room's instructions layer is made of, as the boot carries it, for
 * the boot-too-large refusal; null when the room has no layer or a file
 * cannot be read (then the refusal speaks of memory alone, as before).
 */
function persistentAgentInstructionsSetupParts(agentIdRaw: string): PersistentAgentBootInstructionsParts | null {
	try {
		const instance = createPersistentAgentInstance(agentIdRaw);
		const displayName = String(instance.readAgentJson()?.displayName ?? "").trim() || instance.agentId;
		const composed = composePersistentRoomInstructions(instance.agentId, { persistentAgentsRoot: PERSISTENT_AGENTS_ROOT });
		const layer = buildPersistentRoomInstructionsLayer({ displayName, composed });
		return layer ? persistentAgentBootInstructionsParts(composed, layer) : null;
	} catch {
		return null;
	}
}

/**
 * The instructions are part of "setup" and the one part the user can shorten
 * by hand, from a pane, without a model. Which pane depends on which text is
 * there: this room's own (Room settings), the global text (Settings, or
 * the room's switch), or both. A room with only its own text gets the
 * sentence it always got, with the layer's size, framing included.
 */
function instructionsBootRefusalSentence(parts: PersistentAgentBootInstructionsParts | null, withMessages: boolean): string {
	if (!parts || parts.layerEstimatedTokens == null) return "";
	// With messages, Forget deletes a conversation that has content: the sentence says so.
	const forget = withMessages ? "choosing Forget (which deletes this conversation)" : "choosing Forget";
	const room = parts.roomEstimatedTokens;
	const global = parts.globalEstimatedTokens;
	if (global == null) {
		return ` This room's instructions are ~${parts.layerEstimatedTokens} of those tokens: shortening them in Room settings → Instructions and then ${forget} starts the room again with the shorter text, without touching its memory.`;
	}
	if (room == null) {
		return ` The global instructions are ~${parts.layerEstimatedTokens} of those tokens: shortening them in Settings → Instructions, or switching them off for this room in Room settings → Instructions, and then ${forget} starts the room again with the shorter setup, without touching its memory.`;
	}
	return ` This room's instructions and the global instructions are ~${parts.layerEstimatedTokens} of those tokens together (~${room} this room's, ~${global} global): shortening either (Room settings → Instructions for this room's, Settings → Instructions for the global ones), or switching the global instructions off for this room, and then ${forget} starts the room again with the shorter setup, without touching its memory.`;
}

function persistentAgentHeavyMemoryLayer(agentIdRaw: string): "recent" | "stable" {
	try {
		const instance = createPersistentAgentInstance(agentIdRaw);
		const meta = instance.readAgentJson();
		if (!meta) return "stable";
		const l1b = fs.readFileSync(instance.l1bCurrentPath(meta), "utf-8");
		const recent = extractRecentContextForAbsorb(l1b);
		return recent.recentContext.length > recent.before.length + recent.after.length ? "recent" : "stable";
	} catch {
		return "stable";
	}
}

/**
 * The archive file behind the boot render's pointer lines. Missing is the
 * normal case (a room that has never demoted anything) and unreadable must
 * never fail a boot, so both come back as "no archive".
 */
function readMemoryArchiveTextForBoot(instance: PersistentAgentInstance, meta: Partial<AgentJson> | null): string {
	try {
		return fs.readFileSync(path.join(instance.l1bArchiveDir(meta), MEMORY_ARCHIVE_ENTRIES_FILE), "utf-8");
	} catch {
		return "";
	}
}

/**
 * What the instructions layer of a boot is made of, for the meter, the
 * refusals and diagnostics: the global text and this room's own are one
 * layer in the prompt, and the person reading a number needs to know which
 * text to shorten.
 */
export interface PersistentAgentBootInstructionsParts {
	includesGlobal: boolean;
	globalEnabled: boolean;
	/** Tokens of the global text as the layer carries it; null when it is not part of this boot. */
	globalEstimatedTokens: number | null;
	/** Tokens of this room's own text; null when the room has none. */
	roomEstimatedTokens: number | null;
	/** Tokens of the whole layer, framing included; null when there is no layer. */
	layerEstimatedTokens: number | null;
}

function persistentAgentBootInstructionsParts(composed: ComposedPersistentRoomInstructions, layer: string | null): PersistentAgentBootInstructionsParts {
	return {
		includesGlobal: composed.includesGlobal,
		globalEnabled: composed.globalEnabled,
		globalEstimatedTokens: composed.includesGlobal ? estimateTokens(composed.global.text) : null,
		roomEstimatedTokens: composed.room.text ? estimateTokens(composed.room.text) : null,
		layerEstimatedTokens: layer ? estimateTokens(layer) : null,
	};
}

export function buildPersistentAgentBootContext(contract: PersistentAgentBootContract): {
	contract: PersistentAgentBootContract;
	layers: PersistentAgentPromptLayer[];
	systemPrompt: string;
	promptBudget: PersistentAgentPromptBudget;
	instructionsParts: PersistentAgentBootInstructionsParts;
} {
	const instance = createPersistentAgentInstance(contract.agentId);
	const normalizedContract: PersistentAgentBootContract = { ...contract, agentId: instance.agentId };
	const meta = instance.readAgentJson();
	if (!meta) throw new Error("agent.json is missing or invalid JSON");
	if (meta.id && meta.id !== instance.agentId) throw new Error(`agent.json id mismatch: ${meta.id}`);
	const l1aPath = instance.l1aPath(meta);
	const l1bPath = instance.l1bCurrentPath(meta);
	if (!fs.existsSync(l1aPath)) throw new Error("L1a.md is missing");
	if (!fs.existsSync(l1bPath)) throw new Error("L1b/current.md is missing");

	const l0 = persistentAgentPlatformKernel();
	const l1a = fs.readFileSync(l1aPath, "utf-8");
	// THE room's memory as the model reads it: the CONTEXT render, not the
	// storage file. Entry metadata comments (~15 tokens each) never reach the
	// model, and every topic with archived entries carries its pointer line, so
	// a demotion is disclosure instead of forgetting. A file that has never been
	// migrated renders to itself byte for byte, so this line changes nothing for
	// a room that has not opted into entries yet. The checkpoint provenance
	// comments of the remembered conversations are stripped here, at the boot
	// alone, for the same reason the entry comments are.
	// A note kept beside one it may disagree with carries the day it was learned, so the room can weigh the two.
	const l1b = stripRecentContextMetadata(renderMemoryContext(fs.readFileSync(l1bPath, "utf-8"), readMemoryArchiveTextForBoot(instance, meta), { pairDays: true }));
	const l2 = persistentAgentRuntimeEnvelope(new Date(), normalizedContract.workspaceCapability, normalizedContract.enabledSkillsIndex);
	const displayName = String(meta.displayName ?? "").trim() || instance.agentId;
	// The user's standing instructions ride between the constitution and the
	// memory; a room without any gets no layer, so it boots byte-identical to
	// a room that never had them. The budget counts them under the
	// constitution's share: an extension of L1a from the meter's point of view.
	const composedInstructions = composePersistentRoomInstructions(instance.agentId, { persistentAgentsRoot: PERSISTENT_AGENTS_ROOT });
	const instructions = buildPersistentRoomInstructionsLayer({ displayName, composed: composedInstructions });
	const layers: PersistentAgentPromptLayer[] = [
		{ id: "l0", title: "Persistent Agent Platform Kernel", content: l0, estimatedTokens: estimateTokens(l0) },
		{ id: "l1a", title: `${displayName} Constitution`, content: l1a, estimatedTokens: estimateTokens(l1a) },
		...(instructions ? [{ id: "instructions" as const, title: `${displayName} Instructions`, content: instructions, estimatedTokens: estimateTokens(instructions) }] : []),
		{ id: "l1b", title: `${displayName} Memory`, content: l1b, estimatedTokens: estimateTokens(l1b) },
		{ id: "l2", title: "Persistent Agent Session Runtime Envelope", content: l2, estimatedTokens: estimateTokens(l2) },
	];
	const systemPrompt = layers.map((layer) => layer.content.trim()).join("\n\n---\n\n") + "\n";
	return {
		contract: normalizedContract,
		layers,
		systemPrompt,
		promptBudget: buildPromptBudget(l0, instructions ? `${l1a}\n\n---\n\n${instructions}` : l1a, l1b, l2),
		instructionsParts: persistentAgentBootInstructionsParts(composedInstructions, instructions),
	};
}

/**
 * The per-turn current-identity stanza. The boot prompt a pi-session-jsonl
 * thread serves is a frozen, hash-pinned snapshot, so a rename mid-session
 * never reaches the constitution heading or the Identity section the model is
 * reading — this stanza rides the same before_agent_start assembly as the
 * shelf manifest and re-reads agent.json every turn, so the very next message
 * after a rename carries the room's current name. Kept to a few lines (the
 * frozen layers stay untouched; only this correction is live) and worded to
 * outrank them, the way the kernel outranks the layers below it. Returns ""
 * when the room's metadata is unreadable: a missing stanza degrades to the
 * old frozen-name behavior instead of failing the turn.
 */
export function buildPersistentAgentCurrentIdentitySection(agentIdRaw: string): string {
	try {
		const instance = createPersistentAgentInstance(agentIdRaw);
		const meta = instance.readAgentJson();
		const displayName = String(meta?.displayName ?? "").trim() || instance.agentId;
		return `

## Current identity

Your name is now **${displayName}**. This line is live runtime state and wins over the layers above: if the constitution or memory still call you by another name, the user has renamed you since they were written — introduce yourself and refer to yourself as **${displayName}**.`;
	} catch {
		return "";
	}
}

/**
 * The per-turn current-workspace stanza, the identity stanza's sibling: the
 * boot prompt froze the workspace facts at thread creation, but the room's
 * workspace default now applies live — this stanza re-resolves the effective
 * policy every turn so the model always states the workspace the tools
 * actually enforce, including "none" after the user cleared it.
 */
export function buildPersistentRoomCurrentWorkspaceSection(effectivePolicy: PersistentRoomEffectiveWorkspacePolicy, run: { scheduled?: boolean } = {}): string {
	const heading = `

## Current workspace

This is live runtime state and wins over any "Active workspace capability" section above: the user can change the room workspace at any time, and this stanza reflects the setting in force from this message on, until a later room-state message says otherwise.`;
	const capability = effectivePolicy.workspaceToolsEnabled ? effectivePolicy.capability : undefined;
	if (!capability) {
		// A shared server reads every stored folder as none (the same switch the
		// workspace policy reads), so there is no setting to point the person to.
		const noFolder = serverHooks().ignoresStoredWorkspaceSettings?.()
			? "This server offers no folder and no commands yet; results stay in the chat."
			: "No folder is set for this room: you cannot open the user's files beyond Attachments, save a file, or run commands. When the user asks for one of these, or a result is worth keeping as a file, say so once and how to switch it on: Room settings → Folder → Choose folder. With a folder you can create and edit text files in it (notes, tables, web pages, SVG). Running commands (Bash: scripts, converting files, making Word, Excel, PowerPoint or PDF files with the computer's own programs) also needs Access set to Full access and the Bash switch on; each command then waits for the user's approval unless the chip under the message box says Auto.";
		return `${heading}

${noFolder} If earlier context claims a workspace, the user has removed or changed it since.`;
	}
	const modeLabel = capability.workspaceAccessMode === "localFiles" ? "Full access" : "Bounded workspace";
	const toolNames = capability.availableToolNames.join(", ") || "none";
	const writeLine = capability.workspaceAccessMode === "localFiles"
		? localFilesWorkspaceWriteLine(capability)
		: (capability.writeEnabled ? "- Write scope: files inside the selected workspace only, via the write and edit tools" : "- Write access: disabled. If asked to change files, say the room is read-only up front; do not attempt workarounds.");
	// Bash writes files too, and a scheduled run, which has none, has no one to ask.
	const noSilentReplace = !capability.writeEnabled && !capability.bashEnabled
		? ""
		: run.scheduled
			? "Never replace an existing file unless the task names that file: look first, and if it exists, write under a new name and say so.\n\n"
			: "Before you write a file, look: if a file with that name exists, the user did not ask to change it and you did not make it for them, ask, or write under a new name and say so. Changing or recreating a file the user asked to change, or one you made for them, needs no question.\n\n";
	return `${heading}

- Workspace label: ${safeWorkspaceCapabilityLabel(capability.workspaceLabel)}
- Workspace mode: ${modeLabel}
- Workspace tools: ${toolNames}
${writeLine}
- Bash/shell access: ${capability.bashEnabled ? "enabled" : "disabled. Commands need Access set to Full access and the Bash switch on, in Room settings → Folder; say so if a task needs one."}

${noSilentReplace}Where files land, so you describe it truthfully: a file you create in the workspace stays in the workspace folder on the user's computer and does NOT appear in this room's Attachments panel (that panel shows only the room's own files). When you tell the user where a file is, name the actual workspace folder path; never claim a workspace file is in the Attachments panel.

If these facts differ from a workspace described earlier in this conversation, the user changed the workspace mid-conversation; follow these facts and the usage rules of this mode from the boot context.`;
}

export interface PersistentAgentPiSessionJsonlPaths {
	sessionFilePath: string;
	sessionFileRelPath: string;
	bootPromptSnapshotPath: string;
	bootPromptSnapshotRelPath: string;
}

export interface PersistentAgentBootPromptSnapshotWriteResult {
	path: string;
	relPath: string;
	sha256: string;
}

export interface PersistentAgentPiSessionJsonlThreadRuntimeMetadataInput {
	sessionId: string;
	bootPromptSha256: string;
	l1bFingerprint: L1bSourceFingerprint;
	/** sha256 hex of the booted instructions layer, null for none; omit only when unknown (legacy records). */
	instructionsFingerprint?: string | null;
	createdAt?: number;
	leafId?: string | null;
}

export interface CreatePersistentAgentPiSessionJsonlThreadRuntimeInput {
	agentId: PersistentAgentId;
	threadId: string;
	model: PersistentAgentModelLock;
	cwd: string;
	workspaceCapability?: PersistentAgentWorkspaceCapabilitySummary;
}

export function persistentAgentPiSessionJsonlPaths(agentIdRaw: string, threadIdRaw: string): PersistentAgentPiSessionJsonlPaths {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const sessionFilePath = instance.runtimePiSessionPath(threadIdRaw);
	const bootPromptSnapshotPath = instance.runtimeBootPromptSnapshotPath(threadIdRaw);
	return {
		sessionFilePath,
		sessionFileRelPath: instance.rootRelativePath(sessionFilePath),
		bootPromptSnapshotPath,
		bootPromptSnapshotRelPath: instance.rootRelativePath(bootPromptSnapshotPath),
	};
}

export function fingerprintPersistentAgentBootContextL1b(bootContext: ReturnType<typeof buildPersistentAgentBootContext>): L1bSourceFingerprint {
	const l1b = bootContext.layers.find((layer) => layer.id === "l1b")?.content;
	if (typeof l1b !== "string") throw new Error("persistent-agent boot context is missing L1b layer");
	return fingerprintL1bSource(l1b);
}

export function writePersistentAgentBootPromptSnapshot(agentIdRaw: string, threadIdRaw: string, systemPrompt: string): PersistentAgentBootPromptSnapshotWriteResult {
	const { bootPromptSnapshotPath, bootPromptSnapshotRelPath } = persistentAgentPiSessionJsonlPaths(agentIdRaw, threadIdRaw);
	ensureDir(path.dirname(bootPromptSnapshotPath));
	fs.writeFileSync(bootPromptSnapshotPath, systemPrompt, { mode: 0o600, flag: "wx" });
	return {
		path: bootPromptSnapshotPath,
		relPath: bootPromptSnapshotRelPath,
		sha256: crypto.createHash("sha256").update(systemPrompt, "utf-8").digest("hex"),
	};
}

export function buildPersistentAgentPiSessionJsonlThreadRuntime(agentIdRaw: string, threadIdRaw: string, input: PersistentAgentPiSessionJsonlThreadRuntimeMetadataInput): PersistentAgentPiSessionJsonlThreadRuntime {
	const { sessionFileRelPath, bootPromptSnapshotRelPath } = persistentAgentPiSessionJsonlPaths(agentIdRaw, threadIdRaw);
	const sessionId = normalizePersistentAgentRuntimeString(input.sessionId);
	const bootPromptSha256 = normalizeSha256Hex(input.bootPromptSha256);
	const l1bFingerprint = normalizeL1bSourceFingerprint(input.l1bFingerprint);
	const leafId = input.leafId == null ? undefined : normalizePersistentAgentRuntimeString(input.leafId);
	if (!sessionId) throw new Error("persistent-agent Pi session id is invalid");
	if (!bootPromptSha256) throw new Error("persistent-agent boot prompt sha256 is invalid");
	if (!l1bFingerprint) throw new Error("persistent-agent L1b fingerprint is invalid");
	if (input.leafId != null && !leafId) throw new Error("persistent-agent Pi session leaf id is invalid");
	const instructionsFingerprint = input.instructionsFingerprint === undefined ? undefined : (normalizeSha256Hex(input.instructionsFingerprint) ?? null);
	const createdAt = Number.isFinite(input.createdAt) && Number(input.createdAt) > 0 ? Math.floor(Number(input.createdAt)) : Date.now();
	return {
		kind: "pi-session-jsonl",
		sessionId,
		sessionFileRelPath,
		bootPromptSnapshotRelPath,
		bootPromptSha256,
		l1bFingerprint,
		...(instructionsFingerprint !== undefined ? { instructionsFingerprint } : {}),
		createdAt,
		...(leafId ? { leafId } : {}),
	};
}

function emptyPersistentAgentThread(agentIdRaw: string, threadIdRaw: string): PersistentAgentThreadRecord | null {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const threadId = safeRuntimeThreadId(threadIdRaw);
	if (!threadId) return null;
	const thread = getPersistentAgentThread(instance.agentId, threadId);
	if (!thread || thread.state === "closed" || thread.runtime.kind !== "pi-session-jsonl") return null;
	if (threadHasUserVisibleTurns(thread.items)) return null;
	const turn = getPersistentAgentActiveTurnState(instance.agentId, threadId);
	if (turn.state === "running" || turn.state === "cancelling") return null;
	if (!piSessionHasNoMessages(instance.agentId, thread.runtime)) return null;
	return thread;
}

// The prompt budget keeps a margin under the model's context window, divided
// by the model's factor: the one formula in token-estimate.ts
// (promptTokenBudget), which minimumMemoryWindow reads too, so the Memory
// model's size check and these guards cannot disagree. Shared by the
// checkpoint and consult workers, the maintenance guard and the boot gate.
const CHECKPOINT_PROMPT_OUTPUT_RESERVE_TOKENS = PROMPT_OUTPUT_RESERVE_TOKENS;

const CHECKPOINT_PROMPT_MIN_TOKEN_BUDGET = PROMPT_MIN_TOKEN_BUDGET;

/** The budget in the model's own tokens, before its factor. */
function checkpointPromptRealTokenBudget(window: CheckpointModelWindow): number {
	return promptRealTokenBudget(window);
}

/** In estimated tokens: a model that counts more per estimated token (modelTokenFactor) gets less. */
function checkpointPromptTokenBudget(window: CheckpointModelWindow, model?: { provider: string; model: string } | null): number {
	return promptTokenBudget(window, model);
}

export { CHECKPOINT_PROMPT_MIN_TOKEN_BUDGET, CHECKPOINT_PROMPT_OUTPUT_RESERVE_TOKENS, checkpointPromptRealTokenBudget, checkpointPromptTokenBudget, emptyPersistentAgentThread, persistentAgentBootInstructionsParts };
