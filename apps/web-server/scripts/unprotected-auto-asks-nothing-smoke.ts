// A room with protection off on Auto asks the person nothing: a connector's
// tools run with no card, and the file tools read and change files outside the
// room's folders with no folder card, the person's keys included, while the
// app's own data and the connector settings stay closed.
// The first rows run the room's own gate and file tools in this process; the
// rest run a real server, a gateway that plays the model, real room windows
// and a stand-in connector over standard input and output. Each refusal sits
// beside a row that runs, and a protected room, a room on Ask and a shared
// server still ask or refuse as before.
// Run: npm run smokes -- unprotected-auto-asks-nothing
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { RoomBox } from "../src/room-box/box-session.js";

if (os.platform() === "win32") {
	console.log("SKIPPED: the stand-in connector and the hard links here are written for a Mac or Linux; the Windows wait's row runs on a Mac too");
	process.exit(0);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const webServerDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-asks-nothing-")));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
// This process's own modules read the throwaway home too, so they are loaded only after it is set.
Object.assign(process.env, { HOME: home, USERPROFILE: home, EXXPERTS_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot });
delete process.env.EXXPERTS_STATE_HOME;
delete process.env.EXXPERTS_DATA_DIR;

const { authedFetch, freePort, putRunWithoutAsking, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, waitForServer } = await import("./smoke-server-process.js");
type AuthedFetchInit = Parameters<typeof authedFetch>[1];
const { waitForTurnSettled } = await import("./smoke-turn-settle.js");
const { waitEvery } = await import("./smoke-wait.js");
const policyMod = await import("../src/persistent-room-workspace-policy.js");
const { PERSISTENT_ROOM_READONLY_WORKSPACE_TOOL_NAMES } = await import("../src/persistent-room-tool-policy.js");
const { createPersistentRoomWorkspaceTools, openedWithoutAsking } = await import("../src/persistent-room-workspace-tools.js");
const { closedRefusal, linkRefused, neverChanged, outsideFence, readOnlyFolder, skillsFolderRefusal } = await import("../src/room-files.js");
const { notEnoughSpace, tooLargeForTool } = await import("../src/room-box/box-files.js");
const { FolderWait } = await import("../src/room-box/windows/folder-wait.js");
const { FILE_WORKER } = await import("../src/room-box/box-process.js");
const { writePersistentRoomMcpSettings } = await import("../src/persistent-room-mcp-settings.js");
const { addAlsoAllowedFolder, saveAlsoAllowedFolders } = await import("../src/room-box/also-allowed.js");
const { roomScopedMcpToolRegistration } = await import("../../../pi-package/extensions/mcp/room-scope.js");
const { contentPolicyBlockReason, RULE_WORDS } = await import("../../../pi-package/extensions/content-policy/words.js");
const { persistentRoomProtection, writePersistentRoomProtection } = await import("../src/persistent-room-protection.js");
const { unprotectedRoomOnAuto, unprotectedRoomOnAutoIn, writePersistentRoomBashSettings } = await import("../src/persistent-room-bash-settings.js");
const { registerServerHooks } = await import("../src/server-hooks.js");
const { RUN_WITHOUT_ASKING_BODY } = await import("../src/room-box/card-text.js");
const { enablePersistentRoomSkill } = await import("../src/persistent-room-skill-settings.js");
const { readLibrarySkill, roomSkillFolders } = await import("../src/skills-executable.js");

const waitUntil = waitEvery(25, 30_000);
const MODEL = { provider: "openai-compatible", model: "room-model" };
// The state's line in the room-state message (persistent-agent-boot.ts), by its opening words.
const STATE_LINE = "The person chose to let this room work without asking";

// --- The places: the room's folder, a folder of the person's outside it, and what stays closed.
const roomFolder = path.join(home, "Rooms", "Notes room");
const outside = path.join(home, "Documents", "Reports");
const signInFile = path.join(agentDir, "auth.json");
const connectorFile = path.join(agentDir, "mcp.json");
const sharedConnectorFile = path.join(home, ".config", "mcp", "mcp.json");
for (const dir of [roomFolder, outside, path.dirname(sharedConnectorFile), path.join(appRoot, "rooms-data"), path.join(home, ".exxperts-work"), path.join(home, "keys")]) fs.mkdirSync(dir, { recursive: true });
const writeSetting = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(outside, "q3.txt"), "Q3 revenue: 12\n");
fs.writeFileSync(path.join(appRoot, "rooms-data", "other-room.json"), "{}\n");
fs.writeFileSync(path.join(home, ".exxperts-work", "profile.json"), "{}\n");
writeSetting(sharedConnectorFile, { mcpServers: {} });

// --- The stand-in connector: a program that answers over standard input and output and counts its calls.
const connectorDir = path.join(tempRoot, "connector");
fs.mkdirSync(connectorDir);
const calledFile = path.join(connectorDir, "called.txt");
const connectorScript = path.join(connectorDir, "standin.cjs");
fs.writeFileSync(connectorScript, `
const fs = require("node:fs");
const tools = [
	{ name: "make_note", description: "Make a note", inputSchema: { type: "object" } },
	{ name: "wipe_notes", description: "Wipe the notes", inputSchema: { type: "object" } },
	{ name: "read_notes", description: "Read the notes", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let end;
	while ((end = buffer.indexOf("\\n")) !== -1) {
		const message = JSON.parse(buffer.slice(0, end));
		buffer = buffer.slice(end + 1);
		if (message.id === undefined) continue;
		let result;
		if (message.method === "initialize") result = { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "standin", version: "1.0.0" } };
		else if (message.method === "tools/list") result = { tools };
		else if (message.method === "resources/list") result = { resources: [] };
		else if (message.method === "tools/call") {
			fs.appendFileSync(${JSON.stringify(calledFile)}, message.params.name + "\\n");
			result = { content: [{ type: "text", text: message.params.name + " done" }] };
		}
		process.stdout.write(JSON.stringify(result ? { jsonrpc: "2.0", id: message.id, result } : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } }) + "\\n");
	}
});
`);
const connectorEntry = { command: process.execPath, args: [connectorScript] };
const writeConnectors = (excludeTools?: string[]) => writeSetting(connectorFile, { mcpServers: { standin: { ...connectorEntry, ...(excludeTools ? { excludeTools } : {}) } } });
writeConnectors();
writeSetting(signInFile, { "openai-compatible": { type: "api_key", key: "synthetic-asks-nothing" } });
const called = (): string[] => (fs.existsSync(calledFile) ? fs.readFileSync(calledFile, "utf8").split("\n").filter(Boolean) : []);
const resetCalls = () => fs.rmSync(calledFile, { force: true });

let failures = 0;
async function row(name: string, body: () => Promise<void | string> | void): Promise<void> {
	try {
		const skipped = await body();
		console.log(skipped ? `skip ${name}: ${skipped}` : `ok   ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${name}: ${(error as Error).message}`);
	}
}

// =============================================================================
// In this process: the room's own file tools and gate, given whether the room asks nothing.
// =============================================================================
const toolRoom = "asks-nothing-tools-room";
function toolsOf(options: { asksNothing?: () => boolean; asks?: () => boolean; canChange?: boolean; folderWait?: InstanceType<typeof FolderWait>; freeSpace?: (folder: string) => number; box?: RoomBox } = {}) {
	const policy = policyMod.createPersistentRoomCapabilityPolicy({
		agentId: toolRoom, conversationId: "conversation-a", repoRoot, root: roomFolder, workspaceAccessMode: "localFiles", source: "manual",
		...(options.canChange === false ? { toolSelection: { kind: "custom", allowedToolNames: [...PERSISTENT_ROOM_READONLY_WORKSPACE_TOOL_NAMES] } } : {}),
	} as any);
	const tools = new Map(createPersistentRoomWorkspaceTools(policy, { asksNothing: options.asksNothing, asks: options.asks, folderWait: options.folderWait, freeSpace: options.freeSpace, box: options.box }).map((tool) => [String(tool.name), tool]));
	return async (name: string, params: Record<string, unknown>): Promise<{ failed: boolean; text: string }> => {
		const tool = tools.get(name);
		if (!tool) return { failed: true, text: `no ${name} tool` };
		try {
			const result = await tool.execute(`call-${name}`, params as any, undefined, undefined, undefined as any);
			return { failed: false, text: result.content.map((part: any) => part.text ?? "").join("") };
		} catch (error) {
			return { failed: true, text: (error as Error).message };
		}
	};
}
const inOutside = (name: string) => path.join(outside, name);

await row("1 asks nothing: read, write and edit outside the room's folders go through, with nothing to answer", async () => {
	const call = toolsOf({ asksNothing: () => true });
	const read = await call("read", { path: inOutside("q3.txt") });
	assert(!read.failed && read.text.includes("Q3 revenue: 12"), `read outside: ${read.text}`);
	const wrote = await call("write", { path: inOutside("summary.txt"), content: "Summary\n" });
	assert(!wrote.failed && fs.readFileSync(inOutside("summary.txt"), "utf8") === "Summary\n", `write outside: ${wrote.text}`);
	const edited = await call("edit", { path: inOutside("summary.txt"), edits: [{ oldText: "Summary", newText: "Short summary" }] });
	assert(!edited.failed && fs.readFileSync(inOutside("summary.txt"), "utf8") === "Short summary\n", `edit outside: ${edited.text}`);
	const listed = await call("ls", { path: outside });
	assert(!listed.failed && listed.text.includes("q3.txt"), `ls outside: ${listed.text}`);
	const found = await call("grep", { pattern: "revenue", path: outside });
	assert(!found.failed && found.text.includes("q3.txt"), `grep outside: ${found.text}`);
});

await row("2 outside the state, and with the state's reader throwing, the same outside paths are refused", async () => {
	for (const [label, asksNothing] of [["on Ask", () => false], ["the reader throws", () => { throw new Error("unreadable"); }], ["no reader", undefined]] as const) {
		const call = toolsOf({ asksNothing });
		const read = await call("read", { path: inOutside("q3.txt") });
		assert(read.failed && read.text === outsideFence(inOutside("q3.txt")), `${label}: read outside, got ${read.text}`);
		const wrote = await call("write", { path: inOutside("other.txt"), content: "x" });
		assert(wrote.failed && !fs.existsSync(inOutside("other.txt")), `${label}: write outside, got ${wrote.text}`);
	}
});

await row("3 Can change files off: outside, read goes through; the room has no write or edit tool to change it with", async () => {
	const call = toolsOf({ asksNothing: () => true, canChange: false });
	const read = await call("read", { path: inOutside("q3.txt") });
	assert(!read.failed && read.text.includes("Q3 revenue"), `read: ${read.text}`);
	const wrote = await call("write", { path: inOutside("new.txt"), content: "x" });
	assert(wrote.failed && wrote.text === "no write tool" && !fs.existsSync(inOutside("new.txt")), `write: ${wrote.text}`);
	const edited = await call("edit", { path: inOutside("q3.txt"), edits: [{ oldText: "12", newText: "13" }] });
	assert(edited.failed && edited.text === "no edit tool" && fs.readFileSync(inOutside("q3.txt"), "utf8") === "Q3 revenue: 12\n", `edit: ${edited.text}`);
});

// Another name for the sign-in file and the connector settings files: a hard link a command could have made.
const signInAlias = path.join(outside, "notes-backup.txt");
const connectorAlias = path.join(outside, "settings-copy.txt");
const sharedConnectorAlias = path.join(outside, "list.txt");
fs.linkSync(signInFile, signInAlias);
fs.linkSync(connectorFile, connectorAlias);
fs.linkSync(sharedConnectorFile, sharedConnectorAlias);
await row("4 still closed in the state, each for a read and a write: the app's data, a sibling profile, both connector settings files, and the sign-in and connector files under another name", async () => {
	const call = toolsOf({ asksNothing: () => true });
	const closed: Array<[string, string]> = [
		["the app's data", path.join(appRoot, "rooms-data", "other-room.json")],
		["the sign-in file", signInFile],
		["a sibling profile", path.join(home, ".exxperts-work", "profile.json")],
		["the connector settings", connectorFile],
		["the shared connector settings", sharedConnectorFile],
		["the sign-in file under another name", signInAlias],
		["the connector file under another name", connectorAlias],
		["the shared connector file under another name", sharedConnectorAlias],
	];
	for (const [label, place] of closed) {
		const before = fs.readFileSync(place, "utf8");
		const read = await call("read", { path: place });
		assert(read.failed && read.text === closedRefusal(place) && !read.text.includes("synthetic"), `${label}: read, got ${read.text}`);
		const wrote = await call("write", { path: place, content: "changed", overwrite: true });
		assert(wrote.failed && fs.readFileSync(place, "utf8") === before, `${label}: write, got ${wrote.text}`);
		const edited = await call("edit", { path: place, edits: [{ oldText: before.slice(0, 2), newText: "zz" }] });
		assert(edited.failed && fs.readFileSync(place, "utf8") === before, `${label}: edit, got ${edited.text}`);
	}
	const searched = await call("grep", { pattern: "synthetic", path: outside });
	assert(!searched.text.includes("synthetic-asks-nothing"), `grep beyond the folders leaves out the sign-in file under another name, got ${searched.text}`);
	// The neighbour: an ordinary file beside the aliases opens.
	const neighbour = await call("read", { path: inOutside("q3.txt") });
	assert(!neighbour.failed, `the ordinary file beside them: ${neighbour.text}`);
});

