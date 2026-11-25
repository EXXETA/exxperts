// A connector program started by a server whose PATH is the system's short
// one, as an app opened from the Dock has it, row by row:
//
//  found      a program in one of the usual install folders (~/.local/bin
//             here) is found and started; the start check judges that same
//             file: a room that can change that folder refuses it, a room
//             elsewhere doesn't.
//  causes     each of the four ways a program fails to start keeps its own
//             cause with the check, and the row says its own sentence, with
//             the program's last lines under Technical details: a program that
//             isn't there (Node.js's and uv's own programs with their own
//             sentence when no Node.js or uv is along the PATH, by name when
//             one is; Python by one name where only the other is found), one
//             that stops right after starting, one that never answers, one
//             that writes something that isn't the connector protocol.
//  download   a program started by uvx, which fetches what it runs at its
//             first start, answers after 40 seconds and connects, where a
//             program that isn't on that list still gives up within a minute;
//             the status marks the first and not the second.
//  first      an npx package installed for the first time, taking longer than
//             the 20 seconds a check had, starts; the install gets the
//             connector's short environment, never a server setting outside
//             that list.
//  cancel     a check stopped by the person while npx installs ends the
//             install, starts nothing and keeps nothing.
//
// Offline: npm and npx are scripts of the smoke's own, first on the PATH, and
// every program is a script run by the Node that runs the smoke. Mac and Linux
// only: on Windows programs install onto the system's PATH, which the server
// already has.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform === "win32") {
	console.log("connector-search-path-smoke: skipped on Windows, where programs install onto the system's PATH");
	process.exit(0);
}

const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "connector-search-path-")));
const SHORT_PATH = "/usr/bin:/bin";
// This process reads the start check as the server does: the short PATH, the temp home.
process.env.HOME = tempHome;
process.env.PATH = SHORT_PATH;

const { connectorStartRefusal } = await import("../src/connector-start-check.js");
const { connectorRowState, wentWrongLine, technicalDetails, lineText, rowLook, CONNECTOR_WORDS } = await import("../../web-ui/src/connector-rows.js");
const { authedFetch, freePort, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, waitForServer } = await import("./smoke-server-process.js");

