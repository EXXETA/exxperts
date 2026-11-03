import fs from "node:fs";
import { settleMemoryBudget } from "./memory-entries-store.js";
import { notesToSortCount } from "./absorb-reread.js";
import { countRecentContextEntries } from "./recent-context-entries.js";
import path from "node:path";
import { readPersistentRoomMaintenanceSettings, overMemoryBudget } from "./persistent-room-maintenance-settings.js";
import { settleCommits } from "./memory-commit.js";
import { sweepForgotten } from "./forget-erase.js";
import { readPersistentRoomLastUsed } from "./persistent-room-last-used.js";
import { type PersistentRoomScheduleSummary, summarizePersistentRoomScheduleJobs, listPersistentRoomScheduleJobs } from "../../../pi-package/extensions/schedule-prompt/index.js";
import { type PersistentAgentPromptBudget, type PersistentAgentStatus, type PersistentAgentStatusValue, REQUIRED_L1B_SECTIONS } from "./persistent-agent-types.js";
import { type AgentJson, createPersistentAgentInstance, defaultPersistentAgentRuntimeState, getPersistentAgentRuntimeState, isPersistentAgentArchived, isValidPersistentAgentId, PERSISTENT_AGENTS_ROOT, readJson, RECENT_CONTEXT_BLOCK_CAP, RECENT_CONTEXT_HARD_CAP, RECENT_CONTEXT_SOFT_CAP } from "./persistent-agent-store.js";
import { activeThreadSummaryForRuntime } from "./persistent-agent-threads.js";
import { clearPersistentAgentUnseenLandedAnswer, estimatePersistentRoomLastUsed, getPersistentAgentUnseenLandedAnswer, unseenLandedAnswerStillReachable } from "./persistent-agent-turns.js";
import { buildMemoryStatus, extractChronosLine, extractMarkdownSections, reviewTargetEstimatedTokensFromL1b } from "./persistent-agent-memory-files.js";
import { buildPersistentAgentBootContext } from "./persistent-agent-boot.js";

