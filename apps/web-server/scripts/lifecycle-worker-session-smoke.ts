import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A maintenance worker session is single-shot: one prompt, one reply, thrown
// away. Left on the interactive defaults it inherited, it did three things
// nobody asked for — summarized itself mid-turn when prompt plus reply outgrew
// the window minus the compaction reserve (an extra call whose summary is
// discarded with the session), restarted the whole generation on a dropped
// stream (minutes of output paid for twice), and waited forever on a stream
// that never ends. This smoke drives the real worker runtime against a
// synthetic gateway and pins all three: one request per call, no matter how
// big the reported context or how hard the provider fails, and a hard ceiling
// that fails with a reason.

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-worker-session-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const agentDir = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");

const FAIL_MARKER = "SMOKE_PROVIDER_FAILS";
const HANG_MARKER = "SMOKE_PROVIDER_HANGS";
// The reserve the runtime keeps free is 16384 tokens, so a 20k window plus a
// reported context well above 3616 tokens is squarely in compaction territory.
const MODEL_CONTEXT_WINDOW = 20000;
const REPORTED_PROMPT_TOKENS = 15000;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Synthetic gateway: POST /v1/chat/completions, SSE. Every request is recorded
// so the smoke can count calls and see what a second call would have carried.
// ---------------------------------------------------------------------------
const requests: Array<{ body: string; finished: boolean }> = [];
const openConnections = new Set<http.ServerResponse>();

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
		const record = { body, finished: false };
		requests.push(record);
		if (body.includes(FAIL_MARKER)) {
			res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "synthetic gateway failure" } }));
			return;
		}
		const base = { id: `cmpl_${requests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "maintenance-model" };
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: "Draft line one. " }, finish_reason: null }] }));
		if (body.includes(HANG_MARKER)) {
			// Headers sent, one delta delivered, then nothing: the stream that
			// never ends, which is what the hard ceiling exists for.
			openConnections.add(res);
			res.on("close", () => openConnections.delete(res));
			return;
		}
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: "Draft line two." }, finish_reason: null }] }));
		res.write(sseChunk({
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: REPORTED_PROMPT_TOKENS, completion_tokens: 200, total_tokens: REPORTED_PROMPT_TOKENS + 200 },
		}));
		res.write("data: [DONE]\n\n");
		record.finished = true;
		res.end();
	});
});

let exitCode = 0;
try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;

	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"openai-compatible": {
					name: "Synthetic Gateway",
					baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
					api: "openai-completions",
					models: [{ id: "maintenance-model", name: "Maintenance Model", contextWindow: MODEL_CONTEXT_WINDOW, maxTokens: 4096 }],
				},
			},
		}, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(agentDir, "auth.json"),
		JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-worker-session-key" } }, null, 2),
		{ mode: 0o600 },
	);

	const { AuthStorage, ModelRegistry } = await import("@exxeta/exxperts-runtime");
	const { runIsolatedPersistentAgentWorker, IsolatedPersistentAgentWorkerTurnError } = await import("../src/persistent-agent-worker-runtime.js");

	const registry = ModelRegistry.create(AuthStorage.create(path.join(agentDir, "auth.json")), path.join(agentDir, "models.json"));
	const modelLock = { provider: "openai-compatible", model: "maintenance-model" };
	const model = registry.find(modelLock.provider, modelLock.model);
	if (!model) throw new Error("the synthetic maintenance model should be in the registry");
	const workerModel: NonNullable<typeof model> = model;

	async function runWorker(systemPrompt: string, timeoutMs?: number) {
		return runIsolatedPersistentAgentWorker({
			workerSystemPrompt: systemPrompt,
			triggerPrompt: "Produce the draft now.",
			modelLock,
			resolveExpectedModel: () => workerModel,
			workerLabel: "maintenance worker",
			emptyTextError: "maintenance worker produced no text",
			cwd: repoRoot,
			agentDir,
			modelRegistry: registry,
			...(timeoutMs ? { timeoutMs } : {}),
		});
	}

	// --- 1. A reported context past the compaction threshold makes ONE call ---
	// The reply is complete and the session is disposed straight after, so a
	// second request here is a summary nothing will ever read. The summarizing
	// call is fired after the turn resolves, so the smoke lets the session settle
	// before counting — otherwise the waste lands in the next test's window.
	requests.length = 0;
	const FIRST_CALL_MARKER = "SMOKE_WORKER_CALL_ONE";
	const healthy = await runWorker(`Synthetic maintenance worker prompt. ${FIRST_CALL_MARKER}`);
	assert(healthy.text.includes("Draft line two."), `the worker should return the gateway's reply, got ${JSON.stringify(healthy.text)}`);
	assert(healthy.usage?.input === REPORTED_PROMPT_TOKENS, `the worker should carry the reported usage, got ${JSON.stringify(healthy.usage)}`);
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert(requests.length === 1, `a worker call whose context is past the compaction threshold must make exactly one request, got ${requests.length}`);
	assert(requests.every((request) => request.body.includes(FIRST_CALL_MARKER)), "every request a worker call makes must be that call's own prompt, never a follow-up the session invented");

	// --- 2. A failing provider is reported, not retried ----------------------
	// Client-side SDK retries and the session's own backoff loop both restart
	// the whole generation; on a long maintenance reply that is minutes of work
	// paid for again for no new information.
	requests.length = 0;
	const startedAt = Date.now();
	let failure: Error | undefined;
	try {
		await runWorker(`Synthetic maintenance worker prompt. ${FAIL_MARKER}`);
	} catch (error) {
		failure = error as Error;
	}
	assert(failure, "a failing provider should reject the worker call");
	assert(requests.length === 1, `a failing provider must be reported after one attempt, got ${requests.length} requests`);
	assert(Date.now() - startedAt < 10_000, "a failing provider must fail fast, without a backoff loop");

	// --- 3. The hard ceiling aborts a stream that never ends -----------------
	requests.length = 0;
	let timeout: Error | undefined;
	try {
		await runWorker(`Synthetic maintenance worker prompt. ${HANG_MARKER}`, 2000);
	} catch (error) {
		timeout = error as Error;
	}
	assert(timeout instanceof IsolatedPersistentAgentWorkerTurnError, `a call past its ceiling should fail as a turn error, got ${timeout?.constructor.name}: ${timeout?.message}`);
	assert(timeout.stopReason === "aborted", `a call past its ceiling should stop as aborted, got ${timeout.stopReason}`);
	assert(/2 second limit/.test(String(timeout.providerMessage)), `the failure should name the ceiling in seconds, got ${JSON.stringify(timeout.providerMessage)}`);
	assert(requests.length === 1, `a call past its ceiling must not be retried, got ${requests.length} requests`);

	// --- 4. Without a ceiling the switch is off, and a normal call is normal --
	requests.length = 0;
	const uncapped = await runWorker("Synthetic maintenance worker prompt, second run.");
	assert(uncapped.text.includes("Draft line one."), "a worker call without a ceiling still returns its reply");
	assert(requests.length === 1, `an ordinary worker call makes exactly one request, got ${requests.length}`);

	console.log("lifecycle-worker-session-smoke: PASS");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	exitCode = 1;
} finally {
	for (const connection of openConnections) { try { connection.destroy(); } catch {} }
	gateway.close();
	fs.rmSync(tempHome, { recursive: true, force: true });
	process.exit(exitCode);
}
