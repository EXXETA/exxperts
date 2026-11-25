// Shell commands on a Windows computer with no shell (no Git for Windows).
//
// The runtime's lookup is walked as on Windows (the server's test switch fakes
// the platform; Program Files points at a temp folder), against a real server,
// a real room and a real websocket turn. The model is a synthetic gateway that
// runs one bash command per turn and reads the tool's result back. Pinned:
//
// - the Folder pane shows the one plain line, under the Commands switch, and
//   only while no shell is found;
// - a command that finds no shell answers the chat and the model with that
//   line; the runtime's settings.json advice reaches the server log only;
// - Git installed while the app runs is found by the next command and the next
//   look at the pane, with no restart;
// - without the switch (macOS, Linux) the pane never shows the line;
// - a settings file's shell path that does not exist is not a missing shell:
//   no line, with the switch or without;
// - with Windows PowerShell there (a stand-in) and no Git, commands run in it:
//   no line in the pane, its output in the chat and in what the model reads,
//   the PowerShell texts, and on Auto without protection no question, with
//   nobody connected too. With it taken away, the Git line again, or the
//   launcher's own answer where only Windows' Linux launcher is there. Which
//   shell, and how it is started, is windows-plain-commands-smoke.ts's.
//
// The faked lookup needs a machine that is not Windows: on a real Windows
// runner Git is installed and found through git.exe. Windows is checked by
// hand (release checklist, Windows without Git).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort, type AuthedFetchInit, putRunWithoutAsking } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";
import { COMMANDS } from "../src/room-box/card-text.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

if (process.platform === "win32") {
	console.log("shell-missing-windows smoke skipped (the faked lookup needs a machine that is not Windows)");
	process.exit(0);
}

const SENTENCE = "On Windows, shell commands need Git for Windows. Install it from gitforwindows.org; the room can run commands as soon as it is installed. If it still says this, restart exxperts.";
const COMMAND_OUTPUT = "shell-ran-after-install";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-shell-missing-"));
const programFiles = path.join(tempRoot, "pf");
fs.mkdirSync(programFiles, { recursive: true });
// What the Windows lookup checks first. Its backslashes make one file name
// here, so a link by that name stands in for Git Bash once "installed".
const gitBash = `${programFiles}\\Git\\bin\\bash.exe`;

const chromiumPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
const hasBrowser = Boolean(chromiumPath && fs.existsSync(chromiumPath));

// ---------------------------------------------------------------------------
// Synthetic gateway: the first request of a turn runs one bash command; the
// follow-up (with the tool result in its messages) is captured, answered "done".
// ---------------------------------------------------------------------------
const capturedToolResults: string[] = [];
const ECHO = { name: "bash", args: { command: `echo ${COMMAND_OUTPUT}` } };
// The next turn's call, what the command tool said of itself to the model, and a hold on the next turn's first answer.
let nextCall: { name: string; args: Record<string, unknown> } = ECHO;
let toolText = "";
let holdAnswer: Promise<void> | null = null;
let firstRequests = 0;

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", async () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		const toolMessages = messages.filter((m) => m?.role === "tool");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${capturedToolResults.length + 1}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		if (toolMessages.length === 0) {
			toolText = String((parsed?.tools ?? []).find((tool: any) => tool?.function?.name === "bash")?.function?.description ?? "");
			firstRequests += 1;
			await holdAnswer;
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_bash", type: "function", function: { name: nextCall.name, arguments: "" } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(nextCall.args) } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			capturedToolResults.push(toolMessages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 5, total_tokens: 155 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

type SmokeServer = { process: ChildProcessWithoutNullStreams; baseUrl: string; port: number; output: string[]; home: string };