// The person's keys, outside the room's folders and inside them.
const KEY_LINE = "synthetic-key-line";
const keyFiles = [
	inOutside(".env"), inOutside(".env.local"), path.join(home, "keys", "server.pem"), path.join(home, "keys", "server.key"), path.join(home, "keys", "id_rsa"), path.join(home, ".ssh", "config"), path.join(home, ".aws", "credentials"),
	path.join(roomFolder, ".env"), path.join(roomFolder, "certs", "server.pem"), path.join(roomFolder, "id_ed25519"), path.join(roomFolder, ".ssh", "config"), path.join(roomFolder, ".aws", "credentials"),
];
const keyText = (file: string) => `${KEY_LINE} ${path.basename(file)}\n`;
const plantKeys = () => {
	for (const file of keyFiles) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, keyText(file));
	}
};
plantKeys();

await row("23 in the state the person's keys open: a .env, a .pem, a .key, an id_rsa and files under .ssh and .aws/credentials are read, written and edited, outside the room's folders and inside them, with nothing to answer", async () => {
	const call = toolsOf({ asksNothing: () => true });
	const made = path.join(home, ".ssh", "id_ed25519");
	try {
		for (const file of keyFiles) {
			const read = await call("read", { path: file });
			assert(!read.failed && read.text.includes(keyText(file).trim()), `read ${file}: ${read.text}`);
			const wrote = await call("write", { path: file, content: "KEY=written\n", overwrite: true });
			assert(!wrote.failed && fs.readFileSync(file, "utf8") === "KEY=written\n", `write ${file}: ${wrote.text}`);
			const edited = await call("edit", { path: file, edits: [{ oldText: "written", newText: "edited" }] });
			assert(!edited.failed && fs.readFileSync(file, "utf8") === "KEY=edited\n", `edit ${file}: ${edited.text}`);
		}
		const created = await call("write", { path: made, content: "new key\n" });
		assert(!created.failed && fs.readFileSync(made, "utf8") === "new key\n", `a new key file: ${created.text}`);
	} finally {
		fs.rmSync(made, { force: true });
		plantKeys();
	}
});

/** The text lines of one tool call, as the model reads them. */
const linesOf = (text: string) => text.split("\n");
const LEFT_OUT_WORDS = "left out: secret files or the app's own data.";
const RIPGREP_OFF = "EXXETA_BOUNDED_GREP_DISABLE_RIPGREP";

await row("24 in the state ls, find and grep show and search the keys, outside the room's folders and inside them, with either search engine; outside the state, in the room's folder, they leave them out", async () => {
	const free = toolsOf({ asksNothing: () => true });
	const listed = await free("ls", { path: roomFolder });
	assert(!listed.failed && [".env", "id_ed25519", ".ssh/", ".aws/", "certs/"].every((entry) => linesOf(listed.text).includes(entry)) && !listed.text.includes("left out"), `ls in the room's folder: ${listed.text}`);
	const listedOutside = await free("ls", { path: path.join(home, "keys") });
	assert(!listedOutside.failed && ["server.pem", "server.key", "id_rsa"].every((entry) => linesOf(listedOutside.text).includes(entry)) && !listedOutside.text.includes("left out"), `ls outside: ${listedOutside.text}`);
	const found = await free("find", { pattern: "**/*", path: roomFolder });
	assert(!found.failed && [".env", "certs/server.pem", "id_ed25519", ".ssh/config", ".aws/credentials"].every((entry) => linesOf(found.text).includes(entry)), `find in the room's folder: ${found.text}`);
	const foundOutside = await free("find", { pattern: "config", path: path.join(home, ".ssh") });
	assert(!foundOutside.failed && linesOf(foundOutside.text).includes(path.join(home, ".ssh", "config")), `find outside: ${foundOutside.text}`);
	const engines: Array<[string, string | undefined]> = [["the walk", "1"], ["ripgrep where there is one", undefined]];
	for (const [engine, off] of engines) {
		const saved = process.env[RIPGREP_OFF];
		if (off) process.env[RIPGREP_OFF] = off;
		else delete process.env[RIPGREP_OFF];
		try {
			const inRoom = await free("grep", { pattern: KEY_LINE, path: roomFolder });
			for (const file of keyFiles.filter((file) => file.startsWith(roomFolder))) {
				assert(inRoom.text.includes(`${path.relative(roomFolder, file)}:1: ${keyText(file).trim()}`), `${engine}: grep in the room's folder misses ${file}: ${inRoom.text}`);
			}
			const beyond = await free("grep", { pattern: KEY_LINE, path: home });
			for (const file of keyFiles.filter((file) => !file.startsWith(roomFolder))) {
				assert(beyond.text.includes(`${file}:1: ${keyText(file).trim()}`), `${engine}: grep beyond the folders misses ${file}: ${beyond.text}`);
			}
		} finally {
			if (saved === undefined) delete process.env[RIPGREP_OFF];
			else process.env[RIPGREP_OFF] = saved;
		}
	}
	// The neighbour outside the state: the same folder hides them and says so.
	const onAsk = toolsOf({ asksNothing: () => false });
	const hidden = await onAsk("ls", { path: roomFolder });
	assert(!hidden.failed && [".env", "id_ed25519", ".ssh/"].every((entry) => !linesOf(hidden.text).includes(entry)) && linesOf(hidden.text).includes("certs/") && hidden.text.includes(LEFT_OUT_WORDS), `ls on Ask: ${hidden.text}`);
	const unfound = await onAsk("find", { pattern: "**/*", path: roomFolder });
	assert(!unfound.failed && [".env", "certs/server.pem", ".ssh/config"].every((entry) => !linesOf(unfound.text).includes(entry)) && unfound.text.includes(LEFT_OUT_WORDS), `find on Ask: ${unfound.text}`);
	const unsearched = await onAsk("grep", { pattern: KEY_LINE, path: roomFolder });
	assert(!unsearched.failed && !unsearched.text.includes(KEY_LINE), `grep on Ask: ${unsearched.text}`);
});

// What a command in the room can already change: git's hooks and settings, a
// launch agent, the names other programs run from and the startup files.
const runsLater: Array<[string, string]> = [
	["a git hook in a repository in the room's folder", path.join(roomFolder, "repo", ".git", "hooks", "pre-commit")],
	["git's settings in a repository in the room's folder", path.join(roomFolder, "repo", ".git", "config")],
	["a git hook in a repository outside", inOutside(path.join("repo", ".git", "hooks", "pre-commit"))],
	["git's settings in a repository outside", inOutside(path.join("repo", ".git", "config"))],
	["~/.gitconfig", path.join(home, ".gitconfig")],
	["a launch agent", path.join(home, "Library", "LaunchAgents", "com.example.agent.plist")],
	["a file under .husky in the room's folder", path.join(roomFolder, ".husky", "pre-commit")],
	[".vscode/tasks.json in the room's folder", path.join(roomFolder, ".vscode", "tasks.json")],
	[".vscode/tasks.json outside", inOutside(path.join(".vscode", "tasks.json"))],
	["a file under .claude in the room's folder", path.join(roomFolder, ".claude", "settings.json")],
	["a file under .claude outside", inOutside(path.join(".claude", "settings.json"))],
	["~/.zshrc", path.join(home, ".zshrc")],
	["~/.npmrc", path.join(home, ".npmrc")],
];
// A file in a `.git` folder that isn't there yet makes a new repository.
const newGitFolders: Array<[string, string]> = [
	["a new .git folder in the room's folder", path.join(roomFolder, "fresh", ".git", "HEAD")],
	["a new .git folder outside", inOutside(path.join("fresh", ".git", "HEAD"))],
];
const KEPT = "kept\n";
const plantRunsLater = () => {
	for (const [, file] of runsLater) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, KEPT);
	}
	for (const [, file] of newGitFolders) fs.rmSync(path.dirname(file), { recursive: true, force: true });
};
const inRoomFolder = (file: string) => file.startsWith(`${roomFolder}${path.sep}`);
const homeStartup = (file: string) => [".zshrc", ".npmrc"].some((name) => file === path.join(home, name));

/** Reads, writes and edits a file the room's commands can change; a new `.git` file is made, then edited. */
async function changedWithNothingToAnswer(call: ReturnType<typeof toolsOf>, file: string, made = false): Promise<void> {
	if (!made) {
		const read = await call("read", { path: file });
		assert(!read.failed && read.text.includes("kept"), `read: ${read.text}`);
	}
	const wrote = await call("write", { path: file, content: "changed\n", ...(made ? {} : { overwrite: true }) });
	assert(!wrote.failed && fs.readFileSync(file, "utf8") === "changed\n", `write: ${wrote.text}`);
	const edited = await call("edit", { path: file, edits: [{ oldText: "changed", newText: "edited" }] });
	assert(!edited.failed && fs.readFileSync(file, "utf8") === "edited\n", `edit: ${edited.text}`);
}

plantRunsLater();
for (const [label, file] of [...runsLater, ...newGitFolders]) {
	await row(`25 in the state ${label} is ${newGitFolders.some(([, made]) => made === file) ? "made" : "read"}, written and edited with nothing to answer, where the server writes it`, async () => {
		try {
			await changedWithNothingToAnswer(toolsOf({ asksNothing: () => true }), file, newGitFolders.some(([, made]) => made === file));
		} finally {
			plantRunsLater();
		}
	});
}

/** The refusal outside the state, as on main: the room's folder reads them and never changes them, outside it nothing opens, and the home folder's startup files are closed. */
function refusedAsOnMain(file: string): { read: string | null; write: string } {
	if (homeStartup(file)) return { read: closedRefusal(file), write: closedRefusal(file) };
	if (inRoomFolder(file)) return { read: null, write: neverChanged(file) };
	return { read: outsideFence(file), write: outsideFence(file) };
}

async function asOnMain(call: ReturnType<typeof toolsOf>, label: string, file: string): Promise<void> {
	const expected = refusedAsOnMain(file);
	const made = newGitFolders.some(([, entry]) => entry === file);
	if (!made) {
		const read = await call("read", { path: file });
		assert(expected.read === null ? !read.failed && read.text.includes("kept") : read.failed && read.text === expected.read, `${label}: read ${file}, got ${read.text}`);
	}
	const wrote = await call("write", { path: file, content: "changed\n", overwrite: true });
	assert(wrote.failed && wrote.text === expected.write && (made ? !fs.existsSync(file) : fs.readFileSync(file, "utf8") === KEPT), `${label}: write ${file}, got ${wrote.text}`);
	if (made) return;
	const edited = await call("edit", { path: file, edits: [{ oldText: "kept", newText: "changed" }] });
	assert(edited.failed && edited.text === expected.write && fs.readFileSync(file, "utf8") === KEPT, `${label}: edit ${file}, got ${edited.text}`);
}

await row("30 outside the state each of those is as on main: on Ask, in a protected room, with a reader that throws and with no reader", async () => {
	const readers: Array<[string, (() => boolean) | undefined]> = [
		["on Ask", () => false],
		["a protected room", () => unprotectedRoomOnAutoIn(toolRoom, "conversation-a", { state: "on" })],
		["the reader throws", () => { throw new Error("unreadable"); }],
		["no reader (a scheduled run)", undefined],
	];
	for (const [label, asksNothing] of readers) {
		const call = toolsOf({ asksNothing });
		for (const [, file] of [...runsLater, ...newGitFolders]) await asOnMain(call, label, file);
	}
});

await row("31 in the state, where the Mac's box writes in the room's folder, those names are read, written and edited there too, as outside the room's folders, which the server writes", async () => {
	const call = toolsOf({ asksNothing: () => true, box: standInBox(path.join(appRoot, "skills", "none")) });
	try {
		for (const [label, file] of [...runsLater, ...newGitFolders]) {
			await changedWithNothingToAnswer(call, file, newGitFolders.some(([, entry]) => entry === file)).catch((error: Error) => {
				throw new Error(`${label}: ${error.message}`);
			});
			plantRunsLater();
		}
	} finally {
		plantRunsLater();
	}
});

await row("33 ask_for_folder in the state says what a write would find: a folder other programs run from in the room's folder can be changed, as can an ordinary folder and one outside it", async () => {
	const policy = policyMod.createPersistentRoomCapabilityPolicy({ agentId: toolRoom, conversationId: "conversation-a", repoRoot, root: roomFolder, workspaceAccessMode: "localFiles", source: "manual" } as any);
	const asked = (folder: string): string => {
		try {
			return openedWithoutAsking(policy, folder, "write").real;
		} catch (error) {
			return (error as Error).message;
		}
	};
	const editorFolder = path.join(roomFolder, ".vscode");
	const plainFolder = path.join(roomFolder, "docs");
	const outsideEditor = inOutside(".vscode");
	for (const folder of [editorFolder, plainFolder, outsideEditor]) fs.mkdirSync(folder, { recursive: true });
	try {
		for (const folder of [editorFolder, plainFolder, outsideEditor]) assert(asked(folder) === folder, `${folder}: ${asked(folder)}`);
	} finally {
		fs.rmSync(plainFolder, { recursive: true, force: true });
		plantRunsLater();
	}
});

