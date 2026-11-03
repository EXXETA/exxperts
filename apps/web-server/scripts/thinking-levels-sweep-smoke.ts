import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, freePort, smokeHomeEnv, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import { runSweep, type SweepRow } from "./thinking-levels-sweep.js";

// The live thinking-level sweep, proved offline: a real server with the
// recorder preloaded, a fake OpenAI-compatible provider, and three models.
//   1. honest-model: every rung sends the effort its label names, and its off
//      rung ("none") stops the thinking. The sweep flags nothing.
//   2. silent-model: the same dial, but its requests carry no effort at all.
//      The sweep flags every rung, its "none" rung included.
//   3. stubborn-model: its off rung sends "none" and the provider thinks
//      anyway. The sweep flags that rung as an off that still thought.
//   4. flaky-model: its first message fails three times over (the client's
//      own retries, then the room's), then answers. The rung is judged on
//      the answer that came through, and its cost covers every attempt.
//   5. slow-model: its first message never finishes, and while it hangs one
//      status read is cut and the next one stalls. The sweep reads again,
//      stops that turn at its timeout, flags the rung and goes on.
//   6. tooler-model: its first message calls a memory tool, thinking in that
//      step only, then answers in three characters, so the room asks it once
//      more for a real answer. The rung counts all three calls and their
//      cost, and its off rung is flagged for the thinking in the tool step.
//   7. broken-model: every call fails, so the room keeps retrying. The sweep
//      stops the turn at its timeout, wherever the retries are, and goes on.
// The recorder refuses to start on a log it cannot write, and refuses a call
// it cannot log later, so a sweep never pays for calls it cannot see.
// The fake also keeps what it received, so the recorder's account of every
// request is checked against the request as it arrived. The sweeps reach the
// server through a proxy that holds the room socket's frames back, so a
// status read that says the turn is over arrives before the turn's last
// frames, and that cuts or stalls status reads on cue.

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-sweep-smoke-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const recorderLog = path.join(tempHome, "recorder.jsonl");
const tsvOut = path.join(tempHome, "sweep-fake.tsv");
const recorderUrl = pathToFileURL(path.join(scriptDir, "thinking-levels-sweep-recorder.mjs")).href;
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// What the fake provider received, in arrival order: the model and the
// reasoning_effort field (null when the request had none).
const received: Array<{ model: string; reasoningEffort: string | null }> = [];
const FLAKY_FAILURES = 3;
const TOOL_STEP_REASONING = 5;
let flakyFailures = 0;
let slowHeld = false;
let slowClosed = false;
const SOCKET_DELAY_MS = 600;
// What the proxy does to the next status reads (GET /api/persistent-agents),
// armed once slow-model's answer hangs.
let statusTraps: Array<"cut" | "stall"> = [];
let statusTrapsSprung = 0;

