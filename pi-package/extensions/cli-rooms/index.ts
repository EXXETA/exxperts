/**
 * CLI persistent-room bridge.
 *
 * `/exxperts-room <name>` writes a launcher marker and exits so the wrapper can
 * restart the runtime with the selected persistent room's locked boot/runtime.
 * In room mode the launcher chooses either legacy transcript recap or the
 * room-owned Pi JSONL session. This extension registers bounded workspace tools
 * when the saved room policy allows them, mirrors terminal user/assistant
 * messages into the same display cache used by the web UI, creates new
 * persistent rooms with `/exxperts-room-create`, soft-deletes rooms with
 * `/exxperts-room-delete`, exposes the web checkpoint
 * workflow as `/exxperts-checkpoint`, and mirrors web Memento with
 * `/exxperts-memento`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { complete } from "@exxeta/exxperts-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@exxeta/exxperts-runtime";
import {
	archivePersistentAgent,
	buildCheckpointProposal,
	createPersistentAgentFromScaffoldInput,
	getPersistentAgentStatus,
	getPersistentAgentThread,
	listPersistentAgents,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentMementoBoundary,
	writePersistentAgentThread,
} from "../../../apps/web-server/src/persistent-agents.js";
import {
	createPersistentRoomDefaultCapabilityPolicy,
	deletePersistentRoomDefaultCapabilityPolicy,
	persistentRoomCapabilityPolicyView,
	readPersistentRoomDefaultCapabilityPolicy,
	resolvePersistentRoomCapabilityPolicy,
	updatePersistentRoomCapabilityPolicyWorkspaceSettings,
	writePersistentRoomDefaultCapabilityPolicy,
} from "../../../apps/web-server/src/persistent-room-workspace-policy.js";
import {
	createPersistentRoomWorkspaceTools,
	isPersistentRoomWorkspaceToolPolicyEnabled,
} from "../../../apps/web-server/src/persistent-room-workspace-tools.js";
import { getPersistentRoomModelLocks } from "../../../apps/web-server/src/persistent-agent-ai-profiles.js";
import { readPersistentAgentAiProfileState } from "../../../apps/web-server/src/persistent-agent-ai-profile-state.js";
import { cliLauncherStatePath, productAppStatePath } from "../../product-state-paths.js";

// Half-block "exxperts" logotype, shown atop the room header for brand
// consistency with the launcher picker. (Mirrors WORDMARK in exxcode-launcher.cjs.)
const ROOM_WORDMARK = [
	"                                                             ██",
	"   ▄▄▄▄    ▄▄    ▄▄  ▄▄    ▄▄  ▄▄  ▄▄▄       ▄▄▄▄    ▄▄▄▄▄ ▄███▄▄  ▄▄▄▄▄▄",
	" ███████▄  ▀██  ██▀  ▀██  ██▀  ████▀▀██▄   ███████▄  █████ ██████ ████████",
	"███▄▄▄▄██▄  ▀████▀    ▀████▀   ██▀    ███ ███▄▄▄▄██  ██      ██    ██▄▄",
	"███▀▀▀▀▀▀▀   ████      ████    ██▄    ▄██ ███▀▀▀▀▀▀▀ ██      ██     ▀▀██▄",
	"▀██▄▄▄▄██  ▄██▀▀██▄  ▄██▀▀██▄  ███▄▄▄▄██▀ ▀██▄▄▄▄██  ██      ██▄▄  ▄▄▄▄███",
	"  ▀████▀   ██▀  ▀██  ██▀  ▀██  ██▀▀███▀     ▀████▀   ██      ████▀▀███████",
	"                               ██",
	"                               ██",
];

// Short label for the recent-context buffer level (Absorb/Maintain territory).
function recentContextLevelText(level: string | undefined): string {
	switch (level) {
		case "hard_cap":
			return "full · maintain in web app";
		case "at_soft_cap":
			return "nearly full";
		case "approaching_soft_cap":
			return "filling";
		case "empty":
			return "empty";
		default:
			return "ok";
	}
}

function timeAgo(iso: string | null | undefined): string | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

const EXXETA_HOME = process.env.EXXETA_HOME || "";
const ROOM_STATE_FILE = cliLauncherStatePath(".room-state");
const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/;
const CHECKPOINT_TRIGGER_PROMPT = "Produce the checkpoint compression fields now.";
let suppressRoomStandbyOnShutdown = false;

type RoomMarker = {
	action: "enter" | "exit";
	agentId?: string;
	threadId?: string;
	model?: ModelLock;
	ts: number;
};

type ThreadItem = {
	kind: "user" | "assistant";
	id: string;
	text: string;
	ts: number;
	source: "cli";
};

type CheckpointDensity = "compact" | "standard" | "rich";

type CheckpointEditFields = {
	sessionArc: string;
	body: string;
	parked: string;
};

type ModelLock = {
	provider: string;
	model: string;
	label?: string;
};

type CreateRoomArgs = {
	displayName?: string;
	userName?: string;
	preferredUserAddress?: string;
	mode?: string;
	enter?: boolean;
	noEnter?: boolean;
};

type DeleteRoomArgs = {
	room?: string;
	confirmation?: string;
	forceCurrent?: boolean;
};

function writeRoomMarker(marker: RoomMarker): boolean {
	if (!ROOM_STATE_FILE) return false;
	try {
		fs.mkdirSync(path.dirname(ROOM_STATE_FILE), { recursive: true, mode: 0o700 });
		fs.writeFileSync(ROOM_STATE_FILE, JSON.stringify(marker), { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}

function displayName(room: ReturnType<typeof listPersistentAgents>[number]): string {
	return String(room.displayName || room.id).trim() || room.id;
}

function normalizeHumanName(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function resolveRoom(raw: string): ReturnType<typeof listPersistentAgents>[number] | undefined {
	const query = raw.trim();
	if (!query) return undefined;
	const rooms = listPersistentAgents().filter((room) => room.exists && room.status === "ready");
	const queryLower = query.toLowerCase();
	const queryHuman = normalizeHumanName(query);
	return rooms.find((room) =>
		room.id.toLowerCase() === queryLower ||
		normalizeHumanName(displayName(room)) === queryHuman
	);
}

// Shared advisory room lock (plain CJS, also used by the launcher and web server).
// Fail-open: if it can't load, we simply don't show/enforce the lock.
let roomLockMod: { readLock: (id: string) => { surface: string } | null; isActive: (lock: unknown) => boolean } | false | null = null;
function roomLockApi() {
	if (roomLockMod !== null) return roomLockMod;
	try {
		roomLockMod = EXXETA_HOME ? createRequire(import.meta.url)(path.join(EXXETA_HOME, "bin", "lib", "room-lock.cjs")) : false;
	} catch {
		roomLockMod = false;
	}
	return roomLockMod;
}

// Returns the holding surface if the target room is currently active somewhere
// other than the room this session already owns.
function lockedByOther(targetAgentId: string): { surface: string } | null {
	const api = roomLockApi();
	if (!api) return null;
	if (roomEnv()?.agentId === targetAgentId) return null; // we already hold this room
	try {
		const lock = api.readLock(targetAgentId);
		return lock && api.isActive(lock) ? { surface: lock.surface } : null;
	} catch {
		return null;
	}
}

function lockWhereLabel(surface: string): string {
	return surface === "web" ? "the web app" : "another CLI session";
}

// Block entering a room that's open elsewhere — stay in the current session
// (no marker, no restart) and tell the user why. Returns true if blocked.
function blockIfLocked(targetAgentId: string, label: string, ctx: ExtensionCommandContext): boolean {
	const held = lockedByOther(targetAgentId);
	if (!held) return false;
	ctx.ui.notify(`🔒 "${label}" is open in ${lockWhereLabel(held.surface)}. Close it there first; a room can be active in only one place at a time.`, "warning");
	return true;
}

function roomOptions(): string[] {
	return listPersistentAgents()
		.filter((room) => room.exists && room.status === "ready")
		.map((room) => {
			const held = lockedByOther(room.id);
			const prefix = held ? `🔒 [open in ${held.surface === "web" ? "web" : "CLI"}] ` : "";
			return `${prefix}${displayName(room)} (${room.id})`;
		});
}

function roomFromOption(option: string): string | undefined {
	const match = option.match(/\(([^()]+)\)\s*$/);
	return match?.[1];
}

function shellLikeTokens(raw: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | "\"" | null = null;
	let escaped = false;
	for (const ch of raw) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === "\"") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (escaped) current += "\\";
	if (current) tokens.push(current);
	return tokens;
}

function parseCreateRoomArgs(args: string): CreateRoomArgs {
	const tokens = shellLikeTokens(args);
	const parsed: CreateRoomArgs = {};
	const positional: string[] = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		const next = () => tokens[++i] ?? "";
		if (token === "--name" || token === "-n") parsed.displayName = next();
		else if (token.startsWith("--name=")) parsed.displayName = token.slice("--name=".length);
		else if (token === "--user" || token === "-u") parsed.userName = next();
		else if (token.startsWith("--user=")) parsed.userName = token.slice("--user=".length);
		else if (token === "--address" || token === "--preferred-address" || token === "-a") parsed.preferredUserAddress = next();
		else if (token.startsWith("--address=")) parsed.preferredUserAddress = token.slice("--address=".length);
		else if (token.startsWith("--preferred-address=")) parsed.preferredUserAddress = token.slice("--preferred-address=".length);
		else if (token === "--mode" || token === "-m") parsed.mode = next();
		else if (token.startsWith("--mode=")) parsed.mode = token.slice("--mode=".length);
		else if (token === "--enter") parsed.enter = true;
		else if (token === "--no-enter") parsed.noEnter = true;
		else positional.push(token);
	}
	if (!parsed.displayName && positional.length > 0) parsed.displayName = positional.join(" ");
	return parsed;
}

function createRoomUsage(): string {
	return [
		"usage: /exxperts-room-create <room name> --user \"Your Name\" [--address \"Preferred\"] [--mode default|learning] [--enter]",
		"",
		"Interactive CLI can prompt for missing values.",
	].join("\n");
}

function parseDeleteRoomArgs(args: string): DeleteRoomArgs {
	const tokens = shellLikeTokens(args);
	const parsed: DeleteRoomArgs = {};
	const positional: string[] = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		const next = () => tokens[++i] ?? "";
		if (token === "--confirm" || token === "-c") parsed.confirmation = next();
		else if (token.startsWith("--confirm=")) parsed.confirmation = token.slice("--confirm=".length);
		else if (token === "--force-current") parsed.forceCurrent = true;
		else positional.push(token);
	}
	if (positional.length > 0) parsed.room = positional.join(" ");
	return parsed;
}

function deleteRoomUsage(): string {
	return [
		"usage: /exxperts-room-delete <room-id-or-name>",
		"       /exxperts-room-delete <room-id-or-name> --confirm \"DELETE <room-id>\"",
		"",
		"This is the same soft delete/archive used by the web UI.",
	].join("\n");
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => Boolean(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function stripRestoredThreadBlock(text: string): string {
	return text
		.replace(/^\[RESTORED PERSISTENT ROOM LIVE THREAD CONTEXT\][\s\S]*?\[\/RESTORED PERSISTENT ROOM LIVE THREAD CONTEXT\]\s*/m, "")
		.trim();
}

