// Remember with a switch: Remember's propose takes `continueOn`, the model the
// new conversation continues on, keeps it with the job, and the save opens the
// new conversation on it, marked as chosen, with its "Continued on" line, in
// one write. Against a real spawned server:
// - reviewed: progress and result return `continueOn` after a reload, and the
//   save opens the new conversation on it; the room's default stays;
// - automatic (the page saves right after the proposal): the same;
// - cancel and discard switch nothing;
// - a save whose new entry makes the picked model too small for a new
//   conversation still saves, and the new conversation starts on the model it
//   would have had, its first line saying why.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { rememberPartsOfPage } from "../src/memory-typed-text.js";

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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-continue-on-"));
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
const OTHER = { provider: PROVIDER, model: "other-fake" };
const MID = { provider: PROVIDER, model: "mid-fake" };
const modelsFile = path.join(agentDir, "models.json");

// While set, Remember's read is refused at once, so its job fails.
let refuseRemember = false;

const providers = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		if (refuseRemember && raw.includes("Checkpoint Compression Constitution")) {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "This request was refused.", type: "invalid_request_error" } }));
			return;
		}
		const text = raw.includes("Checkpoint Compression Constitution") ? "TITLE:\nContinue on\n\nSESSION_ARC:\nPicked a model.\n\nBODY:\n- Picked.\n\nPARKED:\nNone\n" : "Answer.";
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: "cmpl_continue", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