function sse(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const fakeProvider = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const parsed = JSON.parse(body || "{}");
		const model = String(parsed.model ?? "");
		const effort = typeof parsed.reasoning_effort === "string" ? parsed.reasoning_effort : null;
		received.push({ model, reasoningEffort: effort });
		if (model === "flaky-model" && flakyFailures < FLAKY_FAILURES) {
			flakyFailures++;
			res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "overloaded, try again" } }));
			return;
		}
		if (model === "broken-model") {
			res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "broken for good" } }));
			return;
		}
		if (model === "tooler-model" && !(parsed.messages ?? []).some((message: any) => message.role === "tool")) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const head = { id: `cmpl_${received.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
			res.write(sse({ ...head, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_memory", type: "function", function: { name: "memory_search", arguments: JSON.stringify({ query: "17 times 23" }) } }] }, finish_reason: null }] }));
			res.write(sse({ ...head, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37, completion_tokens_details: { reasoning_tokens: TOOL_STEP_REASONING } } }));
			res.write("data: [DONE]\n\n");
			res.end();
			return;
		}
		if (model === "slow-model" && !slowHeld) {
			// Holds the first answer open after its first words, as a provider
			// that stalls mid-answer does.
			slowHeld = true;
			statusTraps = ["cut", "stall"];
			res.on("close", () => { slowClosed = true; });
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(sse({ id: "cmpl_slow", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant", content: "3" }, finish_reason: null }] }));
			return;
		}
		// Thinks unless told "none"; stubborn-model thinks whatever it is told.
		const reasoningTokens = model === "stubborn-model" || (effort !== null && effort !== "none") ? 9 : 0;
		res.writeHead(200, { "content-type": "text/event-stream" });
		const head = { id: `cmpl_${received.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
		res.write(sse({ ...head, choices: [{ index: 0, delta: { role: "assistant", content: "391" }, finish_reason: null }] }));
		res.write(sse({ ...head, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 2 + reasoningTokens, total_tokens: 32 + reasoningTokens, completion_tokens_details: { reasoning_tokens: reasoningTokens } } }));
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

// A byte proxy to the server. The room socket's frames reach the sweep
// SOCKET_DELAY_MS late, in order; plain requests pass at once, unless a
// status trap is armed.
const proxy = net.createServer((client) => {
	const upstream = net.connect(port, "127.0.0.1");
	let socketConnection: boolean | null = null;
	let stalled = false;
	const toClient = (deliver: () => void) => (socketConnection ? setTimeout(deliver, SOCKET_DELAY_MS) : deliver());
	client.on("data", (chunk) => {
		if (stalled) return;
		const text = chunk.toString("latin1");
		socketConnection ??= text.startsWith("GET /ws");
		if (!socketConnection && statusTraps.length > 0 && /^GET \/api\/persistent-agents HTTP/m.test(text)) {
			const trap = statusTraps.shift();
			statusTrapsSprung++;
			if (trap === "cut") {
				client.destroy();
				upstream.destroy();
				return;
			}
			stalled = true;
			return;
		}
		upstream.write(chunk);
	});
	upstream.on("data", (chunk) => toClient(() => { if (!client.destroyed) client.write(chunk); }));
	upstream.on("end", () => toClient(() => client.end()));
	upstream.on("error", () => client.destroy());
	client.on("error", () => upstream.destroy());
	client.on("close", () => upstream.destroy());
});

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
let passes = 0;
function pass(label: string): void {
	passes += 1;
	console.log(`  ok ${label}`);
}

function rowsOf(rows: SweepRow[], model: string): SweepRow[] {
	return rows.filter((row) => row.model === model);
}

try {
	await new Promise<void>((resolve) => fakeProvider.listen(0, "127.0.0.1", resolve));
	const fakePort = (fakeProvider.address() as AddressInfo).port;

	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(tempHome, ".exxperts", "app"), { recursive: true, mode: 0o700 });
	const dial = { off: "none", minimal: null, medium: null };
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"openai-compatible": {
				name: "Fake Provider",
				baseUrl: `http://127.0.0.1:${fakePort}/v1`,
				api: "openai-completions",
				models: [
					{ id: "honest-model", name: "Honest Model", contextWindow: 128000, maxTokens: 16384, reasoning: true, thinkingLevelMap: dial },
					{ id: "silent-model", name: "Silent Model", contextWindow: 128000, maxTokens: 16384, reasoning: true, thinkingLevelMap: dial, compat: { supportsReasoningEffort: false } },
					{ id: "stubborn-model", name: "Stubborn Model", contextWindow: 128000, maxTokens: 16384, reasoning: true, thinkingLevelMap: dial },
					{ id: "flaky-model", name: "Flaky Model", contextWindow: 128000, maxTokens: 16384, reasoning: true, thinkingLevelMap: dial },
					{ id: "slow-model", name: "Slow Model", contextWindow: 128000, maxTokens: 16384, reasoning: true, thinkingLevelMap: dial },
					// Priced, so the cost of every call in a turn shows.
					{ id: "tooler-model", name: "Tooler Model", contextWindow: 128000, maxTokens: 16384, reasoning: true, thinkingLevelMap: dial, cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 } },
					{ id: "broken-model", name: "Broken Model", contextWindow: 128000, maxTokens: 16384, reasoning: true, thinkingLevelMap: dial },
				],
			},
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-sweep-key" } }), { mode: 0o600 });
	fs.writeFileSync(path.join(tempHome, ".exxperts", "app", "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Fake Provider",
		roomModels: ["honest-model", "silent-model", "stubborn-model", "flaky-model", "slow-model", "tooler-model", "broken-model"].map((modelId) => ({ modelId, label: modelId })),
		maintenanceModel: "honest-model",
	}), { mode: 0o600 });
	fs.writeFileSync(path.join(tempHome, ".exxperts", "app", "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }), { mode: 0o600 });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, {
			...SMOKE_SERVER_AUTH_ENV,
			PORT: String(port),
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: agentDir,
			// An inherited room store would take the fake rooms; they belong in the temp home.
			EXXETA_PERSISTENT_AGENTS_ROOT: path.join(tempHome, ".exxperts", "app", "personalized-agents"),
			OPENAI_API_KEY: undefined,
			ANTHROPIC_API_KEY: undefined,
			NODE_OPTIONS: `--import ${JSON.stringify(recorderUrl)}`,
			THINKING_SWEEP_LOG: recorderLog,
			THINKING_SWEEP_HOSTS: `127.0.0.1:${fakePort}`,
		}) as NodeJS.ProcessEnv,
	}) as ChildProcessWithoutNullStreams;
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, base, 30_000);
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	const proxyBase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

	// --- The recorder will not start on a log it cannot write ----------------
	const recorderStart = (log: string) => spawnSync(process.execPath, ["--import", recorderUrl, "-e", "0"], { env: { ...process.env, THINKING_SWEEP_LOG: log }, encoding: "utf8" });
	const unwritable = recorderStart(path.join(tempHome, "missing-folder", "recorder.jsonl"));
	assert(unwritable.status !== 0 && /THINKING_SWEEP_LOG/.test(unwritable.stderr), `the recorder should refuse an unwritable log, got status ${unwritable.status}: ${unwritable.stderr.slice(-300)}`);
	const writable = recorderStart(path.join(tempHome, "writable.jsonl"));
	assert(writable.status === 0, `the recorder should start on a writable log, got status ${writable.status}: ${writable.stderr.slice(-300)}`);
	pass("the recorder refuses to start on a log it cannot write, and starts on one it can");

	// --- The recorder refuses a call it can no longer log --------------------
	// The probe serves itself on 127.0.0.1, removes (or keeps) the log's folder,
	// then makes one provider call: it reports whether the call left and
	// whether its server got it.
	const probe = `import http from "node:http"; import fs from "node:fs";
let got = 0;
const server = http.createServer((req, res) => { got++; res.end("{}"); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
if (process.env.PROBE_DROP_LOG) fs.rmSync(process.env.PROBE_DIR, { recursive: true, force: true });
let outcome = "sent";
try { await fetch("http://127.0.0.1:" + server.address().port + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "probe-model" }) }); } catch (error) { outcome = "refused: " + (error.cause?.message ?? error.message); }
server.close();
console.log(JSON.stringify({ outcome, got }));`;
	const probeCall = (dropLog: boolean) => {
		const dir = fs.mkdtempSync(path.join(tempHome, "probe-"));
		const run = spawnSync(process.execPath, ["--import", recorderUrl, "--input-type=module", "-e", probe], { env: { ...process.env, THINKING_SWEEP_LOG: path.join(dir, "recorder.jsonl"), THINKING_SWEEP_HOSTS: "127.0.0.1", PROBE_DIR: dir, ...(dropLog ? { PROBE_DROP_LOG: "1" } : {}) }, encoding: "utf8" });
		return JSON.parse(run.stdout.trim().split("\n").at(-1) || "{}");
	};
	const lostLog = probeCall(true);
	assert(String(lostLog.outcome).startsWith("refused") && /cannot log/.test(lostLog.outcome) && lostLog.got === 0, `a call the recorder cannot log should never leave: ${JSON.stringify(lostLog)}`);
	const keptLog = probeCall(false);
	assert(keptLog.outcome === "sent" && keptLog.got === 1, `a call the recorder can log should leave: ${JSON.stringify(keptLog)}`);
	pass("a call the recorder can no longer log is refused before it leaves, and one it can log is sent");

	const sweepOptions = { base: proxyBase, token: SMOKE_AUTH_TOKEN, provider: "openai-compatible", route: "fake", log: recorderLog, out: tsvOut, maxUsd: 1 };
	let badBudget = "";
	await runSweep({ ...sweepOptions, maxUsd: Number.NaN }).catch((error: Error) => { badBudget = error.message; });
	assert(/max-usd/.test(badBudget), `a budget that is not a number should be refused, got ${JSON.stringify(badBudget)}`);
	pass("a budget that is not a number is refused before anything is sent");

	const result = await runSweep({ ...sweepOptions, models: ["honest-model", "silent-model", "stubborn-model", "flaky-model", "tooler-model"] });

	// --- The recorder reads the request as it left ---------------------------
	const recorded = fs.readFileSync(recorderLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.kind === "request");
	assert(recorded.length === received.length && recorded.length > 0, `the recorder should log every request the provider got: logged ${recorded.length}, received ${received.length}`);
	for (const [index, request] of recorded.entries()) {
		assert(request.model === received[index].model && (request.sent.reasoning_effort ?? null) === received[index].reasoningEffort, `recorded request ${index} should match what arrived: ${JSON.stringify(request)} vs ${JSON.stringify(received[index])}`);
		assert(!JSON.stringify(request).toLowerCase().includes("authorization") && !JSON.stringify(request).includes("messages"), "the recorder keeps the thinking fields only");
	}
	pass("the recorder logs each request's thinking fields as the provider received them, and nothing else");

	// --- 1. A model whose rungs send what they say ---------------------------
	const honest = rowsOf(result.rows, "honest-model");
	assert(JSON.stringify(honest.map((row) => row.label)) === JSON.stringify(["none", "low", "high"]), `honest-model should offer none, low and high, got ${JSON.stringify(honest.map((row) => row.label))}`);
	for (const row of honest) {
		assert(row.sent === `reasoning_effort="${row.label}"` && row.accepted === "yes", `honest-model's ${row.label} rung should send its own label: ${JSON.stringify(row)}`);
		assert(row.flags.length === 0, `honest-model's ${row.label} rung should not be flagged: ${row.flags.join("; ")}`);
	}
	assert(honest[0].reasoningTokens === 0 && honest[2].reasoningTokens === 9, `the answers' thinking should be read back: ${JSON.stringify(honest.map((row) => row.reasoningTokens))}`);
	pass("a rung that sends its label and an off that stops the thinking are not flagged");

	// --- 2. A label that sends something else --------------------------------
	const silent = rowsOf(result.rows, "silent-model");
	assert(silent.length === 3, `silent-model should have three rows, got ${silent.length}`);
	for (const row of silent) {
		assert(row.sent === "nothing", `silent-model's ${row.label} rung should be recorded as sending nothing: ${row.sent}`);
		assert(row.flags.some((flag) => flag.includes(`"${row.label}" sent nothing`)), `silent-model's ${row.label} rung should be flagged: ${JSON.stringify(row.flags)}`);
	}
	pass("a rung shown as none that sends no field is flagged, and so is every other silent rung");

	// --- 3. An off rung that still thinks ------------------------------------
	const stubborn = rowsOf(result.rows, "stubborn-model");
	assert(stubborn[0]?.label === "none" && stubborn[0].sent === `reasoning_effort="none"`, `stubborn-model's off rung should send none: ${JSON.stringify(stubborn[0])}`);
	assert(stubborn[0].flags.length === 1 && stubborn[0].flags[0].startsWith("off still thought"), `stubborn-model's off rung should be flagged as still thinking only: ${JSON.stringify(stubborn[0].flags)}`);
	assert(stubborn.slice(1).every((row) => row.flags.length === 0), `stubborn-model's thinking rungs should not be flagged: ${JSON.stringify(stubborn.slice(1).map((row) => row.flags))}`);
	pass("an off rung whose answer still thought is flagged, its thinking neighbours are not");

	// --- 4. A rung that only answered after retries -------------------------
	const flaky = rowsOf(result.rows, "flaky-model");
	assert(flakyFailures === FLAKY_FAILURES, `the fake should have failed flaky-model ${FLAKY_FAILURES} times, failed ${flakyFailures}`);
	assert(flaky[0]?.flags.length === 0 && flaky[0].accepted.startsWith("yes") && flaky[0].calls === FLAKY_FAILURES + 1, `flaky-model's first rung should be judged on the answer that came through: ${JSON.stringify(flaky[0])}`);
	assert(flaky.slice(1).every((row) => row.flags.length === 0 && row.calls === 1), `flaky-model's later rungs should be clean single calls: ${JSON.stringify(flaky.slice(1))}`);
	pass("a rung that answered after retries is judged on its answer, with every attempt counted");

	// --- 6. A tool turn, and the answer the room asks for after it ----------
	const tooler = rowsOf(result.rows, "tooler-model");
	assert(tooler[0]?.calls === 3, `tooler-model's first rung should count its tool step, its answer and the room's follow-up: ${JSON.stringify(tooler[0])}`);
	assert(tooler[0].costUsd > 0.09, `tooler-model's first rung should cost all three calls (about $0.10), got ${tooler[0].costUsd}`);
	assert(tooler[0].reasoningTokens === TOOL_STEP_REASONING && tooler[0].flags.some((flag) => flag.startsWith("off still thought")), `tooler-model's off rung should be flagged for the tool step's thinking: ${JSON.stringify(tooler[0])}`);
	assert(tooler.slice(1).every((row) => row.flags.length === 0 && row.calls === 1), `tooler-model's later rungs should be clean single calls: ${JSON.stringify(tooler.slice(1))}`);
	pass("a rung's tool steps and the room's follow-up are all counted, their thinking included");

	// --- The TSV holds one row per rung --------------------------------------
	const tsv = fs.readFileSync(tsvOut, "utf8").trim().split("\n");
	assert(tsv.length === 1 + result.rows.length && result.rows.length === 15, `the TSV should hold a header and fifteen rows, got ${tsv.length} lines`);
	assert(tsv.slice(1).filter((line) => line.endsWith("\tok")).length === 10, `ten rows should read ok (three honest, two stubborn, three flaky, two tooler): ${tsv.join("\n")}`);
	pass("the TSV holds one row per model and rung, with its verdict");

	// --- 5. A turn that never finishes ---------------------------------------
	const slow = await runSweep({ ...sweepOptions, out: path.join(tempHome, "sweep-slow.tsv"), models: ["slow-model"], turnTimeoutMs: 5_000 });
	assert(slow.rows.length === 3 && slow.rows[0].flags.some((flag) => flag.startsWith("timed out")), `slow-model's first rung should be flagged as timed out: ${JSON.stringify(slow.rows[0])}`);
	assert(statusTrapsSprung === 2, `the proxy should have cut one status read and stalled the next, sprang ${statusTrapsSprung}`);
	assert(slowClosed, "the stalled answer should have been stopped, not left running on the server");
	assert(slow.rows.slice(1).every((row) => row.flags.length === 0), `the rungs after a timeout should still be swept: ${JSON.stringify(slow.rows.slice(1))}`);
	pass("a turn past its timeout is stopped and flagged, through a cut and a stalled status read, and the sweep goes on");

	// --- 7. A turn that keeps failing and retrying ---------------------------
	const broken = await runSweep({ ...sweepOptions, out: path.join(tempHome, "sweep-broken.tsv"), models: ["broken-model"], turnTimeoutMs: 5_000 });
	assert(broken.rows.length === 3 && broken.rows.every((row) => row.flags.some((flag) => flag.startsWith("timed out"))), `every broken-model rung should be stopped at its timeout: ${JSON.stringify(broken.rows.map((row) => row.flags))}`);
	pass("a turn stopped while the room retries settles, is flagged, and the sweep goes on");

	console.log(`thinking-levels-sweep-smoke: ${passes} checks passed`);
} catch (error) {
	console.error(`thinking-levels-sweep-smoke FAILED: ${(error as Error).message}`);
	if (serverOutput.length > 0) console.error(serverOutput.join("").slice(-4000));
	process.exitCode = 1;
} finally {
	if (server) await stopSmokeServer(server);
	proxy.close();
	await new Promise<void>((resolve) => fakeProvider.close(() => resolve()));
	try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}
