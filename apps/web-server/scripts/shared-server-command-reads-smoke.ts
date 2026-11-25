// The two room-settings reads that report a room's commands, on the desktop
// and on a shared server, through the real routes: the Folder pane's
// `GET /workspace-default` (`commandsStartOn`) and the chip's
// `GET /bash-settings` (`autoApprove`). A room brings the two files a desktop
// room can hold, a kept "on" from Stop using (`commands-kept.json`) and an
// older app's Run without asking (`bash-settings.json`). The desktop reads
// them; a shared server reads neither, answers as for a room with none, and
// leaves both files as they were. The stored modes' own rows are in
// room-command-modes-smoke.ts, the kept file's in folder-pane-smoke.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-command-reads-home-"));
const agentsRoot = path.join(tempHome, "rooms");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.PI_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;
delete process.env.EXXETA_PERSISTENT_ROOM_AGENT;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function row(name: string, body: () => Promise<void>): Promise<void> {
	try {
		await body();
		console.log(`ok: ${name}`);
	} catch (error) {
		console.error(`FAIL: ${name}\n${(error as Error).stack}`);
		process.exitCode = 1;
	}
}

const boxAvailable = await import("../src/room-box/box-available.js");
// A Mac, where a new room's commands can start on: the desktop's rows read the files as such a room does.
boxAvailable.setRoomBoxForTests({ platform: "darwin", windows: null });
await import("../src/room-settings-routes.js");
const { app, AUTH_HEADER_NAME, AUTH_TOKEN } = await import("../src/server-app.js");
app.log.level = "silent";
const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
const { registerServerHooks } = await import("../src/server-hooks.js");

const runtimeFile = (room: string, name: string) => path.join(agentsRoot, room, "runtime", name);
const KEPT = "commands-kept.json";
const SETTINGS = "bash-settings.json";

/** A room with no folder that brings a kept "on" and an older app's yes, and nothing else of its commands. */
function roomWithStoredCommands(name: string): string {
	const room = String(createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId);
	fs.rmSync(runtimeFile(room, "commands-start-on.json"), { force: true });
	fs.writeFileSync(runtimeFile(room, KEPT), JSON.stringify({ schemaVersion: 1, commands: "on", canChangeFiles: true }) + "\n");
	fs.writeFileSync(runtimeFile(room, SETTINGS), JSON.stringify({ schemaVersion: 1, autoApprove: true, updatedAt: "2026-01-01T00:00:00.000Z" }) + "\n");
	return room;
}

const filesOf = (room: string) => [KEPT, SETTINGS].map((name) => fs.readFileSync(runtimeFile(room, name), "utf-8"));

async function read(room: string, tail: "/workspace-default" | "/bash-settings"): Promise<any> {
	const answer = await app.inject({ method: "GET", url: `/api/persistent-agents/${room}${tail}`, headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN } });
	assert(answer.statusCode === 200, `${tail} answered ${answer.statusCode}: ${answer.body}`);
	return answer.json();
}

const desktopRoom = roomWithStoredCommands("Desktop Room");
const sharedRoom = roomWithStoredCommands("Shared Room");

try {
	await row("on the desktop a kept on and an older app's yes are read: commands start on, and run without asking", async () => {
		const folderPane = await read(desktopRoom, "/workspace-default");
		assert(folderPane.policy === null && folderPane.commandsStartOn === true, `the Folder pane's answer: ${JSON.stringify(folderPane)}`);
		const chip = await read(desktopRoom, "/bash-settings");
		assert(chip.settings.autoApprove === true, `the chip's answer: ${JSON.stringify(chip.settings)}`);
	});

	// Last: a shared server stays one for the rest of this process. Registered as its entry does.
	registerServerHooks({ ignoresStoredWorkspaceSettings: () => true });
	const before = filesOf(sharedRoom);

	await row("on a shared server the Folder pane's read says commands don't start on, and leaves both files", async () => {
		const folderPane = await read(sharedRoom, "/workspace-default");
		assert(folderPane.policy === null && folderPane.commandsStartOn === false, `the Folder pane's answer: ${JSON.stringify(folderPane)}`);
		assert(JSON.stringify(filesOf(sharedRoom)) === JSON.stringify(before), `the read changed the files: ${JSON.stringify(filesOf(sharedRoom))}`);
	});

	await row("on a shared server the chip's read answers as for a room with no setting, and leaves both files", async () => {
		const chip = await read(sharedRoom, "/bash-settings");
		assert(JSON.stringify(chip.settings) === JSON.stringify({ schemaVersion: 1, autoApprove: false, updatedAt: "" }), `the chip's answer: ${JSON.stringify(chip.settings)}`);
		assert(JSON.stringify(filesOf(sharedRoom)) === JSON.stringify(before), `the read changed the files: ${JSON.stringify(filesOf(sharedRoom))}`);
	});
} finally {
	boxAvailable.setRoomBoxForTests(null);
	await app.close();
	fs.rmSync(tempHome, { recursive: true, force: true });
}
if (process.exitCode) process.exit();
console.log("shared-server-command-reads-smoke: ok");
