// The message box's model panel reads one route: for every model the room
// offers, whether this conversation switches to it in place (`fits`),
// whether a new conversation could start on it (`freshFits`), and the
// conversation's effort as that model would run it.
//
// Against a real spawned server, a conversation with a few messages whose
// boot snapshot froze while the room's memory was small, after the memory
// grew past what a mid-sized model can boot on:
// - the large model reads fits and freshFits; the switch route takes it;
// - the mid model reads fits: true, freshFits: false, and the switch route
//   switches in place, while Remember refuses it as the model to continue on;
// - the small model reads neither, and both routes refuse it;
// - every effort.level is one of its model's ladder rungs (a folded token
//   lands on the rung that replaced it);
// - a paired phone can read the route.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";
import { pairDevice, remoteRequest } from "./smoke-pairing.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(100);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

let passes = 0;
function pass(label: string): void {
	passes += 1;
	console.log(`  ok  ${label}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-model-options-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
const threadCwd = path.join(tempRoot, "cwd");
for (const dir of [agentsRoot, agentDir, threadCwd]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const PROVIDER = "fake-gpt";
const BIG = { provider: PROVIDER, model: "big-fake" };
// Folds "minimal" into "low", as Anthropic models do, so the read must show the rung.
const MID = { provider: PROVIDER, model: "mid-fake" };
const TINY = { provider: PROVIDER, model: "tiny-fake" };

// One provider for every call: a short answer, and Remember's fields when Remember asks.
const providers = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const text = raw.includes("Checkpoint Compression Constitution") ? "TITLE:\nOptions\n\nSESSION_ARC:\nRead the options.\n\nBODY:\n- Read.\n\nPARKED:\nNone\n" : "Answer.";
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: "cmpl_options", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => providers.listen(0, "127.0.0.1", resolve));
	const providerPort = (providers.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			[PROVIDER]: {
				name: "Fake GPT",
				baseUrl: `http://127.0.0.1:${providerPort}/v1`,
				api: "openai-completions",
				models: [
					{ id: "big-fake", name: "Big Fake", reasoning: true, contextWindow: 200000, maxTokens: 16000 },
					{ id: "mid-fake", name: "Mid Fake", reasoning: true, thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" }, contextWindow: 40000, maxTokens: 8000 },
					{ id: "tiny-fake", name: "Tiny Fake", contextWindow: 8000, maxTokens: 2000 },
				],
			},
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "synthetic-gpt" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-gpt", providerId: PROVIDER, label: "Fake GPT", roomModels: ["big-fake", "mid-fake", "tiny-fake"], learnModel: "big-fake", reviewMemoryModel: "big-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-gpt" }, null, 2), { mode: 0o600 });

	// The conversation boots while the memory is small: its snapshot freezes then.
	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Model Options Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const conversationId = "c_options_0001";
	roomModels.writeRoomModels(agentId, { conversation: BIG, memory: BIG });
	const created = agents.writePersistentAgentThread(agentId, conversationId, { state: "active", origin: "home", model: BIG, items: [] }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: conversationId, model, cwd: threadCwd }),
	});
	assert(created.thread.runtime.kind === "pi-session-jsonl", "the conversation is Pi-backed");
	const bootSha = created.thread.runtime.bootPromptSha256;
	const seed = agents.openPersistentAgentPiSessionManager(agentId, created.thread.runtime, threadCwd);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	seed.appendMessage({ role: "user", content: [{ type: "text", text: "Which model should this run on?" }], timestamp: Date.now() } as any);
	seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Any of them." }], api: "openai-completions", provider: PROVIDER, model: BIG.model, usage, stopReason: "stop", timestamp: Date.now() } as any);
	// Then the memory grows: about 40,000 tokens more than any new conversation's boot had.
	const l1a = path.join(agentsRoot, agentId, "L1a.md");
	fs.appendFileSync(l1a, `\n\n## Long-standing notes\n\n${"The room keeps a careful record of every decision it has taken. ".repeat(2_500)}\n`);

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, EXXPERTS_REMOTE_TEST_ADDRESS: "::1" }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	// The room's default effort, folded away on the mid model.
	const effortDefault = await api(`/api/persistent-agents/${agentId}/models`, { method: "PUT", body: JSON.stringify({ effort: "minimal" }) });
	assert(effortDefault.status === 200, `the room's default effort is set, got ${effortDefault.status} ${JSON.stringify(effortDefault.body)}`);

	const optionsPath = `/api/persistent-agents/${agentId}/threads/${conversationId}/model-options`;
	const read = await api(optionsPath);
	assert(read.status === 200 && Array.isArray(read.body?.models), `the read answers, got ${read.status} ${JSON.stringify(read.body)}`);
	const byModel = (models: any[], lock: { model: string }) => models.find((row) => row.provider === PROVIDER && row.model === lock.model);
	const [big, mid, tiny] = [BIG, MID, TINY].map((lock) => byModel(read.body.models, lock));
	assert(big && mid && tiny && read.body.models.length === 3, `every offered model is read once, got ${JSON.stringify(read.body.models)}`);
	assert(big.fits === true && big.freshFits === true, `the large model takes both, got ${JSON.stringify(big)}`);
	assert(mid.fits === true && mid.freshFits === false, `the frozen snapshot fits the mid model while a new conversation does not, got ${JSON.stringify(mid)}`);
	assert(tiny.fits === false && tiny.freshFits === false, `the small model takes neither, got ${JSON.stringify(tiny)}`);
	pass("the read marks each model: the large one both, the mid one in place only, the small one neither");

	for (const row of read.body.models) {
		const rungs = (row.effort?.ladder ?? []).map((rung: any) => rung.level);
		assert(rungs.includes(row.effort?.level), `${row.model}'s effort level is one of its rungs, got ${JSON.stringify(row.effort)}`);
	}
	assert(mid.effort.level === "low" && big.effort.level === "minimal" && tiny.effort.level === "off", `each model shows the conversation's level as it would run it, got ${JSON.stringify([big.effort.level, mid.effort.level, tiny.effort.level])}`);
	pass("every effort level is one of its model's rungs, a folded level on the rung that replaced it");

	// freshFits agrees with Remember's own check for the model to continue on.
	for (const [lock, row] of [[TINY, tiny], [MID, mid], [BIG, big]] as const) {
		const propose = await api(`/api/persistent-agents/${agentId}/checkpoint/propose`, { method: "POST", body: JSON.stringify({ conversationId, density: "standard", background: true, continueOn: lock }) });
		if (row.freshFits) {
			assert(propose.status === 202, `Remember takes ${lock.model} as the model to continue on, got ${propose.status} ${JSON.stringify(propose.body)}`);
			await waitUntil(async () => (await api(`/api/persistent-agents/${agentId}/checkpoint/progress?conversationId=${conversationId}`)).body?.state !== "reading", "the Remember read ended");
			const cancel = await api(`/api/persistent-agents/${agentId}/checkpoint/cancel`, { method: "POST", body: JSON.stringify({ conversationId, discard: true }) });
			assert(cancel.status === 200, "the Remember is discarded");
		} else {
			assert(propose.status === 409 && propose.body?.code === "continue_on_too_small", `Remember refuses ${lock.model} as the model to continue on, got ${propose.status} ${JSON.stringify(propose.body)}`);
		}
	}
	pass("freshFits agrees with Remember's refusal for each model");

	// fits agrees with the switch route, and the mid model switches in place.
	const switchTo = (lock: { provider: string; model: string }) => api(`/api/persistent-agents/${agentId}/threads/${conversationId}/switch-model`, { method: "POST", body: JSON.stringify(lock) });
	const toTiny = await switchTo(TINY);
	assert(toTiny.status === 409 && toTiny.body?.code === "switch_too_long", `the switch refuses the small model, got ${toTiny.status} ${JSON.stringify(toTiny.body)}`);
	const toMid = await switchTo(MID);
	assert(toMid.status === 200 && toMid.body?.model?.model === MID.model, `the switch takes the mid model in place, got ${toMid.status} ${JSON.stringify(toMid.body)}`);
	const onMid = (await api(`/api/persistent-agents/${agentId}/threads/${conversationId}`)).body.thread;
	assert(onMid.model.model === MID.model && onMid.runtime.bootPromptSha256 === bootSha, "the conversation runs on the mid model with its frozen snapshot");
	const toBig = await switchTo(BIG);
	assert(toBig.status === 200 && toBig.body?.model?.model === BIG.model, `the switch takes the large model, got ${toBig.status} ${JSON.stringify(toBig.body)}`);
	pass("fits agrees with the switch route for each model, and the mid model switches in place");

	// A paired phone reads the same panel.
	const enable = await api("/api/remote/enable", { method: "POST" });
	assert(enable.status === 200, `remote access is on, got ${enable.status}`);
	const phone = await pairDevice(port, "Model options phone");
	const fromPhone = await remoteRequest(port, optionsPath, { headers: { Cookie: phone.cookie } });
	assert(fromPhone.status === 200 && JSON.parse(fromPhone.body).models?.length === 3, `a paired phone reads the panel, got ${fromPhone.status} ${String(fromPhone.body).slice(0, 300)}`);
	pass("a paired phone can read the route");

	// A conversation that answered on a model that cannot think runs "off":
	// the runtime saved that level in its session and restores it after a
	// switch, so the read shows it rather than the machine's default.
	const plainRoomId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Plain Options Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(plainRoomId, { conversation: TINY, memory: BIG });
	const plainId = "c_options_plain_0001";
	const plainCreated = agents.writePersistentAgentThread(plainRoomId, plainId, { state: "active", origin: "home", model: TINY, items: [] }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: plainRoomId, threadId: plainId, model, cwd: threadCwd }),
	});
	assert(plainCreated.thread.runtime.kind === "pi-session-jsonl", "the plain conversation is Pi-backed");
	const plainSession = agents.openPersistentAgentPiSessionManager(plainRoomId, plainCreated.thread.runtime, threadCwd);
	plainSession.appendThinkingLevelChange("off");
	plainSession.appendMessage({ role: "user", content: [{ type: "text", text: "A question on the small model." }], timestamp: Date.now() } as any);
	plainSession.appendMessage({ role: "assistant", content: [{ type: "text", text: "Answer." }], api: "openai-completions", provider: PROVIDER, model: TINY.model, usage, stopReason: "stop", timestamp: Date.now() } as any);
	const plainRead = await api(`/api/persistent-agents/${plainRoomId}/threads/${plainId}/model-options`);
	const plainBig = plainRead.body?.models?.find((row: any) => row.model === BIG.model);
	assert(plainRead.status === 200 && plainBig?.effort?.level === "off", `a conversation the runtime keeps at off reads off on a model that thinks, got ${plainRead.status} ${JSON.stringify(plainBig?.effort)}`);
	pass("a conversation with no level of its own reads the level its session runs at");

	console.log(`conversation-model-options-smoke: ${passes} checks passed`);
} catch (error) {
	console.error(serverOutput.join("").slice(-8000));
	throw error;
} finally {
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