const failures: string[] = [];
function check(id: string, ok: boolean, message: string): void {
	if (ok) console.log(`ok   ${id}: ${message}`);
	else {
		console.error(`FAIL ${id}: ${message}`);
		failures.push(id);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const localBin = path.join(tempHome, ".local", "bin");
const fakeBin = path.join(tempHome, "row-bin");
const npmCache = path.join(tempHome, ".npm");
const markers = path.join(tempHome, "markers");
const startedFile = path.join(markers, "started.jsonl");
const npmRunsFile = path.join(markers, "npm-runs.jsonl");
const npxRunsFile = path.join(markers, "npx-runs.jsonl");
for (const folder of [agentDir, localBin, fakeBin, npmCache, markers]) fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
// A server setting no connector, nor its install, may see.
const serverSecret = `row-secret-${randomBytes(8).toString("hex")}`;

const STALL_LINE = "row: cannot open the notes folder";
const CHATTER = "Hello! This program prints text, not connector answers.";
// One program, its behaviour by the name it runs under.
const PROGRAM = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const as = path.basename(process.argv[1]);
fs.appendFileSync(${JSON.stringify(startedFile)}, JSON.stringify({ as, file: process.argv[1] }) + "\\n");
if (as === "row-stops") {
	process.stderr.write("row: starting\\n${STALL_LINE}\\n");
	process.exit(1);
}
if (as === "row-chatty") {
	process.stdout.write("${CHATTER}\\n");
	setTimeout(() => process.exit(0), 200);
} else if (as === "row-silent") {
	setInterval(() => {}, 1000);
} else {
	// uvx stands in for a first start that downloads before it answers.
	const firstAnswerAfter = as === "uvx" ? 40000 : 0;
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
			const answer = () => process.stdout.write(JSON.stringify(result ? { jsonrpc: "2.0", id: message.id, result } : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } }) + "\\n");
			if (message.method === "initialize") setTimeout(answer, firstAnswerAfter);
			else answer();
		}
	});
}
`;
function writeScript(file: string, text: string): void {
	fs.writeFileSync(file, text, { mode: 0o755 });
}
for (const name of ["row-connector", "row-stops", "row-silent", "row-chatty", "uvx"]) writeScript(path.join(localBin, name), PROGRAM);
// Python by one name only, each in a folder of its own.
const python3Only = path.join(tempHome, "row-python3-bin");
const pythonOnly = path.join(tempHome, "row-python-bin");
for (const [folder, name] of [[python3Only, "python3"], [pythonOnly, "python"]]) {
	fs.mkdirSync(folder, { recursive: true });
	writeScript(path.join(folder, name), PROGRAM);
}

// npm as the adapter's first-run install calls it: `npm exec --yes --package <spec> -- node -e 1`.
// It notes what it was given and puts the package where npx keeps it, after a wait the package names.
writeScript(path.join(fakeBin, "npm"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "config") {
	process.stdout.write((process.env.NPM_CONFIG_CACHE || "") + "\\n");
	process.exit(0);
}
const spec = args[args.indexOf("--package") + 1];
fs.appendFileSync(${JSON.stringify(npmRunsFile)}, JSON.stringify({ spec, pid: process.pid, names: Object.keys(process.env), path: process.env.PATH }) + "\\n");
const wait = spec === "row-first-start" ? 21000 : spec === "row-never-installs" ? 600000 : 0;
setTimeout(() => {
	const folder = path.join(process.env.NPM_CONFIG_CACHE, "_npx", "row", "node_modules", spec);
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({ name: spec, version: "1.0.0", bin: { [spec]: "server.js" } }));
	fs.writeFileSync(path.join(folder, "server.js"), ${JSON.stringify(PROGRAM)});
	process.exit(0);
}, wait);
`);
// npx itself must never run here: it would download.
writeScript(path.join(fakeBin, "npx"), `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(npxRunsFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stderr.write("row: npx was not to run\\n");
process.exit(1);
`);
fs.symlinkSync(process.execPath, path.join(fakeBin, "node"));

