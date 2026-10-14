// HiveMind asked across several rooms answers on the Memory default, and
// sends it only the memory of rooms whose own Memory model is on that same
// provider. Room A remembers with Claude (the default), rooms B and C with
// GPT. Asked across all rooms, or across A and B, Claude's request holds A's
// memory and never B's or C's, and the answer says how many rooms were left
// out. Asked across B and C only, nothing is sent and the reply is "no
// memory" with the same line. Asked about B alone, the room's own Memory
// model (GPT) reads B's memory, as before. A follow-up carries earlier answers
// only from the provider that answers now.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-hivemind-provider-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const CLAUDE = { provider: "fake-claude", model: "claude-fake" };
const GPT = { provider: "fake-gpt", model: "gpt-fake" };
const requests: Array<{ model: string; raw: string }> = [];
/** When set, the provider answers with these words instead of naming its model. */
let answerWith: string | null = null;

function sse(res: http.ServerResponse, event: string | null, payload: unknown): void {
	res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`);
}

const providers = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		requests.push({ model: String(body.model), raw });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const text = answerWith ?? `Answer from ${body.model}.`;
		if (String(req.url ?? "").includes("/messages")) {
			sse(res, "message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
			return;
		}
		const base = { id: `cmpl_${requests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		sse(res, null, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
		sse(res, null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

// A line in the room's Deep Memory only this room holds.
function plantMarker(agentId: string, marker: string): void {
	const l1bPath = path.join(agentsRoot, agentId, "L1b", "current.md");
	const l1b = fs.readFileSync(l1bPath, "utf-8");
	assert(/^## Deep Memory\s*$/m.test(l1b), `room ${agentId} has a Deep Memory section`);
	fs.writeFileSync(l1bPath, l1b.replace(/^## Deep Memory\s*$/m, `## Deep Memory\n\n- ${marker}`), "utf-8");
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => providers.listen(0, "127.0.0.1", resolve));
	const providerPort = (providers.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] },
			"fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: "openai-completions", models: [{ id: "gpt-fake", name: "GPT Fake", input: ["text"], contextWindow: 128000, maxTokens: 16000 }] },
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" }, "fake-gpt": { type: "api_key", key: "synthetic-gpt" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
		{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	roomModels.writeAiDefaults({ conversation: CLAUDE, memory: CLAUDE });
	const create = (displayName: string) => agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const roomA = create("Claude Memory Room");
	const roomB = create("GPT Memory Room");
	const roomC = create("Second GPT Room");
	roomModels.writeRoomModels(roomB, { memory: GPT });
	roomModels.writeRoomModels(roomC, { memory: GPT });
	plantMarker(roomA, "MARKER-ROOM-A the launch is in March.");
	plantMarker(roomB, "MARKER-ROOM-B the budget is private.");
	plantMarker(roomC, "MARKER-ROOM-C the client is private.");

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	type Turn = { role: "user" | "assistant"; content: string; provider?: string };
	const ask = async (rooms?: string[], history?: Turn[]) => {
		requests.length = 0;
		const res = await authedFetch(`${baseUrl}/api/memory/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "What is planned?", ...(rooms ? { rooms } : {}), ...(history ? { history } : {}) }) });
		assert(res.ok, `the ask answers, got ${res.status}`);
		return await res.json() as { ok: boolean; answer?: string; sources?: string[]; note?: string; reason?: string; message?: string; provider?: string };
	};
	const sent = () => requests.map((r) => r.raw).join("\n");
	// Read through a call: an assert on the length would narrow it for the rest of the file.
	const sentCount = () => requests.length;

	// 1. Across every room: Claude reads A's memory only.
	let reply = await ask();
	assert(reply.ok && reply.answer === "Answer from claude-fake.", `the ask across all rooms answers on Claude, got ${JSON.stringify(reply)}`);
	assert(sentCount() === 1 && requests[0]!.model === CLAUDE.model, `one request to Claude, got ${JSON.stringify(requests.map((r) => r.model))}`);
	assert(sent().includes("MARKER-ROOM-A"), "A's memory is sent");
	assert(!sent().includes("MARKER-ROOM-B") && !sent().includes("MARKER-ROOM-C"), "no memory of a room on another provider is sent");
	assert(JSON.stringify(reply.sources) === JSON.stringify(["Claude Memory Room"]), `the sources name A only, got ${JSON.stringify(reply.sources)}`);
	assert(reply.note === "Left out: GPT Memory Room and Second GPT Room, they use a different AI provider.", `the answer names the rooms left out, got ${JSON.stringify(reply.note)}`);
	assert(sent().includes("could not be read for this answer: GPT Memory Room, Second GPT Room"), "the model is told which rooms it could not read, so it never says a thing is recorded nowhere");

	// 2. Across A and B: the same, one room left out.
	reply = await ask([roomA, roomB]);
	assert(reply.ok && !sent().includes("MARKER-ROOM-B") && sent().includes("MARKER-ROOM-A"), `A and B: only A's memory is sent, got ${JSON.stringify(reply)}`);
	assert(reply.note === "Left out: GPT Memory Room, uses a different AI provider.", `one room left out, named, got ${JSON.stringify(reply.note)}`);

	// 3. Across B and C: every room left out, nothing sent, answered as no memory.
	reply = await ask([roomB, roomC]);
	assert(sentCount() === 0, `nothing is sent when every room is left out, got ${sentCount()}`);
	assert(!reply.ok && reply.reason === "no-memory" && reply.message === "Left out: GPT Memory Room and Second GPT Room, they use a different AI provider.", `every room left out says only that, got ${JSON.stringify(reply)}`);

	// 4. B alone: the room's own Memory model reads its memory, as before.
	reply = await ask([roomB]);
	assert(reply.ok && reply.answer === "Answer from gpt-fake." && sent().includes("MARKER-ROOM-B") && reply.note === undefined, `one room asks its own Memory model, got ${JSON.stringify(reply)}`);

	// 4b. A follow-up after B's answer, now across every room: Claude answers,
	// and B's earlier answer (GPT's, from B's memory) is not in what is sent;
	// Claude's own earlier answer and the person's questions are.
	const fromGpt = reply.provider;
	const claudeEarlier = await ask([roomA]);
	reply = await ask(undefined, [
		{ role: "user", content: "QUESTION-ONE about the budget" },
		{ role: "assistant", content: "EARLIER-GPT-ANSWER the budget is private.", ...(fromGpt ? { provider: fromGpt } : {}) },
		{ role: "user", content: "QUESTION-TWO about the launch" },
		{ role: "assistant", content: "EARLIER-CLAUDE-ANSWER the launch is in March.", ...(claudeEarlier.provider ? { provider: claudeEarlier.provider } : {}) },
	]);
	assert(reply.ok && sentCount() === 1 && requests[0]!.model === CLAUDE.model, `the follow-up answers on Claude, got ${JSON.stringify(reply)}`);
	assert(!sent().includes("EARLIER-GPT-ANSWER"), "an earlier answer from another provider is not sent");
	assert(sent().includes("EARLIER-CLAUDE-ANSWER") && sent().includes("QUESTION-ONE") && sent().includes("QUESTION-TWO"), "the person's questions and the same provider's answer are sent");
	assert(fromGpt === GPT.provider && claudeEarlier.provider === CLAUDE.provider, `each answer names the provider that gave it, got ${JSON.stringify([fromGpt, claudeEarlier.provider])}`);

	// 5. Every room on the default's provider: nothing left out, no line.
	reply = await ask([roomA]);
	assert(reply.ok && reply.note === undefined && sent().includes("MARKER-ROOM-A"), `a room on the default's provider has no line, got ${JSON.stringify(reply)}`);

	// 6. An answer cites the room, and the conversation's title or date when it helps: never an internal id.
	answerWith = "The launch is in March \u2014 Claude Memory Room \u00b7 RC-0001\nThe budget holds \u2014 Claude Memory Room \u00b7 RC-0002\u2013RC-0003\nThe date is set (m-0012).\nTake the m-150 exit.";
	reply = await ask([roomA]);
	answerWith = null;
	assert(reply.ok && reply.answer === "The launch is in March \u2014 Claude Memory Room\nThe budget holds \u2014 Claude Memory Room\nThe date is set.\nTake the m-150 exit.", `no internal id reaches the answer, and a real "m-150" stays, got ${JSON.stringify(reply.answer)}`);
	assert(sent().includes("Never write an id such as RC-0001 or m-0012"), "the model is asked to cite plainly");

	console.log("hivemind-memory-provider smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
