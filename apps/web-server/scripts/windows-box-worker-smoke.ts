// The Windows box's process and its engine, on any computer: the worker runs
// from its source with a stand-in for Microsoft's sandbox kit
// (windows-box-stand-in.mjs), which reads each request's grants and keeps a
// note of every call. Rows: the start check's three answers, row by row; the
// first-command proof passing, failing, each network check failing alone, and
// running again the next turn; the turn's proxy in every request, on a fresh
// port closed at the turn's end, its sites sent to the room's decision; a
// command's output by its id, its exit code, Stop and the time limit; the
// request rebuilt at each command from the room's folder, its list and the
// answer's own folders; the turn's temp and the room's caches in the one box
// folder; no telemetry asked for; a room whose folder the folder judge
// refuses, acting as Windows, at each command; the refusal line after a
// command that may have been refused; and the turn's temp as the place a
// long output lands.
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { saveAlsoAllowedFolders } from "../src/room-box/also-allowed.js";
import { BoxFault, COMMAND_FOLDER_MOVED, type SiteAnswer, type SiteAsk } from "../src/room-box/box-process.js";
import { BOX_FAULT_SENTENCE, boxRefusedLine } from "../src/room-box/card-text.js";
import { LOCAL_REFUSAL } from "../src/room-box/site-asks.js";
import { AnswerFolders } from "../src/room-box/folder-question.js";
import { createPersistentRoomDefaultCapabilityPolicy, persistentAgentRootPath, writePersistentRoomDefaultCapabilityPolicy } from "../src/persistent-room-workspace-policy.js";
import { ROOM_FOLDER_REFUSED } from "../src/room-files.js";
import { BOX_ROOT_NAME, type BoxRoot, defaultBoxRoot, openBoxRoot } from "../src/room-box/windows/box-root.js";
import { atOrInside, COMMAND_VARIABLE, type WindowsBoxRequest } from "../src/room-box/windows/box-request.js";
import { type Machine, runStartCheck, type StartAnswer, type WindowsSystem } from "../src/room-box/windows/start-check.js";
import { WindowsRoomBox, type WindowsRoomBoxOptions, windowsSkillFolder } from "../src/room-box/windows/windows-engine.js";
import { approvePersistentRoomSkillExecution, enablePersistentRoomSkill, revokePersistentRoomSkillExecution } from "../src/persistent-room-skill-settings.js";
import { approvedSkills, resolveExecutableSkillFiles } from "../src/skills-executable.js";
import { agentSkillsDir, sha256, writeSkillProvenance } from "../src/skills-store.js";
// @ts-expect-error: plain JavaScript, loaded as the kit in the worker and for its path helpers here.
import { nativePath, requestPath } from "./windows-box-stand-in.mjs";

if (os.platform() === "win32") {
	console.log("SKIPPED: not yet on a real Windows PC: the stand-in for Microsoft's sandbox kit puts a second drive before a path that has one, so the start check answers broken");
	process.exit(0);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function row(name: string, body: () => Promise<void> | void): Promise<void> {
	try {
		await body();
		console.log(`ok: ${name}`);
	} catch (error) {
		console.error(`FAIL: ${name}\n${(error as Error).stack}`);
		process.exit(1);
	}
}

const home = fs.realpathSync(os.homedir());
const work = fs.realpathSync(fs.mkdtempSync(path.join(home, "windows-box-")));
const show = (value: unknown) => JSON.stringify(value);
// What the stand-in's curl says, as curl.exe does, when the proxy refuses a plain request by ending the connection.
const EMPTY_REPLY = "curl: (52) Empty reply from server";
/** A new folder in the smoke's own, by its real path. */
function folderAt(name: string): string {
	fs.mkdirSync(path.join(work, name), { recursive: true });
	return fs.realpathSync(path.join(work, name));
}

// ---- The worker, from its source, with the stand-in for the kit ----------------------------------------

const require = createRequire(import.meta.url);
const TSX = pathToFileURL(require.resolve("tsx/esm")).href;
const STAND_IN = pathToFileURL(path.join(import.meta.dirname, "windows-box-stand-in.mjs")).href;
const WORKER_FILE = path.join(import.meta.dirname, "../src/room-box/windows/box-worker-windows.ts");

type Config = { version?: string; contract?: string; platform?: string; probe?: string; crash?: string; box?: string; net?: string; log: string };
let configs = 0;

/** A config file the stand-in reads at each call, and the worker that reads it. */
function standIn(settings: Omit<Config, "log"> = {}) {
	configs += 1;
	const file = path.join(work, `config-${configs}.json`);
	const log = path.join(work, `log-${configs}.jsonl`);
	const set = (more: Omit<Config, "log">) => fs.writeFileSync(file, JSON.stringify({ ...settings, ...more, log }));
	set({});
	const calls = (call?: string): { call: string; request?: WindowsBoxRequest; more?: unknown[] }[] => {
		const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
		return call ? lines.filter((entry) => entry.call === call) : lines;
	};
	return { worker: { file: WORKER_FILE, execArgv: ["--import", TSX, "--import", `${STAND_IN}?config=${encodeURIComponent(file)}&register`] }, set, calls };
}

// ---- The start check -----------------------------------------------------------------------------

const WINDOWS_11: WindowsSystem = { platform: "win32", arch: "x64", release: "10.0.26200", product: "Windows 10 Pro" };
const MACHINE: Machine = {
	revision: 9711,
	profile: String.raw`C:\Users\Ana`,
	personal: [String.raw`C:\Users\Ana\Documents`, String.raw`C:\Users\Ana\Desktop`],
	environment: { SystemRoot: String.raw`C:\Windows`, ProgramFiles: String.raw`C:\Program Files`, ProgramData: String.raw`C:\ProgramData`, USERPROFILE: String.raw`C:\Users\Ana`, PATH: String.raw`C:\Windows\System32`, EXXPERTS_TOKEN: "secret-token" },
	pathFolders: [String.raw`C:\Windows\System32`],
	programs: { folder: String.raw`C:\Users\Ana\AppData\Local\Programs`, names: [] },
};
const BOX_ROOT = path.join(work, BOX_ROOT_NAME);

function check(worker: { file: string; execArgv: string[] }, more: { system?: WindowsSystem; machine?: () => Promise<Machine>; root?: string } = {}): Promise<StartAnswer> {
	return runStartCheck({ system: more.system ?? WINDOWS_11, readMachine: more.machine ?? (async () => MACHINE), worker, root: more.root ?? BOX_ROOT, requestPath });
}

await row("start check: off before the kit loads, for Windows 10, a Windows Server, an older build or revision, Arm and not Windows", async () => {
	const kit = standIn();
	const cases: [string, WindowsSystem, number | undefined][] = [
		["Windows 10", { ...WINDOWS_11, release: "10.0.19045" }, 9711],
		["Windows Server", { ...WINDOWS_11, product: "Windows Server 2025 Datacenter" }, 9711],
		["Windows 11 below the build line", { ...WINDOWS_11, release: "10.0.22631" }, 9711],
		["26200 below its revision", WINDOWS_11, 9000],
		["Arm", { ...WINDOWS_11, arch: "arm64" }, 9711],
		["a Mac", { ...WINDOWS_11, platform: "darwin" }, 9711],
	];
	for (const [label, system, revision] of cases) {
		const answer = await check(kit.worker, { system, machine: async () => ({ ...MACHINE, revision }) });
		assert(answer.state === "off", `${label}: ${show(answer)}`);
	}
	assert(kit.calls().length === 0, `the kit was asked: ${show(kit.calls())}`);
	// Allowed neighbours: 26100 at any revision, 26200 at its revision, and a revision Windows didn't give.
	for (const [system, revision] of [[{ ...WINDOWS_11, release: "10.0.26100" }, 1], [WINDOWS_11, 9278], [WINDOWS_11, undefined]] as const) {
		const answer = await check(kit.worker, { system, machine: async () => ({ ...MACHINE, revision }) });
		assert(answer.state === "on", `${system.release}.${revision}: ${show(answer)}`);
	}
});

await row("start check: broken when the person's folders can't be read, the kit isn't the pinned one, its platform answer or its probe fails, or the box's process crashes", async () => {
	const unread = await check(standIn().worker, { machine: async () => { throw new Error("PowerShell did not answer"); } });
	assert(unread.state === "broken" && unread.reason.includes("PowerShell did not answer"), show(unread));
	const cases: [string, Omit<Config, "log">, string][] = [
		["another version", { version: "1.0.2" }, "1.0.2"],
		["another contract", { contract: "1.1.0" }, "1.1.0"],
		["a library that won't load", { platform: "throws" }, "did not load"],
		["a platform the kit doesn't support", { platform: "unsupported" }, "not supported here"],
		["no process container", { platform: "no-container" }, "no process container"],
		["a probe that throws", { probe: "throws" }, "native probe failed"],
		["a probe with an error", { probe: "error" }, "detection failed"],
		["a weaker tier", { probe: "appcontainer" }, "appcontainer-dacl"],
		["folder permissions changed", { probe: "dacl" }, "folder permissions"],
		["no denied paths", { probe: "no-deny" }, "baseContainerSupportsDenyPaths"],
		["a crash in the kit", { crash: "check" }, "ended"],
	];
	for (const [label, settings, says] of cases) {
		const answer = await check(standIn(settings).worker);
		assert(answer.state === "broken" && answer.reason.includes(says), `${label}: ${show(answer)}`);
	}
	const missing = await check({ file: path.join(work, "no-such-worker.mjs"), execArgv: [] });
	assert(missing.state === "broken", `a worker that isn't there: ${show(missing)}`);
});

const ready = standIn();
const answer = await check(ready.worker);
await row("start check: on, after the kit's probe of a real request: the PowerShell line, the box root's own probe room, no network and no telemetry", () => {
	assert(answer.state === "on", show(answer));
	const [probed] = ready.calls("probe");
	assert(probed?.request, `no probe: ${show(ready.calls())}`);
	const { request } = probed;
	assert(/^C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand \S+$/.test(request.command), request.command);
	assert(request.workingDirectory === requestPath(path.join(answer.box.root.path, "probe")), request.workingDirectory);
	assert(show(request.network) === show({ egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } }), show(request.network));
	assert(fs.existsSync(path.join(BOX_ROOT, "key")) && !fs.existsSync(path.join(BOX_ROOT, "probe")), "the probe made something, or the key is missing");
});
if (answer.state !== "on") process.exit(1);

