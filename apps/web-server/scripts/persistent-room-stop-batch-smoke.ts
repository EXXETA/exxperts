import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

// Stop while the command card waits, in a reply that asks for bash and then
// read_file on a PDF in one step. The card is asked in the runtime's prepare
// pass, so before the fix the runtime went on to prepare and run read_file with
// the already-aborted signal: the PDF's extraction ignores that signal, ran to
// its end and held the turn's ending. Against a real spawned server, a
// synthetic OpenAI-compatible gateway and a real room websocket, proves:
//
// 1. the turn Stop ended says so, and read_file comes back as "stopped before
//    it ran", never with the PDF's text;
// 2. no extraction started: the room's reading cache, which every finished
//    extraction writes, stays empty;
// 3. the next turn's request pairs both calls with one result each, and with
//    a yes to the card both tools run and the PDF is read (the allowed
//    neighbour: the same batch without a Stop).

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-stop-batch-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir, productAppRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const TURN_TOKEN = "TURN_TOKEN_STOP_BATCH";
const PDF_NAME = "report.pdf";
const PDF_TEXT = "Quarterly payment terms are sixty days";
const ANSWER = "Read the report.";
const STOPPED_TEXT = "the turn was stopped before it ran";

function pdfWithText(text: string): Buffer {
	const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
		`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
		"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
	];
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const object of objects) {
		offsets.push(Buffer.byteLength(body, "latin1"));
		body += object;
	}
	const xrefOffset = Buffer.byteLength(body, "latin1");
	let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

// The gateway: the person's message gets bash and read_file in one reply; a
// request whose last message is a tool result gets a short answer.
const gatewayRequests: Array<{ body: any }> = [];

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		let body: any = {};
		try { body = JSON.parse(raw); } catch {}
		const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
		gatewayRequests.push({ body });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${gatewayRequests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(body?.model ?? "room-model") };
		if (raw.includes(TURN_TOKEN) && messages.at(-1)?.role !== "tool") {
			const n = gatewayRequests.length;
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_ls_${n}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: `call_read_${n}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ name: PDF_NAME }) } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: ANSWER }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 140, completion_tokens: 5, total_tokens: 145 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

const waitUntil = waitEvery(100);

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function getStatus(agentId: string): Promise<any> {
	const response = await requestJson("/api/persistent-agents");
	assert(response.status === 200, `statuses GET should return 200, got ${response.status}`);
	const rows = response.body?.agents ?? response.body ?? [];
	const status = (Array.isArray(rows) ? rows : []).find((row: any) => row.id === agentId);
	assert(status, `status for ${agentId} should exist`);
	return status;
}

type Frame = Record<string, any>;
const WebSocketImpl: any = (await import("ws")).default;

class WsHarness {
	readonly frames: Frame[] = [];
	private constructor(private readonly socket: any) {
		socket.addEventListener("message", (event: { data: unknown }) => {
			try { this.frames.push(JSON.parse(String(event.data))); } catch {}
		});
	}

	static async connect(persistentAgentId: string, conversationId: string): Promise<WsHarness> {
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${persistentAgentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
		const harness = new WsHarness(socket);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
		});
		return harness;
	}

	send(frame: Frame): void {
		this.socket.send(JSON.stringify(frame));
	}

	close(): void {
		try { this.socket.close(); } catch {}
	}

	async waitFor(predicate: (frame: Frame) => boolean, label: string, fromIndex = 0, timeoutMs = 25_000): Promise<number> {
		const deadline = Date.now() + timeoutMs;
		let index = fromIndex;
		while (Date.now() < deadline) {
			for (; index < this.frames.length; index++) {
				if (predicate(this.frames[index])) return index;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`timed out waiting for ${label}; saw frame types: ${this.frames.map((frame) => frame.type).join(", ")}`);
	}
}

const isCard = (frame: Frame) => frame.type === "ui_request" && frame.kind === "confirm";
const isTurnEnd = (frame: Frame) => frame.type === "event" && frame.event?.type === "agent_end";
const stepText = (frames: Frame[], toolName: string): string | null => {
	const end = frames.find((frame) => frame.type === "event" && frame.event?.type === "tool_execution_end" && frame.event.toolName === toolName);
	return end ? String(end.event.result?.content?.[0]?.text ?? "") : null;
};
const readingCacheFiles = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let ws: WsHarness | null = null;

