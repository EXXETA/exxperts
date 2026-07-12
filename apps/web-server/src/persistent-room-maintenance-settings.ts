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
 * `quickCheckpointAutoApply` governs the default Checkpoint button: when true
 * (the default, matching historical behaviour) a blocker-free proposal is
 * approved immediately without showing the preview; when false the quick
 * button still generates the proposal but always falls back to the manual
 * preview for approval. Proposals with blockers fall back to the preview
 * either way, and the server-side propose/approve split is unchanged.
 *
 * `memoryBudgetTokens` is the room's advisory memory budget: the size the
 * whole L1b should stay near. It never gates anything — it drives the
 * settings meter, the room-card nudge, and a target line in the absorb /
 * structural-review proposal prompts. Estimated tokens ≈ chars / 4, the same
 * estimate used everywhere else.
 */
export interface PersistentRoomMaintenanceSettings {
	schemaVersion: 1;
	fastPathSecondApproval: boolean;
	quickCheckpointAutoApply: boolean;
	memoryBudgetTokens: number;
	updatedAt: string;
}

export interface PersistentRoomMaintenanceSettingsStorageOptions {
	persistentAgentsRoot?: string;
}

export const MEMORY_BUDGET_MIN_TOKENS = 10_000;
export const MEMORY_BUDGET_MAX_TOKENS = 50_000;
export const MEMORY_BUDGET_DEFAULT_TOKENS = 20_000;

function clampMemoryBudgetTokens(value: unknown): number {
	const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : MEMORY_BUDGET_DEFAULT_TOKENS;
	return Math.min(MEMORY_BUDGET_MAX_TOKENS, Math.max(MEMORY_BUDGET_MIN_TOKENS, num));
}

const DEFAULT_SETTINGS: PersistentRoomMaintenanceSettings = {
	schemaVersion: 1,
	fastPathSecondApproval: false,
	quickCheckpointAutoApply: true,
	memoryBudgetTokens: MEMORY_BUDGET_DEFAULT_TOKENS,
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
			// Settings files written before this field existed must keep the
			// historical auto-apply behaviour, so only an explicit false disables.
			quickCheckpointAutoApply: raw.quickCheckpointAutoApply !== false,
			memoryBudgetTokens: clampMemoryBudgetTokens(raw.memoryBudgetTokens),
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function writePersistentRoomMaintenanceSettings(agentIdRaw: string, input: { fastPathSecondApproval?: unknown; quickCheckpointAutoApply?: unknown; memoryBudgetTokens?: unknown }, options: PersistentRoomMaintenanceSettingsStorageOptions = {}, now = new Date()): PersistentRoomMaintenanceSettings {
	if (input?.fastPathSecondApproval !== undefined && typeof input.fastPathSecondApproval !== "boolean") throw new Error("fastPathSecondApproval must be a boolean");
	if (input?.quickCheckpointAutoApply !== undefined && typeof input.quickCheckpointAutoApply !== "boolean") throw new Error("quickCheckpointAutoApply must be a boolean");
	if (input?.memoryBudgetTokens !== undefined && (typeof input.memoryBudgetTokens !== "number" || !Number.isFinite(input.memoryBudgetTokens))) throw new Error("memoryBudgetTokens must be a number");
	const current = readPersistentRoomMaintenanceSettings(agentIdRaw, options);
	const settingsPath = persistentRoomMaintenanceSettingsPath(agentIdRaw, options);
	const settings: PersistentRoomMaintenanceSettings = {
		schemaVersion: 1,
		fastPathSecondApproval: input?.fastPathSecondApproval !== undefined ? input.fastPathSecondApproval as boolean : current.fastPathSecondApproval,
		quickCheckpointAutoApply: input?.quickCheckpointAutoApply !== undefined ? input.quickCheckpointAutoApply as boolean : current.quickCheckpointAutoApply,
		memoryBudgetTokens: input?.memoryBudgetTokens !== undefined ? clampMemoryBudgetTokens(input.memoryBudgetTokens) : current.memoryBudgetTokens,
		updatedAt: now.toISOString(),
	};
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
	return settings;
}