await row("33b ask_for_folder in the state says what a read finds of a Keynote deck's name in an approved skill's folder: a file with no deck in it is refused by both, a deck beside it opens for both", async () => {
	const skill = path.join(agentDir, "skills", "deck-maker");
	const plain = path.join(skill, "server.key");
	const deck = path.join(skill, "talk.key");
	fs.mkdirSync(skill, { recursive: true });
	fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: deck-maker\ndescription: makes decks\n---\n\nRead talk.key.\n");
	fs.writeFileSync(plain, `${KEY_LINE} skill key\n`);
	fs.writeFileSync(deck, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("deck")]));
	try {
		assert(enablePersistentRoomSkill(toolRoom, "deck-maker", readLibrarySkill).ok, "the skill switches on");
		const policy = policyMod.createPersistentRoomCapabilityPolicy({ agentId: toolRoom, conversationId: "conversation-a", repoRoot, root: roomFolder, workspaceAccessMode: "localFiles", source: "manual" } as any);
		const call = toolsOf({ asksNothing: () => true, box: standInBox(fs.realpathSync.native(skill)) });
		for (const [file, opens] of [[plain, false], [deck, true]] as const) {
			let asked: string;
			try {
				asked = openedWithoutAsking(policy, file, "read").real;
			} catch (error) {
				asked = (error as Error).message;
			}
			const read = await call("read", { path: file });
			assert((asked === fs.realpathSync.native(file)) === opens && read.failed === !opens && !read.text.includes("skill key"), `${path.basename(file)}: asked ${asked}; read ${read.failed ? "refused" : "opened"}: ${read.text}`);
		}
	} finally {
		fs.rmSync(path.join(agentDir, "skills"), { recursive: true, force: true });
	}
});

// Still refused in the state, each beside a neighbour that opens.
await row("29a in the state a file under a folder named .exxperts stays closed for a read and a write, in the room's folder and outside; one under .vscode beside it opens", async () => {
	const call = toolsOf({ asksNothing: () => true });
	for (const base of [roomFolder, outside]) {
		const closed = path.join(base, "copy", ".exxperts", "notes.txt");
		const open = path.join(base, "copy", ".vscode", "notes.txt");
		for (const file of [closed, open]) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, KEPT);
		}
		try {
			const read = await call("read", { path: closed });
			assert(read.failed && read.text === closedRefusal(closed), `read ${closed}: ${read.text}`);
			const wrote = await call("write", { path: closed, content: "changed\n", overwrite: true });
			assert(wrote.failed && wrote.text === closedRefusal(closed) && fs.readFileSync(closed, "utf8") === KEPT, `write ${closed}: ${wrote.text}`);
			await changedWithNothingToAnswer(call, open);
		} finally {
			fs.rmSync(path.join(base, "copy"), { recursive: true, force: true });
		}
	}
});

await row("29b in the state .mcp.json reads and isn't changed, in the room's folder and outside; a settings file beside it changes", async () => {
	const call = toolsOf({ asksNothing: () => true });
	for (const base of [roomFolder, outside]) {
		const mcp = path.join(base, ".mcp.json");
		const beside = path.join(base, "settings.json");
		for (const file of [mcp, beside]) fs.writeFileSync(file, KEPT);
		try {
			const read = await call("read", { path: mcp });
			assert(!read.failed && read.text.includes("kept"), `read ${mcp}: ${read.text}`);
			const wrote = await call("write", { path: mcp, content: "changed\n", overwrite: true });
			assert(wrote.failed && wrote.text === neverChanged(mcp) && fs.readFileSync(mcp, "utf8") === KEPT, `write ${mcp}: ${wrote.text}`);
			const edited = await call("edit", { path: mcp, edits: [{ oldText: "kept", newText: "changed" }] });
			assert(edited.failed && edited.text === neverChanged(mcp) && fs.readFileSync(mcp, "utf8") === KEPT, `edit ${mcp}: ${edited.text}`);
			await changedWithNothingToAnswer(call, beside);
		} finally {
			for (const file of [mcp, beside]) fs.rmSync(file, { force: true });
		}
	}
});

await row("29c in the state a write in an approved skill's folder of a name commands run is refused as a skill's folder, the file kept; a file there reads; a skill that is off is refused as a skill's folder", async () => {
	const skill = path.join(agentDir, "skills", "deck-maker");
	const offSkill = path.join(agentDir, "skills", "left-off", "SKILL.md");
	fs.mkdirSync(path.dirname(offSkill), { recursive: true });
	fs.writeFileSync(offSkill, KEPT);
	const hook = path.join(skill, ".git", "hooks", "pre-commit");
	const tasks = path.join(skill, ".vscode", "tasks.json");
	for (const file of [hook, tasks, path.join(skill, "notes.txt")]) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, KEPT);
	}
	try {
		const call = toolsOf({ asksNothing: () => true, box: standInBox(skill) });
		for (const file of [hook, tasks]) {
			const wrote = await call("write", { path: file, content: "changed\n", overwrite: true });
			assert(wrote.failed && wrote.text === skillsFolderRefusal(file) && fs.readFileSync(file, "utf8") === KEPT, `write ${file}: ${wrote.text}`);
		}
		const read = await call("read", { path: path.join(skill, "notes.txt") });
		assert(!read.failed && read.text.includes("kept"), `read the skill's notes: ${read.text}`);
		const off = await call("read", { path: offSkill });
		assert(off.failed && off.text === skillsFolderRefusal(offSkill) && !off.text.includes("kept"), `read a skill that is off: ${off.text}`);
	} finally {
		fs.rmSync(path.join(agentDir, "skills"), { recursive: true, force: true });
	}
});

await row("29f in the state a shared-folder skill on in the room opens its folder as in a protected room, and the file tools read a key file there and change a file there, as outside its folder", async () => {
	const skill = path.join(home, ".agents", "skills", "shared-notes");
	const key = path.join(skill, ".env");
	const notes = path.join(skill, "notes.txt");
	fs.mkdirSync(skill, { recursive: true });
	fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: shared-notes\ndescription: notes kept in the shared folder\n---\n\nRead notes.txt.\n");
	fs.writeFileSync(key, `${KEY_LINE} shared skill key\n`);
	fs.writeFileSync(notes, KEPT);
	try {
		assert(enablePersistentRoomSkill(toolRoom, "shared-notes", readLibrarySkill).ok, "the shared skill switches on");
		const opened = roomSkillFolders(toolRoom).find((entry) => entry.name === "shared-notes");
		assert(opened?.skillDir === fs.realpathSync.native(skill), `the room opens its folder as a protected room does, got ${JSON.stringify(opened)}`);
		const call = toolsOf({ asksNothing: () => true });
		const read = await call("read", { path: key });
		assert(!read.failed && read.text.includes("shared skill key"), `read the key file in the skill's folder: ${read.text}`);
		await changedWithNothingToAnswer(call, notes);
	} finally {
		fs.rmSync(path.join(home, ".agents"), { recursive: true, force: true });
	}
});

/** A shared-folder skill whose real folder is `real`, linked from ~/.agents/skills and switched on in the tool room. */
function sharedSkillAt(real: string, name: string): string {
	fs.mkdirSync(real, { recursive: true });
	fs.writeFileSync(path.join(real, "SKILL.md"), `---\nname: ${name}\ndescription: a team guide\n---\n\nRead notes.txt.\n`);
	fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
	fs.symlinkSync(real, path.join(home, ".agents", "skills", name), "dir");
	assert(enablePersistentRoomSkill(toolRoom, name, readLibrarySkill).ok, `${name} switches on`);
	return fs.realpathSync.native(real);
}

await row("29g a protected room: a shared-folder skill's real folder inside a .ssh folder opens, but a key there with a name of its own stays closed; a file in another shared skill's folder reads", async () => {
	const keys = sharedSkillAt(path.join(home, "team", ".ssh"), "ssh-guide");
	const guide = sharedSkillAt(path.join(home, "team", "guide"), "team-guide");
	fs.writeFileSync(path.join(keys, "deploy"), `${KEY_LINE} deploy key\n`);
	fs.writeFileSync(path.join(guide, "notes.txt"), KEPT);
	try {
		assert(roomSkillFolders(toolRoom).some((entry) => entry.skillDir === keys), "the room opens the skill's folder inside .ssh");
		const call = toolsOf();
		const notes = await call("read", { path: path.join(guide, "notes.txt") });
		assert(!notes.failed && notes.text.includes("kept"), `read a file in a shared skill's folder: ${notes.text}`);
		const key = await call("read", { path: path.join(keys, "deploy") });
		assert(key.failed && !key.text.includes("deploy key"), `a key inside .ssh read through a shared skill's folder: ${key.text}`);
	} finally {
		fs.rmSync(path.join(home, ".agents"), { recursive: true, force: true });
		fs.rmSync(path.join(home, "team"), { recursive: true, force: true });
	}
});

await row("29h a protected room: a shared-folder skill's folder swapped for a link to the home folder just after its way was walked opens nothing there; unswapped, the same skill's file reads", async () => {
	const real = sharedSkillAt(path.join(home, "team", "swap-guide"), "swap-guide");
	fs.writeFileSync(path.join(real, "notes.txt"), KEPT);
	const atHome = path.join(home, "home-notes.txt");
	fs.writeFileSync(atHome, "home secret\n");
	const resolve = fs.realpathSync.native;
	let swapped = false;
	try {
		const call = toolsOf();
		const notes = await call("read", { path: path.join(real, "notes.txt") });
		assert(!notes.failed && notes.text.includes("kept"), `read the skill's file: ${notes.text}`);
		// The walk's last resolve gives the real folder; a link to the home folder is put in its place right after.
		fs.realpathSync.native = ((place: fs.PathLike, ...rest: any[]) => {
			const resolved = (resolve as any)(place, ...rest);
			if (!swapped && String(place) === real) {
				swapped = true;
				fs.renameSync(real, `${real}-before`);
				fs.symlinkSync(home, real, "dir");
			}
			return resolved;
		}) as typeof fs.realpathSync.native;
		const read = await call("read", { path: atHome });
		assert(swapped, "the skill's real folder was never resolved");
		assert(read.failed && !read.text.includes("home secret"), `the home folder opened through a skill's folder swapped after its way was walked: ${read.text}`);
		const through = await call("read", { path: path.join(real, "home-notes.txt") });
		assert(through.failed && !through.text.includes("home secret"), `the home folder opened through the link in the skill's folder's place: ${through.text}`);
	} finally {
		fs.realpathSync.native = resolve;
		fs.rmSync(atHome, { force: true });
		fs.rmSync(path.join(home, ".agents"), { recursive: true, force: true });
		fs.rmSync(path.join(home, "team"), { recursive: true, force: true });
	}
});

await row("29i a protected room: a shared-folder skill whose real folder is in the room's folder reads there; swapped for a link to a folder outside, the file tools open nothing there", async () => {
	policyMod.writePersistentRoomDefaultCapabilityPolicy(policyMod.createPersistentRoomDefaultCapabilityPolicy({ agentId: toolRoom, repoRoot, root: roomFolder, workspaceAccessMode: "localFiles", displayLabel: "Notes room", source: "manual" }));
	const inRoom = sharedSkillAt(path.join(roomFolder, "team-skills", "swap-notes"), "swap-notes");
	fs.writeFileSync(path.join(inRoom, "notes.txt"), KEPT);
	const swappedTo = path.join(home, "private-notes");
	fs.mkdirSync(swappedTo, { recursive: true });
	fs.writeFileSync(path.join(swappedTo, "SKILL.md"), "---\nname: swap-notes\ndescription: a folder of notes\n---\n\nNotes.\n");
	fs.writeFileSync(path.join(swappedTo, "private.txt"), "swapped secret\n");
	try {
		const call = toolsOf();
		const notes = await call("read", { path: path.join(inRoom, "notes.txt") });
		assert(!notes.failed && notes.text.includes("kept"), `before the swap, read the skill's file in the room's folder: ${notes.text}`);
		const before = await call("read", { path: path.join(swappedTo, "private.txt") });
		assert(before.failed && !before.text.includes("swapped secret"), `the folder outside read before any swap: ${before.text}`);
		// What a command in the room can do: its folder holds the skill's folder.
		fs.renameSync(inRoom, `${inRoom}-old`);
		fs.symlinkSync(swappedTo, inRoom, "dir");
		const read = await call("read", { path: path.join(swappedTo, "private.txt") });
		assert(read.failed && !read.text.includes("swapped secret"), `the file tools read the folder a link the room left leads to: ${read.text}`);
	} finally {
		policyMod.deletePersistentRoomDefaultCapabilityPolicy(toolRoom);
		fs.rmSync(path.join(home, ".agents"), { recursive: true, force: true });
		fs.rmSync(path.join(roomFolder, "team-skills"), { recursive: true, force: true });
		fs.rmSync(swappedTo, { recursive: true, force: true });
	}
});

await row("29d in the state a folder set to Can read stays read-only for those names: .vscode/tasks.json there reads and isn't written, one outside it is", async () => {
	const tools = inOutside("tools");
	const inReadOnly = path.join(tools, ".vscode", "tasks.json");
	fs.mkdirSync(path.dirname(inReadOnly), { recursive: true });
	fs.writeFileSync(inReadOnly, KEPT);
	addAlsoAllowedFolder(toolRoom, tools, "read");
	try {
		const call = toolsOf({ asksNothing: () => true });
		const read = await call("read", { path: inReadOnly });
		assert(!read.failed && read.text.includes("kept"), `read: ${read.text}`);
		const wrote = await call("write", { path: inReadOnly, content: "changed\n", overwrite: true });
		assert(wrote.failed && wrote.text === `${readOnlyFolder(inReadOnly)} Tell the person.` && fs.readFileSync(inReadOnly, "utf8") === KEPT, `write: ${wrote.text}`);
		await changedWithNothingToAnswer(call, inOutside(path.join(".vscode", "tasks.json")));
	} finally {
		saveAlsoAllowedFolders(toolRoom, []);
		fs.rmSync(tools, { recursive: true, force: true });
		plantRunsLater();
	}
});