function roomEnv() {
	const agentId = String(process.env.EXXETA_PERSISTENT_ROOM_AGENT || "").trim();
	const threadId = String(process.env.EXXETA_PERSISTENT_ROOM_THREAD || "").trim();
	const provider = String(process.env.EXXETA_PERSISTENT_ROOM_MODEL_PROVIDER || "").trim();
	const model = String(process.env.EXXETA_PERSISTENT_ROOM_MODEL_ID || "").trim();
	const label = String(process.env.EXXETA_PERSISTENT_ROOM_MODEL_LABEL || "").trim();
	if (!ROOM_ID_PATTERN.test(agentId) || !threadId || !provider || !model) return null;
	return {
		agentId,
		threadId,
		model: { provider, model, ...(label ? { label } : {}) },
	};
}

function threadItemId(role: "user" | "assistant"): string {
	return `${role}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function appendThreadItem(item: ThreadItem): void {
	const env = roomEnv();
	if (!env) return;
	const existing = getPersistentAgentThread(env.agentId, env.threadId);
	// `items` is a web/CLI display cache. For Pi-backed room threads, canonical
	// runtime continuity lives in the JSONL session opened by the launcher; this
	// write intentionally preserves `existing.runtime` via writePersistentAgentThread.
	writePersistentAgentThread(env.agentId, env.threadId, {
		state: "active",
		origin: existing?.origin ?? "home",
		model: env.model,
		items: [...(existing?.items ?? []), item],
	});
}

function markRoomStandby(): void {
	const env = roomEnv();
	if (!env) return;
	const existing = getPersistentAgentThread(env.agentId, env.threadId);
	// Standby is lifecycle metadata only; keep the activeThread runtime metadata
	// untouched so Pi-backed threads remain resumable through their JSONL session.
	writePersistentAgentThread(env.agentId, env.threadId, {
		state: "standby",
		origin: existing?.origin ?? "home",
		model: env.model,
		items: existing?.items ?? [],
	});
}

function isCheckpointDensity(value: string): value is CheckpointDensity {
	return value === "compact" || value === "standard" || value === "rich";
}

function parseCheckpointArgs(args: string): { density?: CheckpointDensity; rememberText: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	let density: CheckpointDensity | undefined;
	if (parts[0]?.startsWith("--density=")) {
		const value = parts.shift()?.slice("--density=".length).toLowerCase() ?? "";
		if (isCheckpointDensity(value)) density = value;
	} else if (parts[0] === "--density" || parts[0] === "-d") {
		parts.shift();
		const value = parts.shift()?.toLowerCase() ?? "";
		if (isCheckpointDensity(value)) density = value;
	} else if (isCheckpointDensity(parts[0]?.toLowerCase() ?? "")) {
		density = parts.shift()?.toLowerCase() as CheckpointDensity;
	}
	return { density, rememberText: parts.join(" ").trim() };
}

function checkpointTranscriptItems(items: any[]): any[] {
	return items
		.filter((item) => item?.kind === "user" || item?.kind === "assistant" || item?.kind === "system" || item?.kind === "tool")
		.map((item) => {
			if (item.kind === "tool") return { kind: "tool", id: item.id, name: item.name, status: item.status };
			return { kind: item.kind, id: item.id, text: String(item.text ?? "").trim() };
		})
		.filter((item) => item.kind === "tool" || item.text);
}

function checkpointFieldsFromProposal(proposal: any): CheckpointEditFields {
	return {
		sessionArc: String(proposal?.fields?.sessionArc ?? "").trim(),
		body: String(proposal?.fields?.body ?? "").trim(),
		parked: String(proposal?.fields?.parked ?? "").trim() || "None",
	};
}

function buildApprovedRecentContextMarkdown(proposal: any, fields: CheckpointEditFields): string {
	const heading = String(proposal?.proposedRecentContext ?? "").split(/\r?\n/)[0]?.trim()
		|| `### RC-DRAFT | ${fields.parked.trim().toLowerCase() === "none" ? "CLOSED" : "OPEN"} | ${new Date().toISOString().slice(0, 10)} | ${String(proposal?.preview?.title ?? "Untitled checkpoint proposal")}`;
	return `${heading}\n\n**Session arc:** ${fields.sessionArc.trim()}\n\n**Body:**\n${fields.body.trim()}\n\n**Parked:**\n${fields.parked.trim() || "None"}\n`;
}

