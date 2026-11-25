// Per-room MCP store smoke: the grants file (defaults, sanitize-on-read, 0600,
// corrupt fallback), grant/revoke validation, the effective configured
// intersection, the connector-delete revoke sweep across rooms, and the
// marker-guarded update-day migration (existing rooms get the full list once,
// rooms created after the marker read as empty). Offline, isolated agents
// root — set BEFORE any src import reads the roots.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-mcp-settings-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	persistentRoomMcpSettingsPath,
	readPersistentRoomMcpSettings,
	writePersistentRoomMcpSettings,
	grantPersistentRoomMcpConnector,
	revokePersistentRoomMcpConnector,
	effectiveGrantedMcpConnectors,
	computeGrantedConnectorStatuses,
	persistentRoomMcpGrantsFingerprint,
	revokeMcpConnectorFromAllRooms,
	ensurePersistentRoomMcpGrantsMigration,
} = await import("../src/persistent-room-mcp-settings.js");

const agentId = "mcp-settings-smoke-room";
const configured = ["figma", "linear", "notion"];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function seedRoomDir(id: string): void {
	fs.mkdirSync(path.join(root, id), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(root, id, "agent.json"), JSON.stringify({ agentId: id }), { mode: 0o600 });
}

try {
	// Default: empty grant list, no file created by reading.
	const initial = readPersistentRoomMcpSettings(agentId);
	assert(initial.schemaVersion === 1, "default schemaVersion must be 1");
	assert(initial.grantedConnectors.length === 0, "default grants must be empty");
	assert(!fs.existsSync(persistentRoomMcpSettingsPath(agentId)), "read must not create the settings file");

	// Grant requires the connector to be configured RIGHT NOW.
	const granted = grantPersistentRoomMcpConnector(agentId, "linear", configured, {}, new Date("2026-08-10T09:00:00.000Z"));
	assert(granted.ok, "granting a configured connector should succeed");
	assert(granted.settings.grantedConnectors.join(",") === "linear", "the grant should be recorded");
	assert(granted.settings.updatedAt === "2026-08-10T09:00:00.000Z", "grant should stamp updatedAt");
	const unknown = grantPersistentRoomMcpConnector(agentId, "hubspot", configured);
	assert(!unknown.ok && unknown.reason === "unknown-connector", "granting an unconfigured connector must be rejected");
	const badName = grantPersistentRoomMcpConnector(agentId, "not a name", configured);
	assert(!badName.ok && badName.reason === "invalid-name", "an invalid connector name must be rejected");
	assert(!revokePersistentRoomMcpConnector(agentId, "../escape").ok, "a path-escaping name must be rejected");

	// The file is 0600; grants are deduped + sorted.
	const settingsPath = persistentRoomMcpSettingsPath(agentId);
	if (process.platform !== "win32") {
		const mode = fs.statSync(settingsPath).mode & 0o777;
		assert(mode === 0o600, `settings file should be 0600, got ${mode.toString(8)}`);
	}
	grantPersistentRoomMcpConnector(agentId, "figma", configured);
	grantPersistentRoomMcpConnector(agentId, "figma", configured);
	const both = readPersistentRoomMcpSettings(agentId);
	assert(both.grantedConnectors.join(",") === "figma,linear", "grants should be deduped and sorted");

	// Fingerprint changes with the grant list (the live-settings rebind key).
	const fingerprintBefore = persistentRoomMcpGrantsFingerprint(agentId);
	grantPersistentRoomMcpConnector(agentId, "notion", configured);
	assert(persistentRoomMcpGrantsFingerprint(agentId) !== fingerprintBefore, "a grant change must change the fingerprint");
	revokePersistentRoomMcpConnector(agentId, "notion");

	// Effective list = granted ∩ configured; dangling grants show as missing.
	fs.writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 1, grantedConnectors: ["figma", "linear", "ghost"], updatedAt: "" }));
	const withDangling = readPersistentRoomMcpSettings(agentId);
	assert(withDangling.grantedConnectors.length === 3, "a dangling grant survives the read");
	assert(effectiveGrantedMcpConnectors(withDangling.grantedConnectors, configured).join(",") === "figma,linear", "the effective list must drop unconfigured grants");
	const statuses = computeGrantedConnectorStatuses(withDangling.grantedConnectors, configured);
	assert(statuses.find((entry) => entry.name === "ghost")?.configured === false, "a dangling grant should report configured: false");
	assert(statuses.filter((entry) => entry.configured).length === 2, "configured grants should report configured: true");

	// Revoke is permissive (cleans dangling) and idempotent.
	const cleaned = revokePersistentRoomMcpConnector(agentId, "ghost");
	assert(cleaned.ok && cleaned.settings.grantedConnectors.join(",") === "figma,linear", "revoking a dangling grant should clean it");
	const noop = revokePersistentRoomMcpConnector(agentId, "ghost");
	assert(noop.ok && noop.settings.grantedConnectors.length === 2, "revoking an absent grant should be a no-op");

	// Corrupt/foreign files degrade to empty instead of throwing.
	fs.writeFileSync(settingsPath, "not json");
	assert(readPersistentRoomMcpSettings(agentId).grantedConnectors.length === 0, "corrupt settings should fall back to empty");
	fs.writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 99, grantedConnectors: ["figma"] }));
	assert(readPersistentRoomMcpSettings(agentId).grantedConnectors.length === 0, "a foreign schemaVersion should fall back to empty");
	fs.writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 1, grantedConnectors: ["figma", "bad name", 7, "figma"], updatedAt: "" }));
	assert(readPersistentRoomMcpSettings(agentId).grantedConnectors.join(",") === "figma", "malformed entries should be dropped on read");
	let threwId = false;
	try {
		readPersistentRoomMcpSettings("../escape");
	} catch (error) {
		threwId = /invalid persistent-room agent id/.test((error as Error).message);
	}
	assert(threwId, "path-escaping agent ids should be rejected");

	// Connector-delete revoke sweep: every room holding the grant loses it,
	// rooms without it are untouched, non-room dirs are skipped. That the grant
	// is gone through the delete route is persistent-room-mcp-grants-api-smoke's.
	seedRoomDir("room-hold-a");
	seedRoomDir("room-hold-b");
	seedRoomDir("room-clean");
	fs.mkdirSync(path.join(root, "not-a-room"), { recursive: true });
	writePersistentRoomMcpSettings("room-hold-a", ["figma", "linear"]);
	writePersistentRoomMcpSettings("room-hold-b", ["figma"]);
	writePersistentRoomMcpSettings("room-clean", ["linear"]);
	const sweep = revokeMcpConnectorFromAllRooms("figma");
	assert(sweep.revokedFrom.sort().join(",") === "room-hold-a,room-hold-b", `the sweep should name exactly the rooms that held the grant, got ${sweep.revokedFrom.join(",")}`);
	assert(sweep.failures.length === 0, `a clean sweep should report no failures, got ${JSON.stringify(sweep.failures)}`);
	assert(readPersistentRoomMcpSettings("room-hold-a").grantedConnectors.join(",") === "linear", "sweep should remove only the deleted connector");
	assert(readPersistentRoomMcpSettings("room-clean").grantedConnectors.join(",") === "linear", "rooms without the grant stay untouched");
	// Writes are atomic (tmp + rename): no temp file may linger after a write.
	assert(!fs.readdirSync(path.join(root, "room-hold-a", "runtime")).some((entry) => entry.endsWith(".tmp")), "settings writes must not leave temp files behind");

	// A room the sweep can't write: every room keeps the grant and its yeses,
	// the ones swept before it and after it alike, so nothing is half removed.
	// A folder's refusal can be forced only off Windows and not as root.
	const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
	if (canForceFsRefusal) {
		const yes = { linear: [{ tool: "list_issues", addressPin: "a".repeat(64) }] };
		seedRoomDir("room-locked");
		seedRoomDir("room-z-after");
		writePersistentRoomMcpSettings("room-hold-a", ["linear"], {}, new Date(), yes);
		writePersistentRoomMcpSettings("room-locked", ["linear"]);
		writePersistentRoomMcpSettings("room-z-after", ["figma", "linear"], {}, new Date(), yes);
		const lockedRuntime = path.join(root, "room-locked", "runtime");
		fs.chmodSync(lockedRuntime, 0o500);
		let refused;
		try {
			refused = revokeMcpConnectorFromAllRooms("linear");
		} finally {
			fs.chmodSync(lockedRuntime, 0o700);
		}
		assert(refused.failures.map((failure) => failure.agentId).join(",") === "room-locked", `the room that can't be written is named, got ${JSON.stringify(refused.failures)}`);
		assert(refused.revokedFrom.length === 0, `a refused sweep takes the grant from no room, got ${refused.revokedFrom.join(",")}`);
		for (const [room, grants, yeses] of [["room-clean", "linear", 0], ["room-hold-a", "linear", 1], ["room-locked", "linear", 0], ["room-z-after", "figma,linear", 1]] as const) {
			const kept = readPersistentRoomMcpSettings(room);
			assert(kept.grantedConnectors.join(",") === grants, `${room} keeps its grants, got ${kept.grantedConnectors.join(",")}`);
			assert((kept.allowedTools.linear ?? []).length === yeses, `${room} keeps its yeses, got ${JSON.stringify(kept.allowedTools)}`);
		}
		// Once the room can be written, the same sweep finishes everywhere.
		const finished = revokeMcpConnectorFromAllRooms("linear");
		assert(finished.failures.length === 0 && finished.revokedFrom.sort().join(",") === "room-clean,room-hold-a,room-locked,room-z-after", `the retry takes it from every room, got ${JSON.stringify(finished)}`);
		assert(readPersistentRoomMcpSettings("room-z-after").grantedConnectors.join(",") === "figma" && !Object.hasOwn(readPersistentRoomMcpSettings("room-z-after").allowedTools, "linear"), "and its yeses with it");

		// A room whose file can't be read, or whose folder can't be, stops the
		// sweep: its grant can't be known. A room's own reading stays empty.
		writePersistentRoomMcpSettings("room-hold-b", ["notion"]);
		writePersistentRoomMcpSettings("room-locked", ["notion"]);
		for (const [what, locked, mode] of [["file", persistentRoomMcpSettingsPath("room-locked"), 0o600], ["folder", path.join(root, "room-locked"), 0o700]] as const) {
			fs.chmodSync(locked, 0o000);
			let unread;
			try {
				unread = revokeMcpConnectorFromAllRooms("notion");
			} finally {
				fs.chmodSync(locked, mode);
			}
			assert(unread.failures.map((failure) => failure.agentId).join(",") === "room-locked" && unread.revokedFrom.length === 0, `a room whose ${what} can't be read stops the sweep, got ${JSON.stringify(unread)}`);
			assert(readPersistentRoomMcpSettings("room-hold-b").grantedConnectors.join(",") === "notion", `a ${what} that can't be read leaves every room its grant`);
		}
		const readable = revokeMcpConnectorFromAllRooms("notion");
		assert(readable.failures.length === 0 && readable.revokedFrom.sort().join(",") === "room-hold-b,room-locked", `once it can be read the sweep takes it everywhere, got ${JSON.stringify(readable)}`);
	}

	// A room file that is there but not settings this version understands
	// stops the sweep only where its text names the connector: a hand repair
	// or another version could read that grant again. One that never names it
	// can't give it back, so it neither stops the sweep nor is rewritten.
	seedRoomDir("room-garbled");
	const garbledPath = persistentRoomMcpSettingsPath("room-garbled");
	fs.mkdirSync(path.dirname(garbledPath), { recursive: true });
	writePersistentRoomMcpSettings("room-hold-b", ["notion"]);
	for (const garbled of ['{"schemaVersion": 1, "grantedConnectors": ["notion", ', JSON.stringify({ schemaVersion: 2, connectors: { notion: {} } })]) {
		fs.writeFileSync(garbledPath, garbled);
		const stopped = revokeMcpConnectorFromAllRooms("notion");
		assert(stopped.failures.map((failure) => failure.agentId).join(",") === "room-garbled" && stopped.revokedFrom.length === 0, `a file not understood that names it stops the sweep, got ${JSON.stringify(stopped)}`);
		assert(readPersistentRoomMcpSettings("room-hold-b").grantedConnectors.join(",") === "notion", "the rooms swept before it keep their grant");
		assert(fs.readFileSync(garbledPath, "utf-8") === garbled, "and the file stays as it was");
		assert(readPersistentRoomMcpSettings("room-garbled").grantedConnectors.length === 0, "the room's own reading of it is still empty");
	}
	// Not named: no name at all, or only a longer name that holds it.
	for (const garbled of ["not json", '{"schemaVersion": 1, "grantedConnectors": ["notion-wiki", ']) {
		writePersistentRoomMcpSettings("room-hold-b", ["notion"]);
		fs.writeFileSync(garbledPath, garbled);
		const passed = revokeMcpConnectorFromAllRooms("notion");
		assert(passed.failures.length === 0 && passed.revokedFrom.join(",") === "room-hold-b", `a file not understood that never names it doesn't stop the sweep, got ${JSON.stringify(passed)} for ${garbled}`);
		assert(fs.readFileSync(garbledPath, "utf-8") === garbled, "the sweep leaves a file it can't understand as it was");
	}
	fs.rmSync(path.join(root, "room-garbled"), { recursive: true, force: true });

	// A delete that fails after the sweep puts every swept room's file back as it was, its yeses included.
	writePersistentRoomMcpSettings("room-hold-b", ["figma", "notion"], {}, new Date("2026-11-19T01:00:00.000Z"), { notion: [{ tool: "search", addressPin: "b".repeat(64) }] });
	const heldText = fs.readFileSync(persistentRoomMcpSettingsPath("room-hold-b"), "utf-8");
	const swept = revokeMcpConnectorFromAllRooms("notion");
	assert(swept.revokedFrom.join(",") === "room-hold-b" && readPersistentRoomMcpSettings("room-hold-b").grantedConnectors.join(",") === "figma", `the sweep takes it first, got ${JSON.stringify(swept)}`);
	assert(swept.undo().length === 0 && fs.readFileSync(persistentRoomMcpSettingsPath("room-hold-b"), "utf-8") === heldText, "undo puts the room's file back exactly");

	// Update-day migration: rooms WITHOUT a settings file get the full current
	// list once; rooms with a file keep it; the marker makes it one-time. The
	// full list and the marker are persistent-room-mcp-scope-smoke's.
	const migrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-mcp-migration-"));
	const options = { persistentAgentsRoot: migrationRoot };
	fs.mkdirSync(path.join(migrationRoot, "legacy-room-one"), { recursive: true });
	fs.writeFileSync(path.join(migrationRoot, "legacy-room-one", "agent.json"), "{}");
	fs.mkdirSync(path.join(migrationRoot, "legacy-room-two"), { recursive: true });
	fs.writeFileSync(path.join(migrationRoot, "legacy-room-two", "agent.json"), "{}");
	fs.mkdirSync(path.join(migrationRoot, "opted-out-room"), { recursive: true });
	fs.writeFileSync(path.join(migrationRoot, "opted-out-room", "agent.json"), "{}");
	writePersistentRoomMcpSettings("opted-out-room", [], options);
	const migrated = ensurePersistentRoomMcpGrantsMigration(configured, options);
	assert(migrated.sort().join(",") === "legacy-room-one,legacy-room-two", `migration should grant only rooms without a file, got ${migrated.join(",")}`);
	assert(readPersistentRoomMcpSettings("opted-out-room", options).grantedConnectors.length === 0, "a room with an existing file keeps it");
	// After the marker: new rooms without a file simply read as empty.
	fs.mkdirSync(path.join(migrationRoot, "new-room"), { recursive: true });
	fs.writeFileSync(path.join(migrationRoot, "new-room", "agent.json"), "{}");
	assert(ensurePersistentRoomMcpGrantsMigration(configured, options).length === 0, "a second migration run must be a no-op");
	assert(readPersistentRoomMcpSettings("new-room", options).grantedConnectors.length === 0, "a room created after the marker defaults to empty");
	fs.rmSync(migrationRoot, { recursive: true, force: true });

	fs.rmSync(root, { recursive: true, force: true });
	console.log("persistent-room-mcp-settings-smoke: OK");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
