import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-task-list-api-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-task-list-api-agents-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 23000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 15000;
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

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
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
			EXXETA_PERSISTENT_AGENTS_ROOT: tempAgentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const created = await requestJson("/api/persistent-agents", {
		method: "POST",
		body: JSON.stringify({
			displayName: "Task List API Smoke",
			userName: "Synthetic User",
			preferredUserAddress: "Synthetic User",
		}),
	});
	assert(created.status === 201, `create room should succeed, got ${created.status}: ${JSON.stringify(created.body)}`);
	const agentId = String(created.body?.agent?.agentId ?? "");
	assert(agentId, "created room should return agentId");
	const encodedAgentId = encodeURIComponent(agentId);

	// Empty ledger: the route answers, with no rows and no dir created.
	const empty = await requestJson(`/api/persistent-agents/${encodedAgentId}/tasks`);
	assert(empty.status === 200, `empty task list should succeed, got ${empty.status}: ${JSON.stringify(empty.body)}`);
	assert(empty.body?.roomId === agentId && Array.isArray(empty.body?.tasks) && empty.body.tasks.length === 0, "empty ledger should list no tasks");

	// Seed ledger rows directly through the module (same files the server reads).
	const { createTaskLedgerRecord, finalizeTaskLedgerRecord } = await import("../src/persistent-room-task-ledger.js");
	createTaskLedgerRecord({ taskId: "tsk-api1", roomId: agentId, conversationId: "conv-a", templateId: "deck", templateVersion: 2, title: "Deck A" }, {}, new Date("2026-07-18T10:00:00.000Z"));
	finalizeTaskLedgerRecord(agentId, "tsk-api1", { outcome: "ok", summary: "done", artifacts: [{ relativePath: "tasks/tsk-api1/deck.html", bytes: 10, extension: "html" }] }, {}, new Date("2026-07-18T10:05:00.000Z"));
	createTaskLedgerRecord({ taskId: "tsk-api2", roomId: agentId, conversationId: "conv-b", templateId: "diagram-svg", templateVersion: 1, title: "Diagram B" }, {}, new Date("2026-07-18T11:00:00.000Z"));

	const listed = await requestJson(`/api/persistent-agents/${encodedAgentId}/tasks`);
	assert(listed.status === 200, `task list should succeed, got ${listed.status}`);
	assert(listed.body.tasks.length === 2, "both rows should list");
	assert(listed.body.tasks[0].taskId === "tsk-api2" && listed.body.tasks[1].taskId === "tsk-api1", "list should be newest-first");
	assert(listed.body.tasks[1].outcome === "ok" && listed.body.tasks[1].artifacts?.[0]?.relativePath === "tasks/tsk-api1/deck.html", "finalized row should carry outcome and artifacts");
	// Room-scoped history: the panel's origin disclosure needs each row's birth
	// conversation — the projection must expose it.
	assert(listed.body.tasks[0].conversationId === "conv-b" && listed.body.tasks[1].conversationId === "conv-a", "rows should expose their birth conversationId");

	const filtered = await requestJson(`/api/persistent-agents/${encodedAgentId}/tasks?conversationId=conv-a`);
	assert(filtered.status === 200 && filtered.body.tasks.length === 1 && filtered.body.tasks[0].taskId === "tsk-api1", "conversationId filter should narrow the list");

	// First-open stamp (status grammar, 2026-07-18): POST /viewed stamps once,
	// stays idempotent, and the list reflects it — the green dot's decay.
	const viewed = await requestJson(`/api/persistent-agents/${encodedAgentId}/tasks/tsk-api1/viewed`, { method: "POST" });
	assert(viewed.status === 200 && typeof viewed.body?.viewedAt === "string" && viewed.body.viewedAt.length > 0, `viewed stamp should return the timestamp, got ${viewed.status}: ${JSON.stringify(viewed.body)}`);
	const viewedAgain = await requestJson(`/api/persistent-agents/${encodedAgentId}/tasks/tsk-api1/viewed`, { method: "POST" });
	assert(viewedAgain.status === 200 && viewedAgain.body?.viewedAt === viewed.body.viewedAt, "the first stamp wins; a second POST changes nothing");
	const afterViewed = await requestJson(`/api/persistent-agents/${encodedAgentId}/tasks`);
	assert(afterViewed.body.tasks.find((t: any) => t.taskId === "tsk-api1")?.viewedAt === viewed.body.viewedAt, "the list exposes viewedAt");
	const viewedMissing = await requestJson(`/api/persistent-agents/${encodedAgentId}/tasks/tsk-nope/viewed`, { method: "POST" });
	assert(viewedMissing.status === 404, `stamping a missing row should 404, got ${viewedMissing.status}`);

	const unknown = await requestJson(`/api/persistent-agents/does-not-exist/tasks`);
	assert(unknown.status === 404, `unknown room should 404, got ${unknown.status}: ${JSON.stringify(unknown.body)}`);

	console.log("persistent-room task list API smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-60).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	}
}