// ---- The engine -------------------------------------------------------------------------------------

const roomFolder = folderAt("room");
const roomData = folderAt("room-data");

function engine(more: Partial<WindowsRoomBoxOptions> = {}, start: Promise<StartAnswer> = Promise.resolve(answer)): WindowsRoomBox {
	return new WindowsRoomBox({ roomId: "windows-smoke", conversationId: () => "c", rights: () => ({ canChangeFiles: true, skillFolders: [] }), warn: () => {}, folders: () => ({ folder: roomFolder, alsoAllowed: [] }), roomData, startAnswer: () => start, ...more });
}

/** Runs one command and gives what the tool would: its output, its exit code, or the error it ended with. */
async function exec(box: WindowsRoomBox, command: string, options: { timeout?: number; signal?: AbortSignal; onData?: (chunk: Buffer) => void } = {}) {
	let output = "";
	try {
		const { exitCode } = await box.operations().exec(command, roomFolder, { onData: (chunk) => { output += chunk.toString("utf8"); options.onData?.(chunk); }, timeout: options.timeout, signal: options.signal });
		return { output, exitCode, error: null as Error | null };
	} catch (error) {
		return { output, exitCode: null, error: error as Error };
	}
}

const userSpawns = () => ready.calls("spawn").filter((entry) => !/^(Set-Content |Remove-Item |Get-Content |& )/.test(entry.request?.environment[COMMAND_VARIABLE] ?? ""));
const PROOF_COMMANDS = 6;

/** A room's site decision that notes what reached it, and answers by `answer`. */
function siteDecision(answer: (site: SiteAsk) => SiteAnswer = () => ({ allow: false, reason: "the person said no" })) {
	const asks: SiteAsk[] = [];
	const refusals: { site: SiteAsk; reason: string }[] = [];
	return { asks, refusals, sites: { ask: async (site: SiteAsk) => { asks.push(site); return answer(site); }, refused: (site: SiteAsk, reason: string) => refusals.push({ site, reason }) } };
}

// Before any other engine row: the proof runs once per server.
await row("proof: a box that doesn't hold stops the first command with the fault line, and nothing of the command runs", async () => {
	ready.set({ box: "leaks" });
	const box = engine();
	const result = await exec(box, "Write-Output never");
	assert(result.error instanceof BoxFault && result.error.message === BOX_FAULT_SENTENCE, show(result));
	assert(/a read outside/.test((result.error as BoxFault).detail) && /a write outside/.test((result.error as BoxFault).detail) && /a direct connection/.test((result.error as BoxFault).detail), (result.error as BoxFault).detail);
	assert(ready.calls("spawn").length === PROOF_COMMANDS && userSpawns().length === 0, show(ready.calls("spawn").map((entry) => entry.request?.environment[COMMAND_VARIABLE])));
	await box.endTurn();
});

await row("proof: each network check fails alone: a direct connection that gets out, a site through the proxy that reaches its listener, and one the proxy never saw", async () => {
	ready.set({ box: "holds" });
	const cases: [string, string][] = [["direct-open", "a direct connection"], ["through-leaks", "a site the room refuses"], ["proxy-ignored", "a site the room refuses"]];
	for (const [net, failed] of cases) {
		ready.set({ net });
		const box = engine();
		const result = await exec(box, "Write-Output never");
		assert(result.error instanceof BoxFault && result.error.detail === `the box did not hold: ${failed}`, `${net}: ${show(result.error instanceof BoxFault ? result.error.detail : result)}`);
		await box.endTurn();
	}
	assert(userSpawns().length === 0, "a command ran");
	ready.set({ net: "holds" });
});

await row("proof: the next turn runs it again; once it holds, the command runs, its refused site reaches no one, and later turns don't run it again", async () => {
	ready.set({ box: "holds" });
	const decision = siteDecision();
	const box = engine({ sites: decision.sites });
	const before = ready.calls("spawn").length;
	const result = await exec(box, "Write-Output ran");
	assert(result.error === null && result.output === "ran\n" && result.exitCode === 0, show(result));
	assert(ready.calls("spawn").length === before + PROOF_COMMANDS + 1 && userSpawns().length === 1, `${ready.calls("spawn").length - before} spawns`);
	assert(decision.asks.length === 0 && decision.refusals.length === 0, show(decision));
	await box.endTurn();
	const later = engine();
	assert((await exec(later, "Write-Output again")).output === "again\n", "the next turn");
	assert(ready.calls("spawn").length === before + PROOF_COMMANDS + 2, "the proof ran again");
	await later.endTurn();
});

/** Whether something listens on the port of 127.0.0.1. */
const listening = (port: number) => new Promise<boolean>((resolve) => {
	const socket = net.connect({ host: "127.0.0.1", port }, () => {
		socket.destroy();
		resolve(true);
	});
	socket.on("error", () => resolve(false));
});
const proxyOf = (request: WindowsBoxRequest) => (request.network as { runtimeConfig?: { networkProxy: string } }).runtimeConfig?.networkProxy ?? "";