await row("29e in the state with Can change files off those names read and the room has no write or edit tool", async () => {
	const call = toolsOf({ asksNothing: () => true, canChange: false });
	for (const [label, file] of runsLater) {
		const read = await call("read", { path: file });
		assert(!read.failed && read.text.includes("kept"), `${label}: read, got ${read.text}`);
		const wrote = await call("write", { path: file, content: "changed\n", overwrite: true });
		assert(wrote.failed && wrote.text === "no write tool" && fs.readFileSync(file, "utf8") === KEPT, `${label}: write, got ${wrote.text}`);
	}
});

await row("26 outside the state every key file is closed as before, for a read and a write: on Ask, in a protected room, with a reader that throws and with no reader", async () => {
	const readers: Array<[string, (() => boolean) | undefined]> = [
		["on Ask", () => false],
		["a protected room", () => unprotectedRoomOnAutoIn(toolRoom, "conversation-a", { state: "on" })],
		["the reader throws", () => { throw new Error("unreadable"); }],
		["no reader (a scheduled run)", undefined],
	];
	for (const [label, asksNothing] of readers) {
		const call = toolsOf({ asksNothing });
		for (const file of keyFiles) {
			const read = await call("read", { path: file });
			assert(read.failed && read.text === closedRefusal(file), `${label}: read ${file}, got ${read.text}`);
			const wrote = await call("write", { path: file, content: "changed\n", overwrite: true });
			assert(wrote.failed && wrote.text === closedRefusal(file) && fs.readFileSync(file, "utf8") === keyText(file), `${label}: write ${file}, got ${wrote.text}`);
		}
	}
});

await row("27 in the state with Can change files off a key file is read and not written; in a folder set to Can read it is read and not written, and one beside it is written", async () => {
	const readOnlyRoom = toolsOf({ asksNothing: () => true, canChange: false });
	for (const file of [path.join(roomFolder, ".env"), path.join(home, ".ssh", "config")]) {
		const read = await readOnlyRoom("read", { path: file });
		assert(!read.failed && read.text.includes(KEY_LINE), `Can change files off, read ${file}: ${read.text}`);
		const wrote = await readOnlyRoom("write", { path: file, content: "changed\n", overwrite: true });
		assert(wrote.failed && wrote.text === "no write tool" && fs.readFileSync(file, "utf8") === keyText(file), `Can change files off, write ${file}: ${wrote.text}`);
	}
	const keys = path.join(home, "keys");
	addAlsoAllowedFolder(toolRoom, keys, "read");
	try {
		const free = toolsOf({ asksNothing: () => true });
		const pem = path.join(keys, "server.pem");
		const read = await free("read", { path: pem });
		assert(!read.failed && read.text.includes(KEY_LINE), `a Can read folder, read: ${read.text}`);
		const wrote = await free("write", { path: pem, content: "changed\n", overwrite: true });
		assert(wrote.failed && wrote.text === `${readOnlyFolder(pem)} Tell the person.` && fs.readFileSync(pem, "utf8") === keyText(pem), `a Can read folder, write: ${wrote.text}`);
		const beside = await free("write", { path: path.join(home, ".ssh", "config"), content: "changed\n", overwrite: true });
		assert(!beside.failed, `a key file in no Can read folder: ${beside.text}`);
	} finally {
		saveAlsoAllowedFolders(toolRoom, []);
		plantKeys();
	}
});

/**
 * A stand-in for the Mac's box that runs the box's own file program without the
 * sandbox, so the server's side of a boxed call runs on any computer. `inData`
 * is a place in the app's data the room may read, as an approved skill's folder.
 * It names every public method of the real box, so one the box gains fails the
 * typecheck here; the cast only covers the box's private fields.
 */
function standInBox(inData: string): RoomBox {
	const noCommands = (): never => {
		throw new Error("the stand-in box runs no commands");
	};
	const box: { [K in keyof RoomBox]: RoomBox[K] } = {
		ensureRun: noCommands,
		operations: noCommands,
		privateTemp: noCommands,
		readsSpills: noCommands,
		noteSpill: noCommands,
		endTurn: noCommands,
		serveFiles: () => {},
		spills: () => [inData],
		// As a box with no running answer: it has no temp of its own.
		ownTemp: () => undefined,
		noteNoAnswer: () => {},
		runFileProgram: async (call) => {
			const ran = spawnSync(process.execPath, [FILE_WORKER], { input: call.request, cwd: call.cwd });
			return { output: ran.stdout, ended: `exit code ${ran.status}`, errorOutput: ran.stderr };
		},
	};
	return box as unknown as RoomBox;
}

await row("28 in the state, through the box's file program, a key's name with no deck in it in an approved skill's folder stays closed to grep, ls and read, as the app's data; one in the room's folder is searched", async () => {
	const skill = path.join(appRoot, "skills", "deck-maker");
	fs.mkdirSync(skill, { recursive: true });
	fs.writeFileSync(path.join(skill, "server.key"), `${KEY_LINE} skill key\n`);
	fs.writeFileSync(path.join(skill, "notes.txt"), `${KEY_LINE} skill notes\n`);
	const inRoom = path.join(roomFolder, "room.key");
	fs.writeFileSync(inRoom, `${KEY_LINE} room key\n`);
	try {
		const call = toolsOf({ asksNothing: () => true, box: standInBox(skill) });
		const searched = await call("grep", { pattern: KEY_LINE, path: skill });
		assert(!searched.failed && searched.text.includes("skill notes") && !searched.text.includes("skill key"), `grep in the skill's folder: ${searched.text}`);
		const listed = await call("ls", { path: skill });
		assert(!listed.failed && linesOf(listed.text).includes("notes.txt") && !linesOf(listed.text).includes("server.key"), `ls in the skill's folder: ${listed.text}`);
		const read = await call("read", { path: path.join(skill, "server.key") });
		assert(read.failed && !read.text.includes("skill key"), `read in the skill's folder: ${read.text}`);
		const roomSearch = await call("grep", { pattern: "room key", path: roomFolder });
		assert(!roomSearch.failed && roomSearch.text.includes("room.key:1:"), `grep in the room's folder: ${roomSearch.text}`);
	} finally {
		fs.rmSync(path.join(appRoot, "skills"), { recursive: true, force: true });
		fs.rmSync(inRoom, { force: true });
	}
});

await row("5 a replace too large for the disk's free space leaves the file as it was, outside the folders and inside; one that fits goes through", async () => {
	const kept = inOutside("kept.txt");
	const inRoom = path.join(roomFolder, "kept.txt");
	for (const target of [kept, inRoom]) {
		fs.writeFileSync(target, "KEPT");
		const tight = toolsOf({ asksNothing: () => true, freeSpace: () => 16 * 1024 * 1024 + 2 });
		const tooBig = await tight("write", { path: target, content: "TOO BIG", overwrite: true });
		assert(tooBig.failed && fs.readFileSync(target, "utf8") === "KEPT", `${target}: the write too big, got ${tooBig.text}, the file holds ${fs.readFileSync(target, "utf8")}`);
		assert(tooBig.text === notEnoughSpace(target === inRoom ? "kept.txt" : target), `${target}: the words, got ${tooBig.text}`);
		const editTooBig = await tight("edit", { path: target, edits: [{ oldText: "KEPT", newText: "MUCH LONGER" }] });
		assert(editTooBig.failed && fs.readFileSync(target, "utf8") === "KEPT", `${target}: the edit too big, got ${editTooBig.text}`);
		const fits = await tight("write", { path: target, content: "F", overwrite: true });
		assert(!fits.failed && fs.readFileSync(target, "utf8") === "F", `${target}: the write that fits, got ${fits.text}`);
	}
});

await row("6 on Windows a file call on an outside path waits for a protected command of another room on that folder, and runs once it ends", async () => {
	const wait = new FolderWait();
	const call = toolsOf({ asksNothing: () => true, folderWait: wait });
	let release: () => void = () => {};
	const commandRuns = new Promise<void>((resolve) => { release = resolve; });
	let commandStarted = false;
	// Another room's boxed command, on a folder that holds the outside path.
	const command = wait.hold("command", [outside], undefined, async () => { commandStarted = true; await commandRuns; });
	await waitUntil(() => commandStarted, "the other room's command runs");
	let readDone = false;
	const reading = call("read", { path: inOutside("q3.txt") }).then((answer) => { readDone = true; return answer; });
	// A neighbour that holds nothing the command holds runs at once.
	const elsewhere = path.join(home, "Elsewhere");
	fs.mkdirSync(elsewhere, { recursive: true });
	fs.writeFileSync(path.join(elsewhere, "free.txt"), "free");
	const free = await call("read", { path: path.join(elsewhere, "free.txt") });
	assert(!free.failed && free.text.includes("free") && !readDone, `a path no command holds runs while the other waits: ${free.text}, waited ${!readDone}`);
	release();
	await command;
	const read = await reading;
	assert(!read.failed && read.text.includes("Q3 revenue"), `after the command: ${read.text}`);
});

// The gate as the adapter calls it, with a person at the computer who answers no.
const gateRoom = "asks-nothing-gate-room";
fs.mkdirSync(policyMod.persistentAgentRootPath(gateRoom), { recursive: true });
writePersistentRoomMcpSettings(gateRoom, ["standin"]);
async function gateCall(asksNothing: (() => boolean) | undefined, tool = "make_note"): Promise<{ text: string; asked: number; error?: string }> {
	let asked = 0;
	const ctx = { ui: { askConnector: async () => { asked += 1; return "decline" as const; } } };
	const standIn = await roomScopedMcpToolRegistration(gateRoom, {
		name: "mcp",
		asksBeforeConnectorCalls: true,
		execute: async (_id: unknown, _params: unknown, _signal: unknown, _onUpdate: unknown, gate: any) => (await gate({ server: "standin", toolName: tool, liveTool: { name: tool }, resourceRead: false, args: {} })) ?? { content: [{ type: "text", text: "ran" }] },
	} as any, { asksNothing });
	const answer: any = await standIn!.execute("gate-call", { tool, server: "standin" }, undefined, undefined, ctx);
	return { text: answer.content?.[0]?.text ?? "", asked, error: answer.details?.error };
}

await row("7 the gate: asking nothing runs the tool with no question and stores no yes; outside the state and with a reader that throws it asks", async () => {
	const free = await gateCall(() => true);
	assert(free.text === "ran" && free.asked === 0, `asks nothing: ${JSON.stringify(free)}`);
	const stored = JSON.parse(fs.readFileSync(path.join(policyMod.persistentAgentRootPath(gateRoom), "runtime", "mcp-settings.json"), "utf8"));
	assert(JSON.stringify(stored.allowedTools ?? {}) === "{}", `no lasting yes is stored, got ${JSON.stringify(stored.allowedTools)}`);
	for (const [label, reader] of [["on Ask", () => false], ["a reader that throws", () => { throw new Error("unreadable"); }], ["no reader (a scheduled run)", undefined]] as const) {
		const asks = await gateCall(reader);
		assert(asks.asked === 1 && asks.error === "connector_call_declined", `${label}: ${JSON.stringify(asks)}`);
	}
});

await row("8 the gate in the state: a tool excluded and a connector switched off for the room are refused", async () => {
	writeConnectors(["wipe_notes"]);
	try {
		const excluded = await gateCall(() => true, "wipe_notes");
		assert(excluded.error === "connector_tool_withdrawn" && excluded.asked === 0, `excluded: ${JSON.stringify(excluded)}`);
		const neighbour = await gateCall(() => true, "make_note");
		assert(neighbour.text === "ran", `its neighbour runs: ${JSON.stringify(neighbour)}`);
	} finally {
		writeConnectors();
	}
	writePersistentRoomMcpSettings(gateRoom, []);
	try {
		const off = await gateCall(() => true);
		assert(off.text !== "ran" && off.asked === 0, `switched off: ${JSON.stringify(off)}`);
	} finally {
		writePersistentRoomMcpSettings(gateRoom, ["standin"]);
	}
});

await row("16 in the state a link in the room's folder that leads outside is followed, for a read and a write; on Ask it is refused, and in the state a link that stays inside the room's folders is still refused", async () => {
	const outLink = path.join(roomFolder, "reports-link");
	const inLink = path.join(roomFolder, "notes-link");
	fs.mkdirSync(path.join(roomFolder, "notes"), { recursive: true });
	fs.writeFileSync(path.join(roomFolder, "notes", "today.md"), "today\n");
	try {
		fs.symlinkSync(outside, outLink, "dir");
		fs.symlinkSync(path.join(roomFolder, "notes"), inLink, "dir");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return "this computer makes no links without an administrator";
		throw error;
	}
	try {
		const free = toolsOf({ asksNothing: () => true });
		const read = await free("read", { path: path.join(outLink, "q3.txt") });
		assert(!read.failed && read.text.includes("Q3 revenue: 12"), `read through the link: ${read.text}`);
		const wrote = await free("write", { path: path.join(outLink, "via-link.txt"), content: "via\n" });
		assert(!wrote.failed && fs.readFileSync(inOutside("via-link.txt"), "utf8") === "via\n", `write through the link: ${wrote.text}`);
		const inside = await free("read", { path: path.join(inLink, "today.md") });
		assert(inside.failed && inside.text === linkRefused(path.join(inLink, "today.md")), `a link inside the room's folders: ${inside.text}`);
		const onAsk = await toolsOf({ asksNothing: () => false })("read", { path: path.join(outLink, "q3.txt") });
		assert(onAsk.failed && onAsk.text === linkRefused(path.join(outLink, "q3.txt")), `on Ask: ${onAsk.text}`);
	} finally {
		fs.rmSync(outLink, { force: true });
		fs.rmSync(inLink, { force: true });
		fs.rmSync(inOutside("via-link.txt"), { force: true });
	}
});

