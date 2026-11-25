// A local connector program starts outside the room box, so one sitting
// where a room can change files must not start, and none gets the app's
// secrets. Driven through the real Test route's function, the real room
// warm-up, the real room extension's first use and the real adapter, with a
// real program that writes one line to a file outside every room each time
// it runs. Each refused row has its allowed neighbour, the same connector
// once the folder is read-only for the room.
//
// Rows:
//  room folder   a script in a room's folder, the room can change files:
//                Test, warm-up and first use start nothing, and the status
//                names the room; read-only for the room, all three start it.
//  working folder, Also allowed folder with change access, the box's own
//                caches: refused; Also allowed read only: allowed.
//  npx           a package npx runs from npm's cache, a room on that cache
//                (or inside it) can change files: Test starts nothing; read
//                only, it starts from the cache, nothing downloaded.
//  uvx           a room on uv's cache, inside it, or on its installed tools
//                can change files: the status refuses; a sibling folder,
//                or read only: allowed.
//  environment   the started program has neither the app's token nor a
//                provider key nor an app setting, and has what it declares.
//  npx lookup    a room on a folder first on the entry's own PATH: Test runs
//                no npm, node or npx from it; a room on a folder on that PATH
//                holding only what an install script names: nothing runs, and
//                the status says so; an npm in a folder no room can change,
//                linked to a file one can: nothing runs; read only, all run.
//  patch         the adapter patch on scratch copies of the installed
//                adapter: applies to the package's own text, passes when
//                applied, and fails the install when patch 13's or patch
//                14's anchor is gone, it is applied in one place of two, or
//                an earlier version of the script patched it (that line
//                says to run npm ci).
//
// Offline, isolated HOME, agent dir and rooms root, set before any import
// that reads them.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "connector-start-check-")));
const agentDir = path.join(tempHome, ".exxperts", "agent");
const roomsRoot = path.join(tempHome, "rooms");
const npmCache = path.join(tempHome, ".npm");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(roomsRoot, { recursive: true });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = roomsRoot;
// The adapter's npx lookup reads the cache folder from here (npm 11 refuses `npm config get cache`).
// Cleared before it is set: on Windows the two spellings are one variable.
delete process.env.npm_config_cache;
process.env.NPM_CONFIG_CACHE = npmCache;
// uv's folders by its defaults under this home, where a connector's uvx keeps them. A
// setting of the server's own never reaches a connector, so it moves no folder.
const uvCache = path.join(tempHome, ".cache", "uv");
const uvTools = path.join(tempHome, ".local", "share", "uv", "tools");
const serverUvCache = path.join(tempHome, "server-uv-cache");
process.env.UV_CACHE_DIR = serverUvCache;
delete process.env.XDG_CACHE_HOME;
delete process.env.XDG_DATA_HOME;
delete process.env.UV_TOOL_DIR;
// Whatever an npm the adapter runs itself would do, it downloads nothing.
process.env.npm_config_offline = "true";
// What a started program must never see, made at run time.
const appToken = randomBytes(16).toString("hex");
const providerKey = `sk-ant-row-${randomBytes(12).toString("hex")}`;
process.env.EXXPERTS_AUTH_TOKEN = appToken;
process.env.ANTHROPIC_API_KEY = providerKey;
process.env.EXXETA_ROW_SETTING = "on";
process.env.MCP_ROW_SETTING = "on";
delete process.env.MCP_DIRECT_TOOLS;

const failures: string[] = [];
function check(id: string, ok: boolean, message: string): void {
	if (ok) console.log(`ok   ${id}: ${message}`);
	else {
		console.error(`FAIL ${id}: ${message}`);
		failures.push(id);
	}
}

// The program: writes one line (the names it was given, never their values,
// and the one value it declares) and answers MCP over stdio.
const markerFile = path.join(tempHome, "markers", "started.jsonl");
fs.mkdirSync(path.dirname(markerFile), { recursive: true });
const PROGRAM = `
const fs = require("node:fs");
fs.appendFileSync(process.env.ROW_MARKER, JSON.stringify({ at: process.argv[1], names: Object.keys(process.env).sort(), declared: process.env.ROW_DECLARED ?? null }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let end;
	while ((end = buffer.indexOf("\\n")) !== -1) {
		const message = JSON.parse(buffer.slice(0, end));
		buffer = buffer.slice(end + 1);
		if (message.id === undefined) continue;
		const results = {
			initialize: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "row-program", version: "1.0.0" } },
			"tools/list": { tools: [{ name: "row_tool", inputSchema: { type: "object" } }] },
			"resources/list": { resources: [] },
		};
		const result = results[message.method];
		process.stdout.write(JSON.stringify(result ? { jsonrpc: "2.0", id: message.id, result } : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } }) + "\\n");
	}
});
`;
const startsCount = (): number => (fs.existsSync(markerFile) ? fs.readFileSync(markerFile, "utf8").split("\n").filter(Boolean).length : 0);
const lastStart = (): { at: string; names: string[]; declared: string | null } => JSON.parse(fs.readFileSync(markerFile, "utf8").trim().split("\n").at(-1)!);

const declared = `row-${randomBytes(6).toString("hex")}`;
function programEntry(script: string, cwd?: string) {
	return { command: process.execPath, args: [script], ...(cwd ? { cwd } : {}), env: { ROW_MARKER: markerFile, ROW_DECLARED: declared, EXXPERTS_ROW_SETTING: "declared" } };
}
function writeConfig(servers: Record<string, unknown>): void {
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}
function writeProgram(file: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, PROGRAM);
	return file;
}

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const policyMod = await import("../src/persistent-room-workspace-policy.js");
const { writePersistentRoomMcpSettings } = await import("../src/persistent-room-mcp-settings.js");
const { addAlsoAllowedFolder } = await import("../src/room-box/also-allowed.js");
const { testMcpServer } = await import("../src/mcp-admin.js");
const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
// The lookup the status route hands in.
const { startRefusalLookup } = await import("../src/connector-start-check.js");
const { createRoomScopedMcpExtension } = await import("../../../pi-package/extensions/mcp/index.js");
const cacheMod = await import("pi-mcp-adapter/metadata-cache.ts" as string);

