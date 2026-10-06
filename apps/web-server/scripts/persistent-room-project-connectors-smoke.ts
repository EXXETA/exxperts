// A room uses only the connectors from the person's own settings
// (~/.config/mcp/mcp.json, ~/.exxperts/agent/mcp.json), never a connector file
// in its folder. Driven through a really spawned web server with a synthetic
// model, plus the CLI room door in-process. Each folder file below names a
// harmless command that appends to a marker in this smoke's own temp folder,
// so a marker on disk means the file was used. Held:
//
//  - a web room session start with `.mcp.json` or `.pi/mcp.json` (lifecycle
//    "eager") in its folder starts nothing;
//  - a scheduled background run of such a room starts nothing;
//  - a folder file naming a GRANTED connector does not replace it: the room's
//    call reaches the connector from the person's settings;
//  - a connector from the person's settings still starts in the folder it
//    always started in (the server's own working folder, or its `cwd`);
//  - a CLI room (whose process runs in the room's folder) starts nothing from
//    a `.mcp.json` there, and that file's settings change none of the room's
//    tools (no direct tools switched on, the mcp tool not hidden);
//  - a bounded room's write tool cannot create `.mcp.json` or `.pi/mcp.json`.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-connectors-")));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const markers = path.join(tempRoot, "markers");
for (const dir of [agentsRoot, agentDir, productAppRoot, markers]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
// Set before any import that reads them (the in-process CLI door below).
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;
delete process.env.EXXETA_PERSISTENT_ROOM_AGENT;
delete process.env.MCP_DIRECT_TOOLS;

const { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } = await import("./smoke-server-process.js");
type AuthedFetchInit = Parameters<typeof authedFetch>[1];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const marker = (name: string): string => path.join(markers, `${name}.txt`);
const markerText = (name: string): string | null => (fs.existsSync(marker(name)) ? fs.readFileSync(marker(name), "utf-8").trim() : null);
// A stand-in connector is a Node one-liner, so it starts the same way on every
// system: it appends one line to its marker (the time, or the folder it was
// started in) and exits.
const markerCommand = (name: string, what: "time" | "folder" = "time") => ({
	command: process.execPath,
	args: ["-e", `require("node:fs").appendFileSync(${JSON.stringify(marker(name))}, ${what === "folder" ? "process.cwd()" : "new Date().toISOString()"} + "\\n")`],
});

function writeFolderConnectorFile(workspace: string, file: ".mcp.json" | ".pi/mcp.json", markerName: string, serverName = "folder-server", lifecycle = "eager"): void {
	const target = path.join(workspace, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, JSON.stringify({ mcpServers: { [serverName]: { ...markerCommand(markerName), lifecycle } } }, null, 2));
}

// The person's own connectors: `github` over HTTP (a recorder counts every
// request that reaches it) and `cwd-probe`, a command that records the folder
// it was started in.
let githubHits = 0;
const githubRecorder = http.createServer((_req, res) => {
	githubHits += 1;
	res.writeHead(500).end();
});
await new Promise<void>((resolve) => githubRecorder.listen(0, "127.0.0.1", resolve));
fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({
	mcpServers: {
		github: { url: `http://127.0.0.1:${(githubRecorder.address() as AddressInfo).port}/mcp` },
		"cwd-probe": markerCommand("cwd-probe", "folder"),
	},
}, null, 2));

// Synthetic model: a prompt "CONNECT <name>" answers with one `mcp` connect
// call; anything else (and every follow-up) answers "ok".
const gateway = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) return void res.writeHead(404).end();
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		const lastUser = [...messages].reverse().find((m) => m?.role === "user");
		const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
		const connect = userText.match(/CONNECT ([a-z-]+)/)?.[1];
		const base = { id: "cmpl_smoke", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "room-model" };
		const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (connect && !messages.some((m) => m?.role === "tool")) {
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_mcp", type: "function", function: { name: "mcp", arguments: JSON.stringify({ connect }) } }] }, finish_reason: null }] });
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
		} else {
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
		}
		res.end("data: [DONE]\n\n");
	});
});

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
	const text = await response.text();
	let parsed: any = text;
	try { parsed = text ? JSON.parse(text) : null; } catch {}
	return { status: response.status, body: parsed };
}