function truncateDetail(value: string, max = 3000): string {
	return value.length > max ? `${value.slice(0, max)}\n\n...(truncated for preview)` : value;
}

function formatCheckpointProposalDetail(proposal: any, draft: string): string {
	const points = Array.isArray(proposal?.preview?.keyPoints) && proposal.preview.keyPoints.length > 0
		? `\n\nKey points:\n${proposal.preview.keyPoints.map((point: string) => `- ${point}`).join("\n")}`
		: "";
	const warnings = Array.isArray(proposal?.warnings) && proposal.warnings.length > 0
		? `\n\nWarnings:\n${proposal.warnings.map((warning: string) => `- ${warning}`).join("\n")}`
		: "";
	return truncateDetail([
		String(proposal?.preview?.summary ?? "").trim(),
		points,
		`\n\nDraft Recent Context entry:\n\n${draft}`,
		warnings,
	].join(""));
}

async function selectCheckpointDensity(ctx: ExtensionCommandContext, parsed?: CheckpointDensity): Promise<CheckpointDensity | null> {
	if (parsed) return parsed;
	const pick = await ctx.ui.select("Checkpoint summary type", [
		"Standard",
		"Compact",
		"Rich",
		"Cancel",
	], {
		detail: "Standard matches the web UI default. Compact is shorter; rich preserves more nuance.",
	});
	if (!pick || pick === "Cancel") return null;
	return pick.toLowerCase() as CheckpointDensity;
}