export function getPersistentAgentStatus(agentIdRaw: string): PersistentAgentStatus {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const root = instance.rootDir;
	// Status is what every route, the scheduler's classification and the CLI
	// bootstrap read first: a save a crash left pending is settled before the
	// room is described, so nobody sees it half done.
	settleCommits(instance.agentId, root);
	sweepForgotten(instance.agentId, root);
	let scheduleSummary: PersistentRoomScheduleSummary = summarizePersistentRoomScheduleJobs([]);
	const agentJsonPath = instance.agentJsonPath();
	const fallbackL1aPath = path.join(root, "L1a.md");
	const fallbackL1bPath = path.join(root, "L1b", "current.md");
	const fallbackRegistryPath = path.join(root, "section_registry.json");
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!fs.existsSync(root)) {
		const runtime = defaultPersistentAgentRuntimeState(instance.agentId);
		return {
			id: instance.agentId,
			exists: false,
			status: "missing",
			root,
			runtime,
			activeThread: null,
			lastUsedAt: null,
			lastUsedIsEstimate: false,
			l1a: { path: fallbackL1aPath, exists: false },
			l1b: { path: fallbackL1bPath, exists: false, sections: [], missingSections: [...REQUIRED_L1B_SECTIONS] },
			sectionRegistry: { path: fallbackRegistryPath, exists: false, missingSections: [...REQUIRED_L1B_SECTIONS] },
			recentContext: { fullEntries: 0, softCap: RECENT_CONTEXT_SOFT_CAP, hardCap: RECENT_CONTEXT_HARD_CAP, blockCap: RECENT_CONTEXT_BLOCK_CAP },
			memoryStatus: buildMemoryStatus(0, RECENT_CONTEXT_SOFT_CAP, RECENT_CONTEXT_HARD_CAP, null, null, null),
			scheduleSummary,
			errors: ["agent directory does not exist"],
			warnings,
		};
	}

	const meta = readJson(agentJsonPath) as Partial<AgentJson> | null;
	if (!meta) errors.push("agent.json is missing or invalid JSON");
	if (meta?.id && meta.id !== instance.agentId) errors.push(`agent.json id mismatch: ${meta.id}`);

	let l1aPath = fallbackL1aPath;
	let l1bPath = fallbackL1bPath;
	let registryPath = fallbackRegistryPath;
	try {
		l1aPath = instance.l1aPath(meta);
		l1bPath = instance.l1bCurrentPath(meta);
		registryPath = instance.sectionRegistryPath(meta);
	} catch (error) {
		errors.push((error as Error).message);
	}
	const l1aExists = fs.existsSync(l1aPath);
	const l1bExists = fs.existsSync(l1bPath);
	const registryExists = fs.existsSync(registryPath);

	if (!l1aExists) errors.push("L1a.md is missing");
	if (!l1bExists) errors.push("L1b/current.md is missing");
	if (!registryExists) warnings.push("section_registry.json is missing");

	let sections: string[] = [];
	let fullEntries = 0;
	let lastCheckpointAt: string | null = null;
	let lastMemoryWriteAt: string | null = null;
	let notesToSort = 0;
	let reviewTargetEstimatedTokens: number | undefined;
	if (l1bExists) {
		const l1b = fs.readFileSync(l1bPath, "utf-8");
		sections = extractMarkdownSections(l1b);
		fullEntries = countRecentContextEntries(l1b);
		// "memory saved" on the room card is the latest save of either kind: a
		// Remember stamps the checkpoint line, a Memorize the consolidation line,
		// and a card that only watched the first read stale after a Memorize.
		const latestStamp = (labels: string[]): string | null => {
			const stamps = labels
				.map((label) => extractChronosLine(l1b, label))
				.filter((value): value is string => Boolean(value) && !Number.isNaN(new Date(value as string).getTime()));
			return stamps.length ? stamps.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] : null;
		};
		lastCheckpointAt = latestStamp(["Last checkpoint at", "Last consolidation at"]);
		// Every memory write stamps one of these four lines, so none of them
		// means the memory is still the scaffold the room was created with.
		lastMemoryWriteAt = latestStamp(["Last checkpoint at", "Last consolidation at", "Last review at", "Last edit at"]);
		reviewTargetEstimatedTokens = reviewTargetEstimatedTokensFromL1b(l1b);
		notesToSort = notesToSortCount(l1b);
	}
	const missingSections = REQUIRED_L1B_SECTIONS.filter((section) => !sections.includes(section));
	for (const section of missingSections) errors.push(`L1b missing mandatory section: ${section}`);

	let registryMissingSections: string[] = [...REQUIRED_L1B_SECTIONS];
	if (registryExists) {
		const registry = readJson(registryPath);
		const registrySections = registry?.sections && typeof registry.sections === "object" ? Object.keys(registry.sections) : [];
		registryMissingSections = REQUIRED_L1B_SECTIONS.filter((section) => !registrySections.includes(section));
		for (const section of registryMissingSections) warnings.push(`section_registry missing mandatory section: ${section}`);
	}

	let promptBudget: PersistentAgentPromptBudget | undefined;
	// Prompt-budget preview estimates prompt layers only. The required boot contract model is
	// an inert preview placeholder; agent.json.model is optional legacy/status metadata and
	// must not become runtime execution config.
	if (meta && l1aExists && l1bExists) {
		try {
			promptBudget = buildPersistentAgentBootContext({
				agentId: instance.agentId,
				conversationId: "status-preview",
				sessionId: null,
				model: { provider: "status-preview", model: "prompt-budget" },
			}).promptBudget;
		} catch (e) {
			warnings.push(`prompt budget unavailable: ${(e as Error).message}`);
		}
	}

	try {
		scheduleSummary = summarizePersistentRoomScheduleJobs(listPersistentRoomScheduleJobs(instance.agentId));
	} catch (error) {
		warnings.push(`schedule summary unavailable: ${(error as Error).message}`);
	}

	const status: PersistentAgentStatusValue = errors.length > 0 ? "error" : fullEntries >= RECENT_CONTEXT_HARD_CAP ? "needs_absorb" : "ready";
	const archivedAt = Number(meta?.archivedAt ?? 0);
	const archivedBy = typeof meta?.archivedBy === "string" ? meta.archivedBy : undefined;
	const archivedReason = typeof meta?.archivedReason === "string" ? meta.archivedReason : undefined;
	const runtime = getPersistentAgentRuntimeState(instance.agentId);
	let unseenLandedAnswer = getPersistentAgentUnseenLandedAnswer(instance.agentId);
	// Self-heal: the marker is cleared by a web bind, but other surfaces read
	// the answer without one (CLI bind, a thread retired by checkpoint from
	// another door). A marker pointing at a conversation nobody can be "about
	// to see" is dropped here so a file-backed note cannot badge a room forever.
	if (unseenLandedAnswer && !unseenLandedAnswerStillReachable(instance.agentId, unseenLandedAnswer, runtime)) {
		clearPersistentAgentUnseenLandedAnswer(instance.agentId);
		unseenLandedAnswer = null;
	}
	if (l1bExists && !(archivedAt > 0)) settleMemoryBudget(instance.agentId);
	const maintenanceSettings = readPersistentRoomMaintenanceSettings(instance.agentId);
	// A room never stamped (every room on upgrade day) is given an estimate,
	// once; an archived room is left alone until it is restored.
	const lastUsed = readPersistentRoomLastUsed(instance.agentId) ?? (archivedAt > 0 ? null : estimatePersistentRoomLastUsed(instance));
	return {
		id: instance.agentId,
		exists: true,
		status,
		root,
		runtime,
		activeThread: activeThreadSummaryForRuntime(instance.agentId, runtime),
		...(unseenLandedAnswer ? { unseenLandedAnswer } : {}),
		displayName: meta?.displayName,
		description: meta?.description,
		role: meta?.role,
		model: meta?.model,
		// The launcher card seeds an empty room's picker from this and, when the
		// preference lives on a non-active profile, offers switch-and-enter the
		// way a stranded standby room does. Riding the status payload keeps it
		// one fetch — no per-card lookup loop.
		...(Number.isFinite(archivedAt) && archivedAt > 0 ? { archivedAt } : {}),
		...(archivedBy ? { archivedBy } : {}),
		...(archivedReason ? { archivedReason } : {}),
		lastUsedAt: lastUsed?.lastUsedAt ?? null,
		lastUsedIsEstimate: lastUsed?.door === "estimate",
		l1a: { path: l1aPath, exists: l1aExists, bytes: l1aExists ? fs.statSync(l1aPath).size : undefined },
		l1b: { path: l1bPath, exists: l1bExists, bytes: l1bExists ? fs.statSync(l1bPath).size : undefined, sections, missingSections },
		sectionRegistry: { path: registryPath, exists: registryExists, missingSections: registryMissingSections },
		recentContext: { fullEntries, softCap: RECENT_CONTEXT_SOFT_CAP, hardCap: RECENT_CONTEXT_HARD_CAP, blockCap: RECENT_CONTEXT_BLOCK_CAP },
		memoryStatus: buildMemoryStatus(fullEntries, RECENT_CONTEXT_SOFT_CAP, RECENT_CONTEXT_HARD_CAP, typeof meta?.lastCheckpointId === "string" ? meta.lastCheckpointId : null, lastCheckpointAt, lastMemoryWriteAt, notesToSort),
		scheduleSummary,
		promptBudget,
		memoryBudgetTokens: maintenanceSettings.memoryBudgetTokens,
		fastPathSecondApproval: maintenanceSettings.fastPathSecondApproval,
		...(reviewTargetEstimatedTokens !== undefined ? {
			memoryBudget: {
				budgetTokens: maintenanceSettings.memoryBudgetTokens,
				reviewTargetEstimatedTokens,
				overBudget: overMemoryBudget(reviewTargetEstimatedTokens, maintenanceSettings.memoryBudgetTokens),
			},
		} : {}),
		errors,
		warnings,
	};
}