const READ_ONLY = { kind: "custom" as const, allowedToolNames: ["read", "ls", "find", "grep"] };
const STANDARD = { kind: "standard" as const };
/** A room on a folder; canChange decides whether it can change files there, sent each time, since a save without it keeps how the room's folder stood. */
function makeRoom(roomId: string, name: string, folder: string, canChange: boolean): void {
	fs.mkdirSync(path.join(roomsRoot, roomId), { recursive: true });
	fs.writeFileSync(path.join(roomsRoot, roomId, "agent.json"), JSON.stringify({ displayName: name }));
	fs.mkdirSync(folder, { recursive: true });
	policyMod.writePersistentRoomDefaultCapabilityPolicy(policyMod.createPersistentRoomDefaultCapabilityPolicy({
		agentId: roomId, repoRoot, root: folder, workspaceAccessMode: "localFiles", displayLabel: name, source: "manual",
		toolSelection: canChange ? STANDARD : READ_ONLY,
	}));
}
function removeRoom(roomId: string): void {
	fs.rmSync(path.join(roomsRoot, roomId), { recursive: true, force: true });
}

async function refusalOf(name: string): Promise<{ roomId: string; roomName: string } | null> {
	const status = await getMcpConnectorsStatus(startRefusalLookup);
	return status.servers.find((server) => server.name === name)?.startRefused ?? null;
}

interface FakePi {
	tools: Map<string, any>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	[key: string]: unknown;
}
function makeFakePi(): FakePi {
	const pi: FakePi = {
		tools: new Map(),
		handlers: new Map(),
		registerTool(tool: any) { pi.tools.set(String(tool.name), tool); },
		registerCommand() {},
		registerFlag() {},
		getFlag() { return undefined; },
		getAllTools() { return [...pi.tools.values()]; },
		sendMessage() {},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			pi.handlers.set(event, [...(pi.handlers.get(event) ?? []), handler]);
		},
	};
	return pi;
}
const fakeCtx = { cwd: tempHome, hasUI: false, ui: undefined, modelRegistry: undefined, model: undefined, signal: undefined, reload: async () => {} };

/**
 * A room's session through the real extension, whose registration runs the
 * room's warm-up when no tool list is kept yet, and, when a connector is
 * named, its first use of it through the real mcp tool.
 */
async function roomSession(roomId: string, connector?: string): Promise<{ text: string; isError: boolean }> {
	const pi = makeFakePi();
	await createRoomScopedMcpExtension(roomId)(pi);
	for (const handler of pi.handlers.get("session_start") ?? []) await handler({}, fakeCtx);
	try {
		if (!connector) return { text: "", isError: false };
		const result = await pi.tools.get("mcp").execute("row-first-use", { connect: connector }, undefined, undefined, fakeCtx);
		return { text: String(result?.content?.[0]?.text ?? ""), isError: result?.isError === true || /fail|error|not/i.test(String(result?.content?.[0]?.text ?? "")) };
	} finally {
		for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({}, fakeCtx);
	}
}
const dropCache = () => fs.rmSync(cacheMod.getMetadataCachePath(), { force: true });
const cachedServers = (): string[] => Object.keys(cacheMod.loadMetadataCache()?.servers ?? {});