async function createRoom(displayName: string, workspace: string, workspaceAccessMode: "bounded" | "localFiles" = "localFiles"): Promise<string> {
	fs.mkdirSync(workspace, { recursive: true });
	const room = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName, userName: "Smoke User", preferredUserAddress: "Smoke User" }) });
	assert(room.status === 201, `room creation: expected 201, got ${room.status}: ${JSON.stringify(room.body).slice(0, 300)}`);
	const agentId = String(room.body?.agent?.id ?? room.body?.agent?.agentId ?? "");
	const ws = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: workspace, displayLabel: displayName, workspaceAccessMode }) });
	assert(ws.status === 200, `workspace default PUT: expected 200, got ${ws.status}: ${JSON.stringify(ws.body).slice(0, 300)}`);
	return agentId;
}

async function grant(agentId: string, name: string): Promise<void> {
	const result = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/mcp-connectors`, { method: "PUT", body: JSON.stringify({ action: "grant", name }) });
	assert(result.status === 200, `grant ${name}: expected 200, got ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`);
}

const WebSocketImpl: any = (await import("ws")).default;

/** Open the room as the browser does, wait, optionally send one prompt, and return the tool results the model saw. */
async function openRoom(agentId: string, conversationId: string, prompt?: string): Promise<string[]> {
	const seeded = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}`, {
		method: "PUT",
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }),
	});
	assert(seeded.status === 200, `thread seed: expected 200, got ${seeded.status}: ${JSON.stringify(seeded.body).slice(0, 300)}`);
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	socket.addEventListener("message", (event: { data: unknown }) => {
		try { frames.push(JSON.parse(String(event.data))); } catch {}
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
	});
	await sleep(5_000);
	const toolResults: string[] = [];
	if (prompt) {
		socket.send(JSON.stringify({ type: "prompt", text: prompt }));
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && !frames.some((f) => f?.type === "event" && f?.event?.type === "agent_end")) await sleep(100);
		for (const frame of frames) {
			const event = frame?.event;
			if (frame?.type === "event" && event?.type === "tool_execution_end") toolResults.push(JSON.stringify(event?.result ?? "").slice(0, 400));
		}
		await sleep(2_000);
	}
	try { socket.close(); } catch {}
	return toolResults;
}

