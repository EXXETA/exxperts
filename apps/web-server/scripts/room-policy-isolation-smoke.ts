// Can one room read another's tool policy? A room's policy reaches the
// permissions extension through settings the whole server process shares, so
// the answer rests on three things this smoke runs or reads: the extension
// reads them once, before anything can interleave, and keeps what it read; two
// wrappers started together each keep their own room's list; and no other code
// under apps/web-server/src or pi-package/extensions uses the settings' names.
// That search cannot see a copy of the whole environment, and a room's terminal
// gets one (getShellEnv in the runtime's utils/shell.ts). So this also checks
// that after two wrappers overlap the settings hold nothing and a terminal
// started then inherits none of them.
//
// Offline: the real extension and the real background wrapper with a fake `pi`,
// and the source of the two places that set the settings.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import permissionsExt from "../../../pi-package/extensions/permissions/index.js";
import { getShellEnv } from "../../../runtime/packages/coding-agent/src/utils/shell.js";

const { createPersistentRoomPermissionsExtension } = await import("../src/persistent-room-background-execution.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const SETTING_NAMES = ["SESSION", "AGENT", "WORKSPACE_ACCESS_MODE", "WORKSPACE_TOOLS", "BASH_ENABLED", "EXECUTION_CONTEXT"].map((name) => `EXXETA_PERSISTENT_ROOM_${name}`);
const FILE_TOOLS = ["read", "ls", "find", "grep", "write", "edit", "bash"];

type RoomValues = { agent: string; mode: "bounded" | "localFiles"; tools: string; bash?: boolean };
type Handler = (event: { toolName: string; input: object }, ctx: object) => Promise<{ block?: boolean } | undefined>;

function setRoomValues(room: RoomValues): void {
	process.env.EXXETA_PERSISTENT_ROOM_SESSION = "1";
	process.env.EXXETA_PERSISTENT_ROOM_AGENT = room.agent;
	process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_ACCESS_MODE = room.mode;
	process.env.EXXETA_PERSISTENT_ROOM_WORKSPACE_TOOLS = room.tools;
	process.env.EXXETA_PERSISTENT_ROOM_BASH_ENABLED = room.bash ? "1" : "";
	process.env.EXXETA_PERSISTENT_ROOM_EXECUTION_CONTEXT = "manual";
}

function clearRoomValues(): void {
	for (const name of SETTING_NAMES) delete process.env[name];
}

function settingsNow(): Record<string, string> {
	return Object.fromEntries(SETTING_NAMES.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]!]])));
}

function fakePi(): { pi: unknown; handler: () => Handler } {
	const handlers: Handler[] = [];
	return {
		pi: { on(eventName: string, handler: Handler) { if (eventName === "tool_call") handlers.push(handler); } },
		handler: () => {
			assert(handlers.length === 1, `the extension registers one tool_call handler, got ${handlers.length}`);
			return handlers[0];
		},
	};
}

async function assertPasses(handler: Handler, room: string, expected: string[]): Promise<void> {
	for (const toolName of FILE_TOOLS) {
		const result = await handler({ toolName, input: {} }, {});
		const passed = result?.block !== true;
		assert(passed === expected.includes(toolName), `${room}'s handler should ${expected.includes(toolName) ? "pass" : "block"} ${toolName}, with settings now ${JSON.stringify(settingsNow())}`);
	}
	// The policy's baseline, in every room: what passes above is the room's own grant and nothing took the gate down.
	assert((await handler({ toolName: "memory_search", input: {} }, {}))?.block !== true, `${room}'s handler passes the baseline tools`);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const extensionFile = path.join(repoRoot, "pi-package", "extensions", "permissions", "index.ts");
const bracketFiles = ["room-socket.ts", "persistent-room-background-execution.ts"].map((name) => path.join(repoRoot, "apps", "web-server", "src", name));
const WRITE_LINE = /^\s*(?:delete process\.env\.EXXETA_PERSISTENT_ROOM_\w+;|process\.env\.EXXETA_PERSISTENT_ROOM_\w+ = )/m;

function sourceFilesUnder(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "scripts" ? [] : sourceFilesUnder(full);
		return /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
	});
}

const withoutComments = (source: string): string => source.split("\n").filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join("\n");

