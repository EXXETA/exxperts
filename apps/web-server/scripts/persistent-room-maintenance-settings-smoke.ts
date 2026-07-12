import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-maintenance-settings-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	persistentRoomMaintenanceSettingsPath,
	readPersistentRoomMaintenanceSettings,
	writePersistentRoomMaintenanceSettings,
} = await import("../src/persistent-room-maintenance-settings.js");

const agentId = "maintenance-settings-smoke-room";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

try {
	// Default: off, quick-checkpoint auto-apply on, 20k budget, no file created by reading.
	const initial = readPersistentRoomMaintenanceSettings(agentId);
	assert(initial.fastPathSecondApproval === false, "default fast-path must be off");
	assert(initial.quickCheckpointAutoApply === true, "default quick-checkpoint auto-apply must be on");
	assert(initial.memoryBudgetTokens === 20_000, "default memory budget must be 20k tokens");
	assert(!fs.existsSync(persistentRoomMaintenanceSettingsPath(agentId)), "read must not create the settings file");

	// Write/read round-trip.
	const written = writePersistentRoomMaintenanceSettings(agentId, { fastPathSecondApproval: true }, {}, new Date("2026-07-03T12:00:00.000Z"));
	assert(written.fastPathSecondApproval === true, "write should persist the toggle");
	assert(written.memoryBudgetTokens === 20_000, "toggle-only write should keep the default budget");
	assert(written.updatedAt === "2026-07-03T12:00:00.000Z", "write should stamp updatedAt");
	const reread = readPersistentRoomMaintenanceSettings(agentId);
	assert(reread.fastPathSecondApproval === true, "reread should see the persisted toggle");

	// Memory budget: partial writes merge, values clamp to 10k–50k.
	const withBudget = writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: 30_000 });
	assert(withBudget.memoryBudgetTokens === 30_000, "budget write should persist");
	assert(withBudget.fastPathSecondApproval === true, "budget-only write should preserve the toggle");
	assert(readPersistentRoomMaintenanceSettings(agentId).memoryBudgetTokens === 30_000, "reread should see the persisted budget");
	assert(writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: 5_000 }).memoryBudgetTokens === 10_000, "budget should clamp up to 10k");
	assert(writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: 90_000 }).memoryBudgetTokens === 50_000, "budget should clamp down to 50k");
	let budgetThrew = false;
	try {
		writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: "big" as unknown as number });
	} catch (error) {
		budgetThrew = /must be a number/.test((error as Error).message);
	}
	assert(budgetThrew, "non-numeric budget should be rejected");
	writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: 20_000 });

	// File location and mode.
	const settingsPath = persistentRoomMaintenanceSettingsPath(agentId);
	assert(settingsPath === path.join(root, agentId, "runtime", "maintenance-settings.json"), "settings file should live under the room runtime dir");
	if (process.platform !== "win32") {
		// POSIX only: Windows has no file-mode bits, stat reports 666 regardless.
		const mode = fs.statSync(settingsPath).mode & 0o777;
		assert(mode === 0o600, `settings file should be 0600, got ${mode.toString(8)}`);
	}

	// Toggle back off.
	writePersistentRoomMaintenanceSettings(agentId, { fastPathSecondApproval: false });
	assert(readPersistentRoomMaintenanceSettings(agentId).fastPathSecondApproval === false, "toggle off should persist");

	// Quick-checkpoint auto-apply: off round-trips, other writes preserve it,
	// and settings files written before the field existed keep auto-apply on.
	const quickOff = writePersistentRoomMaintenanceSettings(agentId, { quickCheckpointAutoApply: false });
	assert(quickOff.quickCheckpointAutoApply === false, "quick auto-apply off should persist");
	assert(quickOff.fastPathSecondApproval === false, "quick auto-apply write should preserve the fast-path toggle");
	assert(readPersistentRoomMaintenanceSettings(agentId).quickCheckpointAutoApply === false, "reread should see quick auto-apply off");
	assert(writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: 25_000 }).quickCheckpointAutoApply === false, "budget-only write should preserve quick auto-apply");
	writePersistentRoomMaintenanceSettings(agentId, { quickCheckpointAutoApply: true });
	assert(readPersistentRoomMaintenanceSettings(agentId).quickCheckpointAutoApply === true, "quick auto-apply back on should persist");
	const legacy = JSON.parse(fs.readFileSync(persistentRoomMaintenanceSettingsPath(agentId), "utf-8"));
	delete legacy.quickCheckpointAutoApply;
	fs.writeFileSync(persistentRoomMaintenanceSettingsPath(agentId), JSON.stringify(legacy, null, 2) + "\n", "utf-8");
	assert(readPersistentRoomMaintenanceSettings(agentId).quickCheckpointAutoApply === true, "legacy settings without the field should keep auto-apply on");

	// Validation.
	let threw = false;
	try {
		writePersistentRoomMaintenanceSettings(agentId, { fastPathSecondApproval: "yes" as unknown as boolean });
	} catch (error) {
		threw = /must be a boolean/.test((error as Error).message);
	}
	assert(threw, "non-boolean input should be rejected");
	let quickThrew = false;
	try {
		writePersistentRoomMaintenanceSettings(agentId, { quickCheckpointAutoApply: "yes" as unknown as boolean });
	} catch (error) {
		quickThrew = /quickCheckpointAutoApply must be a boolean/.test((error as Error).message);
	}
	assert(quickThrew, "non-boolean quick auto-apply should be rejected");
	let threwId = false;
	try {
		readPersistentRoomMaintenanceSettings("../escape");
	} catch (error) {
		threwId = /invalid persistent-room agent id/.test((error as Error).message);
	}
	assert(threwId, "path-escaping agent ids should be rejected");

	// Corrupt file falls back to defaults.
	fs.writeFileSync(persistentRoomMaintenanceSettingsPath(agentId), "not json", "utf-8");
	assert(readPersistentRoomMaintenanceSettings(agentId).fastPathSecondApproval === false, "corrupt settings should fall back to default off");
	assert(readPersistentRoomMaintenanceSettings(agentId).quickCheckpointAutoApply === true, "corrupt settings should fall back to auto-apply on");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("persistent-room maintenance settings smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