async function editCheckpointFields(ctx: ExtensionCommandContext, fields: CheckpointEditFields): Promise<CheckpointEditFields | null> {
	const sessionArc = await ctx.ui.input("Edit session arc", `Leave blank to keep current:\n${fields.sessionArc}`);
	if (sessionArc === undefined) return null;
	const body = await ctx.ui.input("Edit body", `Leave blank to keep current:\n${fields.body}`);
	if (body === undefined) return null;
	const parked = await ctx.ui.input("Edit parked/open items", `Leave blank to keep current:\n${fields.parked}`);
	if (parked === undefined) return null;
	return {
		sessionArc: sessionArc.trim() || fields.sessionArc,
		body: body.trim() || fields.body,
		parked: parked.trim() || fields.parked || "None",
	};
}

async function runCheckpointCompressionWorker(prompt: string, modelLock: ModelLock, ctx: ExtensionCommandContext) {
	const model = ctx.modelRegistry.find(modelLock.provider, modelLock.model);
	if (!model) throw new Error(`checkpoint model not found: ${modelLock.provider}/${modelLock.model}`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	const response = await complete(model, {
		systemPrompt: prompt,
		messages: [{
			role: "user",
			content: [{ type: "text", text: CHECKPOINT_TRIGGER_PROMPT }],
			timestamp: Date.now(),
		}],
	}, {
		apiKey: auth.apiKey,
		headers: auth.headers,
		maxTokens: 4096,
		signal: ctx.signal,
	});
	return {
		text: textFromContent(response.content),
		usage: (response as any).usage,
	};
}

async function runCheckpointCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const env = roomEnv();
	if (!env) {
		ctx.ui.notify("No active persistent room. Checkpoints can only be created inside a room. Use /exxperts-room <room> first.", "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("/exxperts-checkpoint requires the interactive CLI so you can review and approve the memory write.", "warning");
		return;
	}
	await ctx.waitForIdle();
	const thread = getPersistentAgentThread(env.agentId, env.threadId);
	const transcriptItems = checkpointTranscriptItems(thread?.items ?? []);
	if (!transcriptItems.some((item) => item.kind === "user")) {
		ctx.ui.notify("Send at least one room message before checkpointing.", "warning");
		return;
	}

	const parsed = parseCheckpointArgs(args);
	const density = await selectCheckpointDensity(ctx, parsed.density);
	if (!density) return;
	let rememberText = parsed.rememberText;
	if (!rememberText) {
		const input = await ctx.ui.input("What should carry forward?", "Optional. Press Enter to skip.");
		if (input === undefined) return;
		rememberText = input.trim();
	}
	if (rememberText.length > 500) {
		ctx.ui.notify("Checkpoint guidance must be 500 characters or fewer.", "warning");
		return;
	}

	ctx.ui.notify("Generating checkpoint memory proposal...", "info");
	const proposal = await buildCheckpointProposal({
		agentId: env.agentId,
		conversationId: env.threadId,
		model: env.model,
		density,
		rememberText,
		items: transcriptItems,
		runtimeCwd: process.cwd(),
	}, (prompt, modelLock) => runCheckpointCompressionWorker(prompt, modelLock, ctx));
	if (proposal.agentId !== env.agentId || proposal.conversationId !== env.threadId) {
		throw new Error("checkpoint proposal target does not match the active room");
	}

	let fields = checkpointFieldsFromProposal(proposal);
	while (true) {
		const draft = buildApprovedRecentContextMarkdown(proposal, fields);
		const choice = await ctx.ui.select(`Memory proposal: ${proposal.preview.title}`, [
			"Approve and save memory",
			"Edit fields",
			"Discard",
		], {
			detail: formatCheckpointProposalDetail(proposal, draft),
		});
		if (!choice || choice === "Discard") {
			ctx.ui.notify("Checkpoint discarded. No memory was written.", "info");
			return;
		}
		if (choice === "Edit fields") {
			const edited = await editCheckpointFields(ctx, fields);
			if (edited) fields = edited;
			continue;
		}
		const ok = await ctx.ui.confirm(
			"Approve and save checkpoint?",
			"This archives the current L1b and writes the approved Recent Context entry to durable memory.",
		);
		if (!ok) continue;
		const parsedApproval = parseCheckpointApprovalRequest({
			conversationId: env.threadId,
			model: env.model,
			density: proposal.density,
			proposal,
			approvedRecentContext: draft,
		}, env.agentId);
		const result = writeApprovedCheckpoint(parsedApproval.request, parsedApproval.warnings, new Date(), { runtimeCwd: process.cwd() });
		suppressRoomStandbyOnShutdown = true;
		if (!writeRoomMarker({ action: "enter", agentId: env.agentId, model: env.model, ts: Date.now() })) {
			ctx.ui.notify(`Checkpoint saved: ${result.checkpointId}\nRecent Context entries: ${result.recentContextEntryCount}\nMemory was updated and the old room runtime was closed. Restart the room to enter the refreshed runtime.`, "warning");
			setTimeout(() => process.exit(0), 250);
			return;
		}
		ctx.ui.notify(`Checkpoint saved: ${result.checkpointId}\nRecent Context entries: ${result.recentContextEntryCount}\nRefreshing room runtime...`, "info");
		setTimeout(() => process.exit(0), 250);
		return;
	}
}

async function runMementoCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const env = roomEnv();
	if (!env) {
		ctx.ui.notify("No active persistent room. Memento can only discard a persistent room transcript. Use /exxperts-room <room> first.", "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("/exxperts-memento requires the interactive CLI so you can confirm before discarding the room transcript.", "warning");
		return;
	}
	await ctx.waitForIdle();
	const thread = getPersistentAgentThread(env.agentId, env.threadId);
	const itemCount = thread?.items?.length ?? 0;
	const ok = await ctx.ui.confirm(
		"Forget this conversation and start fresh?",
		`This will discard the current room transcript (${itemCount} item${itemCount === 1 ? "" : "s"}). Nothing will be checkpointed into memory.`,
	);
	if (!ok) return;
	const result = writePersistentAgentMementoBoundary(env.agentId, env.threadId, new Date(), { runtimeCwd: process.cwd() });
	suppressRoomStandbyOnShutdown = true;
	if (!writeRoomMarker({ action: "enter", agentId: env.agentId, threadId: result.postMemento.activeThreadId, model: env.model, ts: Date.now() })) {
		ctx.ui.notify("Memento applied, but could not restart the room because EXXETA_HOME is not set. Exiting this runtime; re-enter the room to continue fresh.", "warning");
		setTimeout(() => process.exit(0), 250);
		return;
	}
	ctx.ui.notify("Memento applied. Starting a fresh room thread...", "info");
	setTimeout(() => process.exit(0), 250);
}

async function readRequiredCreateRoomValue(
	ctx: ExtensionCommandContext,
	current: string | undefined,
	label: string,
	placeholder: string,
): Promise<string | null> {
	const value = String(current ?? "").trim();
	if (value) return value;
	if (!ctx.hasUI) {
		ctx.ui.notify(createRoomUsage(), "warning");
		return null;
	}
	const input = await ctx.ui.input(label, placeholder);
	const trimmed = String(input ?? "").trim();
	if (!trimmed) {
		ctx.ui.notify(`${label} is required.`, "warning");
		return null;
	}
	return trimmed;
}

async function runCreateRoomCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseCreateRoomArgs(args);
	const displayName = await readRequiredCreateRoomValue(ctx, parsed.displayName, "Personal agent name", "Example: Product Strategy Room");
	if (!displayName) return;
	if (ctx.hasUI && !parsed.displayName) {
		const confirmation = String(await ctx.ui.input("Confirm personal agent name", displayName) ?? "").trim();
		if (confirmation !== displayName) {
			ctx.ui.notify("Personal agent name confirmation must match.", "warning");
			return;
		}
	}
	const userName = await readRequiredCreateRoomValue(ctx, parsed.userName, "Your name", "Example: Andre");
	if (!userName) return;
	let preferredUserAddress = String(parsed.preferredUserAddress ?? "").trim();
	if (!preferredUserAddress && ctx.hasUI) {
		preferredUserAddress = String(await ctx.ui.input("Preferred address", "Optional") ?? "").trim();
	}

	try {
		const result = createPersistentAgentFromScaffoldInput({
			displayName,
			userName,
			...(preferredUserAddress ? { preferredUserAddress } : {}),
			...(parsed.mode ? { mode: parsed.mode } : {}),
		});
		const createdId = result.agent.id;
		ctx.ui.notify(`Created room ${result.agent.displayName} (${createdId}).`, "info");
		const enterNow = parsed.noEnter ? false : parsed.enter || (ctx.hasUI
			? await ctx.ui.confirm("Enter new room now?", `Start a fresh persistent room session for ${result.agent.displayName}.`)
			: false);
		if (!enterNow) return;
		if (!writeRoomMarker({ action: "enter", agentId: createdId, ts: Date.now() })) {
			ctx.ui.notify("Room created, but cannot enter it because EXXETA_HOME is not set.", "error");
			return;
		}
		ctx.ui.notify(`Entering room ${result.agent.displayName}...`, "info");
		setTimeout(() => process.exit(0), 250);
	} catch (error) {
		ctx.ui.notify(`Failed to create room: ${(error as Error).message}`, "error");
	}
}

