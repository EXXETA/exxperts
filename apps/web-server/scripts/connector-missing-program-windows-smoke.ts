// A connector on Windows whose program isn't on the computer names it, as on a
// Mac, row by row:
//
//  missing    npx and uvx (the runtime they come with), python where python3
//             is, another program, a full path, and npx behind `cmd /c`.
//  stopped    a program that is there and ends at once keeps its line, behind
//             `cmd /c` too, and so does what `cmd /c` runs that is no plain
//             program name; a file Windows may start but the app can't read
//             counts as there.
//  words      a program that writes other words keeps "not a connector".
//  elsewhere  the same starts, read as a Mac's or Linux's, keep "stopped".
//  again      a check that found no program reads Windows' search path again
//             and tries once more when it changed; no other check does, and
//             no other computer.
//  lookup     the file a command names on Windows.
//
// The start is the real one, as on Windows: the library that starts a program
// (cross-spawn) is loaded as on Windows, and hands cmd.exe (a stand-in script)
// every program it finds no .exe of. The stand-in says a program isn't there
// in German, as cmd.exe speaks the computer's language.
//
// Mac and Linux only: the stand-in is a script. A real Windows PC is checked
// by hand.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform === "win32") {
	console.log("SKIPPED: not yet on a real Windows PC: connector-missing-program-windows-smoke (cmd.exe's stand-in is a script)");
	process.exit(0);
}

const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "connector-missing-program-")));
const agentDir = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
process.env.HOME = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PATHEXT = ".com;.exe;.bat;.cmd";
for (const name of ["NPM_CONFIG_CACHE", "npm_config_cache", "EXXPERTS_SHARED_SERVER"]) delete process.env[name];

// cmd.exe: reads the line cross-spawn writes it, starts the program along its PATH with Windows' endings, or says it isn't there.
const GERMAN_LINE = "ist entweder falsch geschrieben oder konnte nicht gefunden werden.";
const standIn = path.join(tempHome, "cmd-stand-in");
fs.writeFileSync(
	standIn,
	`#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const line = process.argv.at(-1).slice(1, -1);
const program = /^(?:\\^.|[^\\s^])+/.exec(line)[0].replace(/\\^(.)/g, "$1");
fs.appendFileSync(${JSON.stringify(path.join(tempHome, "starts.txt"))}, program + "\\n");
// A program whose name starts so ends only once the smoke lets it.
if (program.startsWith("row-held-")) while (fs.existsSync(${JSON.stringify(tempHome)}) && !fs.existsSync(${JSON.stringify(path.join(tempHome, "let-go"))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
const folders = /[\\\\/]/.test(program) ? [""] : [process.cwd(), ...process.env.PATH.split(":")];
for (const folder of folders) for (const ending of ["", ".com", ".exe", ".bat", ".cmd"]) {
	const file = path.resolve(folder, program + ending);
	if (fs.existsSync(file)) process.exit(require("node:child_process").spawnSync(process.execPath, [file], { stdio: "inherit" }).status ?? 1);
}
process.stderr.write('Der Befehl "' + program + '" ${GERMAN_LINE}\\n');
process.exit(1);
`,
	{ mode: 0o755 },
);
process.env.comspec = standIn;

// cross-spawn reads the system once, as it loads: before anything else loads it.
const own = Object.getOwnPropertyDescriptor(process, "platform")!;
Object.defineProperty(process, "platform", { ...own, value: "win32" });
const fromSdk = createRequire(createRequire(import.meta.url).resolve("@modelcontextprotocol/sdk/client/stdio.js"));
const crossSpawn = fromSdk("cross-spawn");
Object.defineProperty(process, "platform", own);

const { addMcpServer, removeMcpServer, testMcpServer } = await import("../src/mcp-admin.js");
const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
const startCheck = await import("../src/connector-start-check.js");
const { connectorRowState, wentWrongLine, technicalDetails, lineText, rowLook, CONNECTOR_WORDS } = await import("../../web-ui/src/connector-rows.js");

const failures: string[] = [];
function check(id: string, ok: boolean, message: string): void {
	if (ok) console.log(`ok   ${id}: ${message}`);
	else {
		console.error(`FAIL ${id}: ${message}`);
		failures.push(id);
	}
}