await row("16b in the state the line says what a link out of the room's folders does, and it does that: a path given through it reads; find and grep in the room's folder don't follow it, whether the server or the Mac's box walks, and ls lists it as a link", async () => {
	const { buildPersistentRoomCurrentWorkspaceSection } = await import("../src/persistent-agent-boot.js");
	const LINK_LINE = "A path through a link that leads out of this room's folders is followed when you give it; find, grep and ls don't follow links they meet.";
	const section = buildPersistentRoomCurrentWorkspaceSection({ workspaceToolsEnabled: true, capability: { workspaceLabel: "Notes room", availableToolNames: ["read"], writeEnabled: false, bashEnabled: true, commandsChangeFiles: true } } as any, { asksNothing: true });
	assert(section.includes(LINK_LINE), `the state's line says what a link does, got:\n${section}`);
	const outLink = path.join(roomFolder, "reports-link");
	try {
		fs.symlinkSync(outside, outLink, "dir");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return "this computer makes no links without an administrator";
		throw error;
	}
	const saved = process.env[RIPGREP_OFF];
	try {
		for (const [walker, call] of [["the server", toolsOf({ asksNothing: () => true })], ["the box", toolsOf({ asksNothing: () => true, box: standInBox(path.join(appRoot, "skills", "none")) })]] as const) {
			const read = await call("read", { path: path.join(outLink, "q3.txt") });
			assert(!read.failed && read.text.includes("Q3 revenue: 12"), `${walker}: read through the link: ${read.text}`);
			const found = await call("find", { pattern: "**/q3.txt", path: roomFolder });
			assert(!found.failed && !found.text.includes("q3.txt"), `${walker}: find in the room's folder: ${found.text}`);
			for (const off of ["1", undefined]) {
				if (off) process.env[RIPGREP_OFF] = off;
				else delete process.env[RIPGREP_OFF];
				const searched = await call("grep", { pattern: "Q3 revenue", path: roomFolder });
				assert(!searched.failed && !searched.text.includes("Q3 revenue"), `${walker}, ${off ? "the walk" : "ripgrep where there is one"}: grep in the room's folder: ${searched.text}`);
			}
			const listed = await call("ls", { path: roomFolder });
			assert(!listed.failed && linesOf(listed.text).includes("reports-link@"), `${walker}: ls in the room's folder: ${listed.text}`);
			// The neighbour: the same search given the path through the link finds the file.
			const through = await call("find", { pattern: "q3.txt", path: outLink });
			assert(!through.failed && through.text.includes("q3.txt"), `${walker}: find given the path through the link: ${through.text}`);
		}
	} finally {
		if (saved === undefined) delete process.env[RIPGREP_OFF];
		else process.env[RIPGREP_OFF] = saved;
		fs.rmSync(outLink, { force: true });
	}
});

await row("17 find in a folder outside matches a pattern with a folder in it from the folder searched, and grep there shows a match's lines around it", async () => {
	fs.mkdirSync(inOutside("2026"), { recursive: true });
	fs.writeFileSync(inOutside(path.join("2026", "report.txt")), "first\nrevenue rose\nlast\n");
	try {
		const free = toolsOf({ asksNothing: () => true });
		const found = await free("find", { pattern: "2026/*.txt", path: outside });
		assert(!found.failed && found.text.split("\n").includes(inOutside(path.join("2026", "report.txt"))), `find 2026/*.txt: ${found.text}`);
		const none = await free("find", { pattern: "2025/*.txt", path: outside });
		assert(none.text.startsWith("No files found"), `find 2025/*.txt: ${none.text}`);
		const grep = await free("grep", { pattern: "rose", path: inOutside("2026"), context: 1 });
		const shown = inOutside(path.join("2026", "report.txt"));
		assert(!grep.failed && grep.text.includes(`${shown}-1- first`) && grep.text.includes(`${shown}:2: revenue rose`) && grep.text.includes(`${shown}-3- last`), `grep with context: ${grep.text}`);
	} finally {
		fs.rmSync(inOutside("2026"), { recursive: true, force: true });
	}
});

await row("18 in the state a folder the person set to Can read stays read-only: a write there is refused with a line that tells the person, a read goes through", async () => {
	const readOnly = path.join(home, "Documents", "Archive");
	fs.mkdirSync(readOnly, { recursive: true });
	fs.writeFileSync(path.join(readOnly, "old.txt"), "old\n");
	addAlsoAllowedFolder(toolRoom, readOnly, "read");
	try {
		// A room that asks nothing shows no card, at the computer or not, and asking again gives the same refusal, so the line only says to tell the person.
		const refused = `${path.join(readOnly, "new.txt")} is in a folder this room can only read, so it can't change it.`;
		const free = toolsOf({ asksNothing: () => true, asks: () => true });
		for (const [label, write, next] of [
			["in the state at the computer", free, "Tell the person."],
			["in the state, nobody at the computer", toolsOf({ asksNothing: () => true, asks: () => false }), "Tell the person."],
			["on Ask at the computer", toolsOf({ asksNothing: () => false, asks: () => true }), "Call ask_for_folder with access change so the person can allow it."],
			["on Ask, nobody at the computer", toolsOf({ asksNothing: () => false, asks: () => false }), "Tell the person: the person can ask again from the computer and allow it there."],
		] as const) {
			const wrote = await write("write", { path: path.join(readOnly, "new.txt"), content: "new\n" });
			assert(wrote.failed && wrote.text === `${refused} ${next}` && !fs.existsSync(path.join(readOnly, "new.txt")), `${label}, a write in a Can read folder: ${wrote.text}`);
		}
		const read = await free("read", { path: path.join(readOnly, "old.txt") });
		assert(!read.failed && read.text.includes("old"), `a read there: ${read.text}`);
		const elsewhere = await free("write", { path: inOutside("next.txt"), content: "next\n" });
		assert(!elsewhere.failed, `a write in a folder no setting covers: ${elsewhere.text}`);
	} finally {
		saveAlsoAllowedFolders(toolRoom, []);
		fs.rmSync(inOutside("next.txt"), { force: true });
	}
});

await row("19 in the state a file outside larger than a call takes is refused before it is read; one below it is read", async () => {
	const big = inOutside("big.log");
	fs.writeFileSync(big, "");
	fs.truncateSync(big, 64 * 1024 * 1024 + 1);
	try {
		const free = toolsOf({ asksNothing: () => true });
		const read = await free("read", { path: big });
		assert(read.failed && read.text === tooLargeForTool(big), `a large file: ${read.text}`);
		fs.truncateSync(big, 64 * 1024 * 1024);
		const fits = await free("read", { path: big, limit: 1 });
		assert(!fits.failed, `a file at the limit: ${fits.text}`);
	} finally {
		fs.rmSync(big, { force: true });
	}
});

await row("21 the state's two lines on where file tools reach read whole, with Can change files on and with it off", async () => {
	const { buildPersistentRoomCurrentWorkspaceSection } = await import("../src/persistent-agent-boot.js");
	const { createRoomAsks, NotNowCount } = await import("../src/room-box/folder-question.js");
	const nothingToAsk = async (canChangeFiles: boolean): Promise<string> => {
		const never = async (): Promise<never> => {
			throw new Error("a room that asks nothing showed a card");
		};
		const { tools } = createRoomAsks({
			roomId: toolRoom,
			reasonOf: () => "To read the Q3 report.",
			questions: { watcher: () => "computer", askFolder: never, askCommands: never } as any,
			room: () => ({ folder: roomFolder, canChangeFiles, commands: "on" as any, boxed: false, unprotected: true }),
			pickFolder: never,
			turnOnCommands: () => {},
			notNow: new NotNowCount(),
			answer: () => undefined as any,
			opensWithoutAsking: () => (folder) => folder,
		});
		const ask = tools.find((tool) => tool.name === "ask_for_folder");
		const result = await ask!.execute("ask-1", { access: "read", reason: "To read the Q3 report." } as any, undefined, undefined, undefined as any);
		return result.content.map((part: any) => part.text ?? "").join("");
	};
	const section = (writeEnabled: boolean): string => buildPersistentRoomCurrentWorkspaceSection({
		workspaceToolsEnabled: true,
		capability: { workspaceLabel: "Notes room", availableToolNames: writeEnabled ? ["read", "write"] : ["read"], writeEnabled, bashEnabled: true, commandsChangeFiles: true },
	} as any, { asksNothing: true });
	const answers = [
		[await nothingToAsk(true), "Nothing needs the person's approval here: this room's file tools read and change files anywhere on this computer by their full path, except the app's own data, the connector settings file .config/mcp/mcp.json, changes to .mcp.json files and in a folder the person set to Can read, and anything a rule the person added to the content policy blocks. Use the full path, and go on with the job."],
		[await nothingToAsk(false), "Nothing needs the person's approval here: this room's file tools read files anywhere on this computer by their full path, except the app's own data, the connector settings file .config/mcp/mcp.json and anything a rule the person added to the content policy blocks. Use the full path, and go on with the job."],
	] as const;
	for (const [got, want] of answers) assert(got === want, `ask_for_folder with no folder named:\n${got}\nnot\n${want}`);
	const lines = [
		[section(true), "The person chose to let this room work without asking: don't stop to ask their permission for a file, a command, a website or a connector's tool, whatever an earlier line or a tool's description says. Still ask when what they want is unclear. File tools read and change files anywhere on this computer by their full path, except the app's own data, the connector settings file .config/mcp/mcp.json, changes to .mcp.json files and in a folder the person set to Can read, and anything a rule the person added to the content policy blocks; ask_for_folder isn't needed for that. A path through a link that leads out of this room's folders is followed when you give it; find, grep and ls don't follow links they meet."],
		[section(false), "The person chose to let this room work without asking: don't stop to ask their permission for a file, a command, a website or a connector's tool, whatever an earlier line or a tool's description says. Still ask when what they want is unclear. File tools read files anywhere on this computer by their full path, except the app's own data, the connector settings file .config/mcp/mcp.json and anything a rule the person added to the content policy blocks; ask_for_folder isn't needed for that. A path through a link that leads out of this room's folders is followed when you give it; find, grep and ls don't follow links they meet."],
	] as const;
	for (const [got, want] of lines) assert(got.includes(`\n\n${want}\n\n`), `the state's line in the room's state message:\n${got}\nhas no paragraph\n${want}`);
});

await row("21c ask_for_folder with the state's reader throwing shows the folder card as on Ask; a reader that says no folder card is needed shows none", async () => {
	const { createRoomAsks, FOLDER_NOT_NOW, NotNowCount } = await import("../src/room-box/folder-question.js");
	const askFor = async (opensWithoutAsking: () => ((folder: string) => string) | null): Promise<{ cards: number; text: string }> => {
		let cards = 0;
		const never = async (): Promise<never> => {
			throw new Error("no folder window opens here");
		};
		const { tools } = createRoomAsks({
			roomId: toolRoom,
			reasonOf: () => "To read the Q3 report.",
			questions: { watcher: () => "computer", askFolder: async () => (cards += 1, { state: "declined" }), askCommands: never } as any,
			room: () => ({ folder: roomFolder, canChangeFiles: true, commands: "on" as any, boxed: false, unprotected: true }),
			pickFolder: never,
			turnOnCommands: () => {},
			notNow: new NotNowCount(),
			answer: () => undefined as any,
			wait: async () => {},
			opensWithoutAsking,
		});
		const ask = tools.find((tool) => tool.name === "ask_for_folder");
		const result = await ask!.execute("ask-1", { access: "read", reason: "To read the Q3 report." } as any, undefined, undefined, undefined as any);
		return { cards, text: result.content.map((part: any) => part.text ?? "").join("") };
	};
	const throwing = await askFor(() => {
		throw new Error("the room's settings can't be read");
	});
	assert(throwing.cards === 1 && throwing.text === FOLDER_NOT_NOW, `a reader that throws: ${JSON.stringify(throwing)}`);
	const free = await askFor(() => (folder) => folder);
	assert(free.cards === 0 && free.text.startsWith("Nothing needs the person's approval here"), `a reader that opens: ${JSON.stringify(free)}`);
});

