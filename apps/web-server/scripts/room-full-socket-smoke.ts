// A room holding as many remembered conversations as it can is refused at the
// chat socket with a coded frame and one plain sentence, not a bare close (which
// the client reads as a lost connection and redials forever). A room one short
// of the cap still opens. Boots the real server against an isolated HOME with
// real rooms, opened the way the web UI opens them.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-full-socket-"));
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
const { createPersistentAgentFromScaffoldInput, createPersistentAgentInstance, getPersistentAgentStatus } = await import("../src/persistent-agents.js");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
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

function setRecentContextEntries(agentId: string, count: number): void {
	const instance = createPersistentAgentInstance(agentId);
	const l1bPath = instance.l1bCurrentPath(instance.readAgentJson());
	const base = fs.readFileSync(l1bPath, "utf-8");
	const match = /^##\s+Recent Context\s*$/m.exec(base);
	assert(match?.index != null, "scaffold L1b should include Recent Context");
	const start = match.index + match[0].length;
	const entries = Array.from({ length: count }, (_, i) => `### RC-${String(i + 1).padStart(4, "0")} | OPEN | 2026-09-18 | Full room smoke ${i + 1}\n\n**Session arc:** Session ${i + 1} was talked through.\n\n**Body:**\n- Point ${i + 1}.\n\n**Parked:**\nNone\n`).join("\n");
	fs.writeFileSync(l1bPath, `${base.slice(0, start)}\n\n${entries}\n`, "utf-8");
}

type Frame = { type?: string; code?: string; message?: string };
const WebSocketImpl: any = (await import("ws")).default;

/** Saves the thread active and opens the socket, as the web UI does; collects frames until the close or the timeout. */
async function openRoom(roomId: string, threadId: string, timeoutMs = 8000, items: unknown[] = []): Promise<{ frames: Frame[]; closed: boolean }> {
	const saved = await authedFetch(`${baseUrl}/api/persistent-agents/${encodeURIComponent(roomId)}/threads/${threadId}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ state: "active", origin: "launcher", items }),
	});
	assert(saved.status === 200, `the thread save before the open: expected 200, got ${saved.status}: ${(await saved.text()).slice(0, 200)}`);
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${roomId}&conversationId=${threadId}&modelProvider=openai-compatible&model=gpt-5.5&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: Frame[] = [];
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	const closed = await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		socket.addEventListener("close", () => { clearTimeout(timer); resolve(true); });
		socket.addEventListener("message", () => { if (frames.some((frame) => frame.type === "ready")) { clearTimeout(timer); resolve(false); } });
	});
	try { socket.close(); } catch {}
	return { frames, closed };
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	const fullRoom = createPersistentAgentFromScaffoldInput({ displayName: "Nordwind Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.id;
	const nearRoom = createPersistentAgentFromScaffoldInput({ displayName: "Almost Full Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.id;
	const busyFullRoom = createPersistentAgentFromScaffoldInput({ displayName: "Scheduled Full Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.id;
	setRecentContextEntries(fullRoom, 20);
	setRecentContextEntries(busyFullRoom, 20);
	setRecentContextEntries(nearRoom, 19);
	assert(getPersistentAgentStatus(fullRoom).recentContext?.fullEntries === 20, "the full room should hold 20 remembered conversations");
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

	// 1. The full room: a coded frame with one plain sentence, then the close.
	const full = await openRoom(fullRoom, "pi_full_room_0001");
	const refusal = full.frames.find((frame) => frame.type === "error");
	assert(refusal, `the full room: expected an error frame before the close, got frames ${JSON.stringify(full.frames)} (closed ${full.closed})`);
	assert(refusal.code === "room_full", `the full room: expected code room_full, got ${JSON.stringify(refusal)}`);
	assert(full.closed, "the full room: the socket should close after the frame");
	const sentence = String(refusal.message ?? "");
	assert(sentence === "Nordwind Room holds 20 remembered conversations, as many as it can. Memorize them from Maintain on its Home card to start a new conversation.", `the full room's sentence: got ${JSON.stringify(sentence)}`);
	assert(!/[\u2192\u2014]|needs_absorb|persistent agent|session/i.test(sentence), `the sentence carries no arrow, dash or code words: ${sentence}`);
	console.log("  ok  a room at 20 gets the coded frame and one plain sentence, then the close");

	// The page's own sentence, for a frame that came without one: the same
	// full-room sentence, which the dialog smoke's no-bounce check matches too.
	const app = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web-ui", "src", "App.tsx"), "utf-8");
	const atFrame = app.indexOf('msg.code === "room_full"');
	const handler = app.slice(atFrame, app.indexOf("finishLeaveRoom", atFrame));
	assert(atFrame >= 0 && handler.includes("holds as many remembered conversations as it can. Memorize them from Maintain on its Home card to start a new conversation.") && !handler.includes("Memorize them first"), `the page's fallback for a frame with no sentence is the full-room sentence, got ${JSON.stringify(handler.slice(0, 900))}`);
	console.log("  ok  a frame with no sentence gets the same full-room sentence on the page");

	// 2. Every redial meets the same coded refusal.
	const again = await openRoom(fullRoom, "pi_full_room_0001");
	assert(again.frames.some((frame) => frame.type === "error" && frame.code === "room_full"), `a redial: expected room_full again, got ${JSON.stringify(again.frames)}`);
	assert(getPersistentAgentStatus(fullRoom).recentContext?.fullEntries === 20, "the refusal leaves the room's remembered conversations as they were");
	console.log("  ok  a redial meets the same coded refusal, and the room is unchanged");

	// 2b. A full room can still change its Memory model (here back to the default).
	const models = await authedFetch(`${baseUrl}/api/persistent-agents/${encodeURIComponent(fullRoom)}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ memory: null }) });
	assert(models.status === 200, `a full room's Memory model change: expected 200, got ${models.status}: ${(await models.text()).slice(0, 200)}`);
	console.log("  ok  a full room can still change its Memory model");

	// 3. One short of the cap, the room still opens.
	const near = await openRoom(nearRoom, "pi_near_room_0001", 20000);
	assert(near.frames.some((frame) => frame.type === "ready"), `the room at 19: expected ready, got ${JSON.stringify(near.frames)} (closed ${near.closed})`);
	assert(!near.frames.some((frame) => frame.code === "room_full"), "the room at 19 is not refused");
	console.log("  ok  a room at 19 still opens");

	// 4. A full room whose open conversation has messages (a scheduled task's) opens.
	const turns = [{ kind: "user", id: "u1", text: "The scheduled task's question." }, { kind: "assistant", id: "a1", text: "The scheduled task's answer." }];
	const busy = await openRoom(busyFullRoom, "pi_busy_full_0001", 20000, turns);
	assert(busy.frames.some((frame) => frame.type === "ready") && !busy.frames.some((frame) => frame.code === "room_full"), `a full room with messages: expected ready, got ${JSON.stringify(busy.frames)} (closed ${busy.closed})`);
	console.log("  ok  a room at 20 whose conversation has messages opens");

	console.log("room-full-socket smoke: PASS");
} catch (error) {
	console.error("room-full-socket smoke: FAIL:", (error as Error).message);
	console.error(serverOutput.slice(-20).join(""));
	console.error(`  temp root kept for inspection: ${tempRoot}`);
	process.exitCode = 1;
} finally {
	if (server) await stopSmokeServer(server);
	if (process.exitCode !== 1) fs.rmSync(tempRoot, { recursive: true, force: true });
}