try {
	const gatewayPort = await freePort();
	await new Promise<void>((resolve) => gateway.listen(gatewayPort, "127.0.0.1", resolve));
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
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-stop-batch-key" } }, null, 2), { mode: 0o600 });
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
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 30_000);

	const room = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Stop Batch Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(room.status === 201, `room creation should return 201, got ${room.status}: ${JSON.stringify(room.body).slice(0, 300)}`);
	const agentId = String(room.body?.agent?.id ?? "");
	assert(agentId, "room creation should return an agent id");
	// Full access with the terminal on, so the room asks before it runs a command.
	const workspaceRoot = path.join(tempRoot, "workspace");
	fs.mkdirSync(workspaceRoot, { recursive: true });
	fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "notes\n");
	const workspace = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: workspaceRoot, displayLabel: "Batch Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }) });
	assert(workspace.status === 200, `Full access with the terminal on, got ${workspace.status}: ${JSON.stringify(workspace.body).slice(0, 300)}`);
	// A PDF in the room's Attachments that has never been read: reading it means extracting it.
	const { persistentRoomShelfDirPath, persistentRoomReadingCacheDirPath } = await import("../src/persistent-room-shelf.js");
	const shelfDir = persistentRoomShelfDirPath(agentId);
	fs.mkdirSync(shelfDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(shelfDir, PDF_NAME), pdfWithText(PDF_TEXT));
	const readingCacheDir = persistentRoomReadingCacheDirPath(agentId);

	const conversationId = `smokeconv_stop_batch_${Date.now().toString(36)}`;
	const seeded = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}`, {
		method: "PUT",
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }),
	});
	assert(seeded.status === 200, `thread seed should return 200, got ${seeded.status}`);
	ws = await WsHarness.connect(agentId, conversationId);
	await ws.waitFor((frame) => frame.type === "ready", "ready frame");

	// --- 1 and 2. Stop while the card waits: the turn ends, read_file never runs ---
	ws.send({ type: "prompt", text: `List the files and read the report, please. ${TURN_TOKEN}` });
	await ws.waitFor(isCard, "the command card", 0, 30_000);
	const framesAtStop = ws.frames.length;
	ws.send({ type: "abort" });
	const stopEnd = ws.frames[await ws.waitFor(isTurnEnd, "the stopped turn's end", framesAtStop, 15_000)];
	assert(stopEnd.event.endedBy === "stop", `the turn Stop ended says endedBy "stop", got ${JSON.stringify(stopEnd.event.endedBy)}`);
	await waitUntil(async () => (await getStatus(agentId)).activeThread?.inFlight === false, "the stopped turn settled", 20_000);
	const stoppedRead = stepText(ws.frames.slice(framesAtStop), "read_file");
	assert(stoppedRead !== null && stoppedRead.includes(STOPPED_TEXT), `read_file comes back as stopped before it ran, got ${JSON.stringify(stoppedRead)}`);
	assert(!stoppedRead.includes(PDF_TEXT), "the stopped turn never read the PDF's text");
	assert(readingCacheFiles(readingCacheDir).length === 0, `no extraction started after Stop, but the reading cache holds ${JSON.stringify(readingCacheFiles(readingCacheDir))}`);
	assert(gatewayRequests.length === 1, `the stopped turn asked the model once, got ${gatewayRequests.length}`);
	console.log("  Stop with the card open: the turn ended, read_file came back stopped before it ran, no extraction started");

	// --- 3. The same batch without a Stop: both calls run, and the PDF is read ---
	const framesAtNext = ws.frames.length;
	ws.send({ type: "prompt", text: `Again, please. ${TURN_TOKEN}` });
	const card = ws.frames[await ws.waitFor(isCard, "the next turn's command card", framesAtNext, 30_000)];
	ws.send({ type: "ui_response", id: card.id, value: true });
	const nextEnd = ws.frames[await ws.waitFor(isTurnEnd, "the next turn's end", framesAtNext, 30_000)];
	assert(nextEnd.event.endedBy === undefined, `a turn that ran to its end carries no endedBy, got ${JSON.stringify(nextEnd.event.endedBy)}`);
	const nextFrames = ws.frames.slice(framesAtNext);
	assert(String(stepText(nextFrames, "bash") ?? "").includes("notes.txt"), `the approved command ran, got ${JSON.stringify(stepText(nextFrames, "bash"))}`);
	assert(String(stepText(nextFrames, "read_file") ?? "").includes(PDF_TEXT), `read_file read the PDF, got ${JSON.stringify(stepText(nextFrames, "read_file"))}`);
	assert(readingCacheFiles(readingCacheDir).length > 0, "a finished extraction writes the reading cache");
	// The next turn's first request carries the stopped step: each call paired with exactly one result.
	const nextRequest = gatewayRequests[1].body;
	const stoppedStep = (nextRequest.messages as any[]).find((message) => message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length === 2);
	assert(stoppedStep, "the next turn's request carries the stopped step's two calls");
	const resultIds = (nextRequest.messages as any[]).filter((message) => message?.role === "tool").map((message) => message.tool_call_id);
	const callIds = stoppedStep.tool_calls.map((call: any) => call.id);
	assert(JSON.stringify(resultIds) === JSON.stringify(callIds), `each stopped call has one result, got calls ${JSON.stringify(callIds)} and results ${JSON.stringify(resultIds)}`);
	console.log("  without a Stop the same batch runs both tools and reads the PDF; the stopped step's calls each kept one result");

	ws.close();
	ws = null;
	await waitUntil(async () => !(await getStatus(agentId)).activeLock, "room lock released", 20_000);
	console.log("persistent-room-stop-batch-smoke: OK");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { ws?.close(); } catch {}
	try { (gateway as any).closeAllConnections?.(); } catch {}
	try { gateway.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
