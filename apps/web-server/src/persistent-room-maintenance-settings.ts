import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";

/**
 * Per-room memory-maintenance preferences.
 *
 * `fastPathSecondApproval` lets the web UI apply a warning-free absorb or
 * prune proposal immediately after generation instead of showing the final
 * approval screen. The first approval (assessment sign-off) always remains
 * manual, proposals carrying warnings always fall back to the manual screen,
 * and the server-side propose/approve split is unchanged — this file only
 * stores the preference.
 *
 * `quickCheckpointAutoApply` lets the web UI approve a blocker-free quick
 * Checkpoint proposal immediately instead of showing the preview. Proposals
 * carrying deterministic blockers always fall back to the preview, every save
 * still archives the previous memory and writes an audit record, and the
 * server-side propose/approve split is unchanged — this file only stores the
 * preference. Default off: a room saves nothing without review until it
 * explicitly opts in, and records written before the field existed read as
 * off too.
 *
 * `memoryBudgetTokens` is the room's memory budget. It binds on the
 * REVIEW TARGET — Deep Memory + Active Items — not the whole L1b (decision
 * 2026-08-26): Recent Context is transient intake that Memorize clears, and
 * Chronos is system-managed and near-constant, so counting either would nudge
 * the wrong process. It drives the settings meter, the room-card badge, and
 * the memory-page bar (all through `overMemoryBudget` below), the budget
 * section in the Memorize and Review proposal prompts, and the fast-path
 * refusal of over-budget-after outcomes. It never hard-gates a manual
 * approval: a user can always approve an over-budget outcome — disclosed —
 * and there is always a working way back under.
 * Estimated tokens ≈ chars / 4, the same estimate used everywhere else.
 *
 * `memoryBudgetSettled` says the budget has met the room's own memory file
 * once (settleMemoryBudget in memory-entries-store.ts): a room that came from
 * 0.11.2 with the default budget starts at its own size, every other room
 * keeps what it has, and either way the question is asked exactly once.
 * Written by the settle only; absent on disk reads as not yet settled.
 */
export interface PersistentRoomMaintenanceSettings {
	schemaVersion: 1;
	fastPathSecondApproval: boolean;
	quickCheckpointAutoApply: boolean;
	memoryBudgetTokens: number;
	memoryBudgetSettled: boolean;
	/** the budget the settle chose when it resized the room's budget; absent when the settle left the budget alone */
	memoryBudgetSettledTo?: number;
	updatedAt: string;
}

export interface PersistentRoomMaintenanceSettingsStorageOptions {
	persistentAgentsRoot?: string;
}

export const MEMORY_BUDGET_MIN_TOKENS = 10_000;
// The ceiling, raised from 50k with memory v2 (decision 2026-09-12): the
// server now enforces the budget deterministically on every maintenance write,
// so a large room's first v2 run would archive two thirds of its memory unless
// its owner can set a budget that keeps what is there. The DEFAULT stays 20k —
// the ceiling is headroom for rooms that have earned it, not a new normal.
export const MEMORY_BUDGET_MAX_TOKENS = 80_000;
export const MEMORY_BUDGET_DEFAULT_TOKENS = 20_000;

/** A budget as the cards say it — "20k", "52k" — the web UI's fmtTokenLimit, for the sentences the server writes. */
export function formatTokenLimit(tokens: number): string {
	return `${Math.round(tokens / 1000)}k`;
}

// The ONE over-budget comparison. Every surface — server status, meters,
// badges, bars, and the enforcement loop — calls this; never re-derive
// the predicate or its denominator at a render site.
export function overMemoryBudget(reviewTargetEstimatedTokens: number, budgetTokens: number): boolean {
	return reviewTargetEstimatedTokens > budgetTokens;
}

// READ path only: a hand-edited or older file must still yield a usable budget.
function clampMemoryBudgetTokens(value: unknown): number {
	const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : MEMORY_BUDGET_DEFAULT_TOKENS;
	return Math.min(MEMORY_BUDGET_MAX_TOKENS, Math.max(MEMORY_BUDGET_MIN_TOKENS, num));
}

// WRITE path: a budget outside the range is refused, never quietly clamped.
// The budget is now enforced exactly on every maintenance write, so storing a
// number the caller did not ask for would silently decide what a room forgets.
function assertMemoryBudgetInRange(value: number): number {
	const num = Math.round(value);
	if (num < MEMORY_BUDGET_MIN_TOKENS || num > MEMORY_BUDGET_MAX_TOKENS) {
		throw new Error(`The memory budget must be between ${MEMORY_BUDGET_MIN_TOKENS} and ${MEMORY_BUDGET_MAX_TOKENS} tokens.`);
	}
	return num;
}