const folderOf = (name: string, files: Record<string, string> = {}) => {
	const folder = path.join(tempHome, name);
	fs.mkdirSync(folder, { recursive: true });
	for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, file), text);
	return folder;
};
const STOP_LINE = "row: cannot open the notes folder";
const STOPS = `process.stderr.write("${STOP_LINE}\\n"); process.exit(1);\n`;
const CHATS = `process.stdout.write("Hello! This program prints text.\\n"); setTimeout(() => process.exit(0), 200);\n`;
/** A connector that answers as one, with one tool. */
const CONNECTS = `let text = "";
process.stdin.on("data", (chunk) => {
	text += chunk;
	for (let at; (at = text.indexOf("\\n")) >= 0; ) {
		const { id, method, params } = JSON.parse(text.slice(0, at));
		text = text.slice(at + 1);
		if (id === undefined) continue;
		const result = method === "initialize" ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "row", version: "1" } } : method === "tools/list" ? { tools: [{ name: "read_notes", inputSchema: { type: "object" } }] } : {};
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
	}
});
`;
/** One whose first answer is the code the connection gives a request that timed out. */
const TOO_SLOW = `process.stdin.once("data", (chunk) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(chunk).id, error: { code: -32001, message: "Request timed out" } }) + "\\n"));
`;

let added = 0;
/** One check of a program as Windows starts it (or read as another system's), and its row as the page shows it. */
async function checked(command: string, args: string[], PATH: string, platform: NodeJS.Platform = "win32") {
	const { name } = await addMcpServer({ name: `Row ${(added += 1)}`, command, args, env: { PATH } });
	const result = await testMcpServer(name, undefined, platform);
	const server = (await getMcpConnectorsStatus()).servers.find((row) => row.name === name)!;
	const state = connectorRowState(server as never, server.lastCheck as never, null);
	const wrong = wentWrongLine(server as never, state, false);
	return { failure: JSON.stringify(result.programFailure ?? null), error: result.error ?? "", line: wrong ? lineText(wrong.line, false) : "", button: wrong?.button ?? null, details: technicalDetails(state) ?? "", status: rowLook(state, false).status };
}
async function row(id: string, what: string, command: string, args: string[], PATH: string, failure: object, line: string, button: string | null): Promise<void> {
	const got = await checked(command, args, PATH);
	check(id, got.failure === JSON.stringify(failure) && got.line === line && got.button === button, `${what} (${JSON.stringify(got)})`);
}
const words = CONNECTOR_WORDS.wentWrong;
const notFound = (program: string) => [{ cause: "not-found", program }, lineText(words.programMissing(program), false), "tryAgain"] as const;
const stopped = [{ cause: "stopped" }, lineText(words.programStopped, false), "tryAgain"] as const;
const nodeMissing = [{ cause: "runtime-missing", runtime: "node" }, lineText(words.nodeMissing, false), "installNode"] as const;
const uvMissing = [{ cause: "runtime-missing", runtime: "uv" }, lineText(words.uvMissing, false), "installUv"] as const;