const lines = (file: string): any[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const startsAs = (as: string) => lines(startedFile).filter((start) => start.as === as);

// ── The start check judges the file the start runs ──────────────────────────
const toolsRoom = { roomId: "tools", roomName: "Tools room" };
const atLocalBin = connectorStartRefusal({ command: "row-connector", args: [] }, [{ path: fs.realpathSync(localBin), room: toolsRoom }]);
check("found-start-check", atLocalBin?.roomId === "tools", `with the short PATH, the start check finds the program in ~/.local/bin and refuses it when a room can change that folder (${JSON.stringify(atLocalBin)})`);
const elsewhere = path.join(tempHome, "Documents");
fs.mkdirSync(elsewhere);
check("found-start-check-elsewhere", connectorStartRefusal({ command: "row-connector", args: [] }, [{ path: elsewhere, room: toolsRoom }]) === null, "a room on another folder doesn't refuse it");

// ── Against a server with the short PATH ────────────────────────────────────
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
async function requestJson(pathname: string, init?: RequestInit): Promise<{ status: number; body: any; text: string }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, init as never);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null, text };
}
// A program and its arguments as they are (connector-command-smoke.ts reads pasted lines).
async function add(name: string, command: string, args: string[] = [], env?: Record<string, string>): Promise<string> {
	const added = await requestJson("/api/mcp/servers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, command, args, ...(env ? { env } : {}) }) });
	if (added.status !== 200) throw new Error(`adding ${name} failed: ${added.text}`);
	return String(added.body.name);
}
const test = (name: string, signal?: AbortSignal) => requestJson(`/api/mcp/servers/${encodeURIComponent(name)}/test`, { method: "POST", signal });
async function statusOf(name: string): Promise<any> {
	const status = await requestJson("/api/mcp/status");
	return status.body.servers.find((server: { name: string }) => server.name === name);
}
async function waitFor(what: string, until: () => boolean, limitMs: number): Promise<void> {
	const deadline = Date.now() + limitMs;
	while (!until()) {
		if (Date.now() > deadline) throw new Error(`waited ${limitMs} ms for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** The row as the page shows it after this connector's kept check, read back from the status. */
async function rowSays(name: string): Promise<{ status: string; line: string; details: string | null; button: string | null; rowButton: string | null }> {
	const server = await statusOf(name);
	const state = connectorRowState(server, server.lastCheck, null);
	const wrong = wentWrongLine(server, state, false);
	const look = rowLook(state, false);
	return { status: look.status, line: wrong ? lineText(wrong.line, false) : "", details: technicalDetails(state), button: wrong?.button ?? null, rowButton: look.button };
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
try {
	const env = smokeHomeEnv(tempHome, {
		PATH: `${fakeBin}:${SHORT_PATH}`,
		PORT: String(port),
		...SMOKE_SERVER_AUTH_ENV,
		EXXPERTS_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
		NPM_CONFIG_CACHE: npmCache,
		npm_config_cache: undefined,
		EXXPERTS_SHARED_SERVER: undefined,
		ROW_SERVER_SECRET: serverSecret,
	});
	server = spawn(process.execPath, ["--import", tsxLoader, "src/index.ts"], { ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: webServerDir, env: env as NodeJS.ProcessEnv });
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 30_000);

	// Found along the usual install folders.
	const found = await add("Found", "row-connector");
	const foundTest = await test(found);
	check("found-starts", foundTest.body?.ok === true && startsAs("row-connector").length === 1, `with the server's PATH ${SHORT_PATH}, a program in ~/.local/bin starts (${foundTest.text.slice(0, 200)})`);

	// Not found: any program by its name, Node.js's own programs with their own sentence.
	const missing = await add("Missing", "row-missing-program", ["--root", "notes"]);
	const missingTest = await test(missing);
	const missingRow = await rowSays(missing);
	check("cause-not-found", missingTest.body?.programFailure?.cause === "not-found" && missingTest.body.programFailure.program === "row-missing-program", `a program that isn't there is not found, by its name (${JSON.stringify(missingTest.body)})`);
	check("cause-not-found-row", missingRow.line === lineText(CONNECTOR_WORDS.wentWrong.programMissing("row-missing-program"), false) && missingRow.status === CONNECTOR_WORDS.status.cantStart && Boolean(missingRow.details?.includes("ENOENT")) && missingRow.button === "tryAgain", `its row says the program wasn't found, with Try again for once it is installed (${JSON.stringify(missingRow)})`);
	// Node.js is there, the command points elsewhere: the program is named, Node.js isn't said to be missing.
	const wrongNode = await add("Wrong node", "/opt/row-missing-node/bin/npx", ["-y", "@scope/files-connector"]);
	await test(wrongNode);
	const wrongNodeRow = await rowSays(wrongNode);
	check("cause-not-found-node-path", wrongNodeRow.line === lineText(CONNECTOR_WORDS.wentWrong.programMissing("/opt/row-missing-node/bin/npx"), false) && wrongNodeRow.button !== "installNode", `npx not found where the command says, with Node.js along the PATH, names that program (${JSON.stringify(wrongNodeRow)})`);
	// No Node.js anywhere the program is looked for.
	const emptyBin = path.join(tempHome, "row-empty-bin");
	fs.mkdirSync(emptyBin, { recursive: true });
	const noNode = await add("No node", "npx", ["-y", "@scope/files-connector"], { PATH: emptyBin });
	await test(noNode);
	const noNodeRow = await rowSays(noNode);
	check("cause-not-found-node", noNodeRow.line === lineText(CONNECTOR_WORDS.wentWrong.nodeMissing, false) && noNodeRow.button === "installNode", `npx not found, with no Node.js along its PATH, says Node.js is missing, with a way to install it (${JSON.stringify(noNodeRow)})`);
	// No uv anywhere the program is looked for: as for Node.js, with uv's own install link.
	const noUv = await add("No uv", "uvx", ["markitdown-mcp"], { PATH: emptyBin });
	const noUvTest = await test(noUv);
	const noUvRow = await rowSays(noUv);
	check("cause-runtime-missing-uv", noUvTest.body?.programFailure?.cause === "runtime-missing" && noUvTest.body.programFailure.runtime === "uv", `uvx not found, with no uv along its PATH, keeps uv as the missing runtime (${JSON.stringify(noUvTest.body)})`);
	check("cause-runtime-missing-uv-row", noUvRow.line === lineText(CONNECTOR_WORDS.wentWrong.uvMissing, false) && noUvRow.button === "installUv" && noUvRow.status === CONNECTOR_WORDS.status.cantStart, `its row says it needs uv, with a way to install it (${JSON.stringify(noUvRow)})`);
	// Python by the name this computer doesn't have: the row names the one it has, with Remove to add it again.
	const python = await add("Python only three", "python", ["-m", "row_server"], { PATH: python3Only });
	const pythonTest = await test(python);
	const pythonRow = await rowSays(python);
	check("cause-python-is-python3", pythonTest.body?.programFailure?.cause === "python-is-python3" && pythonTest.body.programFailure.found === "python3", `python not found where python3 is keeps that (${JSON.stringify(pythonTest.body)})`);
	check("cause-python-is-python3-row", pythonRow.line === lineText(CONNECTOR_WORDS.wentWrong.pythonOtherName("python3", "python"), false) && pythonRow.button === "remove", `its row says this computer has python3, with Remove (${JSON.stringify(pythonRow)})`);
	const python3 = await add("Python only plain", "python3", ["-m", "row_server"], { PATH: pythonOnly });
	await test(python3);
	const python3Row = await rowSays(python3);
	check("cause-python3-is-python-row", python3Row.line === lineText(CONNECTOR_WORDS.wentWrong.pythonOtherName("python", "python3"), false) && python3Row.button === "remove", `and the other way round (${JSON.stringify(python3Row)})`);
	// A Python named with its folder (a virtual environment's, since gone) wants that one, whose packages the other
	// lacks: the program by its name, though python3 is along the PATH.
	const gonePython = path.join(tempHome, "row-gone-venv", "bin", "python");
	const venvPython = await add("Gone venv", gonePython, ["-m", "row_server"], { PATH: python3Only });
	const venvTest = await test(venvPython);
	const venvRow = await rowSays(venvPython);
	check("cause-python-path-not-found", venvTest.body?.programFailure?.cause === "not-found" && venvRow.line === lineText(CONNECTOR_WORDS.wentWrong.programMissing(gonePython), false), `python named by its folder names that program, not python3 (${JSON.stringify([venvTest.body?.programFailure, venvRow])})`);
	// Neither name found: the program by its name, as before.
	const noPython = await add("No python", "python", ["-m", "row_server"], { PATH: emptyBin });
	await test(noPython);
	const noPythonRow = await rowSays(noPython);
	check("cause-python-not-found-row", noPythonRow.line === lineText(CONNECTOR_WORDS.wentWrong.programMissing("python"), false), `python with no Python at all names the program (${JSON.stringify(noPythonRow)})`);

	// Stopped right after starting, with its last lines.
	const stops = await add("Stops", "row-stops");
	const stopsTest = await test(stops);
	const stopsRow = await rowSays(stops);
	check("cause-stopped", stopsTest.body?.programFailure?.cause === "stopped", `a program that ends before it answers stopped (${JSON.stringify(stopsTest.body)})`);
	check("cause-stopped-row", stopsRow.line === lineText(CONNECTOR_WORDS.wentWrong.programStopped, false) && Boolean(stopsRow.details?.includes(STALL_LINE)) && stopsRow.button === "tryAgain", `its row says it stopped, with its last line under Technical details (${JSON.stringify(stopsRow)})`);

	// Not a connector.
	const chatty = await add("Chatty", "row-chatty");
	const chattyTest = await test(chatty);
	const chattyRow = await rowSays(chatty);
	check("cause-not-a-connector", chattyTest.body?.programFailure?.cause === "not-a-connector", `a program that writes plain text isn't a connector (${JSON.stringify(chattyTest.body)})`);
	check("cause-not-a-connector-row", chattyRow.line === lineText(CONNECTOR_WORDS.wentWrong.notAConnector, false), `its row says so (${JSON.stringify(chattyRow)})`);

	// Four checks at once: one that never answers, a first start that installs for longer than 20 seconds, one stopped while it installs,
	// and one started by uvx that answers after 40 seconds.
	const silent = await add("Silent", "row-silent");
	const first = await add("First start", "npx", ["-y", "row-first-start"]);
	const never = await add("Never installs", "npx", ["-y", "row-never-installs"]);
	const downloads = await add("Downloads first", "uvx", ["row-package"]);
	const downloadsMarked = (await statusOf(downloads))?.downloadsAtFirstStart === true;
	const silentMarked = (await statusOf(silent))?.downloadsAtFirstStart === true;
	check("download-marked", downloadsMarked && !silentMarked, `the status marks the uvx connector as one that downloads at its first start, and not the other program (uvx ${downloadsMarked}, other ${silentMarked})`);
	const stop = new AbortController();
	const startedAt = Date.now();
	const silentRun = test(silent);
	const firstRun = test(first);
	const downloadsRun = test(downloads);
	const neverRun = test(never, stop.signal).catch((error: Error) => ({ status: 0, body: null, text: error.name }));
	await waitFor("the install that never ends to start", () => lines(npmRunsFile).some((run) => run.spec === "row-never-installs"), 15_000);
	const install = lines(npmRunsFile).find((run) => run.spec === "row-never-installs");
	stop.abort();
	await neverRun;
	await waitFor("the stopped install to end", () => !alive(install.pid), 10_000).catch(() => undefined);
	check("cancel-ends-install", !alive(install.pid), `a stopped check ends the install it started (pid ${install.pid})`);

	const [silentTest, firstTest, downloadsTest] = await Promise.all([silentRun, firstRun, downloadsRun]);
	check("download-connects", downloadsTest.body?.ok === true && startsAs("uvx").length === 1, `a program started by uvx that answers after 40 seconds connects (${downloadsTest.text.slice(0, 200)})`);
	const silentRow = await rowSays(silent);
	check("cause-too-slow", silentTest.body?.programFailure?.cause === "too-slow" && Date.now() - startedAt < 60_000, `a program that never answers took too long (${JSON.stringify(silentTest.body)})`);
	check("cause-too-slow-row", silentRow.line === lineText(CONNECTOR_WORDS.wentWrong.programTooSlow, false) && silentRow.status === CONNECTOR_WORDS.status.notAnswering && silentRow.rowButton === "tryAgain" && silentRow.button === null, `its row says it took too long, with one Try again, beside its status (${JSON.stringify(silentRow)})`);
	const firstInstall = lines(npmRunsFile).find((run) => run.spec === "row-first-start");
	check("first-start", firstTest.body?.ok === true && startsAs("server.js").length === 1, `a first start whose install takes over 20 seconds starts (${firstTest.text.slice(0, 200)})`);
	check("first-install-environment", Boolean(firstInstall) && !firstInstall.names.includes("ROW_SERVER_SECRET") && firstInstall.names.includes("PATH") && String(firstInstall.path).includes(localBin), `the install gets the connector's environment with its PATH, not the server setting ROW_SERVER_SECRET (${JSON.stringify(firstInstall?.names)})`);
	const kept = (await requestJson("/api/mcp/status")).body.servers.find((row: { name: string }) => row.name === never);
	check("cancel-keeps-nothing", kept?.lastCheck === null && lines(npxRunsFile).length === 0 && startsAs("server.js").length === 1, `a stopped check keeps nothing and starts nothing (${JSON.stringify(kept?.lastCheck)}, npx runs ${lines(npxRunsFile).length})`);
} finally {
	await stopSmokeServer(server);
	for (const run of lines(npmRunsFile)) if (alive(run.pid)) process.kill(run.pid);
	fs.rmSync(tempHome, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(serverOutput.join("").slice(-3000));
	console.error(`connector-search-path-smoke: ${failures.length} failed: ${failures.join(", ")}`);
	process.exit(1);
}
console.log("connector-search-path-smoke: a program starts from the usual install folders, and each failed start says its own cause");
process.exit(0);
