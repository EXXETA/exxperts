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
	// Default: off, 20k budget, no file created by reading.
	const initial = readPersistentRoomMaintenanceSettings(agentId);
	assert(initial.fastPathSecondApproval === false, "default fast-path must be off");
	assert(initial.quickCheckpointAutoApply === false, "default quick-checkpoint auto-apply must be off");
	assert(initial.memoryBudgetTokens === 20_000, "default memory budget must be 20k tokens");
	assert(!fs.existsSync(persistentRoomMaintenanceSettingsPath(agentId)), "read must not create the settings file");

	// Write/read round-trip.
	const written = writePersistentRoomMaintenanceSettings(agentId, { fastPathSecondApproval: true }, {}, new Date("2026-07-03T12:00:00.000Z"));
	assert(written.fastPathSecondApproval === true, "write should persist the toggle");
	assert(written.quickCheckpointAutoApply === false, "fast-path write should leave quick-checkpoint auto-apply off");
	assert(written.memoryBudgetTokens === 20_000, "toggle-only write should keep the default budget");
	assert(written.updatedAt === "2026-07-03T12:00:00.000Z", "write should stamp updatedAt");
	const reread = readPersistentRoomMaintenanceSettings(agentId);
	assert(reread.fastPathSecondApproval === true, "reread should see the persisted toggle");

	// Quick-checkpoint auto-apply: both choices round-trip, partial writes merge.
	const quickOn = writePersistentRoomMaintenanceSettings(agentId, { quickCheckpointAutoApply: true });
	assert(quickOn.quickCheckpointAutoApply === true, "quick-checkpoint auto-apply write should persist");
	assert(quickOn.fastPathSecondApproval === true, "quick-checkpoint write should preserve the fast-path toggle");
	assert(readPersistentRoomMaintenanceSettings(agentId).quickCheckpointAutoApply === true, "reread should see quick-checkpoint auto-apply on");
	const quickOff = writePersistentRoomMaintenanceSettings(agentId, { quickCheckpointAutoApply: false });
	assert(quickOff.quickCheckpointAutoApply === false, "quick-checkpoint auto-apply off should persist");
	assert(readPersistentRoomMaintenanceSettings(agentId).quickCheckpointAutoApply === false, "reread should see quick-checkpoint auto-apply off");
	writePersistentRoomMaintenanceSettings(agentId, { quickCheckpointAutoApply: true });
	let quickThrew = false;
	try {
		writePersistentRoomMaintenanceSettings(agentId, { quickCheckpointAutoApply: "yes" as unknown as boolean });
	} catch (error) {
		quickThrew = /quickCheckpointAutoApply must be a boolean/.test((error as Error).message);
	}
	assert(quickThrew, "non-boolean quick-checkpoint auto-apply should be rejected");

	// Memory budget: partial writes merge, values clamp to 10k–50k.
	const withBudget = writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: 30_000 });
	assert(withBudget.memoryBudgetTokens === 30_000, "budget write should persist");
	assert(withBudget.fastPathSecondApproval === true, "budget-only write should preserve the toggle");
	assert(withBudget.quickCheckpointAutoApply === true, "budget-only write should preserve quick-checkpoint auto-apply");
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

	// Validation.
	let threw = false;
	try {
		writePersistentRoomMaintenanceSettings(agentId, { fastPathSecondApproval: "yes" as unknown as boolean });
	} catch (error) {
		threw = /must be a boolean/.test((error as Error).message);
	}
	assert(threw, "non-boolean input should be rejected");
	let threwId = false;
	try {
		readPersistentRoomMaintenanceSettings("../escape");
	} catch (error) {
		threwId = /invalid persistent-room agent id/.test((error as Error).message);
	}
	assert(threwId, "path-escaping agent ids should be rejected");

	// A record written before the quick-checkpoint field existed reads as off.
	fs.writeFileSync(persistentRoomMaintenanceSettingsPath(agentId), JSON.stringify({ schemaVersion: 1, fastPathSecondApproval: true, memoryBudgetTokens: 30_000, updatedAt: "2026-07-01T00:00:00.000Z" }, null, 2) + "\n", "utf-8");
	const legacy = readPersistentRoomMaintenanceSettings(agentId);
	assert(legacy.quickCheckpointAutoApply === false, "legacy record without the field should read as quick-checkpoint auto-apply off");
	assert(legacy.fastPathSecondApproval === true, "legacy record should keep its stored fast-path toggle");

	// Corrupt file falls back to defaults.
	fs.writeFileSync(persistentRoomMaintenanceSettingsPath(agentId), "not json", "utf-8");
	assert(readPersistentRoomMaintenanceSettings(agentId).fastPathSecondApproval === false, "corrupt settings should fall back to default off");
	assert(readPersistentRoomMaintenanceSettings(agentId).quickCheckpointAutoApply === false, "corrupt settings should fall back to quick-checkpoint auto-apply off");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("persistent-room maintenance settings smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