clearRoomValues();
try {
	// --- 1. The read ends with the call ------------------------------------------
	const roomA: RoomValues = { agent: "room-a", mode: "localFiles", tools: "read,ls", bash: true };
	const roomB: RoomValues = { agent: "room-b", mode: "bounded", tools: "write,edit" };
	const installedA = fakePi();
	const installedB = fakePi();
	setRoomValues(roomA);
	const doneA = (permissionsExt as any)(installedA.pi);
	setRoomValues(roomB);
	const doneB = (permissionsExt as any)(installedB.pi);
	clearRoomValues();
	await Promise.all([doneA, doneB]);
	await assertPasses(installedA.handler(), "room A", ["read", "ls", "bash"]);
	await assertPasses(installedB.handler(), "room B", ["write", "edit"]);
	setRoomValues(roomB);
	await assertPasses(installedA.handler(), "room A, with room B's values set afterwards", ["read", "ls", "bash"]);
	setRoomValues(roomA);
	await assertPasses(installedB.handler(), "room B, with room A's values set afterwards", ["write", "edit"]);
	clearRoomValues();

	// --- 2. Overlapping wrappers -------------------------------------------------
	const overlapA = fakePi();
	const overlapB = fakePi();
	await Promise.all([
		createPersistentRoomPermissionsExtension("room-a", ["read", "ls"], true, "bounded")(overlapA.pi),
		createPersistentRoomPermissionsExtension("room-b", ["write", "edit"], true, "localFiles")(overlapB.pi),
	]);
	const afterOverlap = settingsNow();
	const terminalAfterOverlap = getShellEnv();
	const toolsOff = fakePi();
	await createPersistentRoomPermissionsExtension("room-c", [], false, "bounded")(toolsOff.pi);
	const afterToolsOff = settingsNow();
	await assertPasses(overlapA.handler(), "the first overlapping room", ["read", "ls"]);
	await assertPasses(overlapB.handler(), "the second overlapping room", ["write", "edit"]);
	await assertPasses(toolsOff.handler(), "the room with workspace tools off", []);
	const inherited = SETTING_NAMES.filter((name) => terminalAfterOverlap[name] !== undefined);
	assert(Object.keys(afterOverlap).length === 0 && inherited.length === 0, `nothing stays after an overlap, but the settings hold ${JSON.stringify(afterOverlap)} and a terminal inherits ${JSON.stringify(inherited)}`);
	assert(Object.keys(afterToolsOff).length === 0, `nothing stays after a later call with workspace tools off, but the settings hold ${JSON.stringify(afterToolsOff)}`);

	// The other side of that check: a terminal does inherit the settings while they are set.
	setRoomValues(roomA);
	assert(getShellEnv().EXXETA_PERSISTENT_ROOM_AGENT === "room-a", "a terminal inherits a setting that is set");
	clearRoomValues();

	// Started while another room's call is still open, so that room's values are in the settings.
	const stillOpen = fakePi();
	const toolsOffDuringCall = fakePi();
	await Promise.all([
		createPersistentRoomPermissionsExtension("room-a", ["read", "ls"], true, "bounded")(stillOpen.pi),
		createPersistentRoomPermissionsExtension("room-c", [], false, "bounded")(toolsOffDuringCall.pi),
	]);
	await assertPasses(stillOpen.handler(), "the room whose call was open", ["read", "ls"]);
	await assertPasses(toolsOffDuringCall.handler(), "the room with workspace tools off, started during another room's call", []);

	// --- 3. No gap in either bracket, and no other reader ------------------------
	for (const file of bracketFiles) {
		const source = fs.readFileSync(file, "utf-8");
		const call = "await (permissionsExt as any)(pi);";
		assert(source.split(call).length === 2, `${path.basename(file)} calls the extension once, in its bracket`);
		const firstWrite = source.search(WRITE_LINE);
		const callAt = source.indexOf(call);
		assert(firstWrite !== -1 && firstWrite < callAt, `${path.basename(file)} writes the settings before the call`);
		assert(!/\bawait\b/.test(source.slice(firstWrite, callAt)), `${path.basename(file)} has no await between the first setting write and the extension's call`);
		assert(/await \(permissionsExt as any\)\(pi\);\s*\} finally \{\s*clearPersistentRoomSettings\(\);\s*\}/.test(source), `${path.basename(file)} clears the settings straight after the extension's call`);
	}
	const extensionSource = fs.readFileSync(extensionFile, "utf-8");
	const lastRead = extensionSource.lastIndexOf("process.env.EXXETA_PERSISTENT_ROOM_");
	assert(lastRead !== -1 && !/\bawait\b/.test(extensionSource.slice(0, lastRead)), "the extension's file has no await before its last read");

	const readers = [...sourceFilesUnder(path.join(repoRoot, "apps", "web-server", "src")), ...sourceFilesUnder(path.join(repoRoot, "pi-package", "extensions"))];
	assert(readers.includes(extensionFile) && bracketFiles.every((file) => readers.includes(file)), "the search covers the extension and both brackets");
	for (const file of readers) {
		if (file === extensionFile) continue;
		const lines = withoutComments(fs.readFileSync(file, "utf-8")).split("\n").filter((line) => line.includes("EXXETA_PERSISTENT_ROOM"));
		if (!bracketFiles.includes(file)) {
			assert(lines.length === 0, `only the extension and the two brackets use the settings, but ${path.relative(repoRoot, file)} has: ${lines[0]?.trim()}`);
			continue;
		}
		for (const line of lines) {
			const writes = /^\s*(?:delete process\.env\.EXXETA_PERSISTENT_ROOM_\w+;|process\.env\.EXXETA_PERSISTENT_ROOM_\w+ = )/.test(line);
			assert(writes, `${path.basename(file)} only writes the settings, but has: ${line.trim()}`);
		}
	}

	console.log("room-policy-isolation-smoke: OK");
} finally {
	clearRoomValues();
}