/** A server on a home of its own; `cwd`: started in that folder, where a program named by a Windows path is one file. */
async function startServer(label: string, gatewayPort: number, extraEnv: Record<string, string>, cwd?: string): Promise<SmokeServer> {
	const home = path.join(tempRoot, label);
	const agentDir = path.join(home, ".exxperts", "agent");
	const productAppRoot = path.join(home, ".exxperts", "app");
	fs.mkdirSync(path.join(productAppRoot, "personalized-agents"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"openai-compatible": {
				name: "Synthetic Gateway",
				baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
				api: "openai-completions",
				models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }],
			},
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-shell-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Synthetic Gateway",
		roomModels: [{ modelId: "room-model", label: "Room Model" }],
		maintenanceModel: "room-model",
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	const port = await freePort();
	const baseEnv: Record<string, string | undefined> = { ...process.env };
	delete baseEnv["ProgramFiles(x86)"];
	delete baseEnv.LOCALAPPDATA;
	const [program, args] = cwd === undefined ? ["npx", ["tsx", "src/index.ts"]] as const : [process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href, path.join(webServerDir, "src", "index.ts")]] as const;
	const child = spawn(program, args, {
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: cwd ?? webServerDir,
		env: {
			...baseEnv,
			HOME: home, USERPROFILE: home,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: agentDir,
			EXXETA_PERSISTENT_AGENTS_ROOT: path.join(productAppRoot, "personalized-agents"),
			...extraEnv,
		},
	});
	const output: string[] = [];
	child.stdout.on("data", (chunk) => output.push(String(chunk)));
	child.stderr.on("data", (chunk) => output.push(String(chunk)));
	const baseUrl = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 20_000;
	while (true) {
		if (child.exitCode != null) throw new Error(`server ${label} exited before startup with code ${child.exitCode}`);
		try {
			if ((await fetch(`${baseUrl}/healthz`)).ok) break;
		} catch {}
		if (Date.now() > deadline) throw new Error(`server ${label} did not become ready`);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	return { process: child, baseUrl, port, output, home };
}

async function requestJson(server: SmokeServer, pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${server.baseUrl}${pathname}`, {
		...init,
		headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** A room with a folder, Commands on and asking off, as a person would set it. */
async function createBashRoom(server: SmokeServer, name: string): Promise<string> {
	const room = await requestJson(server, "/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(room.status === 201, `room creation: expected 201, got ${room.status}: ${JSON.stringify(room.body)}`);
	const agentId = String(room.body?.agent?.id ?? "");
	assert(agentId, "the new room has an id");
	const workspaceRoot = path.join(server.home, "workspace");
	fs.mkdirSync(workspaceRoot, { recursive: true });
	const workspace = await requestJson(server, `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: workspaceRoot, displayLabel: "Shell Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }),
	});
	assert(workspace.status === 200 && workspace.body?.policy?.bashEnabled === true, `workspace default PUT: got ${workspace.status}: ${JSON.stringify(workspace.body)}`);
	const ask = await putRunWithoutAsking(`${server.baseUrl}/api/persistent-agents/${encodeURIComponent(agentId)}/bash-settings`, true);
	assert(ask.status === 200, `bash-settings PUT: got ${ask.status}`);
	return agentId;
}

const WebSocketImpl: any = (await import("ws")).default;

/** A seeded conversation's own connection, and the frames it got. */
async function connect(server: SmokeServer, agentId: string, conversationId: string): Promise<{ socket: any; frames: any[] }> {
	const seeded = await requestJson(server, `/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}`, {
		method: "PUT",
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }),
	});
	assert(seeded.status === 200, `thread seed: expected 200, got ${seeded.status}: ${JSON.stringify(seeded.body).slice(0, 300)}`);
	const socket = new WebSocketImpl(`ws://127.0.0.1:${server.port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	socket.addEventListener("message", (event: { data: unknown }) => {
		try { frames.push(JSON.parse(String(event.data))); } catch {}
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
	});
	return { socket, frames };
}

/** One turn over the room websocket, settled on the server; returns the call's result as the chat received it, and the questions it asked. */
async function runTurn(server: SmokeServer, agentId: string, conversationId: string): Promise<{ text: string; isError: boolean; modelSaw: string; questions: number }> {
	const { socket, frames } = await connect(server, agentId, conversationId);
	const before = capturedToolResults.length;
	socket.send(JSON.stringify({ type: "prompt", text: "Run a command, please." }));
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (capturedToolResults.length > before && frames.some((frame) => frame?.type === "event" && frame?.event?.type === "agent_end")) {
			await waitForTurnSettled((pathname) => requestJson(server, pathname), agentId, `${conversationId}: the turn has settled before the next seed`);
			try { socket.close(); } catch {}
			const toolResult = frames.find((frame) => frame?.type === "event" && frame?.event?.type === "message_end" && frame?.event?.message?.role === "toolResult")?.event?.message;
			assert(toolResult, "the chat must receive the command's result");
			const text = (toolResult.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
			return { text, isError: toolResult.isError === true, modelSaw: capturedToolResults[before], questions: frames.filter((frame) => frame?.type === "ui_request" && typeof frame.id === "string").length };
		}
		const errors = frames.filter((frame) => String(frame?.type ?? "").includes("error"));
		if (errors.length > 0) throw new Error(`turn errored: ${JSON.stringify(errors[0]).slice(0, 400)}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`turn did not complete; frame types: ${frames.map((f) => f?.type).join(", ")}`);
}