try {
	// ── A script in a room's folder ─────────────────────────────────────────
	const project = path.join(tempHome, "Documents", "project");
	const script = writeProgram(path.join(project, "server.js"));
	writeConfig({ rowc: programEntry(script) });
	makeRoom("writer", "Writer room", project, true);
	writePersistentRoomMcpSettings("writer", ["rowc"]);

	const refused = await refusalOf("rowc");
	check("folder-status", refused?.roomId === "writer" && refused.roomName === "Writer room", `the status names the room that can change the script's folder (got ${JSON.stringify(refused)})`);

	// The room's own doors first, before Test has run in this process: each must put the check in place itself.
	delete globalThis.exxpertsConnectorStartCheck;
	dropCache();
	await roomSession("writer");
	check("folder-warm-up", startsCount() === 0 && !cachedServers().includes("rowc"), `the room's warm-up starts nothing (started ${startsCount()} times)`);
	delete globalThis.exxpertsConnectorStartCheck;
	const used = await roomSession("writer", "rowc");
	check("folder-first-use", startsCount() === 0 && used.isError, `a room's first use starts nothing (started ${startsCount()} times; the tool said ${JSON.stringify(used.text.slice(0, 160))})`);

	delete globalThis.exxpertsConnectorStartCheck;
	const test = await testMcpServer("rowc");
	check("folder-test", test.ok === false && test.startRefused?.roomName === "Writer room" && startsCount() === 0, `Test refuses before the program starts (started ${startsCount()} times, result ${JSON.stringify({ ok: test.ok, startRefused: test.startRefused })})`);
	const checksFile = path.join(agentDir, "mcp-connector-checks.json");
	check("folder-test-keeps-no-check", !fs.existsSync(checksFile) || !("rowc" in (JSON.parse(fs.readFileSync(checksFile, "utf8")).checks ?? {})), "a refused start keeps no check: the status says it while it holds");
	// The page keeps what Test found until the next check, where the status sees no refusal (a cache folder set in npm's own settings).
	const { checkOf, connectorRowState } = await import("../../web-ui/src/connector-rows.js");
	const shownRow = (await getMcpConnectorsStatus(startRefusalLookup)).servers.find((server) => server.name === "rowc")!;
	const rowAfterTest = connectorRowState({ ...shownRow, startRefused: undefined } as never, checkOf(test), null);
	check("folder-test-row", rowAfterTest.kind === "cant-start" && rowAfterTest.room === "Writer room", `after a refused Test the row says it can't start, whatever the status says (got ${JSON.stringify(rowAfterTest)})`);

	// The same folder, read-only for the room: every door starts it.
	makeRoom("writer", "Writer room", project, false);
	check("readonly-status", (await refusalOf("rowc")) === null, "read-only for the room, the status says nothing against it");
	const allowedTest = await testMcpServer("rowc");
	check("readonly-test", allowedTest.ok === true && startsCount() === 1, `read-only for the room, Test starts it (started ${startsCount()} times, ok ${allowedTest.ok}, error ${JSON.stringify(allowedTest.error ?? null)})`);
	dropCache();
	await roomSession("writer");
	check("readonly-warm-up", startsCount() === 2 && cachedServers().includes("rowc"), `read-only for the room, the warm-up starts it (started ${startsCount()} times)`);
	await roomSession("writer", "rowc");
	check("readonly-first-use", startsCount() === 3, `read-only for the room, its first use starts it (started ${startsCount()} times)`);

	// ── The environment the started program had ────────────────────────────
	const seen = lastStart();
	check("env-control", process.env.EXXPERTS_AUTH_TOKEN === appToken && process.env.ANTHROPIC_API_KEY === providerKey, "the server process holds the token and the key the program must not get");
	check("env-no-token", !seen.names.includes("EXXPERTS_AUTH_TOKEN"), "the program has no app token");
	check("env-no-key", !seen.names.includes("ANTHROPIC_API_KEY"), "the program has no provider key");
	const appSettings = seen.names.filter((name) => /^(EXXPERTS_|EXXETA_|PI_|MCP_)/.test(name));
	check("env-no-settings", appSettings.join(",") === "EXXPERTS_ROW_SETTING", `the program has no app setting but the one it declares (got ${appSettings.join(",")})`);
	check("env-declared", seen.declared === declared && seen.names.includes("ROW_MARKER"), "a variable the connector declares reaches it");
	check("env-runs", seen.names.includes("PATH") && seen.names.includes("HOME"), "the program has what programs need to run");

	// ── Its working folder, an Also allowed folder, the box's own caches ────
	const outside = writeProgram(path.join(tempHome, "Tools", "outside.js"));
	makeRoom("writer", "Writer room", project, true);
	writeConfig({ rowc: programEntry(outside, project) });
	check("cwd-refused", (await refusalOf("rowc"))?.roomId === "writer", "a program that runs in a room's folder is refused");
	writeConfig({ rowc: programEntry(outside) });
	check("cwd-control", (await refusalOf("rowc")) === null, "the same program run from elsewhere is not");

	const extra = path.join(tempHome, "Documents", "extra");
	const extraScript = writeProgram(path.join(extra, "extra.js"));
	writeConfig({ rowc: programEntry(extraScript) });
	addAlsoAllowedFolder("writer", extra, "write");
	if (process.platform === "win32") console.log("SKIPPED: not yet on a real Windows PC: also-allowed-write (the smoke saves the folder by its short 8.3 name, where the app wants the real path)");
	else check("also-allowed-write", (await refusalOf("rowc"))?.roomId === "writer", "a program in an Also allowed folder the room can change is refused");
	fs.rmSync(path.join(roomsRoot, "writer", "runtime", "also-allowed.json"));
	addAlsoAllowedFolder("writer", extra, "read");
	check("also-allowed-read", (await refusalOf("rowc")) === null, "one the room can only read is not");

	const boxScript = writeProgram(path.join(roomsRoot, "writer", "runtime", "box", "caches", "boxed.js"));
	makeRoom("writer", "Writer room", project, false);
	writeConfig({ rowc: programEntry(boxScript) });
	check("box-caches", (await refusalOf("rowc"))?.roomId === "writer", "a program in the box's own caches is refused, even in a read-only room");

	// A launcher's files and folders count up to its script, the first one that follows no bare flag; the rest is the program's data.
	makeRoom("writer", "Writer room", project, true);
	const packageFolder = path.join(project, "connector-package");
	writeProgram(path.join(packageFolder, "index.js"));
	const outsidePackage = path.join(tempHome, "Tools", "connector-package");
	writeProgram(path.join(outsidePackage, "index.js"));
	writeConfig({ rowc: { ...programEntry(script), args: [packageFolder] } });
	check("entry-folder", (await refusalOf("rowc"))?.roomId === "writer", "node handed a folder in the room's folder is refused: it runs that folder's code");
	writeConfig({ rowc: { ...programEntry(script), args: [outsidePackage] } });
	check("entry-folder-control", (await refusalOf("rowc")) === null, "node handed a folder elsewhere is not");
	writeConfig({ rowc: { command: "uv", args: ["--directory", path.join(project, "weather"), "run", "weather.py"] } });
	fs.mkdirSync(path.join(project, "weather"), { recursive: true });
	check("uv-directory", (await refusalOf("rowc"))?.roomId === "writer", "uv run in a folder of the room's is refused");
	fs.mkdirSync(path.join(tempHome, "Tools", "weather"), { recursive: true });
	writeConfig({ rowc: { command: "uv", args: [`--directory=${path.join(tempHome, "Tools", "weather")}`, "run", "weather.py"] } });
	check("uv-directory-control", (await refusalOf("rowc")) === null, "uv run in a folder elsewhere is not");
	const dataFile = path.join(project, "data.db");
	fs.writeFileSync(dataFile, "");
	writeConfig({ rowc: { ...programEntry(outside), args: [outside, "--db-path", dataFile, project] } });
	check("data-argument", (await refusalOf("rowc")) === null, "a program elsewhere handed a data file and a folder in the room's folder starts");
	const preload = writeProgram(path.join(tempHome, "Tools", "preload.cjs"));
	writeConfig({ rowc: { ...programEntry(script), args: ["--require", preload, script] } });
	check("preload-then-script", (await refusalOf("rowc"))?.roomId === "writer", "node with a preload elsewhere and its script in the room's folder is refused");
	writeConfig({ rowc: { ...programEntry(script), args: [`--require=${path.join(project, "server.js")}`, outside] } });
	check("preload-in-room", (await refusalOf("rowc"))?.roomId === "writer", "node with its preload in the room's folder is refused");
	writeConfig({ rowc: { ...programEntry(script), args: ["--require", preload, outside, project, dataFile] } });
	check("preload-control", (await refusalOf("rowc")) === null, "node with a preload and a script elsewhere, handed the room's folder and a file in it, starts");
	// A bare switch can't be told from a flag that takes a value, so the file after it counts and the data after that too.
	writeConfig({ rowc: { ...programEntry(script), args: ["--no-warnings", outside, dataFile] } });
	check("switch-then-data", (await refusalOf("rowc"))?.roomId === "writer", "node with a bare switch, a script elsewhere and a file in the room's folder is refused, on the safe side");
	// A program file here is a shell script, which Windows can't start.
	if (process.platform !== "win32") {
		const outsideBinary = path.join(tempHome, "Tools", "bin", "row-binary");
		fs.mkdirSync(path.dirname(outsideBinary), { recursive: true });
		fs.writeFileSync(outsideBinary, "#!/bin/sh\n", { mode: 0o755 });
		writeConfig({ rowc: { command: outsideBinary, args: [dataFile] } });
		check("data-argument-binary", (await refusalOf("rowc")) === null, "a program that is no launcher, handed a file in the room's folder, starts");
		writeConfig({ rowc: { command: path.join(project, "row-binary"), args: [] } });
		fs.writeFileSync(path.join(project, "row-binary"), "#!/bin/sh\n", { mode: 0o755 });
		check("program-in-room", (await refusalOf("rowc"))?.roomId === "writer", "a program that is itself in the room's folder is refused");
	} else console.log("skip data-argument-binary, program-in-room: their programs are shell scripts, which Windows can't start");
	writeConfig({ rowc: { ...programEntry(script), args: ["--port", 3000, script] } });
	const odd = await getMcpConnectorsStatus(startRefusalLookup).then((status) => status.servers.find((server) => server.name === "rowc"), (error: Error) => error);
	check("args-not-text", !(odd instanceof Error) && odd?.startRefused?.roomId === "writer", `a hand-edited argument that is no text leaves the page whole, and the program is still judged (got ${odd instanceof Error ? odd.message : JSON.stringify(odd?.startRefused ?? null)})`);

	// Looked up on PATH as the start looks it up: the connector's own PATH, and a file only when it can run.
	// Windows has no "can run" mode bit and can't start the shell script.
	if (process.platform !== "win32") {
		const safeBin = path.join(tempHome, "Tools", "safe-bin");
		const roomBin = path.join(project, "bin");
		fs.mkdirSync(safeBin, { recursive: true });
		fs.mkdirSync(roomBin, { recursive: true });
		fs.writeFileSync(path.join(safeBin, "row-tool"), "not a program", { mode: 0o644 });
		fs.writeFileSync(path.join(roomBin, "row-tool"), `#!/bin/sh\necho '{"at":"row-tool","names":[],"declared":null}' >> "$ROW_MARKER"\n`, { mode: 0o755 });
		const pathEntry = { command: "row-tool", args: [], env: { ROW_MARKER: markerFile, PATH: [safeBin, roomBin, process.env.PATH].join(path.delimiter) } };
		writeConfig({ rowc: pathEntry });
		check("path-declared-status", (await refusalOf("rowc"))?.roomId === "writer", "the status looks the program up on the connector's own PATH, past a file that can't run");
		const pathBefore = startsCount();
		const pathTest = await testMcpServer("rowc");
		check("path-test", pathTest.startRefused?.roomId === "writer" && startsCount() === pathBefore, `Test looks up what would run, skipping a file that can't run, and starts nothing (started ${startsCount() - pathBefore} times)`);
		fs.chmodSync(path.join(safeBin, "row-tool"), 0o755);
		check("path-control", (await refusalOf("rowc")) === null, "once the first one can run, it is the program, and it starts");
	} else console.log("skip path-declared-status, path-test, path-control: Windows has no mode bit that says a file can run");

	// A rooms folder that can't be read is no proof no room can change anything.
	// chmod has no teeth on Windows or as root (the Linux gate runs as root).
	const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
	if (canForceFsRefusal) {
		writeConfig({ rowc: programEntry(outside) });
		fs.chmodSync(roomsRoot, 0o000);
		const unreadableBefore = startsCount();
		const unreadable = await testMcpServer("rowc").catch((error: Error) => ({ ok: false, error: error.message }));
		fs.chmodSync(roomsRoot, 0o755);
		check("rooms-unreadable", unreadable.ok === false && startsCount() === unreadableBefore, `with the rooms folder unreadable, Test starts nothing (started ${startsCount() - unreadableBefore} times)`);
		const readable = await testMcpServer("rowc");
		check("rooms-readable", readable.ok === true && startsCount() === unreadableBefore + 1, "readable again, the same program starts");
	} else console.log("skip rooms-unreadable, rooms-readable: folder modes have no effect on Windows or as root");
	removeRoom("writer");

	// ── npx: a package npx runs from npm's cache ────────────────────────────
	const packageDir = path.join(npmCache, "_npx", "rowhash", "node_modules", "row-mcp");
	writeProgram(path.join(packageDir, "index.js"));
	fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "row-mcp", version: "1.0.0", bin: { "row-mcp": "index.js" } }));
	const { resolveNpxBinary } = await import("pi-mcp-adapter/npx-resolver.ts" as string);
	const resolved = await resolveNpxBinary("npx", ["-y", "row-mcp"]);
	if (resolved?.binPath !== fs.realpathSync(path.join(packageDir, "index.js"))) throw new Error(`the npx rows need the package resolved from the cache, never downloaded (got ${JSON.stringify(resolved)})`);
	writeConfig({ rownpx: { command: "npx", args: ["-y", "row-mcp"], env: { ROW_MARKER: markerFile, ROW_DECLARED: declared } } });
	const before = startsCount();
	makeRoom("npm", "Npm room", npmCache, true);
	const npxTest = await testMcpServer("rownpx");
	check("npx-test", npxTest.startRefused?.roomId === "npm" && startsCount() === before, `with a room on npm's cache, Test starts nothing (started ${startsCount() - before} times, ${JSON.stringify(npxTest.startRefused ?? null)})`);
	check("npx-status", (await refusalOf("rownpx"))?.roomId === "npm", "the status names the room on npm's cache");
	removeRoom("npm");
	makeRoom("npm-inside", "Npm inside room", path.join(npmCache, "_npx", "rowhash", "node_modules", "other-dep"), true);
	check("npx-inside", (await refusalOf("rownpx"))?.roomId === "npm-inside", "a room on a folder inside npm's cache is refused too: npx runs its package with what is installed beside it");
	removeRoom("npm-inside");
	makeRoom("npm-logs", "Npm logs room", path.join(npmCache, "_logs"), true);
	check("npx-logs", (await refusalOf("rownpx")) === null, "a room on npm's log folder is no room on the packages npx runs");
	removeRoom("npm-logs");
	makeRoom("npm", "Npm room", npmCache, false);
	const npxAllowed = await testMcpServer("rownpx");
	check("npx-readonly", npxAllowed.ok === true && startsCount() === before + 1 && lastStart().at === fs.realpathSync(path.join(packageDir, "index.js")), `read-only for the room, Test starts the package from the cache (started ${startsCount() - before} times, error ${JSON.stringify(npxAllowed.error ?? null)})`);
	removeRoom("npm");

	// The npx lookup runs npm, and npm runs node, along the entry's own PATH: a room's folder first there starts neither.
	if (process.platform === "win32") console.log("SKIPPED: not yet on a real Windows PC: npx-lookup-path, npx-lookup-path-readonly (the row's npm, node and npx are shell scripts)");
	else {
		const tools = path.join(tempHome, "Documents", "tools");
		const lookupMarker = path.join(tempHome, "markers", "lookup.txt");
		fs.mkdirSync(tools, { recursive: true });
		for (const name of ["npm", "node", "npx"]) fs.writeFileSync(path.join(tools, name), `#!/bin/sh\necho ${name} >> '${lookupMarker}'\nexit 1\n`, { mode: 0o755 });
		const lookups = (): string[] => (fs.existsSync(lookupMarker) ? fs.readFileSync(lookupMarker, "utf8").split("\n").filter(Boolean) : []);
		writeConfig({ rownpxpath: { command: "npx", args: ["-y", "row-absent-mcp"], env: { ROW_MARKER: markerFile, PATH: `${tools}${path.delimiter}${process.env.PATH}` } } });
		makeRoom("tools", "Tools room", tools, true);
		const pathTest = await testMcpServer("rownpxpath");
		check("npx-lookup-path", pathTest.startRefused?.roomId === "tools" && lookups().length === 0, `with a room on a folder first on the entry's PATH, Test runs no npm, node or npx from it (ran ${JSON.stringify(lookups())}, ${JSON.stringify(pathTest.startRefused ?? pathTest.error ?? null)})`);
		removeRoom("tools");
		makeRoom("tools", "Tools room", tools, false);
		const pathAllowed = await testMcpServer("rownpxpath");
		check("npx-lookup-path-readonly", !pathAllowed.startRefused && lookups().includes("npm"), `read-only for the room, the lookup runs that folder's npm (ran ${JSON.stringify(lookups())}, ${JSON.stringify(pathAllowed.error ?? null)})`);
		removeRoom("tools");

		// npm runs a package's install scripts through /bin/sh, which finds what they name along that same
		// PATH: a room's folder there runs nothing, whatever program it holds. This npm does as npm does.
		const buildTools = path.join(tempHome, "Documents", "build-tools");
		const ownNpm = path.join(tempHome, "own-npm");
		for (const folder of [buildTools, ownNpm]) fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(buildTools, "row-build-tool"), `#!/bin/sh\necho row-build-tool >> '${lookupMarker}'\n`, { mode: 0o755 });
		fs.writeFileSync(path.join(ownNpm, "npm"), "#!/bin/sh\n/bin/sh -c row-build-tool\nexit 1\n", { mode: 0o755 });
		fs.writeFileSync(path.join(ownNpm, "npx"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		writeConfig({ rownpxscript: { command: "npx", args: ["-y", "row-script-mcp"], env: { ROW_MARKER: markerFile, PATH: [buildTools, ownNpm, process.env.PATH].join(path.delimiter) } } });
		makeRoom("build", "Build tools room", buildTools, true);
		const scriptTest = await testMcpServer("rownpxscript");
		check("npx-install-script-path", scriptTest.startRefused?.roomId === "build" && !lookups().includes("row-build-tool"), `with a room on a folder on the entry's PATH, an install script runs nothing from it (ran ${JSON.stringify(lookups())}, ${JSON.stringify(scriptTest.startRefused ?? scriptTest.error ?? null)})`);
		check("npx-install-script-status", (await refusalOf("rownpxscript"))?.roomId === "build", "the status names that room too, so the row says it after a reload");
		removeRoom("build");
		makeRoom("build", "Build tools room", buildTools, false);
		const scriptAllowed = await testMcpServer("rownpxscript");
		check("npx-install-script-readonly", !scriptAllowed.startRefused && lookups().includes("row-build-tool"), `read-only for the room, the install script runs that folder's program (ran ${JSON.stringify(lookups())}, ${JSON.stringify(scriptAllowed.error ?? null)})`);
		removeRoom("build");

		// The lookup's npm, found in a folder no room can change, may be a link to a file a room can: what it runs counts.
		const linkedTools = path.join(tempHome, "linked-tools");
		const npmRoom = path.join(tempHome, "Documents", "npm-room");
		for (const folder of [linkedTools, npmRoom]) fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(npmRoom, "npm"), `#!/bin/sh\necho linked-npm >> '${lookupMarker}'\nexit 1\n`, { mode: 0o755 });
		fs.symlinkSync(path.join(npmRoom, "npm"), path.join(linkedTools, "npm"));
		fs.writeFileSync(path.join(linkedTools, "npx"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		writeConfig({ rownpxlinked: { command: "npx", args: ["-y", "row-linked-mcp"], env: { ROW_MARKER: markerFile, PATH: [linkedTools, process.env.PATH].join(path.delimiter) } } });
		makeRoom("npm-link", "Linked npm room", npmRoom, true);
		const linkedTest = await testMcpServer("rownpxlinked");
		check("npx-lookup-linked-npm", linkedTest.startRefused?.roomId === "npm-link" && !lookups().includes("linked-npm"), `an npm linked to a file a room can change runs nothing (ran ${JSON.stringify(lookups())}, ${JSON.stringify(linkedTest.startRefused ?? linkedTest.error ?? null)})`);
		removeRoom("npm-link");
		makeRoom("npm-link", "Linked npm room", npmRoom, false);
		const linkedAllowed = await testMcpServer("rownpxlinked");
		check("npx-lookup-linked-npm-readonly", !linkedAllowed.startRefused && lookups().includes("linked-npm"), `read-only for the room, the lookup runs that npm (ran ${JSON.stringify(lookups())}, ${JSON.stringify(linkedAllowed.error ?? null)})`);
		removeRoom("npm-link");
	}
	makeRoom("npm", "Npm room", npmCache, false);

	// Two entries, each with its own npm cache, start their own copy of one package, whichever starts first.
	const ownCopies = ["cache-a", "cache-b"].map((name) => {
		const copyDir = path.join(tempHome, "npm-caches", name, "_npx", "rowhash", "node_modules", "row-two-mcp");
		writeProgram(path.join(copyDir, "index.js"));
		fs.writeFileSync(path.join(copyDir, "package.json"), JSON.stringify({ name: "row-two-mcp", version: "1.0.0", bin: { "row-two-mcp": "index.js" } }));
		return { cache: path.join(tempHome, "npm-caches", name), file: fs.realpathSync(path.join(copyDir, "index.js")) };
	});
	writeConfig(Object.fromEntries(ownCopies.map(({ cache }, index) => [`rowtwo${index}`, { command: "npx", args: ["-y", "row-two-mcp"], env: { ROW_MARKER: markerFile, npm_config_cache: cache } }])));
	const copiesStarted: string[] = [];
	for (const index of [0, 1, 0]) {
		const result = await testMcpServer(`rowtwo${index}`);
		copiesStarted.push(result.ok ? lastStart().at : `error ${result.error}`);
	}
	check("npx-own-caches", JSON.stringify(copiesStarted) === JSON.stringify([ownCopies[0].file, ownCopies[1].file, ownCopies[0].file]), `each entry starts the copy in its own npm cache (started ${JSON.stringify(copiesStarted)})`);

	// ── uvx: a package uvx runs from uv's cache, or from its installed tools ──
	writeConfig({ rowuvx: { command: "uvx", args: ["row-mcp"], env: { ROW_MARKER: markerFile } } });
	for (const [roomId, folder, why] of [["uv", uvCache, "uv's cache"], ["uv-inside", path.join(uvCache, "archive-v0", "rowhash"), "a folder inside uv's cache"], ["uv-tools", uvTools, "uv's installed tools"]] as const) {
		makeRoom(roomId, "Uv room", folder, true);
		if (process.platform === "win32") console.log(`SKIPPED: not yet on a real Windows PC: uvx-${roomId} (the smoke puts uv's folders where uv keeps them on a Mac or Linux)`);
		else check(`uvx-${roomId}`, (await refusalOf("rowuvx"))?.roomId === roomId, `a room on ${why} is refused, as one on npm's cache is`);
		removeRoom(roomId);
	}
	makeRoom("uv-beside", "Uv beside room", path.join(tempHome, "uv-cache-notes"), true);
	check("uvx-beside", (await refusalOf("rowuvx")) === null, "a room on a folder beside uv's cache is no room on what uvx runs");
	removeRoom("uv-beside");
	makeRoom("uv", "Uv room", uvCache, false);
	check("uvx-readonly", (await refusalOf("rowuvx")) === null, "read-only for the room, a uvx connector may start");
	removeRoom("uv");
	makeRoom("uv-server", "Uv server room", serverUvCache, true);
	check("uvx-server-setting", (await refusalOf("rowuvx")) === null, "a room on the server's own uv cache setting is no room on what the connector's uvx runs, which never gets that setting");
	removeRoom("uv-server");

	// ── An entry's own cache setting: the folder its program really runs from ──
	const declaredUv = path.join(tempHome, "Documents", "uv-cache");
	const declaredNpm = path.join(tempHome, "Documents", "npm-cache");
	writeConfig({
		rowuvxown: { command: "uvx", args: ["row-mcp"], env: { ROW_MARKER: markerFile, UV_CACHE_DIR: declaredUv } },
		rownpxown: { command: "npx", args: ["-y", "row-mcp"], env: { ROW_MARKER: markerFile, npm_config_cache: declaredNpm } },
	});
	for (const [roomId, folder, connector] of [["uv-own", declaredUv, "rowuvxown"], ["npm-own", path.join(declaredNpm, "_npx"), "rownpxown"]] as const) {
		const startsBefore = startsCount();
		makeRoom(roomId, "Own cache room", folder, true);
		const ownTest = await testMcpServer(connector);
		check(`${roomId}-test`, ownTest.startRefused?.roomId === roomId && startsCount() === startsBefore, `with a room on the cache ${connector}'s entry names, Test starts nothing (${JSON.stringify(ownTest.startRefused ?? ownTest.error ?? null)})`);
		check(`${roomId}-status`, (await refusalOf(connector))?.roomId === roomId, `the status names the room on the cache ${connector}'s entry names`);
		removeRoom(roomId);
	}
	// A relative setting counts from the connector's working folder.
	const connectorState = path.join(tempHome, "Documents", "connector-state");
	fs.mkdirSync(connectorState, { recursive: true });
	writeConfig({ rowuvxrel: { command: "uvx", args: ["row-mcp"], cwd: connectorState, env: { ROW_MARKER: markerFile, UV_CACHE_DIR: "cache" } } });
	makeRoom("uv-relative", "Relative cache room", path.join(connectorState, "cache"), true);
	check("uv-relative-status", (await refusalOf("rowuvxrel"))?.roomId === "uv-relative", "a room on the cache an entry names from its own working folder is refused");
	removeRoom("uv-relative");
	makeRoom("uv-relative-beside", "Beside the cache room", path.join(connectorState, "notes"), true);
	check("uv-relative-beside", (await refusalOf("rowuvxrel")) === null, "a room beside that cache, in the same working folder, is no room on what uvx runs");
	removeRoom("uv-relative-beside");
	writeConfig({
		rowuvxown: { command: "uvx", args: ["row-mcp"], env: { ROW_MARKER: markerFile, UV_CACHE_DIR: declaredUv } },
		rownpxown: { command: "npx", args: ["-y", "row-mcp"], env: { ROW_MARKER: markerFile, npm_config_cache: declaredNpm } },
	});
	makeRoom("uv-default", "Uv default room", uvCache, true);
	check("uv-own-default", (await refusalOf("rowuvxown")) === null, "an entry with its own uv cache doesn't run from uv's default one");
	removeRoom("uv-default");

	// ── The adapter patch, on scratch copies of the installed adapter ───────
	const installed = path.dirname(createRequire(import.meta.url).resolve("pi-mcp-adapter/package.json"));
	const patchScript = path.join(repoRoot, "scripts", "patch-mcp-adapter.mjs");
	const patchedManager = fs.readFileSync(path.join(installed, "server-manager.ts"), "utf8");
	const patchedResolver = fs.readFileSync(path.join(installed, "npx-resolver.ts"), "utf8");
	// The package's own text at the patch's two places, written here by hand.
	const SPAWN_PATCHED = /      const env = resolveEnv\(definition\.env\);\n      const cwd = resolveConfigPath\(definition\.cwd\);\n(?:[^\n]*\n){3}      transport = new StdioClientTransport\(\{\n        command,\n        args,\n        env,\n        cwd,\n/;
	const SPAWN_PRISTINE = "      transport = new StdioClientTransport({\n        command,\n        args,\n        env: resolveEnv(definition.env),\n        cwd: resolveConfigPath(definition.cwd),\n";
	const ENV_PATCHED = /\/\/ What a connector program gets[^\n]*\n[^\n]*\nconst CONNECTOR_ENVIRONMENT[^\n]*\n\nfunction resolveEnv\(env\?: Record<string, string>\): Record<string, string> \{\n[^\n]*\n(  const resolved: Record<string, string> = \{\};\n  for \(const \[key, value\] of Object.entries\(process.env\)\) \{\n)    if \(value !== undefined && CONNECTOR_ENVIRONMENT[^\n]*\n/;
	const ENV_PRISTINE = "function resolveEnv(env?: Record<string, string>): Record<string, string> {\n  // Copy process.env, filtering out undefined values\n$1    if (value !== undefined) {\n";
	if (!SPAWN_PATCHED.test(patchedManager) || !ENV_PATCHED.test(patchedManager)) throw new Error("the installed adapter does not hold patch 13 as this smoke knows it");
	let scratches = 0;
	const scratch = (manager: string, resolver = patchedResolver): string => {
		const adapter = path.join(tempHome, `patch-${(scratches += 1)}`, "node_modules", "pi-mcp-adapter");
		fs.cpSync(installed, adapter, { recursive: true });
		// Patch 11 looks for the AI library copy beside the adapter.
		const copy = path.join(installed, "..", "@earendil-works", "pi-ai");
		if (fs.existsSync(copy)) fs.cpSync(copy, path.join(adapter, "..", "@earendil-works", "pi-ai"), { recursive: true });
		fs.writeFileSync(path.join(adapter, "server-manager.ts"), manager);
		fs.writeFileSync(path.join(adapter, "npx-resolver.ts"), resolver);
		return adapter;
	};
	const runPatch = (adapter: string) => {
		const result = spawnSync(process.execPath, [patchScript, "--adapter-dir", adapter], { cwd: tempHome, encoding: "utf8", env: { PATH: process.env.PATH, HOME: tempHome } });
		return { status: result.status, errors: `${result.stdout}${result.stderr}`.split("\n").filter((line) => line.includes("ERROR")), out: result.stdout };
	};
	const managerOf = (adapter: string) => fs.readFileSync(path.join(adapter, "server-manager.ts"), "utf8");
	const resolverOf = (adapter: string) => fs.readFileSync(path.join(adapter, "npx-resolver.ts"), "utf8");
	// Patch 14's places, patched and as the package has them, written here by hand.
	const START_PLACES: Array<[string | RegExp, string]> = [
		["  async connect(name: string, definition: ServerDefinition, start?: ConnectorStartOptions): Promise<ServerConnection> {\n", "  async connect(name: string, definition: ServerDefinition): Promise<ServerConnection> {\n"],
		["    const promise = this.createConnection(name, definition, start);\n", "    const promise = this.createConnection(name, definition);\n"],
		["    definition: ServerDefinition,\n    start?: ConnectorStartOptions\n  ): Promise<ServerConnection> {\n", "    definition: ServerDefinition\n  ): Promise<ServerConnection> {\n"],
		["    let transport: Transport;\n    let program: ConnectorProgramWatch | undefined;\n", "    let transport: Transport;\n"],
		[/        \/\/ The lookup may run npm[^\n]*\n[^\n]*\n[^\n]*\n        const resolved = await resolveNpxBinary\(command, args, [^\n]*\n/, "        const resolved = await resolveNpxBinary(command, args);\n"],
		['        stderr: definition.debug ? "inherit" : "pipe",\n      });\n      program = watchConnectorProgram(transport as StdioClientTransport);\n', '        stderr: definition.debug ? "inherit" : "ignore",\n      });\n'],
		["      await client.connect(transport, start);\n", "      await client.connect(transport);\n"],
		["      throw program && error instanceof Error ? Object.assign(error, { connectorProgram: program }) : error;\n", "      throw error;\n"],
		[/  \/\/ Where the program is looked for[^\n]*\n[^\n]*\n[^\n]*\n\n  if \(!env\) return resolved;\n/, "  if (!env) return resolved;\n"],
		[/\/\*\* A time limit for a program's first answer[\s\S]*?\n(\/\*\*\n \* Resolve headers)/, "$1"],
	];
	const LOOKUP_PLACES: Array<[string | RegExp, string]> = [
		["  args: string[],\n  env?: Record<string, string>,\n  signal?: AbortSignal\n): Promise<NpxResolution | null> {\n", "  args: string[]\n): Promise<NpxResolution | null> {\n"],
		["  // One package may sit in each connector's own npm cache.\n  const cacheKey = JSON.stringify([getNpmCacheDir(env), command, ...args]);\n", "  const cacheKey = JSON.stringify([command, ...args]);\n"],
		["  const resolved = resolveFromNpmCache(parsed.packageSpec, parsed.binName, env);\n", "  const resolved = resolveFromNpmCache(parsed.packageSpec, parsed.binName);\n"],
		[/  await forceNpxCache\(parsed\.packageSpec, env, signal\);\n[^\n]*\n  signal\?\.throwIfAborted\(\);\n  const resolvedAfterInstall = resolveFromNpmCache\(parsed\.packageSpec, parsed\.binName, env\);\n/, "  await forceNpxCache(parsed.packageSpec);\n  const resolvedAfterInstall = resolveFromNpmCache(parsed.packageSpec, parsed.binName);\n"],
		["function resolveFromNpmCache(packageSpec: string, binName?: string, env?: Record<string, string>): NpxCacheEntry | null {\n  const cacheDir = getNpmCacheDir(env);\n", "function resolveFromNpmCache(packageSpec: string, binName?: string): NpxCacheEntry | null {\n  const cacheDir = getNpmCacheDir();\n"],
		[/\/\/ A first run downloads[^\n]*\nconst FORCE_CACHE_TIMEOUT_MS = 5 \* 60_000;\n\nasync function forceNpxCache\(packageSpec: string, env\?[^\n]*\n/, "const FORCE_CACHE_TIMEOUT_MS = 30_000;\n\nasync function forceNpxCache(packageSpec: string): Promise<void> {\n"],
		['        { stdio: "ignore", env, signal }\n', '        { stdio: "ignore" }\n'],
		[
			/\/\/ npm's answer for each home[\s\S]*?\n  return npmCacheDirs\.get\(key\) \?\? null;\n\}\n/,
			'let npmCacheDirCached: string | null | undefined;\n\nfunction getNpmCacheDir(): string | null {\n  if (npmCacheDirCached !== undefined) return npmCacheDirCached;\n  if (process.env.NPM_CONFIG_CACHE) {\n    npmCacheDirCached = process.env.NPM_CONFIG_CACHE;\n    return npmCacheDirCached;\n  }\n  try {\n    const result = spawnSync("npm", ["config", "get", "cache"], { encoding: "utf-8" });\n    if (result.status === 0) {\n      const path = String(result.stdout).trim();\n      npmCacheDirCached = path || null;\n      return npmCacheDirCached;\n    }\n  } catch {\n    npmCacheDirCached = null;\n    return null;\n  }\n  npmCacheDirCached = null;\n  return null;\n}\n',
		],
	];
	const unpatch = (text: string, places: Array<[string | RegExp, string]>, what: string): string =>
		places.reduce((current, [patched, own]) => {
			if (typeof patched === "string" ? current.split(patched).length !== 2 : !patched.test(current)) throw new Error(`the installed adapter does not hold patch 14 in ${what} as this smoke knows it (${String(patched).slice(0, 60)})`);
			return current.replace(patched, own);
		}, text);
	// Before patch 13 (patch 14 in place), before patch 14 (patch 13 in place), and before both.
	const before13 = patchedManager.replace(SPAWN_PATCHED, SPAWN_PRISTINE).replace(ENV_PATCHED, ENV_PRISTINE);
	const before14 = unpatch(patchedManager, START_PLACES, "server-manager.ts");
	const pristine = unpatch(before13, START_PLACES, "server-manager.ts");
	const pristineResolver = unpatch(patchedResolver, LOOKUP_PLACES, "npx-resolver.ts");

	const already = scratch(patchedManager);
	const alreadyRun = runPatch(already);
	check("patch-already", alreadyRun.status === 0 && alreadyRun.errors.length === 0 && alreadyRun.out.includes("patch 13 (a connector program's start) already patched") && managerOf(already) === patchedManager, "an adapter already patched passes, its file unchanged");
	const fresh = scratch(pristine, pristineResolver);
	const freshRun = runPatch(fresh);
	check("patch-apply", freshRun.status === 0 && freshRun.errors.length === 0 && managerOf(fresh) === patchedManager && resolverOf(fresh) === patchedResolver, `the patch applies to the package's own text, giving the installed files (status ${freshRun.status}, ${freshRun.errors.join(" | ")})`);
	const startGone = scratch(before14.replace("    let transport: Transport;\n", "    let transport: Transport | undefined;\n"));
	const startGoneBefore = managerOf(startGone);
	const startGoneRun = runPatch(startGone);
	check("patch-14-anchor-gone", startGoneRun.status === 1 && startGoneRun.errors.length === 1 && startGoneRun.errors[0].includes("patch 14") && managerOf(startGone) === startGoneBefore, `an adapter whose connect changed fails the install on patch 14, one error line, the file unchanged (status ${startGoneRun.status}, ${startGoneRun.errors.join(" | ")})`);
	const gone = scratch(before13.replace("        env: resolveEnv(definition.env),\n", "        env: process.env as Record<string, string>,\n"));
	const goneBefore = managerOf(gone);
	const goneRun = runPatch(gone);
	check("patch-anchor-gone", goneRun.status === 1 && goneRun.errors.length === 1 && goneRun.errors[0].includes("patch 13") && managerOf(gone) === goneBefore, `an adapter whose start changed fails the install, one error line, the file unchanged (status ${goneRun.status}, ${goneRun.errors.join(" | ")})`);
	const part = scratch(patchedManager.replace(ENV_PATCHED, ENV_PRISTINE));
	const partRun = runPatch(part);
	check("patch-partly", partRun.status === 1 && partRun.errors.length === 1 && partRun.errors[0].includes("patch 13"), `an adapter with the patch in one place of two fails the install (status ${partRun.status}, ${partRun.errors.join(" | ")})`);
	// Patch 13's text before the start check read the connector's environment, written here by hand.
	const LATEST_CALL = "configuredCommand: definition.command, environment: interpolateEnvRecord(definition.env) });";
	if (patchedManager.split(LATEST_CALL).length !== 2) throw new Error("the installed adapter does not hold patch 13's start check call as this smoke knows it");
	const earlier = scratch(patchedManager.replace(LATEST_CALL, "configuredCommand: definition.command, searchPath: env.PATH });"));
	const earlierBefore = managerOf(earlier);
	const earlierRun = runPatch(earlier);
	check("patch-earlier", earlierRun.status === 1 && earlierRun.errors.length === 1 && earlierRun.errors[0].includes("patch 13") && earlierRun.errors[0].includes("npm ci") && managerOf(earlier) === earlierBefore, `an adapter an earlier version of the patch wrote fails the install with a line that says to run npm ci, the file unchanged (status ${earlierRun.status}, ${earlierRun.errors.join(" | ")})`);
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`connector-start-check-smoke: ${failures.length} failed: ${failures.join(", ")}`);
	process.exit(1);
}
console.log("connector-start-check-smoke: every refused start has its allowed neighbour");
process.exit(0);
