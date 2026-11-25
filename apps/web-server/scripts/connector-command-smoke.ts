// A connector's command as a person pastes it from a setup page, and the
// settings a program needs, row by row:
//
//  line      the reader on its own: each spelling a terminal takes (double and
//            single quotes, a backslash before a space or a quote, a leading
//            ~, settings in front, a line joined by a backslash), on a Mac and
//            on Windows (backslashes kept in a path); every line that would need
//            a shell refused, each beside the same character quoted or escaped;
//            a line with no program, or one quoted as nothing, refused.
//  shown     the line a row shows for a program and its arguments reads back
//            as the same, on a Mac and on Windows, whatever a word holds.
//  add       POST /api/mcp/servers against a really spawned server: a pasted
//            line with a quoted folder that holds a space is saved as one
//            program and the right arguments; a refused line, an open quote or
//            a bad setting writes nothing; settings from the line and from the
//            form are in the saved entry; the shape before (command and args)
//            and an entry with no settings work as before.
//  start     Test starts the program with that folder as one argument and the
//            settings' values, through the real adapter.
//  kept      a check, the address route and a sign-in leave the settings as
//            they were; the status never sends a setting's value, and the
//            command it shows, pasted back, adds the same program.
//
// Offline: the program is a script of the smoke's own, run by the Node that
// runs the smoke, in a folder whose name has a space.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandLineOf, CONNECTOR_COMMAND_LINES, readConnectorCommand } from "../src/connector-command.js";
import { authedFetch, freePort, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, waitForServer } from "./smoke-server-process.js";

