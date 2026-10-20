// Shell commands on a Windows computer with no shell (no Git for Windows).
//
// The runtime's lookup is walked as on Windows (the server's test switch fakes
// the platform; Program Files points at a temp folder), against a real server,
// a real room and a real websocket turn. The model is a synthetic gateway that
// runs one bash command per turn and reads the tool's result back. Pinned:
//
// - the Workspace pane shows the one plain line, in the summary and under the
//   Bash switch, and only while no shell is found;
// - a command that finds no shell answers the chat and the model with that
//   line; the runtime's settings.json advice reaches the server log only;
// - Git installed while the app runs is found by the next command and the next
//   look at the pane, with no restart;
// - without the switch (macOS, Linux) the pane never shows the line;
// - a settings file's shell path that does not exist is not a missing shell:
//   no line, with the switch or without.
//
// The faked lookup needs a machine that is not Windows: on a real Windows
// runner Git is installed and found through git.exe. Windows is checked by
// hand (release checklist, Windows without Git).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";

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
	req.on("end", () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		const toolMessages = messages.filter((m) => m?.role === "tool");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${capturedToolResults.length + 1}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		if (toolMessages.length === 0) {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_bash", type: "function", function: { name: "bash", arguments: "" } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: `echo ${COMMAND_OUTPUT}` }) } }] }, finish_reason: null }] }));
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

async function startServer(label: string, gatewayPort: number, extraEnv: Record<string, string>): Promise<SmokeServer> {
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
	const child = spawn("npx", ["tsx", "src/index.ts"], {
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
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

/** A room with a folder, Full access, Bash on and asking off, as a person would set it. */
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
	const ask = await requestJson(server, `/api/persistent-agents/${encodeURIComponent(agentId)}/bash-settings`, { method: "PUT", body: JSON.stringify({ autoApprove: true }) });
	assert(ask.status === 200, `bash-settings PUT: got ${ask.status}`);
	return agentId;
}

const WebSocketImpl: any = (await import("ws")).default;

/** One turn over the room websocket; returns the bash result as the chat received it. */
async function runTurn(server: SmokeServer, agentId: string, conversationId: string): Promise<{ text: string; isError: boolean; modelSaw: string }> {
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
	const before = capturedToolResults.length;
	socket.send(JSON.stringify({ type: "prompt", text: "Run a command, please." }));
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (capturedToolResults.length > before && frames.some((frame) => frame?.type === "event" && frame?.event?.type === "agent_end")) {
			try { socket.close(); } catch {}
			const toolResult = frames.find((frame) => frame?.type === "event" && frame?.event?.type === "message_end" && frame?.event?.message?.role === "toolResult")?.event?.message;
			assert(toolResult, "the chat must receive the command's result");
			const text = (toolResult.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
			return { text, isError: toolResult.isError === true, modelSaw: capturedToolResults[before] };
		}
		const errors = frames.filter((frame) => String(frame?.type ?? "").includes("error"));
		if (errors.length > 0) throw new Error(`turn errored: ${JSON.stringify(errors[0]).slice(0, 400)}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`turn did not complete; frame types: ${frames.map((f) => f?.type).join(", ")}`);
}

type PaneLines = { summary: number; editor: number; text: string };

/** Opens Room settings on Workspace, reads the line in the summary and in the editor; the editor stays open. */
async function readPane(page: any, server: SmokeServer, roomName: string): Promise<PaneLines> {
	await page.goto(`${server.baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").filter({ hasText: roomName }).locator(".card-gear-btn").click();
	await page.waitForSelector(".settings-dialog", { timeout: 10000 });
	await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Workspace$/ }).first().click();
	const pane = page.locator(".room-settings-section:not([hidden]) .room-workspace-section");
	await pane.getByRole("button", { name: "Edit workspace" }).waitFor({ timeout: 10000 });
	await page.waitForTimeout(300);
	const line = pane.locator(".workspace-shell-missing");
	const summary = await line.count();
	const text = summary ? await line.first().innerText() : "";
	await pane.getByRole("button", { name: "Edit workspace" }).click();
	await pane.getByLabel("Bash shell access").waitFor({ timeout: 10000 });
	await page.waitForTimeout(500);
	const editor = await line.count();
	return { summary, editor, text };
}

/** With the dialog still open: leave the editor and open it again, which asks the server again. */
async function reopenEditor(page: any): Promise<number> {
	const pane = page.locator(".room-settings-section:not([hidden]) .room-workspace-section");
	await pane.getByRole("button", { name: "Cancel" }).click();
	await pane.getByRole("button", { name: "Edit workspace" }).click();
	await pane.getByLabel("Bash shell access").waitFor({ timeout: 10000 });
	await page.waitForTimeout(500);
	return pane.locator(".workspace-shell-missing").count();
}

let windowsServer: SmokeServer | undefined;
let plainServer: SmokeServer | undefined;
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
			assert(missing.summary === 1 && missing.text === SENTENCE, `the summary must show the line under Bash on, got ${JSON.stringify(missing)}`);
			assert(missing.editor === 1, `the editor must show the line under the Bash switch, got ${JSON.stringify(missing)}`);
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
			assert((await reopenEditor(openPage)) === 0, "opening the editor again, in the same dialog, must ask again and drop the line");
			const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
			const found = await readPane(page, windowsServer, "Windows Room");
			assert(found.summary === 0 && found.editor === 0, `with a shell found the pane must not show the line, got ${JSON.stringify(found)}`);
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
			assert(lines.summary === 0 && lines.editor === 0, `on ${process.platform} the pane must not show the line, got ${JSON.stringify(lines)}`);
		}
		console.log(`ok: on ${process.platform} the pane shows no line, even with a shell path that does not exist`);
	} finally {
		await browser?.close();
	}

	console.log("shell-missing-windows-smoke: OK");
} catch (error) {
	for (const server of [windowsServer, plainServer]) {
		if (server) console.error(server.output.join("").split("\n").filter((line) => !line.includes("token=")).join("\n").slice(-6000));
	}
	throw error;
} finally {
	try { gateway.close(); } catch {}
	await stopSmokeServer(windowsServer?.process);
	await stopSmokeServer(plainServer?.process);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
