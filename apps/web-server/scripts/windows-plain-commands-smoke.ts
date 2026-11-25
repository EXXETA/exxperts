// A room's commands without protection on a Windows PC with no Git run in
// Windows PowerShell 5.1, and everywhere else in bash as they always did. On
// any computer but Windows, in one process, through the room's own command
// tools: which shell in each case, how PowerShell is started and ended, that
// what a conversation got at its bind stays, each text the model reads, the
// outside tool, the wrapper, and doctor's line. The room's own connection is
// bound here on a server in this process, with a stand-in for the model; a
// server acting as Windows from its start is shell-missing-windows-smoke.ts's.
//
// The lookup is walked as on Windows. Its `where` is a stand-in that answers
// from a folder and keeps what it was asked; powershell.exe is a stand-in at
// C:\Windows\..., which here is one file name in this process's own folder,
// itself on PATH. It keeps what it was started with and runs the command in
// /bin/sh.
import childProcess, { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import type { SkillFilesView } from "../src/persistent-room-skill-tool.js";
import { authedFetch, freePort, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

if (process.platform === "win32") {
	console.log("windows-plain-commands smoke skipped (the stand-in programs need a machine that is not Windows)");
	process.exit(0);
}

let failed = 0;
async function row(name: string, body: () => Promise<void> | void): Promise<void> {
	asOnAPcWithoutGit();
	try {
		await body();
		console.log(`ok: ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`FAIL: ${name}\n${(error as Error).stack}`);
	}
}

const show = (value: unknown) => JSON.stringify(value);
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "windows-plain-")));
const folderAt = (name: string) => {
	fs.mkdirSync(path.join(work, name), { recursive: true });
	return path.join(work, name);
};
const agentDir = folderAt("agent");
const room = folderAt("room");
const bin = folderAt("bin");
const starts = folderAt("starts");
const agentsRoot = folderAt("agents");
const answers = folderAt("where-answers");
const asked = path.join(work, "where-asked.txt");
const programFiles = folderAt("program-files");
const programs = folderAt("programs");
process.chdir(programs);

const POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const script = (file: string, body: string) => fs.writeFileSync(file, body, { mode: 0o755 });
const powerShellFile = path.join(programs, POWERSHELL);
const standIn = path.join(work, "powershell.cjs");
fs.writeFileSync(standIn, `
const fs = require("node:fs");
const { EXXPERTS_COMMAND, ...env } = process.env;
const kept = ${JSON.stringify(starts)} + "/" + process.hrtime.bigint() + ".json";
fs.writeFileSync(kept + ".part", JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
fs.renameSync(kept + ".part", kept);
const ran = require("node:child_process").spawnSync("/bin/sh", ["-c", EXXPERTS_COMMAND], { env, stdio: "inherit" });
process.exit(ran.status ?? 1);
`);
const installPowerShell = () => script(powerShellFile, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(standIn)} "$@"\n`);
const uninstallPowerShell = () => fs.rmSync(powerShellFile, { force: true });
installPowerShell();

script(path.join(bin, "where"), `#!/bin/sh\necho "$1" >> ${JSON.stringify(asked)}\n[ -f ${JSON.stringify(answers)}/"$1" ] || exit 1\ncat ${JSON.stringify(answers)}/"$1"\n`);
/** A program by its Windows path under this smoke's folder: one file name here, and bash as its answer. */
const program = (windowsPath: string) => {
	const file = `${work}/${windowsPath}`;
	if (!fs.existsSync(file)) fs.symlinkSync("/bin/bash", file);
	return file;
};
const onPath = (name: "bash.exe" | "git.exe", file: string | null) => {
	if (file === null) fs.rmSync(path.join(answers, name), { force: true });
	else fs.writeFileSync(path.join(answers, name), `${file}\r\n`);
};
const gitBash = `${programFiles}\\Git\\bin\\bash.exe`;
const uninstallGit = () => fs.rmSync(gitBash, { force: true });
const installGit = () => {
	uninstallGit();
	fs.symlinkSync("/bin/bash", gitBash);
};
const settings = (value: object | null) => {
	const file = path.join(agentDir, "settings.json");
	if (value === null) fs.rmSync(file, { force: true });
	else fs.writeFileSync(file, JSON.stringify(value));
};
const whereAsked = () => (fs.existsSync(asked) ? fs.readFileSync(asked, "utf8").split("\n").filter(Boolean) : []);

Object.assign(process.env, {
	EXXPERTS_CODING_AGENT_DIR: agentDir,
	EXXPERTS_STATE_HOME: folderAt("state"),
	EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
	PATH: [bin, programs, process.env.PATH].join(path.delimiter),
	SystemRoot: String.raw`C:\Windows`,
	ProgramFiles: programFiles,
	"ProgramFiles(x86)": programFiles,
	LOCALAPPDATA: programFiles,
	EXXPERTS_AUTH_TOKEN: "synthetic-sign-in-token",
	ANTHROPIC_API_KEY: "synthetic-provider-key",
	PSModulePath: "modules-of-powershell-7",
	PSMODULEPATH: "modules-of-powershell-7",
	psmodulepath: "modules-of-powershell-7",
	SMOKE_OWN_VARIABLE: "own-value",
});
delete process.env.PYTHONUTF8;

// What each program start asked Node for: the runtime's import of spawn reads this one.
const spawned: { file: string; options: childProcess.SpawnOptions }[] = [];
const nodeSpawn = childProcess.spawn;
(childProcess as { spawn: unknown }).spawn = (file: string, args: string[], options: childProcess.SpawnOptions) => {
	spawned.push({ file, options });
	return nodeSpawn(file, args, options);
};
syncBuiltinESMExports();

const { setShellLookupPlatformForTests } = await import("@exxeta/exxperts-runtime");
const { createRoomCommandTools } = await import("../src/room-command-tool.js");
const { persistentRoomShellFound } = await import("../src/persistent-room-shell-missing.js");
const { createPersistentRoomBashApprovalExtension } = await import("../src/persistent-room-bash-approval.js");
const { skillFilesSection } = await import("../src/persistent-room-skill-tool.js");
const { COMMAND_VARIABLE } = await import("../src/room-box/windows/box-request.js");
const commandLine: Record<string, unknown> = await import("../src/room-box/windows/command-line.js");

/** How each row starts: Windows PowerShell, no bash, and no settings of the person's. */
function asOnAPcWithoutGit(): void {
	setShellLookupPlatformForTests("win32");
	process.env.SystemRoot = String.raw`C:\Windows`;
	uninstallPowerShell();
	installPowerShell();
	uninstallGit();
	onPath("bash.exe", null);
	onPath("git.exe", null);
	settings(null);
	fs.rmSync(asked, { force: true });
}

type Result = { content: { type: string; text?: string }[] };
type Tool = { name: string; description: string; promptSnippet?: string; parameters: { properties: Record<string, { description?: string }> }; execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<Result> };
type Start = { args: string[]; cwd: string; env: Record<string, string> };
const startsKept = (): Start[] => fs.readdirSync(starts).filter((name) => name.endsWith(".json")).sort().map((name) => JSON.parse(fs.readFileSync(path.join(starts, name), "utf8")));
const named = (tools: { tools: unknown[] }, name: string) => (tools.tools as Tool[]).find((tool) => tool.name === name) as Tool;
const textOf = (result: Result) => result.content.map((part) => part.text ?? "").join("");
const run = (tool: Tool, id: string, command: string, more: { signal?: AbortSignal; timeout?: number; reason?: string } = {}) => tool.execute(id, { command, ...(more.timeout === undefined ? {} : { timeout: more.timeout }), ...(more.reason === undefined ? {} : { reason: more.reason }) }, more.signal).then((result) => ({ ok: true, text: textOf(result) }), (error: Error) => ({ ok: false, text: error.message }));
const until = async (what: string, test: () => boolean) => {
	const deadline = Date.now() + 10_000;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`never: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
};
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const BASH_DESCRIPTION = "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Commands time out after 600 seconds by default; provide a timeout in seconds to override.";
const POWERSHELL_DESCRIPTION = "Run a Windows PowerShell 5.1 command in the room's folder. This is PowerShell, not bash: use Get-ChildItem, Get-Content, Select-String, $env:NAME, and ; between commands; && and || don't exist in 5.1. ls, cat, rm, cp and mv are PowerShell's own commands with PowerShell's options: write Remove-Item -Recurse -Force, not rm -rf. curl means Invoke-WebRequest; write curl.exe for curl. To pass text with double quotes to a program, put it in a file first. Text files a command writes are UTF-8 with a byte-order mark; write a file that must have none, such as JSON for Python, with the write tool. Returns the output and errors. Output is truncated to the last 2000 lines or 50KB (whichever is hit first); the full output is saved to a file. Commands time out after 600 seconds by default; provide a timeout in seconds to override.";
const GIT_LINE = "On Windows, shell commands need Git for Windows. Install it from gitforwindows.org; the room can run commands as soon as it is installed. If it still says this, restart exxperts.";
const TOO_LONG = "This command is longer than Windows lets one command be. Split it into shorter commands.";
const BLOCKED = "exxperts can't run commands here: this computer doesn't let it start Windows PowerShell.";
const WRAPPER = "$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Continue'; try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding } catch { }; try { $PSDefaultParameterValues['*:Encoding'] = 'utf8' } catch { }; $exxpertsCommand = $env:EXXPERTS_COMMAND; Remove-Item -LiteralPath Env:EXXPERTS_COMMAND -ErrorAction SilentlyContinue; $global:LASTEXITCODE = 0; $exxpertsOk = $false; Invoke-Expression ($exxpertsCommand + [char]10 + '$exxpertsOk = $?') | Out-Default; if ($exxpertsOk) { exit 0 }; if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1";

/** A room's command tool bound now: the shell its text names and the shell its command runs in, which must agree. */
async function boundNow(label: string): Promise<{ shell: "bash" | "powershell"; ran: { ok: boolean; text: string } }> {
	const bash = named(createRoomCommandTools(room), "bash");
	const before = startsKept().length;
	const ran = await run(bash, `bound-${label}`, "echo command-ran");
	const shell = startsKept().length > before ? "powershell" as const : "bash" as const;
	const text = bash.description === POWERSHELL_DESCRIPTION ? "powershell" : bash.description === BASH_DESCRIPTION ? "bash" : bash.description;
	assert(text === shell, `${label}: the text says ${text}, the command ran in ${shell}`);
	return { shell, ran };
}
const expectShell = async (label: string, shell: "bash" | "powershell") => {
	const bound = await boundNow(label);
	assert(bound.shell === shell && bound.ran.ok && bound.ran.text.trim().endsWith("command-ran"), `${label}: expected ${shell}, got ${show(bound)}`);
};

// ---- 1. Which shell -------------------------------------------------------------------------------------

await row("rule: with no bash at all, commands run in PowerShell", async () => {
	await expectShell("no bash", "powershell");
});

const LAUNCHERS = [String.raw`C:\Windows\System32\bash.exe`, String.raw`C:\Windows\Sysnative\bash.exe`, String.raw`C:\WINDOWS\syswow64\BASH.EXE`, String.raw`C:\Users\Ana\AppData\Local\Microsoft\WindowsApps\bash.exe`];
for (const launcher of LAUNCHERS) {
	await row(`rule: Windows' own launcher at ${launcher} is no bash: PowerShell`, async () => {
		onPath("bash.exe", program(launcher));
		await expectShell(launcher, "powershell");
	});
}

await row("rule: Git's bash, in its usual place or beside git.exe, wins over the launcher, and any other bash on PATH counts", async () => {
	onPath("bash.exe", program(LAUNCHERS[0]));
	installGit();
	await expectShell("Git beside the launcher", "bash");
	uninstallGit();
	await expectShell("Git gone again", "powershell");
	fs.mkdirSync(path.join(work, "git", "cmd"), { recursive: true });
	fs.mkdirSync(path.join(work, "git", "bin"), { recursive: true });
	fs.symlinkSync("/bin/bash", path.join(work, "git", "bin", "bash.exe"));
	onPath("git.exe", path.join(work, "git", "cmd", "git.exe"));
	await expectShell("Git found through git.exe", "bash");
	onPath("git.exe", null);
	// The folder decides, not a name that only starts alike.
	for (const other of [String.raw`C:\cygwin64\bin\bash.exe`, String.raw`C:\tools\System32\usr\bash.exe`, String.raw`C:\tools\mysystem32\bash.exe`]) {
		onPath("bash.exe", program(other));
		await expectShell(other, "bash");
	}
});

await row("rule: the person's shellPath or command prefix keeps bash, their failures included", async () => {
	settings({ shellPath: program(String.raw`D:\my\bash.exe`) });
	await expectShell("shellPath", "bash");
	settings({ shellPath: path.join(work, "no-such-bash.exe") });
	const missing = await boundNow("a shellPath that isn't there");
	assert(missing.shell === "bash" && !missing.ran.ok && missing.ran.text.startsWith("Custom shell path not found"), show(missing));
	settings({ shellCommandPrefix: "echo PREFIX-RAN" });
	const prefixed = await boundNow("a prefix, no bash");
	assert(prefixed.shell === "bash" && !prefixed.ran.ok && prefixed.ran.text.startsWith("No bash shell found."), show(prefixed));
	onPath("bash.exe", program(LAUNCHERS[0]));
	const launched = await boundNow("a prefix and the launcher");
	assert(launched.shell === "bash" && launched.ran.text.includes("PREFIX-RAN"), show(launched));
	onPath("bash.exe", null);
	// Empty settings name nothing.
	settings({ shellPath: "", shellCommandPrefix: "" });
	await expectShell("empty settings", "powershell");
});

await row("rule: with no PowerShell on the disk, or no Windows folder named, bash as before: the no-shell failure, or the launcher's own answer", async () => {
	for (const [label, away, back] of [
		["no PowerShell", uninstallPowerShell, installPowerShell],
		["no SystemRoot", () => { delete process.env.SystemRoot; }, () => { process.env.SystemRoot = String.raw`C:\Windows`; }],
	] as const) {
		away();
		const neither = await boundNow(label);
		assert(neither.shell === "bash" && !neither.ran.ok && neither.ran.text.startsWith("No bash shell found."), `${label}: ${show(neither)}`);
		assert(!persistentRoomShellFound(), `${label}: the Folder page has no Git line`);
		onPath("bash.exe", program(LAUNCHERS[0]));
		await expectShell(`${label}, the launcher`, "bash");
		assert(persistentRoomShellFound(), `${label}, the launcher: a Git line it never had`);
		onPath("bash.exe", null);
		back();
	}
});

await row("rule: the Folder page counts PowerShell as a shell, looked up afresh", () => {
	assert(persistentRoomShellFound(), "PowerShell there, and the Git line shows");
	uninstallPowerShell();
	assert(!persistentRoomShellFound(), "PowerShell gone, and no Git line");
	installGit();
	assert(persistentRoomShellFound(), "Git there, and the Git line shows");
});

await row("rule: a Mac and Linux keep bash, and look nothing up, even with a SystemRoot and a PowerShell", async () => {
	setShellLookupPlatformForTests(undefined);
	await expectShell("this computer's own lookup", "bash");
	delete process.env.SystemRoot;
	await expectShell("no SystemRoot", "bash");
	assert(whereAsked().length === 0, show(whereAsked()));
});

// ---- 2. The start ---------------------------------------------------------------------------------------

const lastStart = (): Start => {
	const last = startsKept().at(-1);
	assert(last, "PowerShell was never started");
	return last;
};

await row("start: by its full path, hidden, with the fixed arguments and the wrapper, in the room's folder; the text only in its variable, as written", async () => {
	const bash = named(createRoomCommandTools(room), "bash");
	const command = "printf '%s|' \"a b\" 'c' \\\n\tä ö ü € '$HOME' \"it's\" '\"' '100%' 'C:\\temp\\'\necho; echo second";
	const ran = await run(bash, "start", command);
	assert(ran.ok && ran.text === "a b|c|ä|ö|ü|€|$HOME|it's|\"|100%|C:\\temp\\|\nsecond\n", show(ran));
	const start = lastStart();
	assert(show(start.args) === show(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-Command", WRAPPER]), show(start.args));
	assert(start.cwd === room && start.env[COMMAND_VARIABLE] === command, show([start.cwd, start.env[COMMAND_VARIABLE]]));
	const asksNode = spawned.filter((each) => each.file === POWERSHELL).at(-1);
	assert(asksNode?.options.windowsHide === true && show(asksNode.options.stdio) === show(["ignore", "pipe", "pipe"]) && !asksNode.options.shell, show(asksNode?.options.windowsHide));
});

await row("start: bash is started with the options it always had", async () => {
	installGit();
	await run(named(createRoomCommandTools(room), "bash"), "bash-start", "echo ran");
	const asksNode = spawned.filter((each) => each.file === gitBash).at(-1);
	assert(asksNode && !asksNode.options.windowsHide, show(asksNode?.options.windowsHide));
});

await row("start: the person's environment without the app's token and keys, no PSModulePath in any case, and PYTHONUTF8 unless the person set it", async () => {
	const bash = named(createRoomCommandTools(room), "bash");
	const seen = await run(bash, "env", "env");
	const start = lastStart();
	assert(start.env.EXXPERTS_AUTH_TOKEN === undefined && start.env.ANTHROPIC_API_KEY === undefined, show(Object.keys(start.env)));
	assert(!JSON.stringify(start.env).includes("synthetic-") && !Object.keys(start.env).some((name) => name.toUpperCase() === "PSMODULEPATH"), show(Object.keys(start.env)));
	assert(start.env.SMOKE_OWN_VARIABLE === "own-value" && start.env.PYTHONUTF8 === "1" && seen.ok, show(start.env.PYTHONUTF8));
	assert(start.env.PATH?.startsWith(path.join(agentDir, "bin")), String(start.env.PATH));
	for (const name of ["PYTHONUTF8", "PythonUtf8"]) {
		process.env[name] = "0";
		await run(bash, `python-${name}`, "true");
		const own = Object.entries(lastStart().env).filter(([each]) => each.toUpperCase() === "PYTHONUTF8");
		assert(show(own) === show([[name, "0"]]), show(own));
		delete process.env[name];
	}
	// A variable of that name in another case is never a second one beside the command's.
	process.env.Exxperts_Command = "not the command";
	await run(bash, "case", "echo mine");
	const commands = Object.entries(lastStart().env).filter(([each]) => each.toUpperCase() === COMMAND_VARIABLE);
	delete process.env.Exxperts_Command;
	assert(show(commands) === show([[COMMAND_VARIABLE, "echo mine"]]), show(commands));
});

await row("start: output of both streams, and a failed command's exit code", async () => {
	const bash = named(createRoomCommandTools(room), "bash");
	const failedRun = await run(bash, "exit", "echo out; echo err >&2; exit 7");
	assert(!failedRun.ok && failedRun.text.includes("out") && failedRun.text.includes("err") && failedRun.text.endsWith("Command exited with code 7"), show(failedRun));
});

/** A command whose child writes its process id: what ends the command must end the child too. */
const withChild = (pidFile: string) => `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`;
const childOf = (pidFile: string) => Number(fs.readFileSync(pidFile, "utf8").trim());

await row("start: Stop ends the command and its child", async () => {
	const pidFile = path.join(work, "stop.pid");
	const stop = new AbortController();
	const running = run(named(createRoomCommandTools(room), "bash"), "stop", withChild(pidFile), { signal: stop.signal });
	await until("the child's process id", () => fs.existsSync(pidFile) && childOf(pidFile) > 0);
	stop.abort();
	const stopped = await running;
	assert(!stopped.ok && stopped.text.endsWith("Command aborted"), show(stopped));
	await until("the child ended", () => !alive(childOf(pidFile)));
});

await row("start: the time limit ends the command and its child", async () => {
	const pidFile = path.join(work, "limit.pid");
	const limited = await run(named(createRoomCommandTools(room), "bash"), "limit", withChild(pidFile), { timeout: 2 });
	assert(!limited.ok && limited.text.endsWith("Command timed out after 2 seconds"), show(limited));
	await until("the child ended", () => !alive(childOf(pidFile)));
});

await row("start: a program left open, which keeps the output open, doesn't hold the command", async () => {
	const pidFile = path.join(work, "open.pid");
	const before = Date.now();
	const left = await run(named(createRoomCommandTools(room), "bash"), "open", `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; echo opened`);
	assert(left.ok && left.text.includes("opened") && Date.now() - before < 20_000, `${show(left)} after ${Date.now() - before} ms`);
	assert(alive(childOf(pidFile)), "the program the command left open was ended");
	process.kill(childOf(pidFile));
});

/** Whether a failed call would be recorded as a command that ran, by the approval extension's own hook. */
async function recordedAsRan(tools: ReturnType<typeof createRoomCommandTools>, toolName: string, toolCallId: string, text: string): Promise<boolean> {
	const handlers: Record<string, (event: unknown) => Promise<unknown>> = {};
	await createPersistentRoomBashApprovalExtension({ beforeBashCall: async () => ({ allow: true }) }, tools.started)({ on: (event: string, handler: any) => { handlers[event] = handler; } } as any);
	return (await handlers.tool_result({ toolName, toolCallId, isError: true, content: [{ type: "text", text }] })) !== undefined;
}

await row("start: the longest command Windows allows runs; one character more is refused before any start, and isn't a command that ran", async () => {
	const tools = createRoomCommandTools(room);
	const bash = named(tools, "bash");
	const longest = `echo long #${"x".repeat(32_767 - COMMAND_VARIABLE.length - 1 - 11)}`;
	const ran = await run(bash, "longest", longest);
	assert(ran.ok && ran.text.trim() === "long" && lastStart().env[COMMAND_VARIABLE] === longest, show(ran).slice(0, 200));
	const before = startsKept().length;
	const refused = await run(bash, "too-long", `${longest}x`);
	assert(!refused.ok && refused.text === TOO_LONG && startsKept().length === before, show(refused).slice(0, 200));
	assert(!tools.started("too-long") && tools.started("longest"), "what ran is recorded wrong");
	assert(!(await recordedAsRan(tools, "bash", "too-long", refused.text)), "a refused command is recorded as one that ran");
	const failedRun = await run(bash, "failed-after", "exit 3");
	assert(await recordedAsRan(tools, "bash", "failed-after", failedRun.text), "a command that ran and failed isn't recorded");
});

await row("start: a start Windows refuses answers one plain sentence, its error goes to the log alone, and it isn't a command that ran", async () => {
	const logged: string[] = [];
	const tools = createRoomCommandTools(room, undefined, undefined, undefined, (raw) => logged.push(raw));
	fs.chmodSync(powerShellFile, 0o644);
	const refused = await run(named(tools, "bash"), "blocked", "echo never");
	fs.chmodSync(powerShellFile, 0o755);
	assert(!refused.ok && refused.text === BLOCKED, show(refused));
	assert(logged.length === 1 && logged[0].includes("EACCES") && !logged[0].includes("echo never"), show(logged));
	assert(!tools.started("blocked") && !(await recordedAsRan(tools, "bash", "blocked", refused.text)), "a start that was refused is recorded as a command that ran");
	const after = await run(named(tools, "bash"), "unblocked", "echo works-again");
	assert(after.ok && after.text.includes("works-again") && tools.started("unblocked"), show(after));
});

// ---- 3. Pinned at the bind ------------------------------------------------------------------------------

await row("bind: Git installed afterwards leaves this conversation on PowerShell, text and shell; the next bind has bash's", async () => {
	const bound = named(createRoomCommandTools(room), "bash");
	installGit();
	const before = startsKept().length;
	const ran = await run(bound, "pinned", "echo still-here");
	assert(bound.description === POWERSHELL_DESCRIPTION && ran.ok && startsKept().length === before + 1, show([bound.description.slice(0, 40), ran]));
	await expectShell("the next bind", "bash");
});

// ---- 4. The texts, and the outside tool -----------------------------------------------------------------

await row("texts: an unprotected room's command tool on a PC without Git, letter for letter; a Mac's and a Git PC's as before", async () => {
	const bash = named(createRoomCommandTools(room), "bash");
	assert(bash.description === POWERSHELL_DESCRIPTION && bash.description.length === 828, `${bash.description.length}: ${bash.description}`);
	assert(bash.promptSnippet === "Run Windows PowerShell 5.1 commands (Get-ChildItem, Select-String, etc.)" && bash.parameters.properties.command.description === "Windows PowerShell 5.1 command to run" && bash.parameters.properties.timeout?.description?.startsWith("Timeout in seconds"), show([bash.promptSnippet, bash.parameters]));
	const asBefore = (label: string) => {
		const main = named(createRoomCommandTools(room), "bash");
		assert(main.description === BASH_DESCRIPTION && main.description.length === 297 && main.promptSnippet === "Execute bash commands (ls, grep, find, etc.)" && main.parameters.properties.command.description === "Bash command to execute", `${label}: ${show([main.description, main.promptSnippet, main.parameters])}`);
	};
	installGit();
	asBefore("a Git PC");
	uninstallGit();
	setShellLookupPlatformForTests(undefined);
	asBefore("a Mac");
});

await row("texts: a skill's files line in a room whose commands are PowerShell, letter for letter, and bash's as before", () => {
	const view: SkillFilesView = { kind: "open", reach: "run", skillDir: String.raw`C:\skills\report`, files: ["scripts/report.ps1"], windowsRuns: true };
	const around = (line: string) => `This skill's bundled files live at:\nC:\\skills\\report\nPaths in its instructions are relative to this folder: give them in full, as this folder followed by the path.\nFiles: "scripts/report.ps1"\n${line} Outputs you write stay in the room's folder on the user's computer; when you tell the user where an output landed, name the folder's path. If a later read of this skill no longer gives this folder, do not run its files from memory.`;
	const powerShell = "Read them with the read tool. Run one with this room's commands by naming its program and quoting its full path, never by its name alone: & '<full path>.ps1' for PowerShell, python '<full path>.py' for Python (py '<full path>.py' where python isn't found), node '<full path>.js' for Node. If Python or Node isn't on this computer, don't install it and don't rewrite a long script: tell the person which program the skill needs, and that exxperts must be quit, not just its window closed, and opened again once it's installed. A .sh file can't run on this computer: do its steps with PowerShell commands where they are simple, otherwise tell the person that step can't run here. Write outputs into the room's folder and helper files under $env:TEMP. If a write in the skill's folder is refused, never call ask_for_folder for it.";
	assert(skillFilesSection(view, true) === around(powerShell) && powerShell.length === 827, `${powerShell.length}: ${skillFilesSection(view, true)}`);
	const bash = "Read them with the read tool, and run them with the bash tool when the instructions call for it. Write any outputs into the room's folder, never into the skill's folder. If a write in the skill's folder is refused, never call ask_for_folder for it.";
	assert(skillFilesSection(view, false) === around(bash) && bash.length === 248, `${bash.length}: ${skillFilesSection(view, false)}`);
});

/** A protected room's tools with a box that runs nothing; the person answers each outside card as told. */
function boxedTools(kind: "windows" | undefined, yes: boolean, log: (raw: string) => void = () => {}) {
	const cards: string[] = [];
	const box = { kind, operations: () => ({ exec: async () => ({ exitCode: 0 }) }), privateTemp: async () => folderAt("turn-temp"), readsSpills: () => false, noteSpill: () => {} };
	const tools = createRoomCommandTools(room, { box, outside: { questions: { watcher: () => "computer", askOutside: async (card: { command: string }) => { cards.push(card.command); return yes; } }, setOffered: () => {} } }, undefined, undefined, log);
	return { cards, tools, outside: named(tools, "run_outside_box") };
}
const OUTSIDE_START = "Ask the person to run one command outside this room's protection, with all their rights, when the room's commands can't do it: git push over SSH, git clone in their folder, opening an app.";
const OUTSIDE_END = "They see the full command and your reason on a card and must say yes each time. Use this only when a PowerShell command in the room has failed for that reason, never just to get at a place the room's protection keeps closed on purpose, such as the person's keys or a local address, unless the person asks.";

await row("outside: without Git its texts say PowerShell, and a yes runs the card's command there", async () => {
	const { cards, tools, outside } = boxedTools("windows", true);
	assert(outside.description === `${OUTSIDE_START} It runs in Windows PowerShell 5.1 as well; open an app or a file with Start-Process. ${OUTSIDE_END}` && outside.description.length === 579, `${outside.description.length}: ${outside.description}`);
	assert(outside.parameters.properties.command.description === "The one Windows PowerShell 5.1 command to run outside this room" && outside.parameters.properties.command.description.length === 63, show(outside.parameters));
	const ran = await run(outside, "outside", "echo outside-ran", { reason: "opening an app" });
	assert(ran.ok && ran.text.includes("outside-ran") && show(cards) === show(["echo outside-ran"]) && lastStart().env[COMMAND_VARIABLE] === "echo outside-ran" && lastStart().cwd === room, show([ran, cards]));
	assert(tools.started("outside") && named(tools, "bash").description.includes("Programs a command starts end when it ends."), "the protected room's own command tool changed");
	const declined = boxedTools("windows", false);
	const before = startsKept().length;
	const no = await run(declined.outside, "outside-no", "echo never", { reason: "opening an app" });
	assert(!no.ok && no.text.startsWith("The user declined this command.") && startsKept().length === before && !declined.tools.started("outside-no"), show(no));
});

await row("outside: a start Windows refuses after a yes says so and isn't a command that ran", async () => {
	const logged: string[] = [];
	const { tools, outside } = boxedTools("windows", true, (raw) => logged.push(raw));
	fs.chmodSync(powerShellFile, 0o644);
	const refused = await run(outside, "outside-blocked", "echo never", { reason: "opening an app" });
	fs.chmodSync(powerShellFile, 0o755);
	assert(!refused.ok && refused.text === BLOCKED && logged.length === 1 && !tools.started("outside-blocked"), show([refused, logged]));
	assert(!(await recordedAsRan(tools, "run_outside_box", "outside-blocked", refused.text)), "recorded as ran");
});

await row("outside: with Git, or beside the Mac's box, the texts are as before", () => {
	installGit();
	const git = boxedTools("windows", true).outside;
	assert(git.description === `${OUTSIDE_START} This one runs in Git Bash, not PowerShell, so write it in bash. ${OUTSIDE_END}` && git.description.length === 558, `${git.description.length}: ${git.description}`);
	assert(git.parameters.properties.command.description === "The one bash command to run outside this room, in Git Bash" && git.parameters.properties.command.description.length === 58, show(git.parameters));
	uninstallGit();
	setShellLookupPlatformForTests(undefined);
	const mac = boxedTools(undefined, true).outside;
	assert(mac.description === `${OUTSIDE_START} They see the full command and your reason on a card and must say yes each time. Use this only when the bash tool has failed for that reason, never just to get at a place the room's protection keeps closed on purpose, such as the person's keys or a local address, unless the person asks.` && mac.parameters.properties.command.description === "The one bash command to run outside this room", show([mac.description, mac.parameters]));
});

await row("outside: bound with Git, Git then taken away: the Git line before any card, though PowerShell is there; with neither shell from the start, the same line", async () => {
	installGit();
	const bound = boxedTools("windows", true);
	uninstallGit();
	const gone = await run(bound.outside, "outside-git-gone", "git push", { reason: "SSH" });
	assert(!gone.ok && gone.text === GIT_LINE && bound.cards.length === 0 && !bound.tools.started("outside-git-gone"), show([gone, bound.cards]));
	uninstallPowerShell();
	const neither = boxedTools("windows", true);
	const line = await run(neither.outside, "outside-neither", "git push", { reason: "SSH" });
	assert(!line.ok && line.text === GIT_LINE && neither.cards.length === 0, show([line, neither.cards]));
});

// ---- 6. The wrappers ------------------------------------------------------------------------------------

await row("wrapper: the box's is unchanged, and the plain one is its literal, with no double quote, backslash or line end", () => {
	const box = [
		"$ProgressPreference = 'SilentlyContinue'",
		"$ErrorActionPreference = 'Continue'",
		"try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding } catch { }",
		"try { $PSDefaultParameterValues['*:Encoding'] = 'utf8' } catch { }",
		"try { if ($env:EXXPERTS_TEMP) { $env:TEMP = $env:EXXPERTS_TEMP; $env:TMP = $env:EXXPERTS_TEMP } } catch { }",
		"try { if ($env:HTTPS_PROXY) { [Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy($env:HTTPS_PROXY) } } catch { }",
		"$exxpertsCommand = $env:EXXPERTS_COMMAND",
		"Remove-Item -LiteralPath Env:EXXPERTS_COMMAND -ErrorAction SilentlyContinue",
		"$global:LASTEXITCODE = 0",
		"$exxpertsOk = $false",
		"Invoke-Expression ($exxpertsCommand + \"`n\" + '$exxpertsOk = $?') | Out-Default",
		"if ($exxpertsOk) { exit 0 }",
		"if ($LASTEXITCODE) { exit $LASTEXITCODE }",
		"exit 1",
		"",
	].join("\n");
	assert(commandLine.COMMAND_WRAPPER === box, String(commandLine.COMMAND_WRAPPER));
	assert(commandLine.PLAIN_COMMAND_WRAPPER === WRAPPER && !/["\\\r\n]/.test(WRAPPER) && WRAPPER.length === 611, `${WRAPPER.length}: ${String(commandLine.PLAIN_COMMAND_WRAPPER)}`);
});

// ---- 7. doctor ------------------------------------------------------------------------------------------

/** doctor's line on bash and its hint, acting as Windows with these folders alone on PATH. */
function doctorOnBash(folders: string[]): string {
	const home = folderAt("doctor-home");
	const acting = `Object.defineProperty(process, "platform", { value: "win32" }); globalThis.fetch = () => Promise.reject(new Error("no network here"));`;
	const ran = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(acting)}`, path.join(repoRoot, "scripts", "doctor.mjs"), "--profile", "archive"], {
		cwd: repoRoot,
		env: { HOME: home, USERPROFILE: home, PATH: folders.join(path.delimiter), ProgramFiles: programFiles, LOCALAPPDATA: programFiles },
		encoding: "utf8",
		timeout: 120_000,
	});
	const lines = `${ran.stdout ?? ""}${ran.stderr ?? ""}`.split("\n");
	const at = lines.findIndex((line) => /bash (not )?found/.test(line));
	assert(at >= 0, `doctor says nothing of bash (${ran.status}):\n${lines.join("\n").slice(-3000)}`);
	return `${lines[at]}\n${lines[at + 1] ?? ""}`;
}

await row("doctor: the launcher alone, in each of its folders, is no bash; another bash on PATH is, the launcher's folder before it or not", () => {
	const holding = (windowsFolder: string) => {
		const folder = path.join(work, windowsFolder);
		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, "bash.exe"), "");
		return folder;
	};
	const launchers = ["doctor/Windows/System32", "doctor/Windows/Sysnative", "doctor/Windows/SysWOW64", "doctor/Microsoft/WindowsApps"].map(holding);
	for (const folders of [...launchers.map((folder) => [folder]), launchers, []]) {
		const line = doctorOnBash(folders);
		assert(line.includes("bash not found (needed only for source installs; room commands run in Windows PowerShell)") && line.includes("install Git for Windows (https://gitforwindows.org; no admin rights needed, per-user install works)") && !/WSL/.test(line), line);
	}
	const git = holding("doctor/Git/bin");
	for (const folders of [[git], [launchers[0], git]]) {
		const line = doctorOnBash(folders);
		assert(line.includes("bash found (rooms shell tool)") && line.includes(path.join(git, "bash.exe")), line);
	}
});

// ---- 8. The bind of a room's own connection -------------------------------------------------------------

// Nothing here reaches past this computer, and no key of a provider's is left: the stand-in is the one model.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
	// net.connect and tls.connect hand on their options, the first in a list; any other way in is refused.
	const [to] = Array.isArray(args[0]) ? args[0] : args;
	if (typeof to !== "object") throw new Error("a connection this smoke can't read");
	// No port is a pipe on this computer; a place that isn't this computer is answered as a closed port here.
	if (to.port !== undefined && !["localhost", "127.0.0.1", "::1"].includes(to.host ?? "localhost")) Object.assign(to, { host: "127.0.0.1", port: 1 });
	return connect.apply(this, args as any);
} as typeof connect;
const home = folderAt("home");
const appRoot = folderAt("state/.exxperts/app");
const { findEnvKeys, getProviders } = await import("@exxeta/exxperts-ai");
for (const name of getProviders().flatMap((provider) => findEnvKeys(provider) ?? [])) delete process.env[name];
for (const name of ["EXXPERTS_DATA_DIR", "EXXPERTS_REAL_HOME"]) delete process.env[name];
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV, { HOME: home, USERPROFILE: home, PORT: String(await freePort()), EXXETA_HOME: repoRoot, LOG_LEVEL: "error" });
const MODEL = { provider: "openai-compatible", model: "room-model" };

// The model: makes the next of its calls, then answers in words. Kept: each tool's text as offered, and what its calls gave back.
let calls: { name: string; args: Record<string, unknown> }[] = [];
let offered: Record<string, string> = {};
let gave: string[] = [];
const gateway = http.createServer((request, response) => {
	let body = "";
	request.on("data", (chunk) => { body += chunk; });
	request.on("end", () => {
		const parsed = JSON.parse(body || "{}");
		const messages: any[] = parsed.messages ?? [];
		const turn = messages.slice(messages.map((message) => message.role).lastIndexOf("user") + 1);
		// A request with no tools is the app's own, such as a title's.
		const answers = (parsed.tools ?? []).length > 0;
		if (answers) {
			offered = Object.fromEntries(parsed.tools.map((tool: any) => [tool.function.name, tool.function.description]));
			gave = turn.filter((message) => message.role === "tool").map((message) => (typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")));
		}
		const call = answers ? calls[gave.length] : undefined;
		const base = { id: "answer", object: "chat.completion.chunk", created: 1, model: MODEL.model };
		const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${gave.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: "assistant", content: "Done." };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(`data: ${show({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
		response.write(`data: ${show({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
});
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const written = (folder: string, name: string, value: unknown) => fs.writeFileSync(path.join(folder, name), show(value), { mode: 0o600 });
written(agentDir, "models.json", { providers: { [MODEL.provider]: { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, api: "openai-completions", models: [{ id: MODEL.model, name: "Room Model", contextWindow: 200_000, maxTokens: 4096 }] } } });
written(agentDir, "auth.json", { [MODEL.provider]: { type: "api_key", key: "synthetic-gateway-key" } });
written(appRoot, "openai-compatible-ai-profile.json", { profileId: MODEL.provider, providerId: MODEL.provider, label: "Synthetic Gateway", roomModels: [{ modelId: MODEL.model, label: "Room Model" }], maintenanceModel: MODEL.model });
written(appRoot, "persistent-agent-ai-profile.json", { profileId: MODEL.provider });
const skill = path.join(agentDir, "skills", "report");
fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: report\ndescription: Makes a report\n---\n\nRun scripts/report.ps1.\n");
fs.writeFileSync(path.join(skill, "scripts", "report.ps1"), "Write-Output report\n");

const { setRoomBoxForTests } = await import("../src/room-box/box-available.js");
const { ANSWER_FLOOR_MS } = await import("../src/room-box/card-text.js");
const { app } = await import("../src/server-app.js");
setRoomBoxForTests({ platform: "win32", windows: "off" });
await import("../src/index.js");
await app.ready();
await until("the server listens", () => app.server.listening);
const { getWebChatModelRegistry } = await import("../src/ai-models.js");
const usable = getWebChatModelRegistry().getAvailable().map((each: { provider: string; id: string }) => `${each.provider}/${each.id}`);
assert(show(usable) === show([`${MODEL.provider}/${MODEL.model}`]), `models besides the stand-in can be used: ${show(usable)}`);
assert(getProviders().every((provider) => findEnvKeys(provider) === undefined || findEnvKeys(provider)?.length === 0), "a provider's key is left in the environment");
const WebSocketImpl: any = (await import("ws")).default;

async function json(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${process.env.PORT}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const put = async (pathname: string, body: object) => {
	const saved = await json(pathname, { method: "PUT", body: show(body) });
	assert(saved.status === 200, `${pathname}: ${show(saved)}`);
};
const roomPath = (id: string, tail: string) => `/api/persistent-agents/${id}${tail}`;

/** A room whose commands nobody has set, with a folder saved as given. */
async function madeRoom(name: string, folder?: object, switchedOff = false): Promise<string> {
	const created = await json("/api/persistent-agents", { method: "POST", body: show({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const id = String(created.body?.agent?.id ?? "");
	assert(created.status === 201 && id, `${name}: ${show(created)}`);
	for (const file of ["commands-start-on.json", "bash-settings.json"]) fs.rmSync(path.join(agentsRoot, id, "runtime", file), { force: true });
	if (folder) await put(roomPath(id, "/workspace-default"), { root: folderAt(`home/Documents/${id}`), workspaceAccessMode: "localFiles", ...folder });
	// Switched off is what the person does to commands that are on.
	if (switchedOff) await put(roomPath(id, "/workspace-default"), { bashEnabled: false });
	await put(roomPath(id, "/skill-settings"), { action: "enable", name: "report" });
	return id;
}

let conversations = 0;
/** A conversation of the room's, opened and bound, and what the bind looked up; each card is answered yes. */
async function opened(id: string) {
	const conversation = `conversation-${++conversations}`;
	await put(roomPath(id, `/threads/${conversation}`), { state: "active", origin: "launcher", model: MODEL, items: [] });
	fs.rmSync(asked, { force: true });
	const starts = [spawned.length, startsKept().length];
	const socket = new WebSocketImpl(`ws://127.0.0.1:${process.env.PORT}/ws?persistentAgentId=${id}&conversationId=${conversation}&modelProvider=${MODEL.provider}&model=${MODEL.model}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	let frames: any[] = [];
	socket.addEventListener("message", (event: { data: unknown }) => {
		const frame = JSON.parse(String(event.data));
		frames.push(frame);
		// A person reads first: a yes sooner is asked again.
		if (frame.type === "ui_request" && (frame.kind === "run" || frame.kind === "commands")) setTimeout(() => socket.send(show({ type: "ui_response", id: frame.id, value: true })), ANSWER_FLOOR_MS + 50);
	});
	await until("the conversation is bound", () => frames.some((frame) => frame.type === "ready"));
	// Before any message is sent: the stand-in, and nothing else, answers it.
	const { model } = frames.find((frame) => frame.type === "ready");
	assert(model?.provider === MODEL.provider && model?.model === MODEL.model, `the bind picked another model: ${show(model)}`);
	assert(spawned.length === starts[0] && startsKept().length === starts[1], "the bind started a program of its own");
	return {
		lookedUp: whereAsked(),
		close: () => socket.close(),
		/** One message, whose answer makes these calls: the tools' texts as the model read them, and what each call gave. */
		async says(next: typeof calls) {
			calls = next;
			frames = [];
			fs.rmSync(asked, { force: true });
			const before = startsKept().length;
			socket.send(show({ type: "prompt", text: "Work in the folder." }));
			await until("the answer ended", () => frames.some((frame) => frame.type === "event" && frame.event?.type === "agent_end"));
			await waitForTurnSettled(json, id, "the answer has settled");
			return { texts: offered, gave, powerShellStarts: startsKept().length - before, lookedUp: whereAsked() };
		},
	};
}

const LOOKED_UP = ["git.exe", "bash.exe"];
const echo = { name: "bash", args: { command: "echo command-ran" } };
const readsSkill = { name: "read_skill", args: { name: "report" } };
const POWERSHELL_SKILL = "Run one with this room's commands by naming its program and quoting its full path";
const BASH_SKILL = "run them with the bash tool when the instructions call for it";

await row("bind: a room that can have no commands looks nothing up, protected or not", async () => {
	for (const [windows, name, folder, switchedOff] of [
		["off", "No folder", undefined, false],
		["off", "Bounded", { workspaceAccessMode: "bounded" }, false],
		["off", "Switched off", { bashEnabled: true }, true],
		["off", "Reads only", { toolSelection: { kind: "custom", allowedToolNames: ["read", "ls", "find", "grep"] } }, false],
		["on", "Protected, no folder", undefined, false],
		["on", "Protected, switched off", { bashEnabled: true }, true],
	] as const) {
		setRoomBoxForTests({ platform: "win32", windows });
		const conversation = await opened(await madeRoom(name, folder, switchedOff));
		const { texts } = await conversation.says([]);
		conversation.close();
		assert(conversation.lookedUp.length === 0, `${name}: looked up ${show(conversation.lookedUp)}`);
		assert(texts.bash === undefined && texts.run_outside_box === undefined && texts.read_skill !== undefined, `${name}: offered ${show(Object.keys(texts))}`);
	}
});

await row("bind: a protected room whose commands may come on gets no outside tool, and looks nothing up", async () => {
	setRoomBoxForTests({ platform: "win32", windows: "on" });
	const conversation = await opened(await madeRoom("Protected, may ask", {}));
	const { texts } = await conversation.says([]);
	conversation.close();
	assert(conversation.lookedUp.length === 0 && texts.bash?.includes("Programs a command starts end when it ends.") && texts.run_outside_box === undefined, show([conversation.lookedUp, texts.bash, texts.run_outside_box]));
});

await row("bind: a room with commands on, or that may ask for them, and a protected one with the outside tool, look once", async () => {
	for (const [windows, name, folder] of [
		["off", "Commands on", { bashEnabled: true }],
		["off", "May ask", {}],
		["on", "Protected, commands on", { bashEnabled: true }],
	] as const) {
		setRoomBoxForTests({ platform: "win32", windows });
		const conversation = await opened(await madeRoom(name, folder));
		const { texts } = await conversation.says([]);
		conversation.close();
		assert(show(conversation.lookedUp) === show(LOOKED_UP), `${name}: looked up ${show(conversation.lookedUp)}`);
		if (windows === "off") assert(texts.bash === POWERSHELL_DESCRIPTION, `${name}: ${texts.bash}`);
		else assert(texts.run_outside_box?.includes("It runs in Windows PowerShell 5.1 as well"), `${name}: ${texts.run_outside_box}`);
	}
});

await row("bind: commands turned on by the chat's card, with Git installed since: the tool's text, its shell and a skill's text stay PowerShell until the next bind has bash's", async () => {
	setRoomBoxForTests({ platform: "win32", windows: "off" });
	const conversation = await opened(await madeRoom("Asks for commands", {}));
	installGit();
	const asks = { name: "ask_for_commands", args: { reason: "To list the folder." } };
	const now = await conversation.says([asks, echo, readsSkill]);
	assert(now.texts.bash === POWERSHELL_DESCRIPTION && now.powerShellStarts === 1 && now.gave[1]?.trim() === "command-ran" && now.gave[2]?.includes(POWERSHELL_SKILL), show(now));
	const next = await conversation.says([echo, readsSkill]);
	conversation.close();
	assert(next.texts.bash === BASH_DESCRIPTION && next.powerShellStarts === 0 && next.gave[0]?.trim() === "command-ran" && next.gave[1]?.includes(BASH_SKILL), show(next));
});

await row("bind: commands switched on in Room settings while the conversation is open: the next message looks once, and text, shell and skill are PowerShell", async () => {
	setRoomBoxForTests({ platform: "win32", windows: "off" });
	const id = await madeRoom("Switched on later", { bashEnabled: true }, true);
	const conversation = await opened(id);
	assert(conversation.lookedUp.length === 0, show(conversation.lookedUp));
	const off = await conversation.says([readsSkill]);
	assert(off.texts.bash === undefined && off.lookedUp.length === 0, show(off));
	await put(roomPath(id, "/workspace-default"), { bashEnabled: true });
	const on = await conversation.says([echo, readsSkill]);
	conversation.close();
	assert(on.texts.bash === POWERSHELL_DESCRIPTION && on.powerShellStarts === 1 && on.gave[0]?.trim() === "command-ran" && on.gave[1]?.includes(POWERSHELL_SKILL) && show(on.lookedUp) === show(LOOKED_UP), show(on));
});

setRoomBoxForTests(null);
gateway.closeAllConnections();
gateway.close();
await app.close();

// ---- 1, last: a shared server. A process registers its hooks once, for its whole life. ------------------

await row("rule: a shared server keeps bash and its text, looks nothing up and starts nothing new", async () => {
	const { registerServerHooks } = await import("../src/server-hooks.js");
	registerServerHooks({});
	const before = startsKept().length;
	const bash = named(createRoomCommandTools(room), "bash");
	assert(bash.description === BASH_DESCRIPTION && whereAsked().length === 0 && startsKept().length === before, show([bash.description, whereAsked()]));
	installGit();
	await expectShell("a shared server", "bash");
});

process.chdir(os.tmpdir());
fs.rmSync(work, { recursive: true, force: true });
console.log(failed > 0 ? `windows-plain-commands-smoke: ${failed} rows failed` : "windows-plain-commands-smoke: OK");
// The server's own timers would keep this process going.
process.exit(failed > 0 ? 1 : 0);