await row("21b the state's line names what the file tools refuse there and nothing they change: a git hook and .vscode/tasks.json change, .mcp.json doesn't, the shared connector settings and a file a rule the person added names don't open, and a file beside them does", async () => {
	const { reachWithoutAsking } = await import("../src/room-box/folder-question.js");
	const { createContentPolicyExtension } = await import("../../../pi-package/extensions/content-policy/index.js");
	const changes = reachWithoutAsking(true);
	const reads = reachWithoutAsking(false);
	const call = toolsOf({ asksNothing: () => true });
	// Files that can run code later, which the line once said stay unchanged.
	const hook = path.join(roomFolder, "repo", ".git", "hooks", "pre-commit");
	const tasks = inOutside(path.join(".vscode", "tasks.json"));
	const mcp = inOutside(".mcp.json");
	const ownRules = path.join(appRoot, "content-policy.json");
	const ruled = inOutside("launch-codes.txt");
	for (const file of [hook, tasks, mcp, ruled]) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, KEPT);
	}
	writeSetting(ownRules, { rules: [{ id: "launch-codes", pattern: "launch-codes" }] });
	try {
		for (const file of [hook, tasks]) await changedWithNothingToAnswer(call, file);
		assert(!changes.includes("run code later") && !changes.includes(".vscode"), `the line names a file the tools change: ${changes}`);
		const mcpWrite = await call("write", { path: mcp, content: "changed\n", overwrite: true });
		assert(mcpWrite.failed && mcpWrite.text === neverChanged(mcp) && changes.includes("changes to .mcp.json files"), `.mcp.json: ${mcpWrite.text}`);
		const shared = await call("read", { path: sharedConnectorFile });
		assert(shared.failed && shared.text === closedRefusal(sharedConnectorFile) && [changes, reads].every((line) => line.includes("the connector settings file .config/mcp/mcp.json")), `the shared connector settings: ${shared.text}`);
		// The person's own rules still stop the file tools in the state, a read and a change alike.
		let check: ((event: any, ctx: any) => Promise<any>) | undefined;
		createContentPolicyExtension({ asksNothing: () => true })({ on: (name: string, handler: any) => { if (name === "tool_call") check = handler; } } as any);
		const verdict = async (tool: string, input: Record<string, unknown>) => (await check!({ toolName: tool, input }, { cwd: roomFolder }))?.block === true;
		assert(await verdict("read", { path: ruled }) && await verdict("write", { path: ruled, content: "x" }), "a rule the person added lets the file tools through");
		assert([changes, reads].every((line) => line.includes("anything a rule the person added to the content policy blocks")), `the line leaves out the person's own rules: ${changes}`);
		assert(!(await verdict("read", { path: inOutside("q3.txt") })), "the rule blocks the file beside it");
		const beside = await call("read", { path: inOutside("q3.txt") });
		assert(!beside.failed && beside.text.includes("Q3"), `the file beside them: ${beside.text}`);
		assert(!reads.includes(".mcp.json files") && !reads.includes("Can read"), `the read-only line names a change: ${reads}`);
	} finally {
		fs.rmSync(ownRules, { force: true });
		for (const file of [mcp, ruled]) fs.rmSync(file, { force: true });
		// The hook and tasks.json are planted for row 25: put them back as they were.
		plantRunsLater();
	}
});

await row("22 every room's six file tools read as on main: the shared line names no state, in a protected room, a room on Ask and a room that asks nothing alike", async () => {
	const FENCE_ON_MAIN = "Paths may be relative to this room's folder, absolute, or start with ~; only this room's folder and the folders allowed for it open, links are not followed, and secret files and the app's own data stay closed.";
	const descriptions = (asksNothing?: () => boolean): string[] => {
		const policy = policyMod.createPersistentRoomCapabilityPolicy({ agentId: toolRoom, conversationId: "conversation-a", repoRoot, root: roomFolder, workspaceAccessMode: "localFiles", source: "manual" } as any);
		return createPersistentRoomWorkspaceTools(policy, { asksNothing }).map((tool) => `${tool.name}: ${tool.description}`);
	};
	// A protected room's tools are built with no reader (as a scheduled run's); a room on Ask's with one that answers no.
	const protectedRoom = descriptions();
	assert(protectedRoom.length === 6 && protectedRoom.every((line) => line.includes(` ${FENCE_ON_MAIN} `)), `a protected room's file tools:\n${protectedRoom.join("\n")}`);
	assert(protectedRoom[0] === `ls: List files and folders. ${FENCE_ON_MAIN} Closed entries are left out and counted. Links are marked with @ and not followed.`, `ls in a protected room: ${protectedRoom[0]}`);
	for (const [label, other] of [["on Ask", descriptions(() => false)], ["asking nothing", descriptions(() => true)]] as const) {
		assert(JSON.stringify(other) === JSON.stringify(protectedRoom), `${label} the file tools read otherwise:\n${other.join("\n")}`);
	}
});