/**
 * The one gate every door into a room passes through — the chat socket and the
 * CLI's bootstrap alike. It is the sibling of the Remember gate below, for the
 * same reason: the hard cap means "Memorize is due", and the product says so
 * while promising that "chatting still works meanwhile". It did not: both doors
 * demanded exactly "ready", so the moment a room's tenth session was saved the
 * room could not be entered at all — and Memorize is reached from outside the
 * room, which made the promise a false one rather than a small inaccuracy.
 *
 * At the block cap only a NEW conversation is refused: one whose open
 * conversation has messages (a scheduled task's, an undo's, another
 * device's) always opens, so nothing is trapped. The refusal names Memorize
 * as the way out and keeps the exact phrase "not ready: needs_absorb", which
 * the surfaces match on to offer the remedy.
 */
export function assertPersistentAgentAcceptsSession(status: PersistentAgentStatus): void {
	if (!status.exists || (status.status !== "ready" && status.status !== "needs_absorb")) {
		throw new Error(`persistent agent is not ready: ${status.status}`);
	}
	const entries = status.recentContext?.fullEntries ?? 0;
	if (entries >= RECENT_CONTEXT_BLOCK_CAP && !status.activeThread?.hasUserVisibleTurns) {
		throw new Error(`persistent agent is not ready: needs_absorb — this room is holding ${entries} saved sessions and cannot be opened until they are folded into its memory. Memorize it from Home → Maintain, then open it again.`);
	}
}

/** The gate every Remember step passes through (409). It never refuses on count: a page past the block cap is saved like any other. */
export function assertPersistentAgentAcceptsCheckpoint(status: PersistentAgentStatus): void {
	if (!status.exists || (status.status !== "ready" && status.status !== "needs_absorb")) throw Object.assign(new Error(`persistent agent scaffold is not ready: ${status.status}`), { statusCode: 409 });
}

/** Every room folder's id, archived rooms included, sorted; reads no room file. */
export function listPersistentAgentIds(): string[] {
	const ids: string[] = [];
	try {
		if (fs.existsSync(PERSISTENT_AGENTS_ROOT)) {
			for (const entry of fs.readdirSync(PERSISTENT_AGENTS_ROOT, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				if (!isValidPersistentAgentId(entry.name)) continue;
				ids.push(entry.name);
			}
		}
	} catch {
		// Preserve list compatibility: if the object store cannot currently be
		// scanned, return the discovered set rather than injecting a default room.
	}
	return ids.sort((a, b) => a.localeCompare(b));
}

export function listPersistentAgents(): PersistentAgentStatus[] {
	return listPersistentAgentIds()
		.map((id) => getPersistentAgentStatus(id))
		.filter((status) => !isPersistentAgentArchived(status));
}
