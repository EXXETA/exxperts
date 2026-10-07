// A long conversation stays openable: the thread save carries every chat item
// of the open conversation, and opening a room from Home fetches the thread and
// saves it again before it opens. Boots the real server against an isolated
// HOME with a real room, saves a conversation of about 2 MB, reads it back and
// saves it again the way the open does.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-thread-save-size-"));
const tempHome = path.join(tempRoot, "home");
const tempAgentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempAgentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(tempAgentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(tempAgentRuntimeRoot, { recursive: true, mode: 0o700 });
fs.writeFileSync(
	path.join(tempAgentRuntimeRoot, "models.json"),
	JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "gpt-5.5", name: "GPT-5.5", contextWindow: 128000, maxTokens: 16384 }] } } }, null, 2),
);
fs.writeFileSync(path.join(tempAgentRuntimeRoot, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-smoke-key" } }));
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;
const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 28000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

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

// A conversation of many tool calls, each result near the runtime's 50 KB cut.
function longItems(): unknown[] {
	const items: unknown[] = [];
	const result = "x".repeat(48 * 1024);
	for (let i = 0; i < 42; i++) {
		items.push({ kind: "user", id: `u${i}`, text: `Read part ${i}.`, ts: 1_759_000_000_000 + i });
		items.push({ kind: "tool", id: `t${i}`, name: "read", args: { path: `part-${i}.md` }, status: "done", result });
		items.push({ kind: "assistant", id: `a${i}`, text: `Part ${i} read.`, ts: 1_759_000_000_500 + i });
	}
	return items;
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	const roomId = createPersistentAgentFromScaffoldInput({ displayName: "Long Conversation Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.id;
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
			EXXPERTS_CODING_AGENT_DIR: tempAgentRuntimeRoot,
			EXXETA_PERSISTENT_AGENTS_ROOT: tempAgentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const threadUrl = `${baseUrl}/api/persistent-agents/${encodeURIComponent(roomId)}/threads/pi_long_conversation01`;
	const save = (items: unknown[]) => authedFetch(threadUrl, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ state: "active", origin: "home", items }),
	});

	// 1. A save of about 2 MB is accepted and every item is stored.
	const items = longItems();
	const bytes = Buffer.byteLength(JSON.stringify({ state: "active", origin: "home", items }));
	assert(bytes > 2_000_000 && bytes < 2_300_000, `the save should be about 2 MB, got ${bytes} bytes`);
	const saved = await save(items);
	const savedText = await saved.text();
	assert(saved.status === 200, `a ${bytes}-byte save: expected 200, got ${saved.status}: ${savedText.slice(0, 200)}`);
	console.log(`  ok  a ${bytes}-byte thread save is accepted`);

	// 2. The room opens again: the thread reads back whole, and the open's
	// re-save of everything it read is accepted too.
	const fetched = await authedFetch(threadUrl);
	assert(fetched.status === 200, `reading the thread back: expected 200, got ${fetched.status}`);
	const record = ((await fetched.json()) as { thread: { items: Array<{ id: string; result?: string }> } }).thread;
	assert(record.items.length === items.length, `stored items: expected ${items.length}, got ${record.items.length}`);
	assert(record.items.filter((item) => item.result?.length === 48 * 1024).length === 42, "every tool result is stored whole");
	console.log(`  ok  all ${items.length} items are stored`);
	const reopened = await save(record.items);
	assert(reopened.status === 200, `the open's re-save: expected 200, got ${reopened.status}`);
	console.log("  ok  the room opens again (read back, saved again)");

	console.log("thread-save-size smoke: PASS");
} catch (error) {
	console.error("thread-save-size smoke: FAIL:", (error as Error).message);
	console.error(serverOutput.slice(-20).join(""));
	console.error(`  temp root kept for inspection: ${tempRoot}`);
	process.exitCode = 1;
} finally {
	if (server) await stopSmokeServer(server);
	if (process.exitCode !== 1) fs.rmSync(tempRoot, { recursive: true, force: true });
}
