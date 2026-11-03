// The cost of a turn's cache writes, from the provider's report to the Wallet.
//
// Against a real spawned server and one synthetic Anthropic Messages endpoint
// (the Claude sign-in points there through models.json, so nothing leaves the
// machine and no real token exists), a room on Claude Opus 5.5 answers one
// turn whose report says 11,797 tokens were written to the cache for one hour
// and 577 came out:
//
// - the usage row carries the one-hour count and the cost Anthropic bills
//   (a one-hour write at twice the input price, not the five-minute rate);
// - the Wallet shows that total;
// - the same row stored at zero, as a turn priced later is, reprices to the
//   same total;
// - an older row without the one-hour count still prices every write at the
//   five-minute rate, as before.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(100);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-cache-write-cost-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const SIGN_IN = { type: "oauth", access: "sk-ant-oat01-synthetic-sign-in", refresh: "synthetic-refresh", expires: Date.now() + 365 * 24 * 3600 * 1000 };
const ON_OPUS = { provider: "anthropic", model: "claude-opus-5-5" };
// Claude Opus 5.5 per million tokens: $4 in, $20 out, $5 for a five-minute write; a one-hour write is twice the input price.
const INPUT = 3;
const WRITTEN_FOR_AN_HOUR = 11_797;
const OUTPUT = 577;
const BILLED = (INPUT * 4 + WRITTEN_FOR_AN_HOUR * 8 + OUTPUT * 20) / 1_000_000;
const AT_FIVE_MINUTE_RATE = (INPUT * 4 + WRITTEN_FOR_AN_HOUR * 5 + OUTPUT * 20) / 1_000_000;

let turns = 0;
function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		turns += 1;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const usage = { input_tokens: INPUT, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: WRITTEN_FOR_AN_HOUR, cache_creation: { ephemeral_1h_input_tokens: WRITTEN_FOR_AN_HOUR, ephemeral_5m_input_tokens: 0 } };
		sse(res, "message_start", { type: "message_start", message: { id: `msg_${turns}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answer from the synthetic endpoint." } });
		sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
		sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: OUTPUT } });
		sse(res, "message_stop", { type: "message_stop" });
		res.end();
	});
});

async function api(pathname: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: any; text: string }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: init.body ? { "content-type": "application/json" } : {} });
	const text = await response.text();
	let body: any = null;
	try { body = text ? JSON.parse(text) : null; } catch {}
	return { status: response.status, body, text };
}

const usageFile = path.join(appDir, "usage.jsonl");
const usageRows = (): any[] => (fs.existsSync(usageFile) ? fs.readFileSync(usageFile, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

/** Each row's cost and how it was priced, as the Wallet's export gives them, in ledger order. */
async function walletRows(): Promise<Array<{ cost: number; pricedAt: string }>> {
	const csv = await api("/api/usage/export.csv");
	assert(csv.status === 200, `the Wallet export answers, got ${csv.status}`);
	// The last three columns are cost, how it was priced and the tools (space-separated, no commas).
	return csv.text.trim().split("\n").slice(1).map((line) => {
		const cells = line.split(",");
		return { cost: Number(cells[cells.length - 3]), pricedAt: cells[cells.length - 2] };
	});
}

const WebSocketImpl: any = (await import("ws")).default;
let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: SIGN_IN }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "anthropic" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const room = agents.createPersistentAgentFromScaffoldInput({ displayName: "Cache Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(room, { conversation: ON_OPUS });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	// One turn in the room.
	const conversationId = "c_cache_0001";
	const opened = await api(`/api/persistent-agents/${room}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "home", items: [] }) });
	assert(opened.status === 200, `the conversation opens, got ${opened.status} ${opened.text}`);
	const frames: any[] = [];
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${room}&conversationId=${conversationId}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	await waitUntil(() => frames.some((frame) => frame.type === "ready"), "ready frame");
	socket.send(JSON.stringify({ type: "prompt", text: "A question that fills the cache." }));
	await waitUntil(() => usageRows().some((row) => row.agent === room && row.kind === "chat"), "the turn's usage row is written");
	await waitUntil(async () => (await api(`/api/persistent-agents/${room}/status`)).body?.activeThread?.inFlight === false, "the turn settled");
	socket.close();

	const row = usageRows().find((candidate) => candidate.agent === room && candidate.kind === "chat")!;
	assert(row.cacheWrite === WRITTEN_FOR_AN_HOUR && row.cacheWrite1h === WRITTEN_FOR_AN_HOUR && row.output === OUTPUT, `the row carries the written tokens and how many were written for an hour, got ${JSON.stringify(row)}`);
	assert(Math.abs(row.cost - BILLED) < 1e-9, `the row's cost prices a one-hour write at twice the input price: expected ${BILLED}, got ${row.cost} (the five-minute rate would be ${AT_FIVE_MINUTE_RATE})`);
	pass(`the usage row carries the one-hour writes and costs $${BILLED.toFixed(4)}, not $${AT_FIVE_MINUTE_RATE.toFixed(4)}`);

	const wallet = await api("/api/usage");
	const shown = wallet.body.totals.cost.billed + wallet.body.totals.cost.plan + wallet.body.totals.cost.unattributed;
	assert(Math.abs(shown - BILLED) < 1e-9 && wallet.body.totals.estimatedTurns === 0, `the Wallet shows the turn's own cost, got ${JSON.stringify(wallet.body.totals)}`);
	pass("the Wallet shows the same total");

	// The same row stored at zero, and an older row that predates the one-hour count.
	const { cacheWrite1h: _oneHour, ...olderRow } = row;
	fs.appendFileSync(usageFile, JSON.stringify({ ...row, ts: row.ts + 1, cost: 0 }) + "\n" + JSON.stringify({ ...olderRow, ts: row.ts + 2, cost: 0 }) + "\n");
	const [live, repriced, older] = await walletRows();
	assert(live.pricedAt === "turn" && Math.abs(live.cost - BILLED) < 1e-9, `the live row keeps its own cost, got ${JSON.stringify(live)}`);
	assert(repriced.pricedAt === "today" && Math.abs(repriced.cost - BILLED) < 1e-9, `a row stored at zero reprices to the turn's total, got ${JSON.stringify(repriced)}`);
	assert(older.pricedAt === "today" && Math.abs(older.cost - AT_FIVE_MINUTE_RATE) < 1e-9, `a row without the one-hour count prices as before, got ${JSON.stringify(older)}`);
	pass("a row stored at zero reprices to the same total, and an older row without the count prices as before");

	console.log("cache write cost smoke passed");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	await stopSmokeServer(server);
	endpoint.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