type PaneLines = { count: number; underCommands: number; text: string };

/** Opens Room settings on Folder and reads the line, and where it sits: under the Commands switch. Each open asks the server again. */
async function readPane(page: any, server: SmokeServer, roomName: string): Promise<PaneLines> {
	await page.goto(`${server.baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").filter({ hasText: roomName }).locator(".card-gear-btn").click();
	await page.waitForSelector(".settings-dialog", { timeout: 10000 });
	await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Folder$/ }).first().click();
	const pane = page.locator(".room-settings-section:not([hidden]) .room-workspace-section");
	const commands = pane.getByRole("switch", { name: COMMANDS, exact: true });
	await commands.waitFor({ timeout: 10000 });
	const line = pane.locator(".workspace-shell-missing");
	const count = await line.count();
	const underCommands = await pane.locator("label.settings-row").filter({ has: page.getByRole("switch", { name: COMMANDS, exact: true }) }).locator(".workspace-shell-missing").count();
	return { count, underCommands, text: count ? await line.first().innerText() : "" };
}

let windowsServer: SmokeServer | undefined;
let plainServer: SmokeServer | undefined;
let powerShellServer: SmokeServer | undefined;
try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	windowsServer = await startServer("windows", gatewayPort, { EXXPERTS_TEST_INTROSPECTION: "1", EXXPERTS_TEST_SHELL_PLATFORM: "win32", ProgramFiles: programFiles });
	const agentId = await createBashRoom(windowsServer, "Windows Room");

	// 1. No shell: the server says so, in the one plain line.
	const before = await requestJson(windowsServer, `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`);
	assert(before.status === 200 && before.body?.shellMissingNote === SENTENCE, `without a shell the pane's read must carry the line, got ${JSON.stringify(before.body?.shellMissingNote)}`);

	// 2. A command finds no shell: the chat and the model get the line, the log the rest.
	const failed = await runTurn(windowsServer, agentId, "conv-no-shell");
	assert(failed.isError, "a command with no shell is still a failed command");
	assert(failed.text === SENTENCE, `the chat must show the plain line, got ${JSON.stringify(failed.text)}`);
	assert(failed.modelSaw === SENTENCE, `the model must receive the plain line, got ${JSON.stringify(failed.modelSaw)}`);
	assert(!failed.modelSaw.includes("settings.json") && !failed.text.includes("settings.json"), "the settings.json advice must not reach the person or the model");
	const log = windowsServer.output.join("").split("\n").filter((line) => !line.includes("token=")).join("\n");
	assert(log.includes("shell commands: no shell found") && log.includes("No bash shell found"), "the runtime's own text must reach the server log");
	console.log("ok: no shell, the chat and the model read one plain line, the raw text is logged");

	// 3. The pane shows the line while no shell is found.
	const browser = hasBrowser ? await chromium.launch() : null;
	let openPage: any = null;
	try {
		if (browser) {
			const page = openPage = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
			const missing = await readPane(page, windowsServer, "Windows Room");
			assert(missing.count === 1 && missing.underCommands === 1 && missing.text === SENTENCE, `the pane must show the line once, under the Commands switch, got ${JSON.stringify(missing)}`);
			console.log("ok: the pane shows the line while no shell is found");
		} else {
			console.log("pane checks skipped (Chromium not installed)");
		}

		// 4. Git is installed while the app runs: no restart.
		fs.symlinkSync("/bin/bash", gitBash);
		const after = await requestJson(windowsServer, `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`);
		assert(after.status === 200 && after.body?.shellMissingNote === null, `with a shell found the line must go, got ${JSON.stringify(after.body?.shellMissingNote)}`);
		const ran = await runTurn(windowsServer, agentId, "conv-with-shell");
		assert(!ran.isError && ran.text.includes(COMMAND_OUTPUT), `the next command must run once a shell is there, got ${JSON.stringify(ran.text)}`);
		assert(ran.modelSaw.includes(COMMAND_OUTPUT), "the model must read the command's real output");
		if (browser) {
			const found = await readPane(openPage, windowsServer, "Windows Room");
			assert(found.count === 0, `with a shell found the pane must not show the line, got ${JSON.stringify(found)}`);
		}
		console.log("ok: a shell installed meanwhile runs the next command and clears the line, no restart");

		// A settings file's shell path that does not exist is a developer's error, not a missing shell.
		const windowsSettings = path.join(windowsServer.home, ".exxperts", "agent", "settings.json");
		fs.writeFileSync(windowsSettings, JSON.stringify({ shellPath: path.join(tempRoot, "no-such-bash.exe") }));
		const customWindows = await requestJson(windowsServer, `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`);
		assert(customWindows.status === 200 && customWindows.body?.shellMissingNote === null, `a shell path that does not exist must not show the line, got ${JSON.stringify(customWindows.body?.shellMissingNote)}`);
		fs.rmSync(windowsSettings, { force: true });

		// 5. macOS and Linux: no switch, the line never shows.
		await stopSmokeServer(windowsServer.process);
		windowsServer = undefined;
		plainServer = await startServer("plain", gatewayPort, {});
		const plainId = await createBashRoom(plainServer, "Plain Room");
		const plain = await requestJson(plainServer, `/api/persistent-agents/${encodeURIComponent(plainId)}/workspace-default`);
		assert(plain.status === 200 && plain.body?.shellMissingNote === null, `on ${process.platform} the line must never show, got ${JSON.stringify(plain.body?.shellMissingNote)}`);
		fs.writeFileSync(path.join(plainServer.home, ".exxperts", "agent", "settings.json"), JSON.stringify({ shellPath: path.join(tempRoot, "no-such-bash") }));
		const custom = await requestJson(plainServer, `/api/persistent-agents/${encodeURIComponent(plainId)}/workspace-default`);
		assert(custom.status === 200 && custom.body?.shellMissingNote === null, `on ${process.platform} a shell path that does not exist must not show the line, got ${JSON.stringify(custom.body?.shellMissingNote)}`);
		if (browser) {
			const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
			const lines = await readPane(page, plainServer, "Plain Room");
			assert(lines.count === 0, `on ${process.platform} the pane must not show the line, got ${JSON.stringify(lines)}`);
		}
		console.log(`ok: on ${process.platform} the pane shows no line, even with a shell path that does not exist`);
	} finally {
		await browser?.close();
	}

	// 6. Windows PowerShell there, no Git, no protection on this computer, the room on Auto.
	{
		const programs = path.join(tempRoot, "programs");
		const bin = path.join(tempRoot, "bin");
		const noGit = path.join(tempRoot, "no-git");
		for (const folder of [programs, bin, noGit]) fs.mkdirSync(folder);
		const started = path.join(tempRoot, "powershell-started.txt");
		const powerShell = path.join(programs, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
		fs.writeFileSync(powerShell, `#!/bin/sh\necho started >> ${JSON.stringify(started)}\ncommand=$EXXPERTS_COMMAND\nunset EXXPERTS_COMMAND\nexec /bin/sh -c "$command"\n`, { mode: 0o755 });
		const starts = () => (fs.existsSync(started) ? fs.readFileSync(started, "utf8").split("\n").filter(Boolean).length : 0);
		const launcher = `${tempRoot}/${String.raw`C:\Windows\System32\bash.exe`}`;
		fs.writeFileSync(launcher, "#!/bin/sh\necho the-launchers-own-answer\nexit 1\n", { mode: 0o755 });
		const whereAnswer = path.join(tempRoot, "where-bash.txt");
		fs.writeFileSync(path.join(bin, "where"), `#!/bin/sh\n[ "$1" = bash.exe ] && [ -f ${JSON.stringify(whereAnswer)} ] || exit 1\ncat ${JSON.stringify(whereAnswer)}\n`, { mode: 0o755 });
		fs.writeFileSync(whereAnswer, `${launcher}\r\n`);

		const server = powerShellServer = await startServer("powershell", gatewayPort, {
			EXXPERTS_TEST_INTROSPECTION: "1", EXXPERTS_TEST_SHELL_PLATFORM: "win32", EXXPERTS_TEST_WINDOWS_BOX: "off",
			ProgramFiles: noGit, SystemRoot: String.raw`C:\Windows`, PATH: [bin, programs, process.env.PATH].join(path.delimiter),
		}, programs);
		const skillFolder = path.join(server.home, ".exxperts", "agent", "skills", "report");
		fs.mkdirSync(path.join(skillFolder, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(skillFolder, "SKILL.md"), "---\nname: report\ndescription: Makes a report\n---\n\nRun scripts/report.ps1.\n");
		fs.writeFileSync(path.join(skillFolder, "scripts", "report.ps1"), "Write-Output report\n");
		const roomId = await createBashRoom(server, "PowerShell Room");
		const roomPath = (rest: string) => `/api/persistent-agents/${encodeURIComponent(roomId)}${rest}`;
		assert((await requestJson(server, roomPath("/skill-settings"), { method: "PUT", body: JSON.stringify({ action: "enable", name: "report" }) })).status === 200, "the skill is on");
		const paneNow = async () => (await requestJson(server, roomPath("/workspace-default"))).body;

		const pane = await paneNow();
		assert(pane?.shellMissingNote === null && pane?.protection?.state === "off", `with PowerShell there the pane has no Git line, and the room no protection, got ${JSON.stringify([pane?.shellMissingNote, pane?.protection])}`);
		const ran = await runTurn(server, roomId, "conv-powershell");
		assert(!ran.isError && ran.text.trim() === COMMAND_OUTPUT && ran.modelSaw.trim() === COMMAND_OUTPUT && starts() === 1, `the command must run in PowerShell, and its output reach the chat and the model, got ${JSON.stringify(ran)} after ${starts()} starts`);
		assert(ran.questions === 0, `on Auto without protection a command asks nothing, got ${ran.questions} questions`);
		assert(toolText.startsWith("Run a Windows PowerShell 5.1 command in the room's folder.") && !toolText.includes("Programs a command starts end when it ends."), `the model must read PowerShell's text, got ${JSON.stringify(toolText)}`);
		console.log("ok: with PowerShell and no Git a command runs in PowerShell, its output in the chat and the model, no Git line and no question");

		nextCall = { name: "read_skill", args: { name: "report" } };
		const skill = await runTurn(server, roomId, "conv-powershell-skill");
		nextCall = ECHO;
		assert(skill.modelSaw.includes("Run one with this room's commands by naming its program and quoting its full path") && !skill.modelSaw.includes("can't run them on this computer") && !skill.modelSaw.includes("bash tool"), `a skill's files are run with PowerShell, got ${JSON.stringify(skill.modelSaw)}`);
		console.log("ok: a skill's text says how PowerShell runs its files");

		// Nobody connected: the person leaves while the answer is still coming, and its command runs.
		let release = () => {};
		holdAnswer = new Promise<void>((resolve) => { release = resolve; });
		const before = { starts: starts(), results: capturedToolResults.length, requests: firstRequests };
		const away = await connect(server, roomId, "conv-powershell-away");
		away.socket.send(JSON.stringify({ type: "prompt", text: "Run a command, please." }));
		const wait = async (what: string, test: () => boolean) => {
			const deadline = Date.now() + 30_000;
			while (!test()) {
				assert(Date.now() < deadline, `never: ${what}`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		};
		await wait("the answer began", () => firstRequests > before.requests);
		const closed = new Promise<void>((resolve) => away.socket.addEventListener("close", () => resolve()));
		away.socket.close();
		await closed;
		release();
		holdAnswer = null;
		await wait("the command's result, with nobody connected", () => capturedToolResults.length > before.results);
		await waitForTurnSettled((pathname) => requestJson(server, pathname), roomId, "the turn nobody watched has settled");
		assert(capturedToolResults[before.results].trim() === COMMAND_OUTPUT && starts() === before.starts + 1, `with nobody connected the command runs, got ${JSON.stringify(capturedToolResults[before.results])}`);
		assert(away.frames.every((frame) => !(frame?.type === "ui_request" && typeof frame.id === "string")), "a question was asked");
		console.log("ok: on Auto without protection a command runs in PowerShell with nobody connected");

		// PowerShell taken away: as before this computer had it counted.
		fs.rmSync(powerShell);
		const launched = await runTurn(server, roomId, "conv-launcher");
		assert((await paneNow())?.shellMissingNote === null && launched.isError && launched.text.includes("the-launchers-own-answer") && toolText.startsWith("Execute a bash command"), `with only the launcher there its own answer, got ${JSON.stringify(launched)}`);
		fs.rmSync(whereAnswer);
		const none = await runTurn(server, roomId, "conv-neither");
		assert((await paneNow())?.shellMissingNote === SENTENCE && none.isError && none.text === SENTENCE && none.modelSaw === SENTENCE, `with neither shell the Git line, got ${JSON.stringify(none)}`);
		console.log("ok: with PowerShell taken away, the launcher's own answer, or the Git line where there is no bash at all");
	}

	console.log("shell-missing-windows-smoke: OK");
} catch (error) {
	for (const server of [windowsServer, plainServer, powerShellServer]) {
		if (server) console.error(server.output.join("").split("\n").filter((line) => !line.includes("token=")).join("\n").slice(-6000));
	}
	throw error;
} finally {
	try { gateway.close(); } catch {}
	await stopSmokeServer(windowsServer?.process);
	await stopSmokeServer(plainServer?.process);
	await stopSmokeServer(powerShellServer?.process);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