const failures: string[] = [];
const check = (condition: unknown, message: string): void => {
	if (!condition) failures.push(message);
};

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-room-connectors-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, {
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: agentDir,
			EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
			EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_INTERVAL_MS: "1000",
			EXXPERTS_SCHEDULER_EXECUTION_LOOP_INTERVAL_MS: "1000",
		}) as NodeJS.ProcessEnv,
	}) as ChildProcessWithoutNullStreams;
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	const ready = Date.now() + 30_000;
	for (;;) {
		try { if ((await fetch(`${baseUrl}/healthz`)).ok) break; } catch {}
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		if (Date.now() > ready) throw new Error("server did not become ready");
		await sleep(150);
	}

	// 1 + 2. A web room session start with a folder connector file starts nothing.
	const rootRoom = await createRoom("Folder Root", path.join(tempRoot, "ws-root"));
	writeFolderConnectorFile(path.join(tempRoot, "ws-root"), ".mcp.json", "web-root");
	await openRoom(rootRoom, "conv-root", "hello");
	check(markerText("web-root") === null, `a web room must not use its folder's .mcp.json (marker: ${markerText("web-root")})`);

	const piRoom = await createRoom("Folder Pi", path.join(tempRoot, "ws-pi"));
	writeFolderConnectorFile(path.join(tempRoot, "ws-pi"), ".pi/mcp.json", "web-pi");
	await openRoom(piRoom, "conv-second", "hello");
	check(markerText("web-pi") === null, `a web room must not use its folder's .pi/mcp.json (marker: ${markerText("web-pi")})`);

	// 3. A granted name is the person's connector, whatever the folder says; and a
	// connector from the person's settings starts in the folder it always did.
	const grantRoom = await createRoom("Folder Grant", path.join(tempRoot, "ws-grant"));
	await grant(grantRoom, "github");
	await grant(grantRoom, "cwd-probe");
	writeFolderConnectorFile(path.join(tempRoot, "ws-grant"), ".mcp.json", "shadow", "github", "lazy");
	const hitsBefore = githubHits;
	const shadowResults = await openRoom(grantRoom, "conv-grant", "CONNECT github");
	check(markerText("shadow") === null, `a folder file must not replace a granted connector (marker: ${markerText("shadow")}; tool results: ${shadowResults.join(" | ")})`);
	check(githubHits > hitsBefore, `the room's call must reach the person's own "github" connector (recorder hits ${hitsBefore} -> ${githubHits}; tool results: ${shadowResults.join(" | ")})`);
	await openRoom(grantRoom, "conv-cwd", "CONNECT cwd-probe");
	const startedIn = (markerText("cwd-probe") ?? "").split("\n").filter(Boolean);
	check(startedIn.length > 0 && startedIn.every((dir) => fs.realpathSync(dir) === fs.realpathSync(webServerDir)), `a connector from the person's settings must start in the server's working folder, got: ${JSON.stringify(startedIn)}`);

	// 4. A scheduled background run of a room with a folder connector file starts nothing.
	const backgroundRoom = await createRoom("Folder Background", path.join(tempRoot, "ws-bg"));
	writeFolderConnectorFile(path.join(tempRoot, "ws-bg"), ".mcp.json", "background");
	const schedule = await requestJson(`/api/persistent-agents/${encodeURIComponent(backgroundRoom)}/schedules`, { method: "POST", body: JSON.stringify({ name: "folder check", type: "once", schedule: "+3s", prompt: "hello", enabled: true }) });
	assert(schedule.status === 201, `schedule create: expected 201, got ${schedule.status}: ${JSON.stringify(schedule.body).slice(0, 300)}`);
	let runStatus = "";
	const runDeadline = Date.now() + 60_000;
	while (Date.now() < runDeadline) {
		await sleep(1_000);
		const runs = await requestJson(`/api/persistent-agents/${encodeURIComponent(backgroundRoom)}/background-runs`);
		runStatus = String(runs.body?.runs?.[0]?.status ?? "");
		if (["succeeded", "failed", "blocked", "cancelled"].includes(runStatus)) break;
	}
	await sleep(2_000);
	assert(runStatus === "succeeded", `the scheduled run must complete for the check to mean anything, got status "${runStatus}"`);
	check(markerText("background") === null, `a scheduled run must not use its folder's .mcp.json (marker: ${markerText("background")})`);

	// 5. The CLI room door: the process carries the room id and runs in the folder.
	const cliWorkspace = path.join(tempRoot, "ws-cli");
	fs.mkdirSync(cliWorkspace, { recursive: true });
	fs.writeFileSync(path.join(cliWorkspace, ".mcp.json"), JSON.stringify({
		settings: { directTools: true, disableProxyTool: true },
		mcpServers: { "folder-server": { ...markerCommand("cli"), lifecycle: "eager", directTools: false } },
	}, null, 2));
	// The person's connectors have cached tools, so a folder setting that
	// switched direct tools on would have something to register.
	const cacheMod = await import("pi-mcp-adapter/metadata-cache.ts" as string);
	const personalConfig = JSON.parse(fs.readFileSync(path.join(agentDir, "mcp.json"), "utf-8"));
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify({
		version: 1,
		servers: {
			github: { configHash: cacheMod.computeServerHash(personalConfig.mcpServers.github), cachedAt: Date.now(), resources: [], tools: [{ name: "search_issues", description: "Search issues" }] },
			"cwd-probe": { configHash: cacheMod.computeServerHash(personalConfig.mcpServers["cwd-probe"]), cachedAt: Date.now(), resources: [], tools: [{ name: "where", description: "Where it runs" }] },
		},
	}, null, 2));
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const fakePi = {
		tools: new Map<string, any>(),
		registerTool(tool: any) { fakePi.tools.set(String(tool.name), tool); },
		registerCommand() {},
		registerFlag() {},
		getFlag() { return undefined; },
		getAllTools() { return [...fakePi.tools.values()]; },
		sendMessage() {},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
	};
	const cliCtx = { cwd: cliWorkspace, hasUI: false, ui: undefined, modelRegistry: undefined, model: undefined, signal: undefined };
	process.env.EXXETA_PERSISTENT_ROOM_AGENT = grantRoom;
	const launchCwd = process.cwd();
	try {
		const mcpExtension = await import("../../../pi-package/extensions/mcp/index.js");
		process.chdir(cliWorkspace);
		try {
			await (mcpExtension.default as (pi: unknown) => Promise<unknown>)(fakePi);
		} finally {
			process.chdir(launchCwd);
		}
		const toolNames = [...fakePi.tools.keys()].sort().join(",");
		check(fakePi.tools.has("mcp"), `a CLI room's folder settings must not hide the mcp tool, registered: ${toolNames}`);
		check(![...fakePi.tools.keys()].some((name) => name.includes("search_issues")), `a CLI room's folder settings must not switch direct tools on, registered: ${toolNames}`);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, cliCtx);
		await sleep(2_000);
		check(markerText("cli") === null, `a CLI room must not use its folder's .mcp.json (marker: ${markerText("cli")})`);
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, cliCtx);
	} finally {
		delete process.env.EXXETA_PERSISTENT_ROOM_AGENT;
	}

	// 6. A bounded room's write tool cannot create a connector file in its folder.
	const { createPersistentRoomCapabilityPolicy } = await import("../src/persistent-room-workspace-policy.js");
	const { createPersistentRoomWorkspaceTools } = await import("../src/persistent-room-workspace-tools.js");
	const boundedRoot = path.join(tempRoot, "ws-bounded");
	fs.mkdirSync(boundedRoot, { recursive: true });
	const policy = createPersistentRoomCapabilityPolicy({
		agentId: "room-connectors-bounded",
		conversationId: "c_room_connectors",
		repoRoot,
		persistentAgentsRoot: agentsRoot,
		exxetaStateRoot: productAppRoot,
		root: boundedRoot,
		workspaceAccessMode: "bounded",
		source: "manual",
		now: new Date("2026-10-06T00:00:00.000Z"),
	});
	const writeTool = createPersistentRoomWorkspaceTools(policy).find((tool: any) => tool.name === "write") as any;
	assert(writeTool, "a bounded room must have its write tool");
	for (const target of [".mcp.json", ".pi/mcp.json", "sub/.mcp.json"]) {
		let refusal = "";
		try {
			const result = await writeTool.execute("smoke-write", { path: target, content: "{}" }, undefined, undefined, {} as any);
			refusal = result?.isError ? JSON.stringify(result.content) : "";
		} catch (error) {
			refusal = error instanceof Error ? error.message : String(error);
		}
		check(/blocked by workspace policy/i.test(refusal) && !fs.existsSync(path.join(boundedRoot, target)), `a bounded room's write tool must refuse ${target}, got: ${refusal || "written"}`);
	}

	if (failures.length > 0) throw new Error(`room connector checks failed:\n- ${failures.join("\n- ")}`);
	console.log("persistent-room-project-connectors-smoke: OK");
} catch (error) {
	if (process.env.SMOKE_VERBOSE) console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { gateway.close(); } catch {}
	try { githubRecorder.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