async function selectRoomForDelete(ctx: ExtensionCommandContext, rawRoom: string | undefined): Promise<ReturnType<typeof listPersistentAgents>[number] | null> {
	const value = String(rawRoom ?? "").trim();
	if (value) {
		const room = resolveRoom(value);
		if (!room) {
			ctx.ui.notify(`No ready persistent room found for "${value}". Use /exxperts-rooms to list rooms.`, "warning");
			return null;
		}
		return room;
	}
	const options = roomOptions();
	if (options.length === 0) {
		ctx.ui.notify("No ready persistent rooms found.", "warning");
		return null;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(deleteRoomUsage(), "warning");
		return null;
	}
	const pick = await ctx.ui.select("Delete room", [...options, "Cancel"]);
	if (!pick || pick === "Cancel") return null;
	const id = roomFromOption(pick);
	return id ? resolveRoom(id) ?? null : null;
}

async function runDeleteRoomCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseDeleteRoomArgs(args);
	const room = await selectRoomForDelete(ctx, parsed.room);
	if (!room) return;
	const env = roomEnv();
	if (env?.agentId === room.id && !parsed.forceCurrent) {
		ctx.ui.notify("You are currently inside this room. Leave it first with /exxperts-room-exit, or pass --force-current to archive it anyway.", "warning");
		return;
	}
	const phrase = `DELETE ${room.id}`;
	let confirmation = String(parsed.confirmation ?? "").trim();
	if (!confirmation && ctx.hasUI) {
		confirmation = String(await ctx.ui.input("Confirm soft delete", phrase) ?? "").trim();
	}
	if (confirmation !== phrase) {
		ctx.ui.notify(`Confirmation must exactly match: ${phrase}`, "warning");
		return;
	}
	try {
		const result = archivePersistentAgent(room.id, { confirmation });
		ctx.ui.notify(`Deleted room ${displayName(room)} (${result.agentId}). Files remain archived locally.`, "info");
		if (env?.agentId === room.id && parsed.forceCurrent) {
			suppressRoomStandbyOnShutdown = true;
			if (writeRoomMarker({ action: "exit", ts: Date.now() })) {
				setTimeout(() => process.exit(0), 250);
			}
		}
	} catch (error) {
		ctx.ui.notify(`Failed to delete room: ${(error as Error).message}`, "error");
	}
}

