// A long conversation keeps its newest items. Past the item cap the oldest are
// cut, one notice stands at the head, and the notice never doubles when the
// browser sends it back. An answer the room lands while nobody is in it is
// stored on a full conversation, and survives a later save from a browser that
// has not seen it. Boots the real server against an isolated HOME with a real
// room; the landing is written the way the server's own landing writes it.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-thread-item-cap-"));
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
const { createPersistentAgentFromScaffoldInput, getPersistentAgentThread, writePersistentAgentThread } = await import("../src/persistent-agents.js");

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

type Item = { kind: string; id: string; text?: string };
const NOTICE_ID = "thread-earlier-items-omitted";

function chat(from: number, to: number): Item[] {
	return Array.from({ length: to - from }, (_, k) => ({ kind: (from + k) % 2 ? "assistant" : "user", id: `i${from + k}`, text: `message ${from + k}` }));
}

function describe(items: Item[]): string {
	return `${items.length} items, ${items[0]?.id} .. ${items.at(-1)?.id}`;
}

function assertRun(items: Item[], from: number, to: number, label: string): void {
	const notices = items.filter((item) => item.id === NOTICE_ID).length;
	const rest = items.filter((item) => item.id !== NOTICE_ID);
	assert(notices === 1 && items[0]?.id === NOTICE_ID && items[0]?.kind === "system", `${label}: expected one notice at the head, got ${notices} (${describe(items)})`);
	assert(rest.length === to - from && rest[0]?.id === `i${from}` && rest.at(-1)?.id === `i${to - 1}`, `${label}: expected i${from}..i${to - 1}, got ${describe(rest)}`);
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

	const threadId = "pi_long_conversation01";
	const threadUrl = `${baseUrl}/api/persistent-agents/${encodeURIComponent(roomId)}/threads/${threadId}`;
	const save = async (items: unknown[]): Promise<void> => {
		const response = await authedFetch(threadUrl, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ state: "active", origin: "home", items }),
		});
		assert(response.status === 200, `a save of ${items.length} items: expected 200, got ${response.status}: ${(await response.text()).slice(0, 200)}`);
	};
	const read = async (): Promise<Item[]> => {
		const response = await authedFetch(threadUrl);
		assert(response.status === 200, `reading the thread back: expected 200, got ${response.status}`);
		return ((await response.json()) as { thread: { items: Item[] } }).thread.items;
	};

	// 1. Past the old count, every item is still stored, and nothing is cut.
	await save(chat(0, 1100));
	const all = await read();
	assert(all.length === 1100 && all[0]?.id === "i0" && all.at(-1)?.id === "i1099" && !all.some((item) => item.id === NOTICE_ID), `1100 items: expected i0..i1099 and no notice, got ${describe(all)}`);
	console.log("  ok  a save of 1100 items keeps i0..i1099");

	// 2. Past the cap, the newest are kept and one notice stands at the head.
	await save(chat(0, 2100));
	const cut = await read();
	assertRun(cut, 100, 2100, "2100 items");
	console.log("  ok  a save of 2100 items keeps i100..i2099 plus the notice");

	// 3. The browser sends the notice back: the same items, never a second notice,
	// and no item lost to the notice. One more message moves the window by one.
	await save(cut);
	assertRun(await read(), 100, 2100, "the cut thread saved again");
	await save([...cut, ...chat(2100, 2101)]);
	const moved = await read();
	assertRun(moved, 101, 2101, "the cut thread plus one");
	console.log("  ok  saving a cut thread again keeps 2000 + 1 items, and one more message moves the window by one");

	// 4. An answer lands while nobody is in the room: the server's landing write
	// appends to the stored items, and the full thread stores it.
	const current = getPersistentAgentThread(roomId, threadId);
	assert(current, "the thread exists");
	const landedUser = { kind: "user", id: "detached-user-turn1", text: "A question asked before leaving." };
	const landedAnswer = { kind: "assistant", id: "detached-assistant-turn1", text: "The answer that landed while nobody was in the room.", streaming: false };
	writePersistentAgentThread(roomId, threadId, { state: "standby", origin: current.origin, model: current.model, items: [...current.items, landedUser, landedAnswer] }, { allowInactiveProfileModel: true, keepRuntimeIfMoved: true });
	const landed = await read();
	assert(landed.at(-1)?.id === "detached-assistant-turn1" && landed.at(-2)?.id === "detached-user-turn1", `the landing: expected it at the end, got ${describe(landed)}`);
	assert(landed.length === 2001 && landed.filter((item) => item.id === NOTICE_ID).length === 1 && landed[0]?.id === NOTICE_ID, `the landing: expected 2000 + 1 items and one notice, got ${describe(landed)}`);
	console.log("  ok  an answer landed on a full thread is stored");

	// 5. A browser that has not seen the landing saves its older list: the landed
	// answer is kept.
	await save(moved);
	const afterStale = await read();
	assert(afterStale.some((item) => item.id === "detached-assistant-turn1"), `a later save without the landing dropped it: ${describe(afterStale)}`);
	assert(afterStale.filter((item) => item.id === NOTICE_ID).length === 1 && afterStale[0]?.id === NOTICE_ID && afterStale.length === 2001, `after the later save: expected 2000 + 1 items and one notice, got ${describe(afterStale)}`);
	console.log("  ok  a later save from a browser that has not seen the landing keeps it");

	console.log("thread-item-cap smoke: PASS");
} catch (error) {
	console.error("thread-item-cap smoke: FAIL:", (error as Error).message);
	console.error(serverOutput.slice(-20).join(""));
	console.error(`  temp root kept for inspection: ${tempRoot}`);
	process.exitCode = 1;
} finally {
	if (server) await stopSmokeServer(server);
	if (process.exitCode !== 1) fs.rmSync(tempRoot, { recursive: true, force: true });
}