const failures: string[] = [];
function check(id: string, ok: boolean, message: string): void {
	if (ok) console.log(`ok   ${id}: ${message}`);
	else {
		console.error(`FAIL ${id}: ${message}`);
		failures.push(id);
	}
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── The reader on its own ───────────────────────────────────────────────────
const MAC_HOME = "/Users/me";
const WIN_HOME = "C:\\Users\\me";
const READS: Array<[string, NodeJS.Platform, string, { command: string; args: string[]; env?: Record<string, string> }]> = [
	["double-quotes", "darwin", 'npx -y @scope/files-connector "/Users/me/Documents/My Vault"', { command: "npx", args: ["-y", "@scope/files-connector", "/Users/me/Documents/My Vault"] }],
	["single-quotes", "darwin", "npx -y @scope/files-connector '/Users/me/My Vault'", { command: "npx", args: ["-y", "@scope/files-connector", "/Users/me/My Vault"] }],
	["backslash-space", "darwin", "uvx files-server /Users/me/My\\ Vault", { command: "uvx", args: ["files-server", "/Users/me/My Vault"] }],
	["quote-in-quotes", "darwin", 'node -e "console.log(\\"hi\\")" \'it\'"\'"\'s\'', { command: "node", args: ["-e", 'console.log("hi")', "it's"] }],
	["tilde", "darwin", 'npx -y files ~/Documents ~ "~/kept" a~b', { command: "npx", args: ["-y", "files", "/Users/me/Documents", "/Users/me", "~/kept", "a~b"] }],
	["settings-in-front", "darwin", 'API_KEY=abc ROW_TWO="one two" npx -y pkg --flag=value', { command: "npx", args: ["-y", "pkg", "--flag=value"], env: { API_KEY: "abc", ROW_TWO: "one two" } }],
	["quoted-name-is-a-program", "darwin", '"A=b" --x', { command: "A=b", args: ["--x"] }],
	["joined-lines", "darwin", "npx -y pkg \\\n  /Users/me/notes", { command: "npx", args: ["-y", "pkg", "/Users/me/notes"] }],
	["extra-spaces", "darwin", "  npx\t -y   pkg  ", { command: "npx", args: ["-y", "pkg"] }],
	["windows-quoted-path", "win32", 'npx -y @scope/files-connector "C:\\Users\\me\\My Vault"', { command: "npx", args: ["-y", "@scope/files-connector", "C:\\Users\\me\\My Vault"] }],
	["windows-bare-path", "win32", "C:\\Tools\\server.exe --root C:\\data\\notes", { command: "C:\\Tools\\server.exe", args: ["--root", "C:\\data\\notes"] }],
	["windows-program-files", "win32", '"C:\\Program Files\\nodejs\\node.exe" server.js', { command: "C:\\Program Files\\nodejs\\node.exe", args: ["server.js"] }],
	["windows-tilde", "win32", "npx -y files ~\\notes", { command: "npx", args: ["-y", "files", "C:\\Users\\me\\notes"] }],
	["windows-escaped-quote", "win32", 'node -e "console.log(\\"hi\\")"', { command: "node", args: ["-e", 'console.log("hi")'] }],
	// The allowed neighbours of the refused lines below: the same character quoted or escaped is an argument.
	["pipe-quoted", "darwin", "server --sep '|' \"a && b\" x\\;y \\> '$(id)'", { command: "server", args: ["--sep", "|", "a && b", "x;y", ">", "$(id)"] }],
];
for (const [id, platform, line, want] of READS) {
	const got = readConnectorCommand(line, platform, platform === "win32" ? WIN_HOME : MAC_HOME);
	check(`line-${id}`, same(got, { command: want.command, args: want.args, env: want.env ?? {} }), `${JSON.stringify(line)} reads as ${JSON.stringify(want)} (got ${JSON.stringify(got)})`);
}
const REFUSED: Array<[string, string, string]> = [
	["pipe", "npx -y pkg | tee log", CONNECTOR_COMMAND_LINES.shellOnly],
	["and", "cd /tmp && npx -y pkg", CONNECTOR_COMMAND_LINES.shellOnly],
	["background", "npx -y pkg &", CONNECTOR_COMMAND_LINES.shellOnly],
	["semicolon", "npx -y pkg; rm -rf x", CONNECTOR_COMMAND_LINES.shellOnly],
	["redirect", "npx -y pkg > out.txt", CONNECTOR_COMMAND_LINES.shellOnly],
	["redirect-in", "npx -y pkg < in.txt", CONNECTOR_COMMAND_LINES.shellOnly],
	["command-inside", "npx -y pkg $(whoami)", CONNECTOR_COMMAND_LINES.shellOnly],
	["command-inside-quotes", 'npx -y pkg "$(whoami)"', CONNECTOR_COMMAND_LINES.shellOnly],
	["backtick", "npx -y pkg `whoami`", CONNECTOR_COMMAND_LINES.shellOnly],
	["two-lines", "npx -y pkg\nrm -rf x", CONNECTOR_COMMAND_LINES.shellOnly],
	["open-double", 'npx -y pkg "/Users/me/My Vault', CONNECTOR_COMMAND_LINES.openQuote],
	["open-single", "npx -y pkg '/Users/me", CONNECTOR_COMMAND_LINES.openQuote],
	["settings-only", "API_KEY=abc", CONNECTOR_COMMAND_LINES.missing],
	["empty", "   ", CONNECTOR_COMMAND_LINES.missing],
	["empty-program", '"" -y pkg', CONNECTOR_COMMAND_LINES.missing],
	["empty-program-alone", "''", CONNECTOR_COMMAND_LINES.missing],
	["settings-then-empty-program", 'API_KEY=abc "" pkg', CONNECTOR_COMMAND_LINES.missing],
];
for (const platform of ["darwin", "win32"] as const) {
	for (const [id, line, error] of REFUSED) {
		const got = readConnectorCommand(line, platform, MAC_HOME);
		check(`refused-${id}-${platform}`, same(got, { error }), `${JSON.stringify(line)} is refused with ${JSON.stringify(error)} on ${platform} (got ${JSON.stringify(got)})`);
	}
}

// An entry is judged a program by its command: every line the reader takes gives a non-empty one, and a
// line with none, or one quoted as nothing, gives no entry at all.
const programless = [...READS.map(([, platform, line]) => readConnectorCommand(line, platform, MAC_HOME)), ...['""', "''", 'API_KEY=abc "" pkg', "   "].map((line) => readConnectorCommand(line, "darwin", MAC_HOME))].filter((read) => !("error" in read) && !read.command);
check("every-entry-has-program", programless.length === 0, `each line read gives a program, never an entry with an empty command (got ${JSON.stringify(programless)})`);

// What a row shows reads back as the entry it shows, pasted again.
const SHOWN: Array<[string, NodeJS.Platform, string, string[], string]> = [
	["plain", "darwin", "npx", ["-y", "@scope/files-connector", "/Users/me/notes"], "npx -y @scope/files-connector /Users/me/notes"],
	["space", "darwin", "npx", ["-y", "pkg", "/Users/me/My Vault"], "npx -y pkg '/Users/me/My Vault'"],
	["quote", "darwin", "/Users/me/bin/it's here", ["a\"b", "", "$(id)", "~/x", "a|b"], `'/Users/me/bin/it'"'"'s here' 'a"b' '' '$(id)' '~/x' 'a|b'`],
	["setting-like", "darwin", "API_KEY=abc", ["B=c"], "'API_KEY=abc' B=c"],
	["windows-path", "win32", "C:\\Program Files\\nodejs\\npx.cmd", ["-y", "pkg", "C:\\Users\\me\\My Vault\\"], "'C:\\Program Files\\nodejs\\npx.cmd' -y pkg 'C:\\Users\\me\\My Vault\\'"],
	["windows-plain", "win32", "C:\\tools\\server.exe", ["--root", "D:\\notes"], "C:\\tools\\server.exe --root D:\\notes"],
	["windows-quote", "win32", "server", ["it's \\", "$(id)'"], `server 'it'"'"'s \\' '$(id)'"'"`],
];
for (const [id, platform, command, args, shown] of SHOWN) {
	const line = commandLineOf(command, args, platform);
	check(`shown-${id}`, line === shown, `${JSON.stringify([command, ...args])} shows as ${JSON.stringify(shown)} (got ${JSON.stringify(line)})`);
	const back = readConnectorCommand(line, platform, platform === "win32" ? WIN_HOME : MAC_HOME);
	check(`shown-${id}-reads-back`, same(back, { command, args, env: {} }), `${JSON.stringify(line)} reads back as the same program and arguments on ${platform} (got ${JSON.stringify(back)})`);
}

// ── Against a spawned server ────────────────────────────────────────────────
const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "connector-command-")));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const configFile = path.join(agentDir, "mcp.json");
const checksFile = path.join(agentDir, "mcp-connector-checks.json");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
// A folder whose name has a space, holding the program and its notes.
const vault = path.join(tempHome, "My Vault");
const notes = path.join(vault, "notes folder");
const program = path.join(vault, "row server.js");
const markerFile = path.join(tempHome, "started.jsonl");
fs.mkdirSync(notes, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(program, `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ args: process.argv.slice(2), fromLine: process.env.ROW_FROM_LINE ?? null, fromForm: process.env.ROW_FROM_FORM ?? null }) + "\\n");
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
`);
// Values made at run time, so a status that sent one back would show it.
const fromLine = `line-${randomBytes(8).toString("hex")}`;
const fromForm = `form-${randomBytes(8).toString("hex")}`;
// The existing file: a program in the shape before, with no settings.
fs.writeFileSync(configFile, `${JSON.stringify({ mcpServers: { "old-shape": { command: process.execPath, args: [program, notes] } } }, null, 2)}\n`);

async function requestJson(pathname: string, init?: RequestInit): Promise<{ status: number; body: any; text: string }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, init as never);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null, text };
}
const send = (method: string, pathname: string, body?: unknown) => requestJson(pathname, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
const configText = () => fs.readFileSync(configFile, "utf8");
const entries = (): Record<string, any> => JSON.parse(configText()).mcpServers;
const starts = (): Array<{ args: string[]; fromLine: string | null; fromForm: string | null }> => (fs.existsSync(markerFile) ? fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const quoted = (value: string) => `"${value}"`;

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
try {
	const env = smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXPERTS_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, EXXPERTS_SHARED_SERVER: undefined });
	server = spawn("npx", ["tsx", "src/index.ts"], { shell: process.platform === "win32", ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: webServerDir, env: env as NodeJS.ProcessEnv });
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 30_000);

	// A pasted line: the program and its file quoted, a folder with a space, a setting in front, one from the form.
	const line = `ROW_FROM_LINE=${fromLine} ${quoted(process.execPath)} ${quoted(program)} ${quoted(notes)}`;
	const added = await send("POST", "/api/mcp/servers", { name: "Notes", commandLine: line, env: { ROW_FROM_FORM: fromForm } });
	check("add-line", added.status === 200, `a pasted line with quoted folders is added (${added.status} ${added.text.slice(0, 200)})`);
	const saved = entries()[added.body?.name ?? "notes"];
	check("add-saved", same(saved, { displayName: "Notes", command: process.execPath, args: [program, notes], env: { ROW_FROM_LINE: fromLine, ROW_FROM_FORM: fromForm } }), `saved as one program, its two arguments and both settings (got ${JSON.stringify(saved)})`);
	const name = String(added.body?.name ?? "");

	// Refused lines and settings write nothing.
	for (const [id, body] of [
		["pipe", { name: "Piped", commandLine: `${quoted(process.execPath)} ${quoted(program)} | tee log` }],
		["and", { name: "Two", commandLine: `cd ${quoted(vault)} && ${quoted(process.execPath)} server.js` }],
		["command-inside", { name: "Inside", commandLine: `${quoted(process.execPath)} $(whoami)` }],
		["open-quote", { name: "Open", commandLine: `${quoted(process.execPath)} "${program}` }],
		["empty-program", { name: "No program", commandLine: '""' }],
		["bad-setting-name", { name: "Bad", commandLine: `${quoted(process.execPath)} ${quoted(program)}`, env: { "ROW-DASH": "x" } }],
		["setting-twice", { name: "Twice", commandLine: `ROW_A=1 ${quoted(process.execPath)} ${quoted(program)}`, env: { ROW_A: "2" } }],
		["setting-empty", { name: "Empty", commandLine: `${quoted(process.execPath)} ${quoted(program)}`, env: { ROW_A: "" } }],
		["setting-line-break", { name: "Break", commandLine: `${quoted(process.execPath)} ${quoted(program)}`, env: { ROW_A: "a\nb" } }],
		["settings-on-web", { name: "Web", url: "https://example.test/mcp", env: { ROW_A: "1" } }],
	] as const) {
		const before = configText();
		const refused = await send("POST", "/api/mcp/servers", body);
		check(`refused-${id}`, refused.status === 400 && typeof refused.body?.error === "string" && configText() === before, `refused with words, nothing written (${refused.status} ${refused.text.slice(0, 160)})`);
	}
	const shellRefusal = await send("POST", "/api/mcp/servers", { name: "Piped", commandLine: "npx -y pkg | tee log" });
	check("refused-says-why", shellRefusal.body?.error === CONNECTOR_COMMAND_LINES.shellOnly, `a line that needs a shell says so (${JSON.stringify(shellRefusal.body)})`);

	// The shape before: a program and its arguments as they are.
	const oldAdd = await send("POST", "/api/mcp/servers", { name: "Before", command: process.execPath, args: [program, notes] });
	check("add-shape-before", oldAdd.status === 200 && same(entries()[oldAdd.body?.name], { displayName: "Before", command: process.execPath, args: [program, notes] }), `command and args still add as before, with no settings (${JSON.stringify(entries()[oldAdd.body?.name])})`);

	// Test starts it with the folder as one argument and both settings' values.
	const tested = await send("POST", `/api/mcp/servers/${encodeURIComponent(name)}/test`);
	const started = starts().at(-1);
	check("start-args", tested.body?.ok === true && same(started?.args, [notes]), `the program started with the folder as one argument (test ${tested.text.slice(0, 160)}, args ${JSON.stringify(started?.args)})`);
	check("start-settings", started?.fromLine === fromLine && started?.fromForm === fromForm, `both settings reached the program (${JSON.stringify(started)})`);
	const oldTested = await send("POST", "/api/mcp/servers/old-shape/test");
	check("start-existing-file", oldTested.body?.ok === true && same(starts().at(-1)?.args, [notes]) && starts().at(-1)?.fromForm === null, `an existing entry with no settings starts as before (${oldTested.text.slice(0, 160)})`);

	// Nothing else changes or drops the settings.
	const kept = JSON.stringify(entries()[name]);
	check("kept-check", JSON.stringify(entries()[name]) === kept && fs.existsSync(checksFile), "a check keeps its result beside the entry, never in it");
	const moved = await send("PUT", `/api/mcp/servers/${encodeURIComponent(name)}/address`, { url: "https://example.test/mcp" });
	check("kept-address-route", moved.status >= 400 && JSON.stringify(entries()[name]) === kept, `the address route refuses a program and leaves its settings (${moved.status})`);
	const signIn = await send("POST", `/api/mcp/servers/${encodeURIComponent(name)}/login`);
	check("kept-sign-in", signIn.status >= 400 && JSON.stringify(entries()[name]) === kept, `a sign-in refuses a program and leaves its settings (${signIn.status})`);
	const signOut = await send("POST", `/api/mcp/servers/${encodeURIComponent(name)}/logout`);
	check("kept-sign-out", JSON.stringify(entries()[name]) === kept, `a sign-out leaves its settings (${signOut.status})`);

	// What the page receives: no setting's value, anywhere in the status.
	const status = await requestJson("/api/mcp/status");
	const row = status.body?.servers?.find((s: { name: string }) => s.name === name);
	check("status-no-values", status.status === 200 && !status.text.includes(fromLine) && !status.text.includes(fromForm), "the status never sends a setting's value");
	check("status-shows-command", typeof row?.target === "string" && row.target.includes(program) && !("env" in row), `the row shows the program and its arguments, no settings (${JSON.stringify(row?.target)})`);
	const pastedBack = await send("POST", "/api/mcp/servers", { name: "Pasted back", commandLine: row?.target });
	check("status-command-pastes-back", pastedBack.status === 200 && same([entries()[pastedBack.body?.name]?.command, entries()[pastedBack.body?.name]?.args], [entries()[name].command, entries()[name].args]), `the shown command, pasted back, adds the same program and arguments (${JSON.stringify(row?.target)} gave ${JSON.stringify(entries()[pastedBack.body?.name])})`);
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(serverOutput.join("").slice(-2000));
	console.error(`connector-command-smoke: ${failures.length} failed: ${failures.join(", ")}`);
	process.exit(1);
}
console.log("connector-command-smoke: a pasted command is read as a terminal reads it, and its settings stay its own");
process.exit(0);