await row("sites: every command's request names the turn's proxy on 127.0.0.1, a fresh port each turn, closed at the turn's end", async () => {
	const ports: number[] = [];
	for (const turn of [1, 2]) {
		const box = engine();
		await exec(box, `Write-Output turn-${turn}`);
		await exec(box, "Write-Output again");
		const [first, second] = userSpawns().slice(-2).map((entry) => entry.request!);
		const proxy = proxyOf(first);
		assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(proxy) && proxyOf(second) === proxy, show([first.network, second.network]));
		assert(show(first.network) === show({ egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" }, runtimeConfig: { networkProxy: proxy } }), show(first.network));
		assert(first.environment.HTTP_PROXY === proxy && first.environment.https_proxy === proxy && first.environment.NODE_USE_ENV_PROXY === "1", show(first.environment));
		const port = Number(new URL(proxy).port);
		assert(await listening(port), "the proxy is not listening during the turn");
		await box.endTurn();
		assert(!(await listening(port)), "the proxy's port is still open after the turn's end");
		ports.push(port);
	}
	assert(ports[0] !== ports[1], `the same port twice: ${ports}`);
});

await row("sites: a command's site goes to the room's decision; a no reaches nothing, a yes goes on past it, and every refusal reaches the room with its reason", async () => {
	const decision = siteDecision((site) => (site.host === "allowed.invalid" ? { allow: true } : { allow: false, reason: "the person said no" }));
	const box = engine({ sites: decision.sites });
	const declined = await exec(box, "& \"$env:SystemRoot\\System32\\curl.exe\" -sS 'http://declined.example/'");
	assert(declined.output.startsWith(EMPTY_REPLY) && declined.exitCode === 1, show(declined));
	// Past the yes the proxy looks the name up on this computer; what it answers is the proxy smoke's to check, with a stand-in.
	const allowed = await exec(box, "& \"$env:SystemRoot\\System32\\curl.exe\" -sS 'http://allowed.invalid:8080/'");
	assert(!allowed.output.includes("the person said no"), show(allowed));
	const local = await exec(box, "& \"$env:SystemRoot\\System32\\curl.exe\" -sS 'http://localhost:9/'");
	assert(local.output.startsWith(EMPTY_REPLY), show(local));
	assert(show(decision.asks) === show([{ host: "declined.example", port: 80 }, { host: "allowed.invalid", port: 8080 }]), show(decision.asks));
	const refusals = decision.refusals.map(({ site, reason }) => [site.host, reason]).filter(([host]) => host !== "allowed.invalid");
	assert(show(refusals) === show([["declined.example", "the person said no"], ["localhost", LOCAL_REFUSAL]]), show(decision.refusals));
	assert(decision.refusals.every(({ site, reason }) => site.host !== "allowed.invalid" || reason !== "the person said no"), show(decision.refusals));
	await box.endTurn();
});

await row("sites: with no site decision given, every site is refused and nothing is asked", async () => {
	const box = engine();
	const result = await exec(box, "& \"$env:SystemRoot\\System32\\curl.exe\" -sS 'http://allowed.example/'");
	assert(result.output.startsWith(EMPTY_REPLY) && result.exitCode === 1, show(result));
	await box.endTurn();
});

await row("commands: output streams back by command id, and the exit code reaches the caller", async () => {
	const box = engine();
	const chunks: Record<string, string[]> = { a: [], b: [] };
	const [a, b] = await Promise.all([
		exec(box, "Write-Output a1\nStart-Sleep -Milliseconds 200\nWrite-Output a2", { onData: (chunk) => chunks.a.push(chunk.toString()) }),
		exec(box, "Write-Output b1\nStart-Sleep -Milliseconds 100\nWrite-Output b2\nexit 3", { onData: (chunk) => chunks.b.push(chunk.toString()) }),
	]);
	assert(a.output === "a1\na2\n" && a.exitCode === 0 && chunks.a.length === 2, show({ a, chunks }));
	assert(b.output === "b1\nb2\n" && b.exitCode === 3, show(b));
	const failed = await exec(box, "Write-Error nope");
	assert(failed.exitCode === 1 && failed.output === "nope\n", show(failed));
	await box.endTurn();
});

await row("commands: Stop kills the command and ends with aborted; the time limit ends it with timeout:<seconds>", async () => {
	const box = engine();
	const stop = new AbortController();
	const started = Date.now();
	const stopped = exec(box, "Write-Output started\nStart-Sleep -Seconds 60\nWrite-Output late", { signal: stop.signal, onData: () => stop.abort() });
	const result = await stopped;
	assert(result.error?.message === "aborted" && result.output === "started\n" && Date.now() - started < 10_000, show(result));
	assert(ready.calls("kill").length === 1, "no kill reached the kit");
	const timed = await exec(box, "Start-Sleep -Seconds 60", { timeout: 1 });
	assert(timed.error?.message === "timeout:1", show(timed));
	const kills = ready.calls("kill").length;
	assert((await exec(box, "Write-Output fine", { timeout: 5 })).output === "fine\n", "a command inside its limit");
	assert(ready.calls("kill").length === kills, "a finished command was killed");
	await box.endTurn();
});

await row("refusals: the refusal line follows once after a command that prints Windows' denial, failed or not, in Windows' wording, a script runtime's or PowerShell's error record in another language, and split across two chunks, and after one that fails or times out with no output; a command that worked, one that fails or times out saying why in other words, and one Stop ended get none", async () => {
	let asks = false;
	const box = engine({ asks: () => asks });
	const line = (offered: boolean) => `\n${boxRefusedLine(offered)}\n`;
	const worked = await exec(box, "Write-Output fine");
	assert(worked.output === "fine\n" && worked.exitCode === 0, show(worked));
	// A failure that says what went wrong in its own words is no refusal: Python's missing module, as a person met it.
	const ownWords = await exec(box, "Write-Error \"ModuleNotFoundError: No module named 'pptx'\"");
	assert(ownWords.output === "ModuleNotFoundError: No module named 'pptx'\n" && ownWords.exitCode === 1, show(ownWords));
	const before = await exec(box, "Write-Output before\nexit 3");
	assert(before.output === "before\n" && before.exitCode === 3, show(before));
	// One that fails with nothing to say may have been refused.
	const silent = await exec(box, "exit 3");
	assert(silent.output === line(false) && silent.exitCode === 3, show(silent));
	const deniedFailed = await exec(box, "Write-Error 'Set-Content : Access is denied'");
	assert(deniedFailed.exitCode === 1 && deniedFailed.output === `Set-Content : Access is denied\n${line(false)}`, show(deniedFailed));
	// The same refusal in a script runtime's words: Python's and git's, and Node's.
	for (const words of ["PermissionError: [Errno 13] Permission denied: 'C:\\Data\\x.txt'", "Error: EPERM: operation not permitted, open 'C:\\Data\\x.txt'"]) {
		const runtime = await exec(box, `Write-Error "${words}"`);
		assert(runtime.exitCode === 1 && runtime.output === `${words}\n${line(false)}`, show(runtime));
	}
	// On a PC in another language PowerShell's message is translated; its error record's category and the exception's type name are not.
	const german = "Get-Content : Der Zugriff auf den Pfad C:\\Data\\x.txt wurde verweigert.";
	for (const category of ["    + CategoryInfo          : PermissionDenied: (C:\\Data\\x.txt:String) [Get-Content], UnauthorizedAccessException", "    + CategoryInfo          : ZugriffVerweigert: (C:\\Data\\x.txt:String) [Get-Content], UnauthorizedAccessException"]) {
		const translated = await exec(box, `Write-Error "${german}"\nWrite-Error "${category}"`);
		assert(translated.exitCode === 1 && translated.output === `${german}\n${category}\n${line(false)}`, show(translated));
	}
	const chunks: string[] = [];
	const split = await exec(box, "Write-Host -NoNewline 'Get-Content : Access is'\nStart-Sleep -Milliseconds 100\nWrite-Host ' denied'", { onData: (chunk) => chunks.push(chunk.toString()) });
	assert(split.exitCode === 0 && split.output === `Get-Content : Access is denied\n${line(false)}` && chunks[0] === "Get-Content : Access is", show({ split, chunks }));
	// PowerShell's own file error names the path between its words, and the statement after it decides the exit code.
	const outside = requestPath(path.join(work, "outside.txt"));
	const pathForm = await exec(box, `Get-Content -LiteralPath '${outside}'\nWrite-Output ok`);
	// Its error and its output arrive on two streams, in either order.
	assert(pathForm.exitCode === 0 && pathForm.output.includes(`Access to the path '${outside}' is denied.\n`) && pathForm.output.includes("ok\n") && pathForm.output.endsWith(line(false)) && pathForm.output.split(boxRefusedLine(false)).length === 2, show(pathForm));
	const splitPath = await exec(box, `Write-Host -NoNewline "Get-Content : Access to the path '${outside}"\nStart-Sleep -Milliseconds 100\nWrite-Host "' is denied."`);
	assert(splitPath.exitCode === 0 && splitPath.output === `Get-Content : Access to the path '${outside}' is denied.\n${line(false)}`, show(splitPath));
	// The allowed neighbour: the same words apart are no refusal.
	const apart = await exec(box, "Write-Output Access\nWrite-Output is denied");
	assert(apart.output === "Access\nis denied\n", show(apart));
	asks = true;
	const timed = await exec(box, "Start-Sleep -Seconds 60", { timeout: 1 });
	assert(timed.error?.message === "timeout:1" && timed.output === line(true), show(timed));
	const timedSaying = await exec(box, "Write-Output started\nStart-Sleep -Seconds 60", { timeout: 1 });
	assert(timedSaying.error?.message === "timeout:1" && timedSaying.output === "started\n", show(timedSaying));
	const stop = new AbortController();
	const stopped = await exec(box, "Write-Output started\nStart-Sleep -Seconds 60\nexit 1", { signal: stop.signal, onData: () => stop.abort() });
	assert(stopped.error?.message === "aborted" && stopped.output === "started\n", show(stopped));
	await box.endTurn();
});

await row("spills: a command's long output lands in the turn's temp, which no file tool reads, and goes with the turn", async () => {
	const box = engine();
	const temp = await box.privateTemp();
	await exec(box, "Write-Output one");
	assert(temp === nativePath(userSpawns().at(-1)!.request!.environment.TEMP) && fs.existsSync(temp), `${temp}: ${show(userSpawns().at(-1)!.request!.environment.TEMP)}`);
	assert(box.readsSpills() === false, "the file tools read a long output");
	await box.endTurn();
	assert(!fs.existsSync(temp), "the temp outlived its turn");
});

/** A start answer that comes only after `ms`, as on a slow PC. */
const slowStart = (ms: number, given: StartAnswer = answer) => new Promise<StartAnswer>((resolve) => setTimeout(() => resolve(given), ms));
const turnTemps = () => fs.readdirSync(answer.box.root.path, { recursive: true, withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("temp-"));

await row("commands: Stop while the box is starting ends the command with aborted at once, also when the start then fails, and nothing of it runs", async () => {
	const spawned = userSpawns().length;
	for (const given of [answer, { state: "broken", reason: "the kit's probe failed" } as StartAnswer]) {
		const box = engine({}, slowStart(3_000, given));
		const stop = new AbortController();
		const started = Date.now();
		const pending = exec(box, "Write-Output never", { signal: stop.signal });
		setTimeout(() => stop.abort(), 100);
		const result = await pending;
		assert(result.error?.message === "aborted" && Date.now() - started < 1_000, `${given.state}: ${show(result)} after ${Date.now() - started} ms`);
		await box.endTurn();
	}
	assert(userSpawns().length === spawned, "a stopped command ran");
	// The allowed neighbour: a command not stopped runs after the same slow start.
	const box = engine({}, slowStart(300));
	assert((await exec(box, "Write-Output waited")).output === "waited\n", "a command after a slow start");
	await box.endTurn();
});

await row("commands: a turn that ends while its box is starting runs none of its waiting commands, and leaves no box process or temp", async () => {
	const spawned = userSpawns().length;
	const box = engine({}, slowStart(500));
	const pending = exec(box, "Write-Output after-the-end");
	await box.endTurn();
	const result = await pending;
	assert(result.error?.message === "aborted" && userSpawns().length === spawned, show(result));
	assert(turnTemps().length === 0, `a temp is left: ${turnTemps().map((entry) => entry.name)}`);
	// The room's next turn starts its own box.
	const next = engine();
	assert((await exec(next, "Write-Output next")).output === "next\n", "the next turn");
	await next.endTurn();
});

await row("places: the turn's end removes a large temp without stalling the server", async () => {
	const box = engine();
	await exec(box, "Write-Output one");
	const temp = nativePath(userSpawns().at(-1)!.request!.environment.TEMP);
	for (let folder = 0; folder < 100; folder++) {
		fs.mkdirSync(path.join(temp, `unpacked-${folder}`));
		for (let file = 0; file < 100; file++) fs.writeFileSync(path.join(temp, `unpacked-${folder}`, `${file}.txt`), "x");
	}
	let last = Date.now();
	let longest = 0;
	const ticker = setInterval(() => {
		longest = Math.max(longest, Date.now() - last);
		last = Date.now();
	}, 5);
	const started = Date.now();
	await box.endTurn();
	clearInterval(ticker);
	// The gap up to now counts too: a stall at the very end leaves no tick after it.
	longest = Math.max(longest, Date.now() - last);
	assert(!fs.existsSync(temp), "the temp is still there");
	assert(longest < 100, `the server stalled ${longest} ms in a ${Date.now() - started} ms turn end`);
});

await row("commands: the box's process crashing mid-command ends it with the fault line, and the next command starts a new one", async () => {
	const crashing = standIn({ crash: "run" });
	const box = engine({}, Promise.resolve({ ...answer, box: { ...answer.box, worker: crashing.worker } }));
	const result = await exec(box, "Write-Output never");
	assert(result.error instanceof BoxFault && result.output === "", show(result));
	crashing.set({ crash: undefined });
	assert((await exec(box, "Write-Output back")).output === "back\n", "the next command");
	await box.endTurn();
});

await row("commands: a turn that ends while a crashed box process's replacement is starting ends the replacement too, and leaves no temp", async () => {
	const crashing = standIn({ crash: "run" });
	const box = engine({}, Promise.resolve({ ...answer, box: { ...answer.box, worker: crashing.worker } }));
	assert((await exec(box, "Write-Output never")).error instanceof BoxFault, "the crash");
	crashing.set({ crash: undefined });
	const pending = exec(box, "Write-Output after-the-end");
	await box.endTurn();
	assert((await pending).error?.message === "aborted", "the waiting command");
	assert(turnTemps().length === 0, `a temp is left: ${turnTemps().map((entry) => entry.name)}`);
});

await row("places: the turn's temp and the room's caches sit in the one box folder, named by a key, and the temp goes at the turn's end", async () => {
	const box = engine();
	await exec(box, "Write-Output one");
	const request = userSpawns().at(-1)!.request!;
	const temp = nativePath(request.environment.TEMP);
	const caches = path.join(path.dirname(temp), "caches");
	assert(path.dirname(path.dirname(temp)) === answer.box.root.path && /^[0-9a-f]{32}$/.test(path.basename(path.dirname(temp))) && /^temp-[0-9a-f]{16}$/.test(path.basename(temp)), temp);
	assert(request.environment.TMP === request.environment.TEMP && nativePath(request.environment.LOCALAPPDATA).startsWith(`${caches}/`) && nativePath(request.environment.npm_config_cache).startsWith(`${caches}/`), show(request.environment));
	assert(request.filesystem.readwritePaths.includes(requestPath(temp)) && request.filesystem.readwritePaths.includes(requestPath(caches)), show(request.filesystem));
	assert(fs.existsSync(temp) && JSON.parse(fs.readFileSync(path.join(path.dirname(temp), "owner.json"), "utf8")).room === roomData, "the room's folder");
	assert(!JSON.stringify(request).includes(JSON.stringify(requestPath(roomData)).slice(1, -1)) && !JSON.stringify(request).includes("windows-smoke"), "the request names the room's data");
	await box.endTurn();
	assert(!fs.existsSync(temp) && fs.existsSync(caches), "the temp is still there, or the caches went");
});

/** Runs `body` with these variables set, or removed where undefined, and puts them back after. */
function withEnv<T>(values: Record<string, string | undefined>, body: () => T): T {
	const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	const put = (all: Record<string, string | undefined>) => {
		for (const [name, value] of Object.entries(all)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
	put(values);
	try {
		return body();
	} finally {
		put(before);
	}
}

// The data's home moved into OneDrive in the login home, as Settings suggests.
const loginHome = folderAt("login");
const oneDrive = folderAt(path.join("login", "OneDrive"));
const movedHome = folderAt(path.join("login", "OneDrive", "exxperts"));
const inLogin = path.join(loginHome, ".exxperts.box");
const moved = { EXXPERTS_LOGIN_HOME: loginHome, EXXPERTS_REAL_HOME: movedHome };

await row("box root: with the data's home moved, in the login home; with no moved home, where it was; a start that names no login home keeps it in its own home, never the account's", () => {
	const answered = withEnv(moved, defaultBoxRoot);
	assert(answered === inLogin, `a moved home: ${answered}`);
	assert(withEnv({ EXXPERTS_LOGIN_HOME: loginHome, EXXPERTS_REAL_HOME: loginHome }, defaultBoxRoot) === inLogin, "no moved home");
	// The desktop's scratch runs name only the data's home; a smoke's server often only its own HOME.
	const scratch = folderAt("scratch");
	assert(withEnv({ EXXPERTS_LOGIN_HOME: undefined, EXXPERTS_REAL_HOME: scratch }, defaultBoxRoot) === path.join(scratch, ".exxperts.box"), "a scratch home");
	const testHome = folderAt("test-home");
	assert(withEnv({ EXXPERTS_LOGIN_HOME: undefined, EXXPERTS_REAL_HOME: undefined, HOME: testHome, USERPROFILE: testHome }, defaultBoxRoot) === path.join(testHome, ".exxperts.box"), "a test's own home");
});

await row("box root: with a data profile active, also in a moved home, in the login home", () => {
	const profileHome = folderAt(path.join("login", "OneDrive", "exxperts", ".exxperts-work"));
	const profile = { EXXPERTS_STATE_HOME: profileHome, EXXPERTS_CODING_AGENT_DIR: path.join(profileHome, ".exxperts", "agent"), HOME: profileHome, USERPROFILE: profileHome };
	assert(withEnv({ ...moved, ...profile }, defaultBoxRoot) === inLogin, "a profile in a moved home");
	assert(withEnv({ EXXPERTS_LOGIN_HOME: loginHome, EXXPERTS_REAL_HOME: loginHome, ...profile }, defaultBoxRoot) === inLogin, "a profile in the login home");
});

await row("requests: with the data's home moved into OneDrive, no place a command writes, reads or lists is in that home or above it inside the login home, and OneDrive stays shut", async () => {
	const kit = standIn();
	const machine: Machine = {
		...MACHINE,
		profile: requestPath(loginHome),
		personal: [requestPath(path.join(loginHome, "Documents")), requestPath(oneDrive)],
		environment: { ...MACHINE.environment, USERPROFILE: requestPath(loginHome) },
	};
	const started = await check(kit.worker, { machine: async () => machine, root: withEnv(moved, defaultBoxRoot) });
	assert(started.state === "on", show(started));
	const box = engine({}, Promise.resolve(started));
	await exec(box, "Write-Output one");
	const { filesystem, containment } = kit.calls("spawn").at(-1)!.request!;
	const reached = [...filesystem.readwritePaths, ...filesystem.readonlyPaths, ...containment.config.filesystem.enumeratePaths];
	// The login home itself holds the box root, so it is listed, as with no move.
	const near = reached.filter((place) => atOrInside(place, requestPath(movedHome)) || (atOrInside(requestPath(movedHome), place) && atOrInside(place, requestPath(loginHome)) && !atOrInside(requestPath(loginHome), place)));
	assert(near.length === 0, show(near));
	assert(filesystem.deniedPaths.includes(requestPath(oneDrive)), show(filesystem.deniedPaths));
	await box.endTurn();
});

await row("places: the person's git name and e-mail, from the settings in the home a command's USERPROFILE names, sit in the box root's git folder, named in GIT_CONFIG_GLOBAL and only read; a link at the folder leaves them out of that turn, the command still runs, and the log gets a reason with no path", async () => {
	const profile = folderAt("git-profile");
	fs.writeFileSync(path.join(profile, ".gitconfig"), "[user]\n\tname = Ana Lopez\n\temail = ana@example.com\n[http]\n\textraheader = AUTHORIZATION: bearer TOKEN-ONE\n");
	const machine = { ...answer.box.machine, environment: { ...answer.box.machine.environment, USERPROFILE: profile } };
	const start = Promise.resolve({ ...answer, box: { ...answer.box, machine } });
	const git = path.join(answer.box.root.path, "git");
	const file = path.join(git, "config");
	const box = engine({}, start);
	assert((await exec(box, "Write-Output one")).exitCode === 0, "the command");
	const request = userSpawns().at(-1)!.request!;
	assert(request.environment.GIT_CONFIG_GLOBAL === requestPath(file) && fs.readFileSync(file, "utf8") === '[user]\n\tname = "Ana Lopez"\n\temail = "ana@example.com"\n', show({ GIT_CONFIG_GLOBAL: request.environment.GIT_CONFIG_GLOBAL }));
	assert(request.filesystem.readonlyPaths.includes(requestPath(git)) && !request.filesystem.readwritePaths.some((place) => requestPath(file).startsWith(place)) && !show(request).includes("TOKEN"), show(request.filesystem));
	await box.endTurn();
	// Another home, as on another computer's stand-in: no settings, no file named, no grant.
	const plain = engine();
	await exec(plain, "Write-Output two");
	assert(userSpawns().at(-1)!.request!.environment.GIT_CONFIG_GLOBAL === undefined && !show(userSpawns().at(-1)!.request!.filesystem).includes(JSON.stringify(requestPath(git)).slice(1, -1)), "a home without settings");
	await plain.endTurn();
	const elsewhere = folderAt("git-elsewhere");
	fs.rmSync(git, { recursive: true });
	fs.symlinkSync(elsewhere, git);
	const warned: { detail: Record<string, unknown>; message: string }[] = [];
	try {
		const linked = engine({ warn: (detail, message) => warned.push({ detail, message }) }, start);
		const ran = await exec(linked, "Write-Output three");
		const sent = userSpawns().at(-1)!.request!;
		assert(ran.exitCode === 0 && sent.environment.GIT_CONFIG_GLOBAL === undefined && !show(sent.filesystem).includes(JSON.stringify(requestPath(git)).slice(1, -1)), show({ ran, env: sent.environment.GIT_CONFIG_GLOBAL }));
		assert(fs.readdirSync(elsewhere).length === 0 && fs.lstatSync(git).isSymbolicLink(), "something was written through the link, or it went");
		assert(warned.length === 1 && show(warned[0].detail) === show({ why: "git's settings folder in the box root is a link" }) && !show(warned).includes(work), `the log: ${show(warned)}`);
		await linked.endTurn();
	} finally {
		fs.rmSync(git);
	}
});

await row("places: curl's settings sit in the box root, named in CURL_HOME and only read; _curlrc holds its one line, written again when missing or different; any other failure runs the command without them and logs its code; a link at the folder or the file leaves them out of that turn, even after a good one, and is never followed or removed", async () => {
	const curl = path.join(answer.box.root.path, "curl");
	const settings = path.join(curl, "_curlrc");
	const LINE = "ssl-revoke-best-effort\n";
	const box = engine();
	await exec(box, "Write-Output one");
	const request = userSpawns().at(-1)!.request!;
	assert(request.environment.CURL_HOME === requestPath(curl) && fs.readFileSync(settings, "utf8") === LINE, show({ CURL_HOME: request.environment.CURL_HOME }));
	assert(request.filesystem.readonlyPaths.includes(requestPath(curl)) && !request.filesystem.readwritePaths.some((place) => requestPath(curl).startsWith(place)), show(request.filesystem));
	await box.endTurn();
	// Missing, then changed: the next turn writes it again, and leaves nothing aside.
	for (const spoil of [() => fs.rmSync(settings), () => fs.writeFileSync(settings, "proxy = http://elsewhere.example\n")]) {
		spoil();
		const next = engine();
		assert((await exec(next, "Write-Output again")).exitCode === 0, "the command after the settings were spoiled");
		assert(fs.readFileSync(settings, "utf8") === LINE && fs.readdirSync(curl).join() === "_curlrc", `the settings: ${fs.readdirSync(curl)}`);
		await next.endTurn();
	}
	// Any other failure, here a folder where the file belongs: the command runs without CURL_HOME or its grant, the log gets the reason with no path, and the next turn writes it.
	fs.rmSync(settings);
	fs.mkdirSync(settings);
	const warned: { detail: Record<string, unknown>; message: string }[] = [];
	try {
		const unwritten = engine({ warn: (detail, message) => warned.push({ detail, message }) });
		const ran = await exec(unwritten, "Write-Output without");
		const without = userSpawns().at(-1)!.request!;
		assert(ran.exitCode === 0 && ran.output === "without\n" && without.environment.CURL_HOME === undefined && !without.filesystem.readonlyPaths.includes(requestPath(curl)), show({ ran, env: without.environment.CURL_HOME, readonly: without.filesystem.readonlyPaths }));
		assert(warned.length === 1 && show(warned[0].detail) === show({ why: "curl's settings in the box root are not a file" }) && !show(warned).includes(work), `the log: ${show(warned)}`);
		await unwritten.endTurn();
	} finally {
		fs.rmSync(settings, { recursive: true });
	}
	const again = engine();
	assert((await exec(again, "Write-Output again")).exitCode === 0 && fs.readFileSync(settings, "utf8") === LINE && userSpawns().at(-1)!.request!.environment.CURL_HOME === requestPath(curl), "the next turn didn't write the settings again");
	await again.endTurn();
	// A link in place of the file, then of the folder, after a good turn of the same room: that turn runs its command without CURL_HOME or its grant, logs once with no path, and what the link leads to is left as it was.
	const elsewhere = folderAt("curl-elsewhere");
	const target = path.join(elsewhere, "_curlrc");
	fs.writeFileSync(target, "kept\n");
	const links: [string, string, () => void][] = [
		["the file", settings, () => { fs.rmSync(settings); fs.symlinkSync(target, settings); }],
		["the folder", curl, () => { fs.rmSync(curl, { recursive: true }); fs.symlinkSync(elsewhere, curl); }],
	];
	for (const [what, at, link] of links) {
		const linkWarned: { detail: Record<string, unknown>; message: string }[] = [];
		const room = engine({ warn: (detail, message) => linkWarned.push({ detail, message }) });
		// As the request's JSON spells a Windows path.
		const named = (request: unknown, place: string) => show(request).includes(JSON.stringify(requestPath(place)).slice(1, -1));
		assert((await exec(room, "Write-Output good")).exitCode === 0 && userSpawns().at(-1)!.request!.environment.CURL_HOME === requestPath(curl) && named(userSpawns().at(-1)!.request, curl), `the good turn before a link at ${what}`);
		await room.endTurn();
		link();
		const linked = await exec(room, "Write-Output linked");
		const sent = userSpawns().at(-1)!.request!;
		assert(linked.exitCode === 0 && linked.output === "linked\n" && sent.environment.CURL_HOME === undefined && !named(sent, curl) && !named(sent, elsewhere), `a link at ${what}: ${show({ linked, env: sent.environment.CURL_HOME, readonly: sent.filesystem.readonlyPaths })}`);
		assert(fs.readFileSync(target, "utf8") === "kept\n" && fs.readdirSync(elsewhere).join() === "_curlrc", `what a link at ${what} leads to: ${fs.readdirSync(elsewhere)}`);
		assert(linkWarned.length === 1 && /^curl's settings .* a link$/.test(String(linkWarned[0].detail.why)) && !show(linkWarned).includes(work), `the log for a link at ${what}: ${show(linkWarned)}`);
		await room.endTurn();
		assert(fs.lstatSync(at).isSymbolicLink(), `the link at ${what} was removed`);
		fs.rmSync(at);
	}
	const mended = engine();
	assert((await exec(mended, "Write-Output mended")).exitCode === 0 && fs.readFileSync(settings, "utf8") === LINE, "the settings once the link was gone");
	await mended.endTurn();
});

// ---- The box's own places never follow a link -------------------------------------------------------

/** Whether anything is at `place`, a dangling link included. */
const there = (place: string) => {
	try {
		fs.lstatSync(place);
		return true;
	} catch {
		return false;
	}
};
/** Whether a request names `place`, as its JSON spells a Windows path. */
const names = (request: unknown, place: string) => show(request).includes(JSON.stringify(requestPath(place)).slice(1, -1));
/** A warn that keeps what it was given. */
function warnings() {
	const lines: { detail: Record<string, unknown>; message: string }[] = [];
	return { lines, warn: (detail: Record<string, unknown>, message: string) => lines.push({ detail, message }) };
}
/** A new room's own folder in the box root, made by one answer that ran a command. */
async function placeOf(data: string): Promise<string> {
	const box = engine({ roomData: data });
	assert((await exec(box, "Write-Output made")).exitCode === 0, "the answer that makes the room's folder");
	const place = path.dirname(nativePath(userSpawns().at(-1)!.request!.environment.TEMP));
	await box.endTurn();
	return place;
}
/** Runs one command in a new answer of the room and asserts it never reached the box's process. */
async function refused(data: string, what: string, warn: (detail: Record<string, unknown>, message: string) => void = () => {}): Promise<void> {
	const box = engine({ roomData: data, warn });
	const spawned = userSpawns().length;
	const result = await exec(box, "Write-Output never");
	assert(result.error instanceof BoxFault && result.error.message === BOX_FAULT_SENTENCE && userSpawns().length === spawned, `${what}: ${show({ result, detail: (result.error as BoxFault | null)?.detail })}`);
	await box.endTurn();
}

await row("places: a link, a dangling link or a file at the box root reads broken, with no path in its reason, and nothing is written where a link leads", async () => {
	const target = folderAt("root-elsewhere");
	const nowhere = path.join(work, "root-nowhere");
	const cases: [string, (root: string) => void][] = [
		["a link", (root) => fs.symlinkSync(target, root)],
		["a dangling link", (root) => fs.symlinkSync(nowhere, root)],
		["a file", (root) => fs.writeFileSync(root, "")],
	];
	for (const [what, put] of cases) {
		const root = path.join(folderAt(`home-${what.replaceAll(" ", "-")}`), BOX_ROOT_NAME);
		put(root);
		const answer = await check(ready.worker, { root });
		assert(answer.state === "broken" && !answer.reason.includes(work), `${what} at the box root: ${show(answer)}`);
		assert(fs.readdirSync(target).length === 0 && !there(nowhere), `${what} at the box root: written where it leads: ${fs.readdirSync(target)}`);
		assert(fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(root).isFile(), `${what} at the box root was removed`);
	}
});

await row("places: a link at the box root's key reads broken, with no path in its reason", async () => {
	const root = path.join(folderAt("home-key"), BOX_ROOT_NAME);
	fs.mkdirSync(root);
	const elsewhere = path.join(work, "key-elsewhere");
	fs.writeFileSync(elsewhere, Buffer.alloc(32, 7));
	fs.symlinkSync(elsewhere, path.join(root, "key"));
	const answer = await check(ready.worker, { root });
	assert(answer.state === "broken" && !answer.reason.includes(work), show(answer));
	assert(fs.readFileSync(elsewhere).equals(Buffer.alloc(32, 7)) && fs.readdirSync(root).join() === "key", `the box root: ${fs.readdirSync(root)}`);
});

await row("places: a login home reached through a link reads on, with the box root at the home's real path", async () => {
	const realHome = folderAt("home-real");
	const linkedHome = path.join(work, "home-linked");
	fs.symlinkSync(realHome, linkedHome);
	const answer = await check(ready.worker, { root: path.join(linkedHome, BOX_ROOT_NAME) });
	assert(answer.state === "on" && answer.box.root.path === path.join(realHome, BOX_ROOT_NAME) && there(path.join(realHome, BOX_ROOT_NAME, "key")), show(answer.state === "on" ? answer.box.root.path : answer));
});

await row("places: a link at a room's own folder runs none of that answer's commands and removes nothing where it leads; the next answer runs once the link is gone", async () => {
	const data = folderAt("linked-room-data");
	const place = await placeOf(data);
	const target = folderAt("room-elsewhere");
	fs.mkdirSync(path.join(target, "temp-kept"));
	fs.writeFileSync(path.join(target, "temp-kept", "file.txt"), "kept");
	fs.rmSync(place, { recursive: true });
	fs.symlinkSync(target, place);
	const log = warnings();
	await refused(data, "a link at the room's folder", log.warn);
	assert(fs.readdirSync(target).join() === "temp-kept" && fs.readFileSync(path.join(target, "temp-kept", "file.txt"), "utf8") === "kept", `where the link leads: ${fs.readdirSync(target)}`);
	assert(log.lines.length > 0 && !show(log.lines).includes(work), `the log: ${show(log.lines)}`);
	assert(fs.lstatSync(place).isSymbolicLink(), "the link was removed");
	fs.rmSync(place);
	const next = engine({ roomData: data });
	assert((await exec(next, "Write-Output back")).output === "back\n", "the next answer once the link is gone");
	await next.endTurn();
});

await row("places: a room whose owner is a link or a folder runs none of that answer's commands, and the link's file is left as it was; the next answer writes the owner again once it is gone", async () => {
	const data = folderAt("owner-room-data");
	const place = await placeOf(data);
	const owner = path.join(place, "owner.json");
	const elsewhere = path.join(work, "owner-elsewhere.json");
	const text = JSON.stringify({ room: data });
	fs.writeFileSync(elsewhere, text);
	const cases: [string, () => void][] = [
		["a link", () => fs.symlinkSync(elsewhere, owner)],
		["a folder", () => fs.mkdirSync(owner)],
	];
	for (const [what, put] of cases) {
		fs.rmSync(owner, { recursive: true });
		put();
		await refused(data, `${what} at the room's owner`);
		assert(fs.readFileSync(elsewhere, "utf8") === text, `${what}: the link's file changed`);
	}
	fs.rmSync(owner, { recursive: true });
	const next = engine({ roomData: data });
	assert((await exec(next, "Write-Output back")).output === "back\n", "the next answer once the owner is gone");
	await next.endTurn();
	assert(fs.lstatSync(owner).isFile() && JSON.parse(fs.readFileSync(owner, "utf8")).room === data, "the owner written again");
});

await row("places: a link at a room's caches is removed as itself and a fresh folder made: the answer runs, its request names nothing the link led to, what it led to is left as it was, and the log has one line with no path", async () => {
	const data = folderAt("caches-room-data");
	const caches = path.join(await placeOf(data), "caches");
	const target = folderAt("caches-elsewhere");
	fs.writeFileSync(path.join(target, "kept.txt"), "kept");
	fs.rmSync(caches, { recursive: true });
	fs.symlinkSync(target, caches);
	const log = warnings();
	const box = engine({ roomData: data, warn: log.warn });
	const ran = await exec(box, "Write-Output healed");
	const sent = userSpawns().at(-1)!.request!;
	assert(ran.exitCode === 0 && ran.output === "healed\n", show(ran));
	assert(fs.lstatSync(caches).isDirectory() && sent.filesystem.readwritePaths.includes(requestPath(caches)) && !names(sent, target), show(sent.filesystem));
	assert(fs.readdirSync(target).join() === "kept.txt" && fs.readFileSync(path.join(target, "kept.txt"), "utf8") === "kept", `where the link led: ${fs.readdirSync(target)}`);
	assert(log.lines.length === 1 && !show(log.lines).includes(work), `the log: ${show(log.lines)}`);
	await box.endTurn();
	// Allowed neighbour: a plain caches folder is kept with what is in it, and logs nothing.
	fs.writeFileSync(path.join(caches, "cached.txt"), "cached");
	const quiet = warnings();
	const again = engine({ roomData: data, warn: quiet.warn });
	assert((await exec(again, "Write-Output again")).exitCode === 0 && fs.readFileSync(path.join(caches, "cached.txt"), "utf8") === "cached" && quiet.lines.length === 0, show(quiet.lines));
	await again.endTurn();
});

await row("places: a room's caches whose real path can't be read, as Windows gives for a junction to a volume that is gone, is replaced and the answer runs", async () => {
	const data = folderAt("unreadable-caches-room-data");
	const caches = path.join(await placeOf(data), "caches");
	// Node on Windows reads such a junction as a plain folder and fails to resolve it: here the folder is plain and its real path fails, once.
	const native = fs.realpathSync.native;
	let failed = 0;
	fs.realpathSync.native = ((place: fs.PathLike, ...more: unknown[]) => {
		if (String(place) === caches && failed === 0) {
			failed += 1;
			throw Object.assign(new Error("ENOENT: no such file or directory, realpath"), { code: "ENOENT" });
		}
		return (native as (...args: unknown[]) => string)(place, ...more);
	}) as typeof fs.realpathSync.native;
	const log = warnings();
	try {
		const box = engine({ roomData: data, warn: log.warn });
		const ran = await exec(box, "Write-Output healed");
		assert(ran.exitCode === 0 && ran.output === "healed\n" && failed === 1, show({ ran, failed }));
		await box.endTurn();
	} finally {
		fs.realpathSync.native = native;
	}
	assert(fs.lstatSync(caches).isDirectory() && log.lines.length === 1 && log.lines[0].detail.roomId === "windows-smoke" && !show(log.lines).includes(work), `the log: ${show(log.lines)}`);
});

await row("places: a box root deleted after the start check is made again at the next answer, which runs; a link there, or a root whose path runs through a link, runs none of the answer's commands and writes nothing where it leads", async () => {
	const home = folderAt("home-mid-run");
	const root = openBoxRoot(path.join(home, BOX_ROOT_NAME));
	const startWith = (rootNow: BoxRoot) => Promise.resolve({ ...answer, box: { ...answer.box, root: rootNow } } as StartAnswer);
	const data = folderAt("mid-run-room-data");
	const first = engine({ roomData: data }, startWith(root));
	assert((await exec(first, "Write-Output one")).exitCode === 0, "the first answer");
	await first.endTurn();
	fs.rmSync(root.path, { recursive: true });
	const remade = engine({ roomData: data }, startWith(root));
	assert((await exec(remade, "Write-Output remade")).output === "remade\n" && fs.lstatSync(root.path).isDirectory(), "the answer after the box root was deleted");
	await remade.endTurn();
	// A link where the root was: nothing is made where it leads.
	const target = folderAt("root-mid-run-elsewhere");
	fs.rmSync(root.path, { recursive: true });
	fs.symlinkSync(target, root.path);
	const linkLog = warnings();
	const linked = engine({ roomData: data, warn: linkLog.warn }, startWith(root));
	const spawned = userSpawns().length;
	assert((await exec(linked, "Write-Output never")).error instanceof BoxFault && userSpawns().length === spawned, "a link at the box root ran a command");
	await linked.endTurn();
	assert(fs.readdirSync(target).length === 0 && /the box root is a link/.test(show(linkLog.lines)) && !show(linkLog.lines).includes(work), `where the link leads: ${fs.readdirSync(target)}; the log: ${show(linkLog.lines)}`);
	fs.rmSync(root.path);
	// A root whose path runs through a link above it: every place in it reads plain, and only its real path tells.
	const linkedHome = path.join(work, "home-mid-run-linked");
	fs.symlinkSync(home, linkedHome);
	const throughLog = warnings();
	const through = engine({ roomData: data, warn: throughLog.warn }, startWith({ ...root, path: path.join(linkedHome, BOX_ROOT_NAME) }));
	assert((await exec(through, "Write-Output never")).error instanceof BoxFault && userSpawns().length === spawned, "a root through a link ran a command");
	await through.endTurn();
	assert(/the box root leads elsewhere/.test(show(throughLog.lines)) && !show(throughLog.lines).includes(work), `the log: ${show(throughLog.lines)}`);
});

await row("places: a room's next answer removes a linked temp and a temp with links in it, never what they lead to", async () => {
	const data = folderAt("sweep-room-data");
	const place = await placeOf(data);
	const target = folderAt("temp-elsewhere");
	fs.writeFileSync(path.join(target, "kept.txt"), "kept");
	const linked = path.join(place, "temp-linked");
	const holding = path.join(place, "temp-holding");
	fs.symlinkSync(target, linked);
	fs.mkdirSync(holding);
	fs.symlinkSync(target, path.join(holding, "folder-link"));
	fs.symlinkSync(path.join(target, "kept.txt"), path.join(holding, "file-link"));
	const next = engine({ roomData: data });
	assert((await exec(next, "Write-Output swept")).exitCode === 0, "the next answer");
	await next.endTurn();
	assert(!there(linked) && !there(holding), `the room's folder: ${fs.readdirSync(place)}`);
	assert(fs.readdirSync(target).join() === "kept.txt" && fs.readFileSync(path.join(target, "kept.txt"), "utf8") === "kept", `where they led: ${fs.readdirSync(target)}`);
});

await row("places: the start check's sweep leaves a linked room entry and what it leads to, even when the owner there names data that is gone", async () => {
	const target = folderAt("room-entry-elsewhere");
	const owner = JSON.stringify({ room: path.join(work, "no-such-room-data") });
	fs.writeFileSync(path.join(target, "owner.json"), owner);
	const entry = path.join(answer.box.root.path, "0".repeat(32));
	fs.symlinkSync(target, entry);
	assert((await check(ready.worker)).state === "on", "the check");
	assert(fs.lstatSync(entry).isSymbolicLink() && fs.readFileSync(path.join(target, "owner.json"), "utf8") === owner, `where the entry leads: ${fs.readdirSync(target)}`);
	fs.rmSync(entry);
});

await row("places: the start check's sweep leaves a room whose owner is a link or a folder, whatever the link's file says", async () => {
	const elsewhere = path.join(work, "gone-owner-elsewhere.json");
	const text = JSON.stringify({ room: path.join(work, "no-such-room-data") });
	fs.writeFileSync(elsewhere, text);
	const cases: [string, (owner: string) => void][] = [
		["a link", (owner) => fs.symlinkSync(elsewhere, owner)],
		["a folder", (owner) => fs.mkdirSync(owner)],
	];
	for (const [what, put] of cases) {
		const room = path.join(answer.box.root.path, "1".repeat(32));
		fs.mkdirSync(path.join(room, "caches"), { recursive: true });
		put(path.join(room, "owner.json"));
		assert((await check(ready.worker)).state === "on", `${what}: the check`);
		assert(there(path.join(room, "caches")) && fs.readFileSync(elsewhere, "utf8") === text, `${what} at the owner: the room's folder went`);
		fs.rmSync(room, { recursive: true });
	}
});

await row("places: a temp a cut-off turn left goes at the room's next turn; a room whose data is gone loses its folder at the next start check, and another room keeps its own", async () => {
	const box = engine();
	await exec(box, "Write-Output one");
	const left = nativePath(userSpawns().at(-1)!.request!.environment.TEMP);
	const second = engine();
	await exec(second, "Write-Output two");
	assert(!fs.existsSync(left), "the old temp is still there");
	await second.endTurn();
	await box.endTurn();
	const goneData = folderAt("gone-room-data");
	const gone = engine({ roomData: goneData });
	await exec(gone, "Write-Output three");
	const goneFolder = path.dirname(nativePath(userSpawns().at(-1)!.request!.environment.TEMP));
	assert(goneFolder !== path.dirname(left), "two rooms share a folder");
	await gone.endTurn();
	fs.rmSync(goneData, { recursive: true });
	assert((await check(ready.worker)).state === "on", "the second check");
	assert(!fs.existsSync(goneFolder) && fs.existsSync(path.dirname(left)), "the sweep");
});

await row("requests: no telemetry is asked for: spawn takes the request alone, and no request names telemetry", () => {
	const spawns = ready.calls("spawn");
	assert(spawns.length > 10 && spawns.every((entry) => Array.isArray(entry.more) && entry.more.length === 0), "spawn was given more than the request");
	assert(!/telemetry/i.test(JSON.stringify(ready.calls()).replaceAll("POWERSHELL_TELEMETRY_OPTOUT", "")), "a request names telemetry");
	for (const file of ["box-worker-windows.ts", "start-check.ts", "windows-engine.ts", "box-root.ts"]) {
		const source = fs.readFileSync(path.join(import.meta.dirname, "../src/room-box/windows", file), "utf8");
		assert(!/TelemetryConsent|telemetry\s*:/.test(source), `${file} asks for telemetry`);
	}
	const spawned = spawns.at(-1)!.request!;
	assert(!JSON.stringify(spawned.environment).includes("secret-token") && Object.keys(spawned.environment).every((name) => !name.startsWith("MXC_")), "the server's secrets reach a command");
});

// ---- Approved skills' folders -------------------------------------------------------------------------

await row("requests: an approved skill's folder is read, by its real path, and never written; another skill's, a changed one's, a withdrawn one's, a linked one's and one on a share are not", async () => {
	const roomId = "windows-smoke-skills";
	fs.mkdirSync(persistentAgentRootPath(roomId), { recursive: true });
	// The skills library in the smoke's own folder, so a run outside a temporary home never touches the person's skills.
	const agentDir = process.env.EXXPERTS_CODING_AGENT_DIR;
	process.env.EXXPERTS_CODING_AGENT_DIR = folderAt("agent");
	const library = agentSkillsDir();
	assert(library === path.join(work, "agent", "skills"), library);
	/** A user-store skill as accept leaves it, enabled in the room: its provenance written last, so the digest covers the tree. */
	const plant = (name: string, at = path.join(library, name)) => {
		fs.mkdirSync(path.join(at, "scripts"), { recursive: true });
		const manifest = `---\nname: ${name}\ndescription: a test skill\n---\n\nRun scripts/run.ps1.\n`;
		fs.writeFileSync(path.join(at, "SKILL.md"), manifest);
		fs.writeFileSync(path.join(at, "scripts", "run.ps1"), "Write-Output ran\n");
		writeSkillProvenance(at, { source: "upload", importedAt: new Date().toISOString(), license: null, sha256: sha256(manifest) });
		assert(enablePersistentRoomSkill(roomId, name, () => manifest).ok, `${name} was not enabled`);
		return path.join(library, name);
	};
	const approve = (name: string) => assert(approvePersistentRoomSkillExecution(roomId, name, (each) => resolveExecutableSkillFiles(each)?.filesSha256 ?? null).ok, `${name} was not approved`);
	const report = plant("report");
	approve("report");
	const other = plant("other");
	const linkedTree = plant("linked-tree");
	fs.symlinkSync(folderAt("outside-skill"), path.join(linkedTree, "scripts", "outside"));
	approve("linked-tree");
	fs.mkdirSync(library, { recursive: true });
	const linkedFolder = plant("linked-folder", folderAt("skill-elsewhere"));
	fs.symlinkSync(folderAt("skill-elsewhere"), linkedFolder);
	approve("linked-folder");
	// Each is approved and current, so only the guards keep the linked ones out.
	assert(approvedSkills(roomId).map((skill) => skill.name).sort().join() === "linked-folder,linked-tree,report", show(approvedSkills(roomId)));
	const box = engine({ roomId, rights: () => ({ canChangeFiles: true, skillFolders: approvedSkills(roomId).map((skill) => skill.skillDir) }) });
	const last = async (command: string) => {
		const result = await exec(box, command);
		assert(result.error === null, show(result));
		return userSpawns().at(-1)!.request!;
	};
	const real = requestPath(fs.realpathSync.native(report));
	/** The paths a request reads or writes at or inside `place`, by the name the box gives it. */
	const granted = (request: WindowsBoxRequest, place: string) => {
		const named = requestPath(fs.realpathSync.native(place)).toLowerCase();
		return [...request.filesystem.readonlyPaths, ...request.filesystem.readwritePaths].filter((each) => each.toLowerCase() === named || each.toLowerCase().startsWith(`${named}\\`));
	};
	let request = await last("Write-Output approved");
	assert(request.filesystem.readonlyPaths.includes(real) && !request.filesystem.readwritePaths.some((place) => real.toLowerCase().startsWith(place.toLowerCase())), show(request.filesystem));
	for (const [what, place] of [["another skill", other], ["a link in its tree", linkedTree], ["a folder that is a link", linkedFolder], ["the link's target", path.join(work, "skill-elsewhere")]] as const) {
		assert(granted(request, place).length === 0, `${what} reached the request: ${show(request.filesystem)}`);
	}
	assert(show(granted(request, library)) === show([real]), `the library, beyond the approved skill: ${show(request.filesystem)}`);
	// One changed byte closes it until the person approves it again.
	fs.appendFileSync(path.join(report, "scripts", "run.ps1"), "#");
	request = await last("Write-Output changed");
	assert(!request.filesystem.readonlyPaths.includes(real), "a changed skill's folder reached the request");
	approve("report");
	request = await last("Write-Output approved again");
	assert(request.filesystem.readonlyPaths.includes(real), "the skill approved again is not read");
	assert(revokePersistentRoomSkillExecution(roomId, "report").ok, "the approval was not withdrawn");
	request = await last("Write-Output withdrawn");
	assert(!request.filesystem.readonlyPaths.includes(real), "a withdrawn skill's folder reached the request");
	await box.endTurn();
	// A folder the box would name by a share is never given, and its local neighbour is.
	assert(windowsSkillFolder(report, () => String.raw`\\host\share\report`) === undefined && windowsSkillFolder(report, requestPath) === fs.realpathSync.native(report), "a skill folder on a share");
	if (agentDir === undefined) delete process.env.EXXPERTS_CODING_AGENT_DIR;
	else process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
});

// ---- The room's folders, from its stored settings ----------------------------------------------------

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const chooseFolder = (room: string, root: string) => writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: room, repoRoot, root, workspaceAccessMode: "localFiles", displayLabel: "Room Folder", source: "manual" }));

await row("requests: rebuilt at each command from the room's folder, its Also allowed list and the running answer's own folders", async () => {
	const roomId = "windows-smoke-stored";
	fs.mkdirSync(persistentAgentRootPath(roomId), { recursive: true });
	const own = folderAt("stored-room");
	const listed = folderAt("listed");
	const thisTime = folderAt("this-time");
	const moved = folderAt("moved-room");
	chooseFolder(roomId, own);
	const given = new AnswerFolders();
	const box = engine({ roomId, folders: undefined, roomData: undefined, answer: () => given });
	const last = async (command: string) => {
		const result = await exec(box, command);
		assert(result.error === null, show(result));
		return userSpawns().at(-1)!.request!;
	};
	let request = await last("Write-Output first");
	assert(request.workingDirectory === requestPath(own) && request.filesystem.readwritePaths.includes(requestPath(own)), show(request.filesystem));
	assert(![...request.filesystem.readwritePaths, ...request.filesystem.readonlyPaths].some((place) => place === requestPath(listed) || place === requestPath(thisTime)), "a folder before it was given");
	saveAlsoAllowedFolders(roomId, [{ path: listed, access: "read" }]);
	given.give(thisTime, "write");
	request = await last("Write-Output second");
	assert(request.filesystem.readonlyPaths.includes(requestPath(listed)) && request.filesystem.readwritePaths.includes(requestPath(thisTime)), show(request.filesystem));
	given.end();
	saveAlsoAllowedFolders(roomId, []);
	request = await last("Write-Output third");
	assert(![...request.filesystem.readwritePaths, ...request.filesystem.readonlyPaths].some((place) => place === requestPath(listed) || place === requestPath(thisTime)), "a folder after it was taken back");
	// The folder the person chose is the one a command runs in: another stored folder moves the next command.
	chooseFolder(roomId, moved);
	request = await last("Write-Output fourth");
	assert(request.workingDirectory === requestPath(moved), request.workingDirectory);
	fs.rmSync(moved, { recursive: true });
	const spawned = userSpawns().length;
	const gone = await exec(box, "Write-Output never");
	assert(gone.error?.message === COMMAND_FOLDER_MOVED && userSpawns().length === spawned, show(gone));
	await box.endTurn();
});

await row("requests: acting as Windows, a room whose own folder the folder judge refuses runs no command, checked at each command", async () => {
	Object.assign(process.env, { EXXPERTS_TEST_INTROSPECTION: "1", EXXPERTS_TEST_SHELL_PLATFORM: "win32" });
	const roomId = "windows-smoke-refused";
	fs.mkdirSync(persistentAgentRootPath(roomId), { recursive: true });
	const fine = folderAt("fine-room");
	const box = engine({ roomId, folders: undefined, roomData: undefined });
	chooseFolder(roomId, fine);
	assert((await exec(box, "Write-Output allowed")).output === "allowed\n", "the allowed neighbour");
	// The same folder made into a bare repository, whose files git runs: the judge refuses it from the next command on.
	for (const name of ["HEAD", "objects", "refs"]) fs.mkdirSync(path.join(fine, name));
	const spawned = userSpawns().length;
	const refused = await exec(box, "Write-Output never");
	assert(refused.error?.message === ROOM_FOLDER_REFUSED && userSpawns().length === spawned, show(refused));
	for (const name of ["HEAD", "objects", "refs"]) fs.rmdirSync(path.join(fine, name));
	assert((await exec(box, "Write-Output again")).output === "again\n", "the same turn, the folder a plain one again");
	await box.endTurn();
	delete process.env.EXXPERTS_TEST_SHELL_PLATFORM;
});

fs.rmSync(work, { recursive: true, force: true });
console.log("windows-box-worker-smoke: ok");