function writeModels(providerPort: number, midWindow: number): void {
	fs.writeFileSync(modelsFile, JSON.stringify({
		providers: {
			[PROVIDER]: {
				name: "Fake GPT",
				baseUrl: `http://127.0.0.1:${providerPort}/v1`,
				api: "openai-completions",
				models: [
					{ id: "big-fake", name: "Big Fake", contextWindow: 200000, maxTokens: 16000 },
					{ id: "other-fake", name: "Other Fake", contextWindow: 200000, maxTokens: 16000 },
					{ id: "mid-fake", name: "Mid Fake", contextWindow: midWindow, maxTokens: 4000 },
				],
			},
		},
	}, null, 2), { mode: 0o600 });
}

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
	writeModels(providerPort, 200000);
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "synthetic-gpt" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-gpt", providerId: PROVIDER, label: "Fake GPT", roomModels: ["big-fake", "other-fake", "mid-fake"], learnModel: "big-fake", reviewMemoryModel: "big-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-gpt" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Continue On Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: BIG, memory: BIG });
	const first = "c_continue_0001";
	agents.writePersistentAgentThread(agentId, first, { state: "active", origin: "home", model: BIG, items: [] }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: first, model, cwd: threadCwd }),
	});

	const startServer = async () => {
		server = spawn("npx", ["tsx", "src/index.ts"], {
			shell: process.platform === "win32",
			...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
			cwd: webServerDir,
			env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
		});
		server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
		server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
		await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");
	};
	await startServer();

	/** Something said in the open conversation, written into its session as a turn does. */
	const say = async (conversationId: string, model: { model: string }) => {
		const thread = (await api(`/api/persistent-agents/${agentId}/threads/${conversationId}`)).body.thread;
		const session = agents.openPersistentAgentPiSessionManager(agentId, thread.runtime, threadCwd);
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		session.appendMessage({ role: "user", content: [{ type: "text", text: "Remember that the launch is in May." }], timestamp: Date.now() } as any);
		session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Noted." }], api: "openai-completions", provider: PROVIDER, model: model.model, usage, stopReason: "stop", timestamp: Date.now() } as any);
	};
	const progressOf = async (conversationId: string) => (await api(`/api/persistent-agents/${agentId}/checkpoint/progress?conversationId=${conversationId}`)).body;
	const proposeInBackground = async (conversationId: string, continueOn?: { provider: string; model: string }) => {
		const started = await api(`/api/persistent-agents/${agentId}/checkpoint/propose`, { method: "POST", body: JSON.stringify({ conversationId, density: "standard", background: true, ...(continueOn ? { continueOn } : {}) }) });
		assert(started.status === 202, `Remember starts, got ${started.status} ${JSON.stringify(started.body)}`);
		await waitUntil(async () => (await progressOf(conversationId))?.state === "done", "the Remember read finished");
	};
	const approve = async (conversationId: string, proposal: any, approvedRecentContext?: string) => {
		// Save sends the entry's three parts, as the page does.
		const read = rememberPartsOfPage(approvedRecentContext ?? String(proposal.proposedRecentContext));
		assert(read, "the entry splits into its parts");
		const saved = await api(`/api/persistent-agents/${agentId}/checkpoint/approve`, { method: "POST", body: JSON.stringify({ conversationId, density: proposal.density, proposal, approvedFields: read.parts }) });
		assert(saved.status === 200, `Save writes, got ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
		const freshId = String(saved.body.postCheckpoint.activeThreadId);
		return (await api(`/api/persistent-agents/${agentId}/threads/${freshId}`)).body.thread;
	};
	const roomPick = async () => (await api(`/api/persistent-agents/${agentId}/models`)).body.models.conversation.stored;

	// --- Reviewed, with a reload during the review ---
	await say(first, BIG);
	const refused = await api(`/api/persistent-agents/${agentId}/checkpoint/propose`, { method: "POST", body: JSON.stringify({ conversationId: first, density: "standard", background: true, continueOn: { provider: PROVIDER, model: "not-offered" } }) });
	assert(refused.status === 400 && refused.body?.code === "continue_on_not_offered", `a model the room does not offer is refused, got ${refused.status} ${JSON.stringify(refused.body)}`);
	await proposeInBackground(first, OTHER);
	// A reload: the page asks again from nothing.
	const reloaded = await progressOf(first);
	assert(reloaded.continueOn?.model === OTHER.model, `progress returns the model to continue on after a reload, got ${JSON.stringify(reloaded)}`);
	const result = await api(`/api/persistent-agents/${agentId}/checkpoint/result?conversationId=${first}`);
	assert(result.status === 200 && result.body?.continueOn?.model === OTHER.model, `result returns it too, got ${result.status} ${JSON.stringify(result.body?.continueOn)}`);
	const reviewedFresh = await approve(first, result.body);
	assert(reviewedFresh.model.model === OTHER.model && reviewedFresh.modelChosen === true, `the new conversation opens on the picked model, chosen, got ${JSON.stringify({ model: reviewedFresh.model, chosen: reviewedFresh.modelChosen })}`);
	assert(reviewedFresh.items.length === 1 && reviewedFresh.items[0].kind === "system" && reviewedFresh.items[0].text === "Continued on Other Fake", `its first line is the Continued on line, got ${JSON.stringify(reviewedFresh.items)}`);
	assert((await roomPick())?.model === BIG.model, "the room's default is not written");
	pass("reviewed: continueOn survives a reload, and the save opens the new conversation on it, chosen, with its line; the room's default stays");

	// --- Automatic: the save right after the proposal ---
	await say(reviewedFresh.threadId, OTHER);
	const waited = await api(`/api/persistent-agents/${agentId}/checkpoint/propose`, { method: "POST", body: JSON.stringify({ conversationId: reviewedFresh.threadId, density: "standard", continueOn: BIG }) });
	assert(waited.status === 200 && waited.body?.continueOn?.model === BIG.model, `the waited proposal carries continueOn, got ${waited.status} ${JSON.stringify(waited.body?.continueOn)}`);
	const automaticFresh = await approve(reviewedFresh.threadId, waited.body);
	assert(automaticFresh.model.model === BIG.model && automaticFresh.modelChosen === true && automaticFresh.items[0]?.text === "Continued on Big Fake", `the automatic save opens the new conversation on the picked model with its line, got ${JSON.stringify({ model: automaticFresh.model, items: automaticFresh.items })}`);
	pass("automatic: the save right after the proposal opens the new conversation on the picked model");

	// --- Cancel and discard switch nothing ---
	await say(automaticFresh.threadId, BIG);
	await proposeInBackground(automaticFresh.threadId, OTHER);
	const cancelled = await api(`/api/persistent-agents/${agentId}/checkpoint/cancel`, { method: "POST", body: JSON.stringify({ conversationId: automaticFresh.threadId }) });
	assert(cancelled.status === 200 && (await progressOf(automaticFresh.threadId)).continueOn === undefined, "a cancel drops the model to continue on");
	const kept = await api(`/api/persistent-agents/${agentId}/checkpoint/result?conversationId=${automaticFresh.threadId}`);
	assert(kept.status === 200 && kept.body?.continueOn === undefined, `the kept proposal no longer carries it, got ${kept.status} ${JSON.stringify(kept.body?.continueOn)}`);
	const afterCancel = await approve(automaticFresh.threadId, kept.body);
	assert(afterCancel.model.model === BIG.model && !afterCancel.modelChosen && afterCancel.items.length === 0, `after a cancel the save switches nothing, got ${JSON.stringify({ model: afterCancel.model, chosen: afterCancel.modelChosen, items: afterCancel.items })}`);
	await say(afterCancel.threadId, BIG);
	await proposeInBackground(afterCancel.threadId, OTHER);
	const discarded = await api(`/api/persistent-agents/${agentId}/checkpoint/cancel`, { method: "POST", body: JSON.stringify({ conversationId: afterCancel.threadId, discard: true }) });
	assert(discarded.status === 200 && (await progressOf(afterCancel.threadId)).state === "none", "a discard drops the Remember");
	await proposeInBackground(afterCancel.threadId);
	const plain = await api(`/api/persistent-agents/${agentId}/checkpoint/result?conversationId=${afterCancel.threadId}`);
	assert(plain.body?.continueOn === undefined, "a Remember after a discard carries no switch");
	const afterDiscard = await approve(afterCancel.threadId, plain.body);
	assert(afterDiscard.model.model === BIG.model && !afterDiscard.modelChosen && afterDiscard.items.length === 0, `after a discard the save switches nothing, got ${JSON.stringify({ model: afterDiscard.model, items: afterDiscard.items })}`);
	assert((await roomPick())?.model === BIG.model, "the room's default is still not written");
	pass("cancel and discard switch nothing, and the room's default stays");

	// --- Save on a proposal another generation replaced the pick of ---
	await say(afterDiscard.threadId, BIG);
	await proposeInBackground(afterDiscard.threadId, OTHER);
	const held = await api(`/api/persistent-agents/${agentId}/checkpoint/result?conversationId=${afterDiscard.threadId}`);
	assert(held.body?.continueOn?.model === OTHER.model, "the first proposal carries its pick");
	await proposeInBackground(afterDiscard.threadId, MID);
	const newer = await api(`/api/persistent-agents/${agentId}/checkpoint/result?conversationId=${afterDiscard.threadId}`);
	assert(newer.body?.continueOn?.model === MID.model, "the newer proposal carries its own pick");
	const heldFresh = await approve(afterDiscard.threadId, held.body);
	assert(heldFresh.model.model === BIG.model && !heldFresh.modelChosen && heldFresh.items.length === 0, `a save of a proposal whose pick another generation replaced continues on neither pick, got ${JSON.stringify({ model: heldFresh.model, chosen: heldFresh.modelChosen, items: heldFresh.items })}`);
	pass("a save of an older proposal never continues on the pick a newer generation made");

	// --- A newer Remember fails, then the app restarts ---
	await say(heldFresh.threadId, BIG);
	await proposeInBackground(heldFresh.threadId, OTHER);
	refuseRemember = true;
	try {
		const failing = await api(`/api/persistent-agents/${agentId}/checkpoint/propose`, { method: "POST", body: JSON.stringify({ conversationId: heldFresh.threadId, density: "standard", background: true, continueOn: MID }) });
		assert(failing.status === 202, `the newer Remember starts, got ${failing.status} ${JSON.stringify(failing.body)}`);
		await waitUntil(async () => (await progressOf(heldFresh.threadId))?.state === "failed", "the newer Remember failed");
	} finally {
		refuseRemember = false;
	}
	await stopSmokeServer(server);
	await startServer();
	const recovered = await api(`/api/persistent-agents/${agentId}/checkpoint/result?conversationId=${heldFresh.threadId}`);
	assert(recovered.status === 200 && recovered.body?.continueOn === undefined, `the proposal the restart brings back carries no other job's pick, got ${recovered.status} ${JSON.stringify(recovered.body?.continueOn ?? recovered.body)}`);
	const recoveredFresh = await approve(heldFresh.threadId, recovered.body);
	assert(recoveredFresh.model.model === BIG.model && !recoveredFresh.modelChosen && recoveredFresh.items.length === 0, `its save continues on no pick, got ${JSON.stringify({ model: recoveredFresh.model, chosen: recoveredFresh.modelChosen, items: recoveredFresh.items })}`);
	pass("after a newer Remember failed and the app restarted, the proposal brought back never takes that Remember's pick");

	// --- A save whose entry makes the picked model too small ---
	// The smallest window a new conversation of this room fits now, found by
	// the panel's own read; the mid model gets a little more than that, less
	// than the entry the save adds.
	await say(recoveredFresh.threadId, BIG);
	const freshFitsAt = async (window: number, conversationId = recoveredFresh.threadId) => {
		writeModels(providerPort, window);
		const read = await api(`/api/persistent-agents/${agentId}/threads/${conversationId}/model-options`);
		assert(read.status === 200, `the panel read answers, got ${read.status} ${JSON.stringify(read.body)}`);
		return read.body.models.find((row: any) => row.model === MID.model)?.freshFits === true;
	};
	let low = 1_000;
	let high = 200_000;
	assert(await freshFitsAt(high) && !(await freshFitsAt(low)), "the search starts between a window too small and one large enough");
	while (high - low > 50) {
		const middle = Math.floor((low + high) / 2);
		if (await freshFitsAt(middle)) high = middle;
		else low = middle;
	}
	assert(await freshFitsAt(high + 200), "the mid model takes a new conversation now");
	await proposeInBackground(recoveredFresh.threadId, MID);
	const tight = await api(`/api/persistent-agents/${agentId}/checkpoint/result?conversationId=${recoveredFresh.threadId}`);
	assert(tight.body?.continueOn?.model === MID.model, "the Remember keeps the mid model to continue on");
	// The person's entry, long enough (about 1,700 tokens) to tip the mid model over.
	const longEntry = String(tight.body.proposedRecentContext).replace("**Body:**\n", `**Body:**\n- ${"The launch plan has many careful details to keep. ".repeat(140)}\n`);
	const tooSmall = await approve(recoveredFresh.threadId, tight.body, longEntry);
	const closed = (await api(`/api/persistent-agents/${agentId}/threads/${recoveredFresh.threadId}`)).body.thread;
	assert(closed.state === "closed" && closed.closedReason === "checkpoint", "the memory still saves");
	assert(tooSmall.model.model === BIG.model && !tooSmall.modelChosen, `the new conversation starts on the model it would have had, got ${JSON.stringify({ model: tooSmall.model, chosen: tooSmall.modelChosen })}`);
	assert(tooSmall.items.length === 1 && tooSmall.items[0].text === "With this save the room's memory no longer fits Mid Fake, so this conversation started on Big Fake.", `its first line says why, got ${JSON.stringify(tooSmall.items)}`);
	pass("a save whose entry makes the picked model too small saves, and the new conversation starts on its old model with one line saying why");

	// --- A conversation with its own workspace settings ---
	// A new conversation starts on the room's settings, not on the ones this
	// conversation changed for itself: the read says what that new one fits.
	const policies = await import("../src/persistent-room-workspace-policy.js");
	const workspace = path.join(tempRoot, "workspace");
	fs.mkdirSync(workspace, { recursive: true });
	const forbiddenRoots = [
		{ kind: "repo-root" as const, path: repoRoot },
		{ kind: "exxeta-state-root" as const, path: path.join(tempHome, ".exxperts") },
		{ kind: "persistent-agents-root" as const, path: agentsRoot },
		{ kind: "persistent-agent-root" as const, path: policies.persistentAgentRootPath(agentId, agentsRoot) },
	];
	const grant = { agentId, root: workspace, repoRoot, persistentAgentsRoot: agentsRoot, forbiddenRoots };
	policies.writePersistentRoomDefaultCapabilityPolicy(policies.createPersistentRoomDefaultCapabilityPolicy({ ...grant, workspaceAccessMode: "localFiles", bashEnabled: true }), { persistentAgentsRoot: agentsRoot });
	policies.writePersistentRoomCapabilityPolicy(policies.createPersistentRoomCapabilityPolicy({ ...grant, conversationId: tooSmall.threadId, workspaceAccessMode: "bounded", toolSelection: { kind: "custom", allowedToolNames: ["read"] }, bashEnabled: false }), { persistentAgentsRoot: agentsRoot });
	await say(tooSmall.threadId, BIG);
	low = 1_000;
	high = 200_000;
	const overrideFitsAt = (window: number) => freshFitsAt(window, tooSmall.threadId);
	assert(await overrideFitsAt(high) && !(await overrideFitsAt(low)), "the search starts between a window too small and one large enough");
	while (high - low > 50) {
		const middle = Math.floor((low + high) / 2);
		if (await overrideFitsAt(middle)) high = middle;
		else low = middle;
	}
	const atEdge = high + 200;
	assert(await overrideFitsAt(atEdge), "the conversation's read says a new conversation fits the mid model");
	const newcomer = "c_continue_newcomer_0001";
	const opened = await api(`/api/persistent-agents/${agentId}/threads/${newcomer}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "home", items: [] }) });
	assert(opened.status === 200, `a new conversation opens, got ${opened.status} ${JSON.stringify(opened.body)}`);
	assert(await freshFitsAt(atEdge, newcomer), "a new conversation, on the room's settings, fits the mid model where the read said it would");
	pass("freshFits counts the room's workspace settings a new conversation starts on, not the open conversation's own");

	console.log(`remember-continue-on-smoke: ${passes} checks passed`);
} catch (error) {
	console.error(serverOutput.join("").slice(-8000));
	throw error;
} finally {
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