export default function (pi: ExtensionAPI) {
	const env = roomEnv();
	if (env) {
		const policy = resolvePersistentRoomCapabilityPolicy(env.agentId, env.threadId).policy;
		if (isPersistentRoomWorkspaceToolPolicyEnabled(policy)) {
			for (const tool of createPersistentRoomWorkspaceTools(policy)) {
				pi.registerTool(tool);
			}
		}
	}

	const listRoomsHandler = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const options = roomOptions();
		if (options.length === 0) {
			ctx.ui.notify("No ready rooms found.", "warning");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(options.join("\n"), "info");
			return;
		}
		const pick = await ctx.ui.select("Rooms", [...options, "Cancel"]);
		if (!pick || pick === "Cancel") return;
		const id = roomFromOption(pick);
		if (!id) return;
		if (blockIfLocked(id, id, ctx)) return;
		if (!writeRoomMarker({ action: "enter", agentId: id, ts: Date.now() })) {
			ctx.ui.notify("Cannot enter room: EXXETA_HOME is not set.", "error");
			return;
		}
		ctx.ui.notify(`Entering room ${id}...`, "info");
		setTimeout(() => process.exit(0), 250);
	};

	const exitRoomHandler = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (!writeRoomMarker({ action: "exit", ts: Date.now() })) {
			ctx.ui.notify("Cannot leave room: EXXETA_HOME is not set.", "error");
			return;
		}
		ctx.ui.notify("Leaving room...", "info");
		setTimeout(() => process.exit(0), 250);
	};

	// Mirrors the web "Room settings" modal: workspace (saved root + tools), a
	// rebind to the current directory, and delete (danger zone). Scheduled tasks
	// are deliberately NOT here — they only run via the web-server background
	// worker, so exposing them on the CLI would be misleading.
	const roomSettingsHandler = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const env = roomEnv();
		if (!env) {
			ctx.ui.notify("Open a room first with /rooms.", "warning");
			return;
		}
		const roomRecord = listPersistentAgents().find((r) => r.id === env.agentId);
		const name = roomRecord ? displayName(roomRecord) : env.agentId;

		const defaultPolicy = readPersistentRoomDefaultCapabilityPolicy(env.agentId);
		const wsView = defaultPolicy ? persistentRoomCapabilityPolicyView(defaultPolicy) : null;
		const wsRoot = wsView?.roots?.[0];
		const wsLabel = wsRoot ? wsRoot.displayLabel || wsRoot.basename : null;
		const wsMode = wsView?.workspaceAccessMode === "localFiles" ? "Full access" : "Bounded workspace";
		const wsBash = wsView?.workspaceAccessMode === "localFiles" ? `; bash ${wsView.bashEnabled ? "on" : "off"}` : "";
		const wsTools = wsView?.allowedToolNames?.length
			? `${wsView.allowedToolNames.join(", ")}${wsBash}`
			: wsView?.workspaceAccessMode === "localFiles" ? `none${wsBash}` : "none";
		const modelLabel = env.model.label || `${env.model.provider}/${env.model.model}`;

		// Recent-context usage + last checkpoint. Checkpoints (/checkpoint) save
		// session memory but do NOT drain this buffer — only the web app's
		// Maintain/Absorb does. When it fills (hard cap) the room can't be opened
		// on the CLI until maintained there.
		let memory = "recent context (unavailable)";
		let lastSaved: string | null = null;
		try {
			const status = getPersistentAgentStatus(env.agentId);
			const rc = status.recentContext;
			memory = `recent context ${rc.fullEntries}/${rc.hardCap} · ${recentContextLevelText(status.memoryStatus?.recentContextLevel)}`;
			lastSaved = timeAgo(status.memoryStatus?.lastCheckpointAt);
		} catch {}

		const summary = [
			`Room          ${name}`,
			`Model         ${modelLabel} (locked)`,
			`Workspace     ${wsLabel ? `${wsLabel} (${wsMode})` : "none · file tools off"}`,
			...(wsLabel ? [`Tools         ${wsTools}`] : []),
			`Memory        ${memory}`,
			`Last saved    ${lastSaved ?? "no checkpoint yet"}`,
			`Maintain      Absorb / Prune in the web app`,
			`Scheduled     managed in the web app`,
		].join("\n");

		ctx.ui.notify(summary, "info");
		if (!ctx.hasUI) return;

		const cwd = process.cwd();
		const cwdName = path.basename(cwd) || cwd;
		const useHere = `Use this directory as the workspace (${cwdName})`;
		const clearWs = wsLabel ? "Clear saved workspace" : null;
		const toggleBash = defaultPolicy?.workspaceAccessMode === "localFiles" ? `${defaultPolicy.bashEnabled ? "Turn Bash off" : "Turn Bash on"} (applies to a fresh thread)` : null;
		const changeModel = "Change model (applies to a fresh thread)";
		const del = "Delete this room…";
		const options = [useHere, ...(clearWs ? [clearWs] : []), ...(toggleBash ? [toggleBash] : []), changeModel, del, "Cancel"];

		const pick = await ctx.ui.select("Room settings", options);
		if (!pick || pick === "Cancel") return;

		if (pick === useHere) {
			try {
				const localFilesOption = "Full access (native file tools, bash off)";
				const boundedOption = "Bounded workspace";
				const modePick = await ctx.ui.select("Workspace access mode", [localFilesOption, boundedOption, "Cancel"]);
				if (!modePick || modePick === "Cancel") return;
				const workspaceAccessMode = modePick === boundedOption ? "bounded" : "localFiles";
				const policy = createPersistentRoomDefaultCapabilityPolicy({
					agentId: env.agentId,
					repoRoot: EXXETA_HOME ? path.resolve(EXXETA_HOME) : cwd,
					root: cwd,
					workspaceAccessMode,
					mode: "read",
					source: "manual",
					writeEnabled: true,
				});
				writePersistentRoomDefaultCapabilityPolicy(policy);
				ctx.ui.notify(`Workspace set to "${cwdName}" (${workspaceAccessMode === "localFiles" ? "Full access" : "Bounded workspace"}). It applies the next time you open this room.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not set workspace: ${(error as Error).message}`, "error");
			}
			return;
		}
		if (clearWs && pick === clearWs) {
			try {
				deletePersistentRoomDefaultCapabilityPolicy(env.agentId);
				ctx.ui.notify("Saved workspace cleared. Applies the next time you open this room.", "info");
			} catch (error) {
				ctx.ui.notify(`Could not clear workspace: ${(error as Error).message}`, "error");
			}
			return;
		}
		if (toggleBash && pick === toggleBash && defaultPolicy) {
			try {
				const next = updatePersistentRoomCapabilityPolicyWorkspaceSettings(defaultPolicy, { bashEnabled: defaultPolicy.bashEnabled !== true });
				writePersistentRoomDefaultCapabilityPolicy(next);
				ctx.ui.notify(`Bash ${next.bashEnabled ? "enabled" : "disabled"} for Full access. Applies the next time you open this room.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not update Bash: ${(error as Error).message}`, "error");
			}
			return;
		}
		if (pick === changeModel) {
			// The active thread's model is locked (same as the UI). Writing the room
			// model selection makes the NEXT fresh thread (checkpoint / memento / new
			// room) use it — mirroring the UI, where model choice is a fresh-thread action.
			try {
				const profileId = readPersistentAgentAiProfileState().profileId;
				const models = getPersistentRoomModelLocks(profileId);
				if (models.length === 0) {
					ctx.ui.notify("No models available for the active AI profile.", "warning");
					return;
				}
				const labelOf = (m: { provider: string; model: string }) => `${m.provider}/${m.model}`;
				const choice = await ctx.ui.select("Model for the next fresh thread", [...models.map(labelOf), "Cancel"]);
				if (!choice || choice === "Cancel") return;
				const picked = models.find((m) => labelOf(m) === choice);
				if (!picked) return;
				const file = productAppStatePath("web-chat-model.json");
				fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
				fs.writeFileSync(file, JSON.stringify({ provider: picked.provider, model: picked.model }, null, 2), { mode: 0o600 });
				ctx.ui.notify(`Model set to ${choice}. It applies to a fresh thread — run /checkpoint or /memento to start one with it.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not change model: ${(error as Error).message}`, "error");
			}
			return;
		}
		if (pick === del) {
			await runDeleteRoomCommand(`${env.agentId} --force-current`, ctx);
		}
	};

	// UI-aligned room commands, each registered under exactly one name (no
	// duplicate aliases). The picker handles list/create/switch (the
	// "dashboard"); in-room you get settings, memory, and leave — mirroring the
	// web room view. Create lives only in the picker; delete lives in /room-settings.
	const roomCommands: Array<{ name: string; description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }> = [
		{ name: "rooms", description: "List or switch rooms", handler: listRoomsHandler },
		{ name: "room-settings", description: "Room workspace & settings", handler: roomSettingsHandler },
		{ name: "checkpoint", description: "Save a room memory checkpoint", handler: runCheckpointCommand },
		{ name: "memento", description: "Reset the room transcript and start fresh", handler: runMementoCommand },
		{ name: "exit", description: "Leave the room (back to the picker)", handler: exitRoomHandler },
	];
	for (const command of roomCommands) {
		pi.registerCommand(command.name, { description: command.description, handler: command.handler });
	}

	// Render the room banner as a TUI header (part of the managed render tree) so
	// it survives terminal resize / maximize — unlike static text printed before
	// the TUI starts. Mirrors the launcher banner; the launcher now only clears.
	pi.on("session_start", async (_event, ctx) => {
		if (!env || !ctx.ui.setHeader) return;
		const roomRecord = listPersistentAgents().find((r) => r.id === env.agentId);
		const name = roomRecord ? displayName(roomRecord) : env.agentId;
		const model = env.model.label || `${env.model.provider}/${env.model.model}`;
		const policy = resolvePersistentRoomCapabilityPolicy(env.agentId, env.threadId).policy;
		let workspace = "none (file tools off)";
		let tools = "none";
		if (policy) {
			const view = persistentRoomCapabilityPolicyView(policy);
			const root = view.roots[0];
			if (isPersistentRoomWorkspaceToolPolicyEnabled(policy) || view.bashEnabled === true) {
				const modeLabel = view.workspaceAccessMode === "localFiles" ? "Full access" : "Bounded workspace";
				const bashLabel = view.workspaceAccessMode === "localFiles" ? `; bash ${view.bashEnabled ? "on" : "off"}` : "";
				workspace = root ? `${root.displayLabel || root.basename} (${modeLabel})` : modeLabel;
				tools = view.allowedToolNames.length > 0
					? `${view.allowedToolNames.join(", ")}${bashLabel}`
					: view.workspaceAccessMode === "localFiles" ? `none${bashLabel}` : "none";
			}
		}
		ctx.ui.setHeader((_tui, theme) => {
			const label = (text: string) => theme.fg("accent", text.padEnd(9));
			const sep = theme.fg("dim", " · ");
			const cmd = (name: string, desc: string) => `${theme.fg("accent", name)} ${theme.fg("dim", desc)}`;
			// Only show the id when it differs from the display name (avoids "test  test").
			const idSuffix = name.toLowerCase() !== env.agentId.toLowerCase() ? `   ${theme.fg("dim", env.agentId)}` : "";
			const commands = [
				cmd("/rooms", "switch"),
				cmd("/room-settings", "settings"),
				cmd("/memento", "reset"),
				cmd("/exit", "leave"),
				cmd("/quit", "quit"),
			].join(sep);
			const staticTop = [
				"",
				...ROOM_WORDMARK.map((line) => `  ${theme.fg("accent", line)}`),
				"",
				`  ${theme.fg("accent", theme.bold("▌ room"))}  ${theme.bold(name)}${idSuffix}`,
				"",
				`  ${label("model")}  ${theme.bold(model)}`,
				`  ${label("workspace")}  ${workspace}`,
			];
			const staticBottom = [`  ${label("tools")}  ${theme.fg("dim", tools)}`, "", `  ${commands}`];

			// Live recent-context usage (throttled so we don't stat the room on every
			// frame). Colour escalates as the buffer approaches the maintain point.
			let memoryValue = theme.fg("dim", "…");
			let memoryAt = 0;
			const readMemory = (): string => {
				const now = Date.now();
				if (now - memoryAt < 2500) return memoryValue;
				memoryAt = now;
				try {
					const status = getPersistentAgentStatus(env.agentId);
					const rc = status.recentContext;
					const level = status.memoryStatus?.recentContextLevel;
					const text = `${rc.fullEntries}/${rc.hardCap} · ${recentContextLevelText(level)}`;
					const color: "error" | "warning" | "dim" = level === "hard_cap" ? "error" : level === "at_soft_cap" ? "warning" : "dim";
					memoryValue = theme.fg(color, text);
				} catch {
					memoryValue = theme.fg("dim", "—");
				}
				return memoryValue;
			};

			return {
				render: (_width: number): string[] => [...staticTop, `  ${label("memory")}  ${readMemory()}`, ...staticBottom],
			};
		});
	});

	pi.on("message_end", async (event) => {
		if (!env) return;
		const role = event.message.role;
		if (role !== "user" && role !== "assistant") return;
		const rawText = textFromContent((event.message as any).content);
		const text = role === "user" ? stripRestoredThreadBlock(rawText) : rawText;
		if (!text) return;
		appendThreadItem({
			kind: role,
			id: threadItemId(role),
			text,
			ts: Date.now(),
			source: "cli",
		});
	});

	pi.on("session_shutdown", async () => {
		if (!env) return;
		if (suppressRoomStandbyOnShutdown) return;
		markRoomStandby();
	});
}