const DEFAULT_SETTINGS: PersistentRoomMaintenanceSettings = {
	schemaVersion: 1,
	fastPathSecondApproval: false,
	quickCheckpointAutoApply: false,
	memoryBudgetTokens: MEMORY_BUDGET_DEFAULT_TOKENS,
	memoryBudgetSettled: false,
	updatedAt: "",
};

function safeSettingsAgentId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("invalid persistent-room agent id");
	return id;
}

export function persistentRoomMaintenanceSettingsPath(agentIdRaw: string, options: PersistentRoomMaintenanceSettingsStorageOptions = {}): string {
	const agentId = safeSettingsAgentId(agentIdRaw);
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), "runtime", "maintenance-settings.json");
}

export function readPersistentRoomMaintenanceSettings(agentIdRaw: string, options: PersistentRoomMaintenanceSettingsStorageOptions = {}): PersistentRoomMaintenanceSettings {
	const settingsPath = persistentRoomMaintenanceSettingsPath(agentIdRaw, options);
	try {
		if (!fs.existsSync(settingsPath)) return { ...DEFAULT_SETTINGS };
		const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return { ...DEFAULT_SETTINGS };
		return {
			schemaVersion: 1,
			fastPathSecondApproval: raw.fastPathSecondApproval === true,
			// Absent means off: records written before the field existed stay
			// review-first until the room explicitly opts in.
			quickCheckpointAutoApply: raw.quickCheckpointAutoApply === true,
			memoryBudgetTokens: clampMemoryBudgetTokens(raw.memoryBudgetTokens),
			memoryBudgetSettled: raw.memoryBudgetSettled === true,
			...(typeof raw.memoryBudgetSettledTo === "number" && Number.isFinite(raw.memoryBudgetSettledTo) ? { memoryBudgetSettledTo: Math.round(raw.memoryBudgetSettledTo) } : {}),
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function writePersistentRoomMaintenanceSettings(agentIdRaw: string, input: { fastPathSecondApproval?: unknown; quickCheckpointAutoApply?: unknown; memoryBudgetTokens?: unknown; memoryBudgetSettled?: unknown; memoryBudgetSettledTo?: unknown }, options: PersistentRoomMaintenanceSettingsStorageOptions = {}, now = new Date()): PersistentRoomMaintenanceSettings {
	if (input?.fastPathSecondApproval !== undefined && typeof input.fastPathSecondApproval !== "boolean") throw new Error("fastPathSecondApproval must be a boolean");
	if (input?.quickCheckpointAutoApply !== undefined && typeof input.quickCheckpointAutoApply !== "boolean") throw new Error("quickCheckpointAutoApply must be a boolean");
	if (input?.memoryBudgetTokens !== undefined && (typeof input.memoryBudgetTokens !== "number" || !Number.isFinite(input.memoryBudgetTokens))) throw new Error("memoryBudgetTokens must be a number");
	if (input?.memoryBudgetSettled !== undefined && typeof input.memoryBudgetSettled !== "boolean") throw new Error("memoryBudgetSettled must be a boolean");
	if (input?.memoryBudgetSettledTo !== undefined && (typeof input.memoryBudgetSettledTo !== "number" || !Number.isFinite(input.memoryBudgetSettledTo))) throw new Error("memoryBudgetSettledTo must be a number");
	const current = readPersistentRoomMaintenanceSettings(agentIdRaw, options);
	const settingsPath = persistentRoomMaintenanceSettingsPath(agentIdRaw, options);
	const settings: PersistentRoomMaintenanceSettings = {
		schemaVersion: 1,
		fastPathSecondApproval: input?.fastPathSecondApproval !== undefined ? input.fastPathSecondApproval as boolean : current.fastPathSecondApproval,
		quickCheckpointAutoApply: input?.quickCheckpointAutoApply !== undefined ? input.quickCheckpointAutoApply as boolean : current.quickCheckpointAutoApply,
		memoryBudgetTokens: input?.memoryBudgetTokens !== undefined ? assertMemoryBudgetInRange(input.memoryBudgetTokens as number) : current.memoryBudgetTokens,
		memoryBudgetSettled: input?.memoryBudgetSettled !== undefined ? input.memoryBudgetSettled as boolean : current.memoryBudgetSettled,
		...((input?.memoryBudgetSettledTo !== undefined ? input.memoryBudgetSettledTo as number : current.memoryBudgetSettledTo) !== undefined ? { memoryBudgetSettledTo: (input?.memoryBudgetSettledTo !== undefined ? input.memoryBudgetSettledTo as number : current.memoryBudgetSettledTo) } : {}),
		updatedAt: now.toISOString(),
	};
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
	return settings;
}
