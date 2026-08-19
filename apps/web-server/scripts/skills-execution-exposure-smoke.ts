import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";
import { computeSkillFilesDigest, sha256, writeSkillProvenance } from "../src/skills-store.js";

// Pins the REAL execution-exposure chain end to end, through a live room
// session — the seam every other skill smoke stubs. A synthetic gateway
// plays the model and calls read_skill; the server executes the actual tool
// with the actual resolveExecutionExposure closure from index.ts; the tool
// result then travels back to the gateway inside the follow-up completion
// request, where this smoke reads it. Asserted:
//
// - with localFiles + bash + a pinned execution approval, the served body
//   carries the on-disk skill dir and the bundled file name (the gate OPENS
//   on a real turn — the regression this smoke exists for: the original
//   gate read an env var that only existed during extension install, so it
//   could never open outside a test);
// - after revoke-execution, the same read serves the body PATH-FREE;
// - the path never appears for a room without bash.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skill-exposure-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const workspaceRoot = path.join(tempRoot, "workspace");
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });

// The skill under test: a user-store skill with one bundled script, planted
// exactly as accept would leave it (SKILL.md + files + provenance sidecar
// stamped LAST so the digest covers the tree).
const skillName = "convert-docs";
const skillDir = path.join(agentDir, "skills", skillName);
fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true, mode: 0o700 });
const skillManifest = `---\nname: ${skillName}\ndescription: Converts documents with a bundled script\n---\n\nRun the bundled script to convert documents.\n`;
fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillManifest, { mode: 0o600 });
fs.writeFileSync(path.join(skillDir, "scripts", "convert.py"), "print('converted')\n", { mode: 0o600 });
writeSkillProvenance(skillDir, { source: "upload", importedAt: new Date().toISOString(), license: null, sha256: sha256(skillManifest) });
assert(computeSkillFilesDigest(skillDir)?.files.some((f) => f.path === "scripts/convert.py"), "the planted skill must digest its bundled script");

// ---------------------------------------------------------------------------
// Synthetic gateway: first request of each turn answers with a read_skill
// tool call; the follow-up request (recognizable by the tool result riding
// in its messages) is captured and answered with plain text.
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
			// First leg of the turn: the model "decides" to read the skill.
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_read_skill", type: "function", function: { name: "read_skill", arguments: "" } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ name: skillName }) } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			// Second leg: the tool already ran server-side; capture what it said.
			capturedToolResults.push(toolMessages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 5, total_tokens: 155 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 20_000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

const WebSocketImpl: any = (await import("ws")).default;

// Run one prompt turn over the room WS and wait for the assistant's "done",
// which only arrives after the tool round-trip completed.
async function runTurn(agentId: string, conversationId: string): Promise<void> {
	// Prompting requires the room's current active thread; seed an empty one
	// under this conversation id first, like the client does on room open.
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
	socket.send(JSON.stringify({ type: "prompt", text: "Please read the convert-docs skill." }));
	const deadline = Date.now() + 30_000;
	const before = capturedToolResults.length;
	while (Date.now() < deadline) {
		if (capturedToolResults.length > before) {
			try { socket.close(); } catch {}
			return;
		}
		const errors = frames.filter((frame) => String(frame?.type ?? "").includes("error"));
		if (errors.length > 0) throw new Error(`turn errored before the tool round-trip: ${JSON.stringify(errors[0]).slice(0, 400)}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`turn did not complete a tool round-trip; frame types: ${frames.map((f) => f?.type).join(", ")}`);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
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
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-exposure-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Synthetic Gateway",
		roomModels: [{ modelId: "room-model", label: "Room Model" }],
		maintenanceModel: "room-model",
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: agentDir,
			EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// A bash room: localFiles workspace with the bash switch on.
	const room = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Exposure Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(room.status === 201, `room creation: expected 201, got ${room.status}: ${JSON.stringify(room.body)}`);
	const agentId = String(room.body?.agent?.id ?? room.body?.agent?.agentId ?? "");
	assert(agentId, `room creation must return an id, got ${JSON.stringify(room.body).slice(0, 300)}`);
	const workspace = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: workspaceRoot, displayLabel: "Exposure Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }),
	});
	assert(workspace.status === 200, `workspace default PUT: expected 200, got ${workspace.status}: ${JSON.stringify(workspace.body)}`);
	assert(workspace.body?.policy?.bashEnabled === true, "the room default must carry bashEnabled");

	const enable = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: skillName }) });
	assert(enable.status === 200, `skill enable: expected 200, got ${enable.status}: ${JSON.stringify(enable.body)}`);
	const approve = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "approve-execution", name: skillName }) });
	assert(approve.status === 200, `approve-execution: expected 200, got ${approve.status}: ${JSON.stringify(approve.body)}`);
	const approvedRow = (approve.body?.skills ?? []).find((s: any) => s.name === skillName);
	assert(approvedRow?.executeState === "approved", `the skill must report executeState approved, got ${JSON.stringify(approvedRow)}`);

	// 1. Approved + bash + localFiles: the REAL closure must expose the path.
	await runTurn(agentId, "conv-exposed");
	const exposed = capturedToolResults[0];
	assert(exposed.includes("Run the bundled script to convert documents."), `the tool result must carry the skill body, got: ${exposed.slice(0, 400)}`);
	assert(exposed.includes(skillDir), `the tool result must carry the on-disk skill dir (the gate must OPEN on a real turn), got: ${exposed.slice(0, 600)}`);
	assert(exposed.includes(JSON.stringify("scripts/convert.py")), `the tool result must list the bundled script, got: ${exposed.slice(0, 600)}`);

	// 2. Revoked: same room, next conversation — the body serves path-free.
	const revoke = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "revoke-execution", name: skillName }) });
	assert(revoke.status === 200, `revoke-execution: expected 200, got ${revoke.status}`);
	await runTurn(agentId, "conv-revoked");
	const revoked = capturedToolResults[1];
	assert(revoked.includes("Run the bundled script to convert documents."), "the revoked read must still serve the body");
	assert(!revoked.includes(skillDir), `a revoked approval must serve the body path-free, got: ${revoked.slice(0, 600)}`);

	// 3. A room without bash never sees the path, approval or not.
	const room2 = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "No Bash Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const agentId2 = String(room2.body?.agent?.id ?? room2.body?.agent?.agentId ?? "");
	assert(agentId2, "second room must create");
	const enable2 = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId2)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: skillName }) });
	assert(enable2.status === 200, `skill enable (room 2): expected 200, got ${enable2.status}`);
	const approve2 = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId2)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "approve-execution", name: skillName }) });
	assert(approve2.status === 200, `approve-execution (room 2): expected 200, got ${approve2.status}`);
	await runTurn(agentId2, "conv-no-bash");
	const noBash = capturedToolResults[2];
	assert(!noBash.includes(skillDir), `a room without bash must never see the path, got: ${noBash.slice(0, 600)}`);

	console.log("skills-execution-exposure-smoke: OK");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { gateway.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