// =============================================================================
// A real server: the room's windows, a scripted model and the stand-in connector.
// =============================================================================
type Call = { name: string; args: Record<string, unknown> };
interface Leg { calls: Call[]; before?: () => Promise<void> }
let script: Leg[] = [];
let requests: string[] = [];
let toolResults: string[] = [];
let hookFailure: unknown;
const sseChunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const gateway = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", async () => {
		const parsed = JSON.parse(body || "{}");
		const messages: any[] = Array.isArray(parsed.messages) ? parsed.messages : [];
		const userAt = messages.map((message) => message?.role).lastIndexOf("user");
		const results = messages.slice(userAt + 1).filter((message) => message?.role === "tool");
		const legsDone = messages.slice(userAt + 1).filter((message) => message?.role === "assistant").length;
		const leg = (parsed.tools ?? []).length > 0 ? script[legsDone] : undefined;
		// Only a turn's own requests carry tools: a request with none, which can come after the turn, leaves its results as they were.
		if ((parsed.tools ?? []).length > 0) {
			requests.push(body);
			toolResults = results.map((message) => (typeof message.content === "string" ? message.content : message.content.map((part: any) => String(part?.text ?? "")).join("")));
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${legsDone}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed.model ?? MODEL.model) };
		if (leg) {
			try {
				await leg.before?.();
			} catch (error) {
				hookFailure ??= error;
				return void res.end();
			}
			const tool_calls = leg.calls.map((call, index) => ({ index, id: `call_${legsDone}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 12, total_tokens: 162 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
const connectorCall = (tool: string): Call => ({ name: "mcp", args: { tool: `standin_${tool}`, args: "{}" } });
const fileCall = (name: string, args: Record<string, unknown>): Call => ({ name, args });
const folderAsk = (folder?: string): Call => ({ name: "ask_for_folder", args: { access: "read", reason: "To read the Q3 report.", ...(folder ? { folder } : {}) } });

const WebSocketImpl: any = (await import("ws")).default;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let port = 0;
async function json(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const roomPath = (room: string, rest: string) => `/api/persistent-agents/${encodeURIComponent(room)}${rest}`;

async function openWindow(room: string, conversation: string) {
	const query = `persistentAgentId=${room}&conversationId=${conversation}&modelProvider=${MODEL.provider}&model=${MODEL.model}&reattach=1`;
	const ws = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?${query}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	ws.addEventListener("message", (event: any) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	const seen = async (match: (frame: any) => boolean, label: string): Promise<any> => {
		await waitUntil(() => {
			if (hookFailure) throw hookFailure;
			return frames.some(match);
		}, `${label}; frames ${frames.map((frame) => frame.type).join(",")}`);
		return frames.find(match);
	};
	// A question has an id to answer; the connection's status lines have none.
	const cards = () => frames.filter((frame) => frame.type === "ui_request" && typeof frame.id === "string" && frame.again !== true);
	await seen((frame) => frame.type === "ready", `${conversation}: the window is ready`);
	return {
		ws,
		cards,
		card: async (count = 1) => { await waitUntil(() => { if (hookFailure) throw hookFailure; return cards().length >= count; }, `card ${count} came; frames ${frames.map((frame) => frame.type).join(",")}`); return cards()[count - 1]; },
		// Not now, as the panel sends it for each kind of card.
		decline: (card: { id: string; kind: string }) => ws.send(JSON.stringify({ type: "ui_response", id: card.id, value: card.kind === "connector" ? "decline" : false })),
		prompt: (text: string) => ws.send(JSON.stringify({ type: "prompt", text })),
		ended: () => seen((frame) => frame.type === "event" && frame.event?.type === "agent_end", "the turn ended"),
	};
}
type RoomWindow = Awaited<ReturnType<typeof openWindow>>;

// A new room has no active thread to settle, so the wait starts after its first conversation.
const spokenIn = new Set<string>();
const settled = async (room: string, label: string) => {
	if (spokenIn.has(room)) await waitForTurnSettled(json, room, label);
};
async function conversationIn(room: string, conversation: string): Promise<RoomWindow> {
	await settled(room, `the turn before ${conversation} has settled`);
	spokenIn.add(room);
	assert((await json(roomPath(room, `/threads/${conversation}`), { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: MODEL, items: [] }) })).status === 200, `${conversation} was seeded`);
	resetCalls();
	requests = [];
	toolResults = [];
	return openWindow(room, conversation);
}

async function newRoom(name: string, folder: string): Promise<string> {
	const created = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const room = String(created.body?.agent?.id ?? created.body?.agent?.agentId ?? "");
	assert(created.status === 201 && room, `${name} created, got ${created.status}`);
	fs.mkdirSync(folder, { recursive: true });
	const saved = await json(roomPath(room, "/workspace-default"), { method: "PUT", body: JSON.stringify({ root: folder, displayLabel: name, workspaceAccessMode: "localFiles", bashEnabled: true }) });
	assert(saved.status === 200 && saved.body?.policy?.bashEnabled === true, `${name}'s folder with commands on, got ${saved.status}: ${JSON.stringify(saved.body)}`);
	assert((await json(roomPath(room, "/mcp-connectors"), { method: "PUT", body: JSON.stringify({ action: "grant", name: "standin" }) })).status === 200, `${name}: the connector is enabled`);
	return room;
}
const setMode = async (room: string, auto: boolean) => {
	const answer = await putRunWithoutAsking(`http://127.0.0.1:${port}${roomPath(room, "/bash-settings")}`, auto);
	assert(answer.status === 200 && (await answer.json())?.settings?.autoApprove === auto, `the room is on ${auto ? "Auto" : "Ask"}`);
};
const protectionOf = async (room: string) => (await json(roomPath(room, "/bash-settings"))).body?.protection;
const roomAsksNothing = async (room: string) => (await json(roomPath(room, "/mcp-connectors"))).body?.asksNothing === true;
const allowedToolsOf = async (room: string) => (await json(roomPath(room, "/mcp-connectors"))).body?.allowedTools ?? {};

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	writeSetting(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 200000, maxTokens: 4096 }] } } });
	writeSetting(path.join(appRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" });
	writeSetting(path.join(appRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });
	port = await freePort();
	serverProcess = spawn("npx", ["tsx", "src/index.ts"], {
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, ...smokeHomeEnv(home), EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot } as NodeJS.ProcessEnv,
	});
	serverProcess.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	serverProcess.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(serverProcess, `http://127.0.0.1:${port}`, 20_000);

	const freeRoom = await newRoom("Free room", path.join(home, "Rooms", "Free room"));
	// Where this computer has no protection the room is already without it; elsewhere the person turns it off.
	if ((await protectionOf(freeRoom))?.state === "on") assert((await json(roomPath(freeRoom, "/protection"), { method: "PUT", body: JSON.stringify({ state: "off" }) })).status === 200, "protection is off for the free room");
	assert((await protectionOf(freeRoom))?.state === "off", "the free room is without protection");
	await setMode(freeRoom, true);

	await row("9 a live conversation in the state: a connector's tool runs, a file outside is read, written and edited, the keys under .ssh and .aws/credentials and the room's .env are read, and ask_for_folder answers, all with no card; no lasting yes is stored", async () => {
		const window = await conversationIn(freeRoom, "conv-free");
		const roomKey = path.join(home, "Rooms", "Free room", ".env");
		fs.writeFileSync(roomKey, keyText(roomKey));
		script = [
			{ calls: [connectorCall("make_note")] },
			{ calls: [fileCall("read", { path: inOutside("q3.txt") })] },
			{ calls: [fileCall("write", { path: inOutside("live.txt"), content: "live\n" })] },
			{ calls: [fileCall("edit", { path: inOutside("live.txt"), edits: [{ oldText: "live", newText: "lively" }] })] },
			{ calls: [fileCall("read", { path: path.join(home, ".ssh", "config") })] },
			{ calls: [fileCall("read", { path: path.join(home, ".aws", "credentials") })] },
			{ calls: [fileCall("read", { path: ".env" })] },
			{ calls: [folderAsk(outside)] },
		];
		window.prompt("Note it down and tidy the Q3 report.");
		await window.ended();
		assert(window.cards().length === 0, `no card at all, got ${JSON.stringify(window.cards())}`);
		assert(JSON.stringify(called()) === JSON.stringify(["make_note"]), `the connector ran the tool once, got ${JSON.stringify(called())}`);
		assert(fs.readFileSync(inOutside("live.txt"), "utf8") === "lively\n", "the file outside was written and edited");
		assert(toolResults.at(-1) === `This room can already read files in ${outside}: use that full path, and go on with the job.`, `ask_for_folder answers from the fence, got ${toolResults.at(-1)}`);
		const [ssh, aws, env] = toolResults.slice(-4, -1);
		assert(ssh?.includes(keyText(path.join(home, ".ssh", "config")).trim()) && aws?.includes(keyText(path.join(home, ".aws", "credentials")).trim()), `the keys under .ssh and .aws: ${JSON.stringify([ssh, aws])}`);
		assert(env?.includes(keyText(roomKey).trim()), `the .env read: ${env}`);
		assert(JSON.stringify(await allowedToolsOf(freeRoom)) === "{}", "no lasting yes is stored");
		assert(requests.length > 0 && requests[0].includes(STATE_LINE), "the request sent to the model carries the state's line");
		assert(requests[0].includes("File tools read and change files anywhere on this computer by their full path, except the app's own data, the connector settings file .config/mcp/mcp.json, changes to .mcp.json files and in a folder the person set to Can read, and anything a rule the person added to the content policy blocks;") && !requests[0].includes("secret files, the app's own data"), "the request's line on where file tools reach names no secret files");
		assert(await roomAsksNothing(freeRoom), "the room's Connectors answer says it asks nothing");
		window.ws.close();
	});

	await row("10 ask_for_folder in the state: a closed folder gets the fence's refusal, the keys' folder opens, no folder named gets a line that names none, a folder that isn't there says so, and a change with Can change files off gets today's words; never a card", async () => {
		const window = await conversationIn(freeRoom, "conv-folder-ask");
		const closedFolder = path.join(home, ".exxperts-work");
		const keysFolder = path.join(home, ".ssh");
		const missingFolder = path.join(home, "Nowhere");
		script = [{ calls: [folderAsk(closedFolder)] }, { calls: [folderAsk()] }, { calls: [folderAsk(missingFolder)] }, { calls: [folderAsk(keysFolder)] }];
		window.prompt("Look for my keys and the report.");
		await window.ended();
		assert(window.cards().length === 0, `no card, got ${JSON.stringify(window.cards())}`);
		window.ws.close();
		const [closedAnswer, noneAnswer, missingAnswer, keysAnswer] = toolResults;
		assert(keysAnswer === `This room can already read files in ${keysFolder}: use that full path, and go on with the job.`, `the keys' folder: ${keysAnswer}`);
		assert(missingAnswer === `Path not found: ${missingFolder}`, `a folder that isn't there: ${missingAnswer}`);
		assert(closedAnswer === closedRefusal(closedFolder), `a closed folder: ${closedAnswer}`);
		assert(noneAnswer?.startsWith("Nothing needs the person's approval here") && !noneAnswer.includes(home), `no folder named: ${noneAnswer}`);
	});

	await row("11 switching mid-conversation: on Ask the next connector call asks and the next outside path is refused; an open card stays until answered; back on Auto the next asks nothing", async () => {
		const window = await conversationIn(freeRoom, "conv-switch");
		script = [
			{ calls: [connectorCall("make_note")], before: () => setMode(freeRoom, false) },
			{ calls: [fileCall("read", { path: inOutside("q3.txt") })] },
		];
		window.prompt("Make a note.");
		const card = await window.card();
		assert(card.kind === "connector" && called().length === 0, `on Ask the connector call asks, got ${JSON.stringify(card)}`);
		// Back on Auto while the card is open: it stays until answered.
		await setMode(freeRoom, true);
		assert(window.cards().length === 1 && called().length === 0, "the open card stays and nothing ran");
		window.decline(card);
		await window.ended();
		assert(window.cards().length === 1, `the switch back neither closed the card nor asked again, got ${JSON.stringify(window.cards())}`);
		assert(called().length === 0, `the No still stops it, got ${JSON.stringify(called())}`);
		window.ws.close();
		// The file call came after the switch back, so it ran with no card.
		assert(toolResults.at(-1)?.includes("Q3 revenue"), `back on Auto the next call asks nothing: ${toolResults.at(-1)}`);

		const asking = await conversationIn(freeRoom, "conv-ask");
		await setMode(freeRoom, false);
		script = [{ calls: [fileCall("read", { path: inOutside("q3.txt") })] }, { calls: [folderAsk(outside)] }];
		asking.prompt("Read the report.");
		const folderCard = await asking.card();
		assert(toolResults.at(-1) === outsideFence(inOutside("q3.txt")), `on Ask the outside path is refused: ${toolResults.at(-1)}`);
		assert(folderCard.kind !== "connector", `on Ask the folder ask shows its card, got ${JSON.stringify(folderCard)}`);
		asking.decline(folderCard);
		await asking.ended();
		assert(!requests.some((request) => request.includes(STATE_LINE)), "on Ask the request carries no state line");
		assert(!(await roomAsksNothing(freeRoom)), "on Ask the Connectors answer doesn't say it");
		asking.ws.close();
		await setMode(freeRoom, true);
	});

	await row("12 Can change files off in the state, live: the outside read goes through, the write is refused, and ask_for_folder for a change gets today's words", async () => {
		await settled(freeRoom, "the free room is idle");
		const saved = await json(roomPath(freeRoom, "/workspace-default"), { method: "PUT", body: JSON.stringify({ toolSelection: { kind: "custom", allowedToolNames: ["ls", "find", "grep", "read"] } }) });
		assert(saved.status === 200, `Can change files off, got ${saved.status}: ${JSON.stringify(saved.body)}`);
		try {
			const window = await conversationIn(freeRoom, "conv-read-only");
			script = [{ calls: [fileCall("read", { path: inOutside("q3.txt") })] }, { calls: [{ name: "ask_for_folder", args: { access: "change", reason: "To fix the report.", folder: outside } }] }];
			window.prompt("Fix the report.");
			await window.ended();
			assert(window.cards().length === 0, "no card");
			const { READ_ONLY_ROOM_ASK } = await import("../src/room-box/folder-question.js");
			// A computer with no protection holds commands off while Can change files is, so there the room is no longer in the state.
			const inState = saved.body?.policy?.bashEnabled === true;
			assert(inState ? toolResults[0]?.includes("Q3 revenue") : toolResults[0] === outsideFence(inOutside("q3.txt")), `the read, ${inState ? "in" : "out of"} the state: ${toolResults[0]}`);
			assert(toolResults[1] === READ_ONLY_ROOM_ASK, `the change ask: ${toolResults[1]}`);
			assert((await roomAsksNothing(freeRoom)) === inState, "the Connectors answer follows the state");
			window.ws.close();
		} finally {
			await settled(freeRoom, "the read-only turn landed");
			await json(roomPath(freeRoom, "/workspace-default"), { method: "PUT", body: JSON.stringify({ toolSelection: { kind: "standard" } }) });
		}
	});

	await row("13 a protected room on Auto still asks: the connector card and the folder card both appear", async () => {
		const guarded = await newRoom("Guarded room", path.join(home, "Rooms", "Guarded room"));
		const protection = await protectionOf(guarded);
		if (protection?.state !== "on") return `this computer's protection reads ${JSON.stringify(protection)}; the mini runs it`;
		const answer = await json(roomPath(guarded, "/bash-settings"), { method: "PUT", body: JSON.stringify({ autoApprove: true, free: true, protection }) });
		assert(answer.status === 200 && answer.body?.settings?.free === true, `the protected room is on Auto, got ${JSON.stringify(answer.body)}`);
		const window = await conversationIn(guarded, "conv-guarded");
		script = [{ calls: [connectorCall("make_note")] }, { calls: [folderAsk(outside)] }];
		window.prompt("Make a note and read the report.");
		const connectorCard = await window.card();
		assert(connectorCard.kind === "connector", `the connector card, got ${JSON.stringify(connectorCard)}`);
		window.decline(connectorCard);
		const folderCard = await window.card(2);
		assert(folderCard.kind !== "connector", `the folder card, got ${JSON.stringify(folderCard)}`);
		window.decline(folderCard);
		await window.ended();
		assert(called().length === 0 && !requests.some((request) => request.includes(STATE_LINE)), "nothing ran, and no state line");
		assert(!(await roomAsksNothing(guarded)), "its Connectors answer doesn't say it asks nothing");
		window.ws.close();
	});

	await row("14 rooms already on Auto without protection keep their yes: the confirm's words name the connectors, and the state holds with no new yes", async () => {
		assert(RUN_WITHOUT_ASKING_BODY.includes("use its connectors"), `the confirm names the connectors: ${RUN_WITHOUT_ASKING_BODY}`);
		assert(await roomAsksNothing(freeRoom), "the free room asks nothing on the yes it was given");
	});

	await row("14b a room whose stored mode can't be read now: its Connectors answer leaves the state out; the free room's beside it says it", async () => {
		// Root writes past a folder's mode, so there nothing can't be read.
		if (process.platform === "win32" || process.getuid?.() === 0) return "root writes in a folder that takes no write";
		const stuck = await newRoom("Stuck settings room", path.join(home, "Rooms", "Stuck settings room"));
		if ((await protectionOf(stuck))?.state === "on") assert((await json(roomPath(stuck, "/protection"), { method: "PUT", body: JSON.stringify({ state: "off" }) })).status === 200, "protection is off for the stuck room");
		// An older app's yes moves at its next read, and the move can't be written where its folder takes no write.
		const runtime = path.join(policyMod.persistentAgentRootPath(stuck), "runtime");
		fs.mkdirSync(runtime, { recursive: true });
		writeSetting(path.join(runtime, "bash-settings.json"), { schemaVersion: 1, autoApprove: true, updatedAt: "" });
		fs.chmodSync(runtime, 0o500);
		try {
			const answer = await json(roomPath(stuck, "/mcp-connectors"));
			assert(answer.status === 200 && !("asksNothing" in (answer.body ?? {})), `the stuck room's Connectors answer, got ${answer.status}: ${JSON.stringify(answer.body)}`);
		} finally {
			fs.chmodSync(runtime, 0o700);
		}
		assert(await roomAsksNothing(freeRoom), "the free room's answer says it asks nothing");
	});

	await row("20 live in the state: a tool the person excluded and a connector switched off for the room mid-conversation are refused with no card, and the next allowed tool runs", async () => {
		const window = await conversationIn(freeRoom, "conv-blocked");
		script = [
			{ calls: [connectorCall("wipe_notes")], before: async () => writeConnectors(["wipe_notes"]) },
			{ calls: [connectorCall("make_note")] },
			{ calls: [connectorCall("make_note")], before: async () => { writePersistentRoomMcpSettings(freeRoom, []); } },
		];
		try {
			window.prompt("Tidy my notes.");
			await window.ended();
		} finally {
			writeConnectors();
			writePersistentRoomMcpSettings(freeRoom, ["standin"]);
			window.ws.close();
		}
		assert(window.cards().length === 0, `no card, got ${JSON.stringify(window.cards())}`);
		assert(JSON.stringify(called()) === JSON.stringify(["make_note"]), `only the allowed tool ran, and only before the connector was switched off, got ${JSON.stringify(called())}`);
	});

	// Last: a shared server reads no stored mode, so here the same room, in the same state on disk, asks.
	await row("15 the shared-server switch on: the room in the state on disk reads as outside it, the connector asks, and an outside path is refused even to a reader that says yes", async () => {
		const shared = "asks-nothing-shared-room";
		const sharedFolder = path.join(home, "Rooms", "Shared room");
		fs.mkdirSync(sharedFolder, { recursive: true });
		policyMod.writePersistentRoomDefaultCapabilityPolicy(policyMod.createPersistentRoomDefaultCapabilityPolicy({ agentId: shared, repoRoot, root: sharedFolder, workspaceAccessMode: "localFiles", displayLabel: "Shared", source: "manual", bashEnabled: true }));
		if (persistentRoomProtection(shared).state === "on") writePersistentRoomProtection(shared, "off");
		writePersistentRoomBashSettings(shared, { autoApprove: true, protection: persistentRoomProtection(shared) });
		assert(unprotectedRoomOnAuto(shared, "conversation-a"), "before the switch the room is in the state");
		const forced = toolsOf({ asksNothing: () => true });
		const before = await forced("read", { path: inOutside("q3.txt") });
		const wroteBefore = await forced("write", { path: inOutside("shared.txt"), content: "shared\n" });
		assert(!before.failed && !wroteBefore.failed && fs.existsSync(inOutside("shared.txt")), `before the switch a room that asks nothing reaches outside: ${before.text} / ${wroteBefore.text}`);
		fs.rmSync(inOutside("shared.txt"));
		registerServerHooks({});
		assert(!unprotectedRoomOnAuto(shared, "conversation-a"), "on a shared server it isn't");
		// The fence itself refuses, whatever the reader answers.
		const forcedRead = await forced("read", { path: inOutside("q3.txt") });
		const forcedWrite = await forced("write", { path: inOutside("shared.txt"), content: "shared\n" });
		assert(forcedRead.failed && forcedRead.text === outsideFence(inOutside("q3.txt")) && forcedWrite.failed && !fs.existsSync(inOutside("shared.txt")), `a reader that says yes on a shared server: ${forcedRead.text} / ${forcedWrite.text}`);
		for (const file of keyFiles) {
			const keyRead = await forced("read", { path: file });
			assert(keyRead.failed && keyRead.text === closedRefusal(file), `a key file on a shared server, read ${file}: ${keyRead.text}`);
			const keyWrite = await forced("write", { path: file, content: "changed\n", overwrite: true });
			assert(keyWrite.failed && fs.readFileSync(file, "utf8") === keyText(file), `a key file on a shared server, write ${file}: ${keyWrite.text}`);
		}
		const reader = () => unprotectedRoomOnAuto(shared, "conversation-a");
		const asks = await gateCall(reader);
		assert(asks.asked === 1, `the connector asks: ${JSON.stringify(asks)}`);
		const read = await toolsOf({ asksNothing: reader })("read", { path: inOutside("q3.txt") });
		assert(read.failed && read.text === outsideFence(inOutside("q3.txt")), `an outside path is refused: ${read.text}`);
	});

	await row("32 the shared-server switch on: the names other programs run from and the startup files are as on main, even to a reader that says yes", async () => {
		plantRunsLater();
		const forced = toolsOf({ asksNothing: () => true });
		for (const [, file] of [...runsLater, ...newGitFolders]) await asOnMain(forced, "a shared server", file);
	});

	// -------------------------------------------------------------------------
	// The content policy in a room that asks nothing: it steps aside for the
	// room's file tools and its commands, and nowhere else. The shared-server
	// switch above is on in this process only; the server is a desktop one.
	// -------------------------------------------------------------------------
	const contentPolicy = await import("../../../pi-package/extensions/content-policy/index.js");
	const { createRoomCommandTools } = await import("../src/room-command-tool.js");
	// Built here, so the source holds no key-shaped text.
	const KEY = `sk-${"Synth3ticKey".repeat(2)}`;
	const blocked = (tool: string, rule: string, inText = false) => contentPolicyBlockReason(tool, RULE_WORDS[rule].reason, inText);
	const OWN_RULE_REASON = "blocked by local content policy";
	const freeFolder = path.join(home, "Rooms", "Free room");
	const envFile = path.join(freeFolder, ".env");
	const pemFile = path.join(freeFolder, "server.pem");
	const resetKeyFiles = () => {
		fs.writeFileSync(envFile, "TOKEN=1\n");
		fs.writeFileSync(pemFile, "-----BEGIN KEY-----\n");
		for (const name of ["key.txt", "carried.txt"]) fs.rmSync(path.join(freeFolder, name), { force: true });
	};
	// The five calls the person's own room makes in the state.
	const roomHands = (): Call[] => [
		fileCall("read", { path: envFile }),
		fileCall("edit", { path: envFile, edits: [{ oldText: "TOKEN=1", newText: `OPENAI_API_KEY=${KEY}` }] }),
		fileCall("write", { path: path.join(freeFolder, "key.txt"), content: `OPENAI_API_KEY=${KEY}\n` }),
		{ name: "bash", args: { command: `cat "${pemFile}"` } },
		{ name: "bash", args: { command: `printf %s ${KEY} > "${path.join(freeFolder, "carried.txt")}"` } },
	];
	const handsBlocked = [blocked("read", "dot-env"), blocked("edit", "dot-env"), blocked("write", "openai-key", true), blocked("bash", "pem-file"), blocked("bash", "openai-key")];
	const policyBlocks = (results: string[]) => results.filter((result) => result.startsWith("Content policy blocked tool "));

	await row("34 in the state the room's file tools and commands name .env and .pem and carry a key with no content-policy block: the .env reads, and a key goes into it and into a file", async () => {
		resetKeyFiles();
		const window = await conversationIn(freeRoom, "conv-key-hands");
		script = roomHands().map((call) => ({ calls: [call] }));
		window.prompt("Put my key in a file and log in to the server.");
		await window.ended();
		window.ws.close();
		assert(window.cards().length === 0, `no card, got ${JSON.stringify(window.cards())}`);
		assert(policyBlocks(toolResults).length === 0, `no content-policy block, got ${JSON.stringify(policyBlocks(toolResults))}`);
		const [read, , , pem] = toolResults;
		assert(read?.includes("TOKEN=1"), `the .env read gets the file: ${read}`);
		assert(fs.readFileSync(envFile, "utf8") === `OPENAI_API_KEY=${KEY}\n`, "the edit put the key in the .env");
		assert(fs.readFileSync(path.join(freeFolder, "key.txt"), "utf8") === `OPENAI_API_KEY=${KEY}\n`, "the write put the key in the file");
		assert(pem?.includes("-----BEGIN KEY-----"), `the command read the .pem file: ${pem}`);
		assert(fs.readFileSync(path.join(freeFolder, "carried.txt"), "utf8") === KEY, "the command carried the key");
	});

	await row("35 in the state the check still blocks a connector call that carries a key or names .env, a web search and a page with a key, and a file tool not on the list; a plain connector call and a plain attachments read beside them run", async () => {
		const attached = await json(roomPath(freeRoom, "/files"), { method: "POST", body: JSON.stringify({ filename: "notes.txt", contentBase64: Buffer.from("attached notes\n").toString("base64") }) });
		assert(attached.status === 200 || attached.status === 201, `notes.txt is attached, got ${attached.status}: ${JSON.stringify(attached.body)}`);
		const window = await conversationIn(freeRoom, "conv-key-out");
		script = [
			{ calls: [{ name: "mcp", args: { tool: "standin_make_note", args: JSON.stringify({ text: KEY }) } }] },
			{ calls: [{ name: "mcp", args: { tool: "standin_make_note", args: JSON.stringify({ file: ".env" }) } }] },
			{ calls: [{ name: "web_search", args: { query: `who uses ${KEY}` } }] },
			{ calls: [{ name: "fetch_url", args: { url: `https://example.com/?key=${KEY}` } }] },
			// The room's attachments reader, a file tool that isn't one of the room's six.
			{ calls: [{ name: "read_file", args: { name: ".env" } }] },
			{ calls: [connectorCall("make_note")] },
			{ calls: [{ name: "read_file", args: { name: "notes.txt" } }] },
		];
		window.prompt("Send my key around.");
		await window.ended();
		window.ws.close();
		const want = [blocked("mcp", "openai-key"), blocked("mcp", "dot-env"), blocked("web_search", "openai-key"), blocked("fetch_url", "openai-key"), blocked("read_file", "dot-env")];
		assert(JSON.stringify(toolResults.slice(0, 5)) === JSON.stringify(want), `each is blocked:\n${toolResults.slice(0, 5).join("\n")}`);
		assert(JSON.stringify(called()) === JSON.stringify(["make_note"]), `only the plain connector call ran, got ${JSON.stringify(called())}`);
		assert(toolResults.length === 7 && toolResults[6].includes("attached notes"), `the attachments reader on a plain name reads the file: ${toolResults.at(-1)}`);
	});

	await row("36 in the state a rule the person added still blocks a file tool and a command; a file beside it reads", async () => {
		const ownRules = path.join(appRoot, "content-policy.json");
		writeSetting(ownRules, { rules: [{ id: "launch-codes", pattern: "launch-codes" }] });
		fs.writeFileSync(path.join(freeFolder, "launch-codes.txt"), "1234\n");
		fs.writeFileSync(path.join(freeFolder, "notes.txt"), "notes\n");
		try {
			const window = await conversationIn(freeRoom, "conv-own-rule");
			script = [
				{ calls: [fileCall("read", { path: path.join(freeFolder, "launch-codes.txt") })] },
				{ calls: [{ name: "bash", args: { command: "cat launch-codes.txt" } }] },
				{ calls: [fileCall("read", { path: path.join(freeFolder, "notes.txt") })] },
			];
			window.prompt("Read the codes.");
			await window.ended();
			window.ws.close();
			assert(toolResults[0] === contentPolicyBlockReason("read", OWN_RULE_REASON) && toolResults[1] === contentPolicyBlockReason("bash", OWN_RULE_REASON), `the person's rule blocks both:\n${toolResults.slice(0, 2).join("\n")}`);
			assert(toolResults[2]?.includes("notes"), `the file beside it reads: ${toolResults[2]}`);
		} finally {
			fs.rmSync(ownRules, { force: true });
		}
	});

	await row("37 a room on Ask blocks the same five calls as on main, with no card", async () => {
		resetKeyFiles();
		await setMode(freeRoom, false);
		try {
			const window = await conversationIn(freeRoom, "conv-key-ask");
			script = roomHands().map((call) => ({ calls: [call] }));
			window.prompt("Put my key in a file and log in to the server.");
			await window.ended();
			window.ws.close();
			assert(window.cards().length === 0, `no card, got ${JSON.stringify(window.cards())}`);
			assert(JSON.stringify(toolResults) === JSON.stringify(handsBlocked), `each is blocked:\n${toolResults.join("\n")}`);
			assert(fs.readFileSync(envFile, "utf8") === "TOKEN=1\n" && !fs.existsSync(path.join(freeFolder, "key.txt")) && !fs.existsSync(path.join(freeFolder, "carried.txt")), "nothing was written");
		} finally {
			await settled(freeRoom, "the Ask turn landed");
			await setMode(freeRoom, true);
		}
	});

	await row("38 a protected room on Auto blocks the same five calls as on main", async () => {
		const guarded = await newRoom("Guarded keys room", path.join(home, "Rooms", "Guarded keys room"));
		const protection = await protectionOf(guarded);
		if (protection?.state !== "on") return `this computer's protection reads ${JSON.stringify(protection)}; the mini runs it`;
		const answer = await json(roomPath(guarded, "/bash-settings"), { method: "PUT", body: JSON.stringify({ autoApprove: true, free: true, protection }) });
		assert(answer.status === 200, `the protected room is on Auto, got ${JSON.stringify(answer.body)}`);
		const window = await conversationIn(guarded, "conv-guarded-keys");
		script = roomHands().map((call) => ({ calls: [call] }));
		window.prompt("Put my key in a file and log in to the server.");
		await window.ended();
		window.ws.close();
		assert(JSON.stringify(toolResults) === JSON.stringify(handsBlocked), `each is blocked:\n${toolResults.join("\n")}`);
	});

	await row("39 switching mid-conversation: on Ask the next .env read and command are blocked; back on Auto the next are not", async () => {
		resetKeyFiles();
		const window = await conversationIn(freeRoom, "conv-key-switch");
		const both = (): Call[] => [fileCall("read", { path: envFile }), { name: "bash", args: { command: `cat "${envFile}"` } }];
		script = [
			{ calls: both(), before: () => setMode(freeRoom, false) },
			{ calls: both(), before: () => setMode(freeRoom, true) },
		];
		window.prompt("Show me the .env file.");
		await window.ended();
		window.ws.close();
		const [askRead, askCommand, autoRead, autoCommand] = toolResults;
		assert(askRead === blocked("read", "dot-env") && askCommand === blocked("bash", "dot-env"), `on Ask:\n${askRead}\n${askCommand}`);
		assert(autoRead?.includes("TOKEN=1") && autoCommand?.includes("TOKEN=1"), `back on Auto:\n${autoRead}\n${autoCommand}`);
	});

	await row("40 at the check itself: a reader that says no, one that throws, no reader and the shared-server reader block the five calls; a reader that says yes lets them through, and a connector call stays blocked", async () => {
		const verdicts = async (factory: (pi: any) => void, calls: Call[]): Promise<Array<string | undefined>> => {
			let hook: ((event: any, ctx: any) => Promise<any>) | undefined;
			factory({ on: (name: string, handler: any) => { if (name === "tool_call") hook = handler; } });
			const out: Array<string | undefined> = [];
			for (const call of calls) out.push((await hook!({ toolName: call.name, input: call.args }, { cwd: freeFolder }))?.reason);
			return out;
		};
		const sharedReader = () => unprotectedRoomOnAuto("asks-nothing-shared-room", "conversation-a");
		const outsideTheState: Array<[string, (pi: any) => void]> = [
			["a reader that says no", contentPolicy.createContentPolicyExtension({ asksNothing: () => false })],
			["a reader that throws", contentPolicy.createContentPolicyExtension({ asksNothing: () => { throw new Error("unreadable"); } })],
			["no reader (a scheduled run)", contentPolicy.default],
			["the shared-server switch on", contentPolicy.createContentPolicyExtension({ asksNothing: sharedReader })],
		];
		for (const [label, factory] of outsideTheState) {
			const got = await verdicts(factory, roomHands());
			assert(JSON.stringify(got) === JSON.stringify(handsBlocked), `${label}:\n${got.join("\n")}`);
		}
		const free = contentPolicy.createContentPolicyExtension({ asksNothing: () => true });
		const passes = await verdicts(free, roomHands());
		assert(passes.every((reason) => reason === undefined), `a reader that says yes: ${JSON.stringify(passes)}`);
		const out = await verdicts(free, [{ name: "mcp", args: { tool: "standin_make_note", args: JSON.stringify({ text: KEY }) } }, connectorCall("make_note")]);
		assert(out[0] === blocked("mcp", "openai-key") && out[1] === undefined, `the connector call with a key, and a plain one beside it: ${JSON.stringify(out)}`);
	});

	await row("41 the tools the check steps aside for are the room's six file tools and its command tool, by their real names", async () => {
		const policy = policyMod.createPersistentRoomCapabilityPolicy({ agentId: toolRoom, conversationId: "conversation-a", repoRoot, root: roomFolder, workspaceAccessMode: "localFiles", source: "manual" } as any);
		const real = [...createPersistentRoomWorkspaceTools(policy, {}).map((tool) => String(tool.name)), ...createRoomCommandTools(roomFolder).tools.map((tool) => String(tool.name))].sort();
		const listed = [...contentPolicy.ROOM_FILE_AND_COMMAND_TOOLS].sort();
		assert(real.length === 7 && JSON.stringify(listed) === JSON.stringify(real), `the list ${JSON.stringify(listed)} is not the tools ${JSON.stringify(real)}`);
	});
} finally {
	await stopSmokeServer(serverProcess);
	gateway.close();
	if (failures > 0) console.log(serverOutput.join("").slice(-4000));
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
if (failures > 0) {
	console.log(`${failures} row(s) failed`);
	process.exit(1);
}
console.log("unprotected-auto-asks-nothing: all rows passed");
process.exit(0);