try {
	check("stand-in", crossSpawn._parse("npx", ["-y"], {}).command === standIn, "cross-spawn starts a program it finds no .exe of through cmd.exe, as on Windows");

	const empty = folderOf("empty");
	const programs = folderOf("Müller Programme", { "row-stops.cmd": STOPS, "row-chatty.cmd": CHATS, "npx.cmd": STOPS, "node.exe": "" });
	const python3Only = folderOf("python3", { "python3.exe": "" });
	const system = folderOf("system");
	for (const name of ["cmd", "cmd.exe"]) fs.symlinkSync(process.execPath, path.join(system, name));
	for (const name of ["row-stops.cmd", "npx.cmd"]) fs.writeFileSync(path.join(system, name), STOPS);
	const bareSystem = folderOf("bare-system");
	for (const name of ["cmd", "cmd.exe"]) fs.symlinkSync(process.execPath, path.join(bareSystem, name));
	const goneNpx = path.join(empty, "nodejs", "npx.cmd");
	const gonePython = path.join(tempHome, "gone-venv", "python.exe");

	// ── The program isn't there ─────────────────────────────────────────────────
	const npx = await checked("npx", ["-y", "@scope/files-connector"], empty);
	check("missing-npx", npx.failure === JSON.stringify(nodeMissing[0]) && npx.line === nodeMissing[1] && npx.button === nodeMissing[2] && npx.status === CONNECTOR_WORDS.status.cantStart, `npx with no Node.js along its PATH says Node.js is missing (${JSON.stringify(npx)})`);
	check("missing-details", npx.error.includes("-32000") && npx.details.includes(GERMAN_LINE), `the start ended with the connection closed, and what cmd.exe wrote stays under Technical details (${JSON.stringify(npx.details)})`);
	await row("missing-uvx", "uvx with no uv along its PATH says uv is missing", "uvx", ["markitdown-mcp"], empty, ...uvMissing);
	await row("missing-npx-cmd", "npx.cmd, as some write it, says the same", "npx.cmd", ["-y", "@scope/files-connector"], empty, ...nodeMissing);
	await row("missing-npx-node-there", "npx missing where Node.js is names npx", "npx", ["-y", "@scope/files-connector"], folderOf("node-only", { "node.exe": "" }), ...notFound("npx"));
	await row("missing-python", "python where python3 is names the one this computer has", "python", ["-m", "row_server"], python3Only, { cause: "python-is-python3", found: "python3" }, lineText(words.pythonOtherName("python3", "python"), false), "remove");
	await row("missing-python-both", "python with no Python at all names the program", "python", ["-m", "row_server"], empty, ...notFound("python"));
	await row("missing-python-path", "python named by its folder names that program, not python3", gonePython, ["-m", "row_server"], python3Only, ...notFound(gonePython));
	await row("missing-other", "another program is named", "row-missing-program", ["--root", "notes"], empty, ...notFound("row-missing-program"));
	await row("missing-full-path", "a full path that isn't there is named, where Node.js is", goneNpx, ["-y", "@scope/files-connector"], programs, ...notFound(goneNpx));
	await row("missing-cmd-npx", "cmd /c npx with no Node.js along its PATH says Node.js is missing", "cmd", ["/c", "npx", "-y", "@scope/files-connector"], bareSystem, ...nodeMissing);
	await row("missing-cmd-exe-npx", "cmd.exe with other switches and /C says the same", "cmd.exe", ["/d", "/s", "/C", "npx", "-y", "@scope/files-connector"], bareSystem, ...nodeMissing);
	await row("missing-cmd-other", "cmd /c with another program names that program", "cmd", ["/c", "row-missing-program"], bareSystem, ...notFound("row-missing-program"));
	const goneServer = path.join(empty, "Program Files (x86)", "Müller Tools", "server.exe");
	await row("missing-cmd-path", "cmd /c with a full path with spaces names that program", "cmd", ["/c", goneServer, "--root", "notes"], bareSystem, ...notFound(goneServer));
	await row("missing-python-quoted-path", "python3 is found in a PATH folder in quotes", "python", ["-m", "row_server"], `"${python3Only}"`, { cause: "python-is-python3", found: "python3" }, lineText(words.pythonOtherName("python3", "python"), false), "remove");

	// ── The program is there ────────────────────────────────────────────────────
	const stops = await checked("row-stops", [], programs);
	check("stopped", stops.failure === JSON.stringify(stopped[0]) && stops.line === stopped[1] && stops.details.includes(STOP_LINE), `a program that is there and ends at once stopped (${JSON.stringify(stops)})`);
	await row("stopped-npx", "npx that is there and ends at once stopped", "npx", ["-y", "@scope/files-connector"], programs, ...stopped);
	await row("stopped-path", "a path with a space and an umlaut that is there stopped", path.join(programs, "row-stops.cmd"), [], empty, ...stopped);
	await row("stopped-quoted-path", "a PATH folder in quotes is looked in", "row-stops", [], `"${programs}"`, ...stopped);
	await row("stopped-cmd", "cmd /c with a program that is there stopped", "cmd", ["/c", "npx", "-y", "@scope/files-connector"], system, ...stopped);
	await row("stopped-cmd-own", "cmd /c with a command of cmd.exe's own names no program", "cmd", ["/c", "call", "npx"], bareSystem, ...stopped);
	await row("stopped-cmd-line", "cmd /c with a whole line in one argument names no program", "cmd", ["/c", "npx -y @scope/files-connector"], bareSystem, ...stopped);
	const spaced = folderOf("spaced", { "run.cmd": STOPS });
	await row("stopped-cmd-path", "cmd /c with a full path with spaces that is there stopped", "cmd", ["/c", path.join(programs, "row-stops.cmd")], bareSystem, ...stopped);
	await row("stopped-cmd-path-line", "cmd /c with a program that is there and its arguments in one argument stopped", "cmd", ["/c", `${path.join(spaced, "run")} out.exe`], bareSystem, ...stopped);
	await row("stopped-cmd-two-programs", "cmd /c with two programs in one argument names neither", "cmd", ["/c", `${path.join(empty, "gone.exe")} other.exe`], bareSystem, ...stopped);
	// A link in a circle can't be read, as the Microsoft Store's python.exe can't.
	const unreadable = folderOf("store-python");
	fs.symlinkSync("python.exe", path.join(unreadable, "python.exe"));
	await row("stopped-unreadable", "a program's file that can't be read counts as there", "python", ["-m", "row_server"], unreadable, ...stopped);
	const chatty = await checked("row-chatty", [], programs);
	check("not-a-connector", chatty.failure === JSON.stringify({ cause: "not-a-connector" }) && chatty.line === lineText(words.notAConnector, false), `a program that writes other words isn't a connector (${JSON.stringify(chatty)})`);

	// ── Elsewhere the same starts read as before ────────────────────────────────
	for (const platform of ["darwin", "linux"] as const) {
		const read = await checked("npx", ["-y", "@scope/files-connector"], empty, platform);
		const behind = await checked("cmd", ["/c", "npx"], bareSystem, platform);
		check(`elsewhere-${platform}`, read.failure === JSON.stringify(stopped[0]) && behind.failure === JSON.stringify(stopped[0]), `a start that ended, read on ${platform}, stopped (${read.failure}, ${behind.failure})`);
	}

	// ── Asked again ─────────────────────────────────────────────────────────────
	const connects = folderOf("connects", { "npx.cmd": CONNECTS, "node.exe": "", "python.cmd": CONNECTS, "row-later.cmd": CONNECTS, "row-held-later.cmd": CONNECTS });
	const serverPath = process.env.PATH;
	const letGo = path.join(tempHome, "let-go");
	const starts = () => (fs.existsSync(path.join(tempHome, "starts.txt")) ? fs.readFileSync(path.join(tempHome, "starts.txt"), "utf8").split("\n").filter(Boolean) : []);
	const publish = (folder: string) => {
		process.env.PATH = `${process.env.PATH}${path.delimiter}${folder}`;
	};
	/** One check of a program on a server whose PATH is a folder without it, and what it started. The entry's own PATH is the server's, so no folder of this computer's counts; `own` sets another, null none. */
	async function again(command: string, options: { found?: string; own?: string | null; platform?: NodeJS.Platform; onReread?: (name: string, stop: AbortController) => void | Promise<void>; args?: string[]; path?: string } = {}) {
		process.env.PATH = options.path ?? empty;
		try {
			const own = options.own === undefined ? "${PATH}" : options.own;
			const { name } = await addMcpServer({ name: `Again ${(added += 1)}`, command, args: options.args ?? [], ...(own === null ? {} : { env: { PATH: own } }) });
			const stop = new AbortController();
			let rereads = 0;
			const before = starts().length;
			const result = await testMcpServer(name, stop.signal, options.platform ?? "win32", async () => {
				rereads += 1;
				await options.onReread?.(name, stop);
				if (options.found) publish(options.found);
			});
			const server = (await getMcpConnectorsStatus()).servers.find((row) => row.name === name);
			const state = server ? connectorRowState(server as never, server.lastCheck as never, null) : null;
			const wrong = server && state ? wentWrongLine(server as never, state, false) : null;
			return { ok: result.ok, cause: result.programFailure?.cause ?? null, tools: result.toolNames ?? [], cancelled: result.cancelled === true, superseded: result.superseded === true, rereads, starts: starts().length - before, line: wrong ? lineText(wrong.line, false) : "", status: state ? rowLook(state, false).status : "", checked: Boolean(server?.lastCheck) };
		} finally {
			process.env.PATH = serverPath;
		}
	}
	const is = (got: object, expected: object) => Object.entries(expected).every(([key, value]) => JSON.stringify((got as Record<string, unknown>)[key]) === JSON.stringify(value));
	async function againRow(id: string, what: string, expected: object, command: string, options: Parameters<typeof again>[1] = {}): Promise<void> {
		const got = await again(command, options);
		check(id, is(got, expected), `${what} (${JSON.stringify(got)})`);
	}
	const found = { ok: true, cause: null, tools: ["read_notes"], rereads: 1, starts: 2, line: "", checked: true };
	await againRow("again-npx", "npx missing at first and there on Windows' search path: connected, and so says the page's row", { ...found, status: CONNECTOR_WORDS.status.connected }, "npx", { found: connects, args: ["-y", "@scope/files-connector"] });
	await againRow("again-python", "python where only python3 was, and python on Windows' search path: connected", found, "python", { found: connects, path: python3Only, args: ["-m", "row_server"] });
	await againRow("again-no-own-path", "a connector with no PATH of its own starts with the server's, new folders included: connected", found, "row-later", { found: connects, own: null });
	await againRow("again-missing", "a program still missing: today's line, one start", { ok: false, cause: "runtime-missing", rereads: 1, starts: 1, line: nodeMissing[1], checked: true }, "npx");
	await againRow("again-missing-other", "new folders without the program: one start more, and today's line", { ok: false, cause: "runtime-missing", rereads: 1, starts: 2, line: nodeMissing[1], checked: true }, "npx", { found: folderOf("other-new") });
	await againRow("again-fixed-path", "a connector whose own PATH stays the same starts once", { ok: false, cause: "runtime-missing", rereads: 1, starts: 1, line: nodeMissing[1] }, "npx", { found: connects, own: empty });
	await againRow("again-then-stops", "a program found the second time that ends at once: its own line", { ok: false, cause: "stopped", rereads: 1, starts: 2, line: stopped[1] }, "npx", { found: programs });
	await againRow("again-stopped-check", "a check stopped while Windows is asked: no second start, and nothing kept", { ok: false, cancelled: true, rereads: 1, starts: 1, checked: false }, "npx", { found: connects, onReread: (_name, stop) => stop.abort() });
	await againRow("again-removed", "a connector removed while Windows is asked: no second start", { ok: false, superseded: true, rereads: 1, starts: 1 }, "npx", { found: connects, onReread: async (name) => void (await removeMcpServer(name)) });
	await againRow("again-stopped", "a program that is there and ends at once: nothing asked, one start", { ok: false, cause: "stopped", rereads: 0, starts: 1 }, "row-stops", { found: connects, path: programs });
	await againRow("again-not-a-connector", "a program that writes other words: nothing asked, one start", { ok: false, cause: "not-a-connector", rereads: 0, starts: 1 }, "row-chatty", { found: connects, path: programs });
	await againRow("again-too-slow", "a program that answers too late: nothing asked, one start", { ok: false, cause: "too-slow", rereads: 0, starts: 1 }, "row-too-slow", { found: connects, path: folderOf("too-slow", { "row-too-slow.cmd": TOO_SLOW }) });
	await againRow("again-connects", "a program that connects: nothing asked, one start", { ...found, rereads: 0, starts: 1 }, "npx", { path: connects });
	for (const platform of ["darwin", "linux"] as const) await againRow(`again-${platform}`, `the same start on ${platform}: nothing asked, one start, stopped as before`, { ok: false, cause: "stopped", rereads: 0, starts: 1 }, "npx", { found: connects, platform });
	{
		// A Mac and Linux say themselves that a program isn't there: here by a working folder that isn't, which fails the start the same way.
		const direct = folderOf("direct");
		fs.symlinkSync(process.execPath, path.join(direct, "row-direct.exe"));
		const { name } = await addMcpServer({ name: `Again ${(added += 1)}`, command: "row-direct.exe", args: [], env: { PATH: "${PATH}" } });
		const file = path.join(agentDir, "mcp.json");
		const config = JSON.parse(fs.readFileSync(file, "utf8"));
		config.mcpServers[name].cwd = path.join(tempHome, "no-such-folder");
		fs.writeFileSync(file, JSON.stringify(config));
		process.env.PATH = direct;
		try {
			for (const [platform, count] of [["darwin", 0], ["linux", 0], ["win32", 1]] as const) {
				let rereads = 0;
				const result = await testMcpServer(name, undefined, platform, async () => void (rereads += 1));
				check(`again-not-found-${platform}`, result.programFailure?.cause === "not-found" && rereads === count, `a program not found, read on ${platform}: asked ${count === 0 ? "nothing" : "once"} (${JSON.stringify(result.programFailure)}, ${rereads})`);
			}
		} finally {
			process.env.PATH = serverPath;
		}
	}
	{
		// A shared server has no connector program to check, and its check reads this before anything starts.
		const { name } = await addMcpServer({ name: `Again ${(added += 1)}`, command: "npx", args: [], env: { PATH: empty } });
		process.env.EXXPERTS_SHARED_SERVER = "1";
		try {
			for (const platform of ["linux", "win32"] as const) {
				const before = starts().length;
				let rereads = 0;
				const refused = await testMcpServer(name, undefined, platform, async () => void (rereads += 1)).then(() => null, (error: Error & { statusCode?: number }) => error.statusCode);
				check(`again-shared-server-${platform}`, refused === 404 && rereads === 0 && starts().length === before, `a shared server, read as ${platform}: nothing asked, nothing started (${refused}, ${rereads}, ${starts().length - before})`);
			}
		} finally {
			delete process.env.EXXPERTS_SHARED_SERVER;
		}
	}
	// Two checks at once. The second's start ends only after the first has added the folders, so its failure is read against the PATH it started with: the connector's own, or, where it has none, the server's.
	for (const [id, what, entry] of [["again-two", "with the server's PATH as their own", { env: { PATH: "${PATH}" } }], ["again-two-no-own-path", "with no PATH of their own", {}]] as const) {
		fs.rmSync(letGo, { force: true });
		process.env.PATH = empty;
		try {
			const names = [];
			for (const command of ["row-later", "row-held-later"]) names.push((await addMcpServer({ name: `Again ${(added += 1)}`, command, args: [], ...entry })).name);
			let rereads = 0;
			const reread = async () => {
				rereads += 1;
				publish(connects);
			};
			const before = starts().length;
			const second = testMcpServer(names[1], undefined, "win32", reread);
			while (!starts().slice(before).includes("row-held-later")) await new Promise((resolve) => setTimeout(resolve, 20));
			const first = await testMcpServer(names[0], undefined, "win32", reread);
			fs.writeFileSync(letGo, "");
			const answers = [first, await second];
			check(id, answers.every((answer) => answer.ok) && rereads === 1 && starts().length - before === 4, `two checks at once ${what}, the second read after the first added the folders: both connected, asked once (${JSON.stringify({ answers, rereads, starts: starts().slice(before) })})`);
		} finally {
			process.env.PATH = serverPath;
		}
	}
	{
		// What a check asks on its own, with Windows PowerShell's path as one file name in a folder on PATH.
		const asked = path.join(tempHome, "asked.txt");
		const bin = folderOf("powershell-bin");
		fs.writeFileSync(path.join(bin, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`), `#!/bin/sh\necho asked >> ${JSON.stringify(asked)}\necho '["",""]'\n`, { mode: 0o755 });
		const asks = () => (fs.existsSync(asked) ? fs.readFileSync(asked, "utf8").split("\n").filter(Boolean).length : 0);
		process.env.SystemRoot = String.raw`C:\Windows`;
		process.env.PATH = `${empty}${path.delimiter}${bin}`;
		try {
			const { name } = await addMcpServer({ name: `Again ${(added += 1)}`, command: "npx", args: [], env: { PATH: empty } });
			for (const [platform, cause, count] of [["darwin", "stopped", 0], ["linux", "stopped", 0], ["win32", "runtime-missing", 1]] as const) {
				const before = starts().length;
				const result = await testMcpServer(name, undefined, platform);
				check(`again-asks-${platform}`, result.programFailure?.cause === cause && asks() === count && starts().length - before === 1, `a check on ${platform} starts Windows PowerShell ${count === 0 ? "never" : "once"} (${result.programFailure?.cause}, ${asks()}, ${starts().length - before})`);
			}
		} finally {
			process.env.PATH = serverPath;
			delete process.env.SystemRoot;
		}
	}

	// ── The file a command names on Windows ─────────────────────────────────────
	const at = (command: string, searchPath = programs, cwd = empty) => startCheck.programFile(command, cwd, searchPath, "win32");
	check("lookup-npx", at("npx") === path.join(programs, "npx.cmd"), `npx is npx.cmd (${at("npx")})`);
	check("lookup-node", at("node") === path.join(programs, "node.exe"), `node is node.exe (${at("node")})`);
	check("lookup-extension", at("npx.cmd") === path.join(programs, "npx.cmd"), `a name with its extension is that file (${at("npx.cmd")})`);
	check("lookup-path", at(path.join(programs, "row-stops")) === path.join(programs, "row-stops.cmd"), `a path with a space and an umlaut, its extension left out, is found (${at(path.join(programs, "row-stops"))})`);
	check("lookup-cwd", at("row-stops", empty, programs) === path.join(programs, "row-stops.cmd"), `the working folder comes first (${at("row-stops", empty, programs)})`);
	check("lookup-missing", at("uvx") === null, `a program that isn't there is none (${at("uvx")})`);
	check("lookup-elsewhere", startCheck.programFile("npx", empty, programs) === null, "this computer takes no Windows ending");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`connector-missing-program-windows-smoke: ${failures.length} failed: ${failures.join(", ")}`);
	process.exit(1);
}
console.log("connector-missing-program-windows-smoke: on Windows a connector whose program isn't there says which one is missing");
process.exit(0);
