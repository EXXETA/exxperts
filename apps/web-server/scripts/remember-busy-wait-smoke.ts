// Remember waits out a busy Memory model, and ends in one notice when it
// cannot be reached.
//
// Before the shared patience, Remember's single pass and final call never
// retried and a part retried once at once: one 429 failed the whole Remember
// with the provider's raw words. This smoke drives the real engine with a fake
// model: a 429 twice then the answer gives a proposal, with each wait
// published (the try that comes next, and when); six overloads end as "still
// busy"; a 401 ends at once as "signed out"; a stall then a dead probe ends as
// "not answering"; a refusal is not waited out. A conversation read in parts
// gets the same patience on each part and on the final call.
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "remember-busy-wait-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "remember-busy-wait-rooms-"));
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "remember-busy-wait-cwd-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	buildCheckpointProposal,
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	openPersistentAgentPiSessionManager,
	writePersistentAgentRuntimeState,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { IsolatedPersistentAgentWorkerTurnError } = await import("../src/persistent-agent-worker-runtime.js");

const agentId = "remember-busy-wait-room";
const threadId = "pi_busy_00000001";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const FIELDS = "TITLE:\nA busy afternoon\n\nSESSION_ARC:\nThe model was busy, then answered.\n\nBODY:\n- It answered in the end.\n\nPARKED:\nNone\n";
const NOTE = "ARC:\nA part of the conversation.\n\nMUST-KEEP:\n- None\n";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const busy = (words: string) => new IsolatedPersistentAgentWorkerTurnError("checkpoint compression worker", "error", words);
const noSleep = async () => {};

async function rejects(promise: Promise<unknown>): Promise<any> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected Remember to fail");
}

try {
	createPersistentAgentFromScaffoldInput({ displayName: "Remember Busy Wait Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const write = writePersistentAgentThread(agentId, threadId, { state: "active", origin: "home", model, items: [] }, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
	});
	writePersistentAgentRuntimeState(agentId, { state: "active", activeThreadId: threadId, model });
	const session = openPersistentAgentPiSessionManager(agentId, write.thread.runtime as Parameters<typeof openPersistentAgentPiSessionManager>[1], tempCwd);
	for (let n = 1; n <= 40; n++) {
		const text = `message ${n}: ${"a sentence about the afternoon's work. ".repeat(40)}`;
		if (n % 2 === 1) session.appendMessage({ role: "user", content: text, timestamp: Date.now() } as any);
		else session.appendMessage({ role: "assistant", content: [{ type: "text", text }], api: "responses" as any, provider: model.provider as any, model: model.model, usage, stopReason: "stop", timestamp: Date.now() } as any);
	}
	const request = { agentId, conversationId: threadId, model, density: "standard", runtimeCwd: tempCwd };

	// A 429 twice, then the answer.
	{
		let calls = 0;
		const waits: any[] = [];
		const proposal = await buildCheckpointProposal(request, async () => {
			calls += 1;
			if (calls <= 2) throw busy('429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit"}}');
			return { text: FIELDS };
		}, { model, patience: { sleep: noSleep, onWait: (wait: any) => waits.push(wait) } } as any);
		assert(proposal.fields.title === "A busy afternoon", "a busy model waited out still gives the proposal");
		assert(calls === 3, `the single pass is asked again after each 429, got ${calls} calls`);
		const shown = waits.filter(Boolean);
		assert(shown.length === 2 && shown[0].attempt === 2 && shown[1].attempt === 3 && typeof shown[1].nextTryAt === "string", `each wait is published with the next try and its time, got ${JSON.stringify(waits)}`);
		assert(waits[waits.length - 1] === null, "the line clears once the model answered");
		pass("a 429 twice, then the answer: Remember gives its proposal and shows each wait");
	}

	// Six overloads: still busy.
	{
		let calls = 0;
		const error = await rejects(buildCheckpointProposal(request, async () => {
			calls += 1;
			throw busy('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
		}, { model, patience: { sleep: noSleep } } as any));
		assert(error?.code === "model_unreachable" && error?.details?.detail === "still-busy" && error?.statusCode === 503, `six overloads end in the notice as "still busy", got ${error?.message}`);
		assert(calls === 6, `the first call and five more, got ${calls}`);
		assert(!/overloaded_error|529/.test(error.message), "the notice's sentence carries no raw provider words");
		pass("a model busy past the patience ends in the one notice, as still busy");
	}

	// Signed out at the call: at once.
	{
		let calls = 0;
		const error = await rejects(buildCheckpointProposal(request, async () => {
			calls += 1;
			throw busy('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
		}, { model, patience: { sleep: noSleep } } as any));
		assert(error?.code === "model_unreachable" && error?.details?.detail === "signed-out" && calls === 1, `a 401 ends at once as signed out, got ${error?.message} after ${calls} calls`);
		pass("a sign-in failure ends at once, with the cause the Sign in button needs");
	}

	// A stall, a stall, a stall, and a probe that does not answer.
	{
		let calls = 0;
		let probes = 0;
		const error = await rejects(buildCheckpointProposal(request, async () => {
			calls += 1;
			throw new IsolatedPersistentAgentWorkerTurnError("checkpoint compression worker", "aborted", "it stopped answering for 90 seconds", { reason: "stalled" });
		}, { model, patience: { sleep: noSleep, probe: async () => { probes += 1; throw busy("Connection error."); } } } as any));
		assert(calls === 3 && probes === 1, `a stall is tried twice more, then the probe, got ${calls} calls and ${probes} probes`);
		assert(error?.code === "model_unreachable" && error?.details?.detail === "not-answering", `then "not answering", got ${error?.message}`);
		pass("a stalled stream is asked again twice, then the probe decides: not answering");
	}

	// A refusal is not waited out.
	{
		let calls = 0;
		const error = await rejects(buildCheckpointProposal(request, async () => {
			calls += 1;
			throw busy("the model refused to answer this request");
		}, { model, patience: { sleep: noSleep } } as any));
		assert(calls === 1 && error?.code !== "model_unreachable", `a refusal is handed back after one call, got ${calls} calls`);
		pass("a refusal is not waited out and is not the notice");
	}

	// In parts: each part and the final call get the same patience.
	{
		const failedOnce = new Set<string>();
		let calls = 0;
		const proposal = await buildCheckpointProposal(request, async (prompt: string, _model: unknown, call?: { trigger?: string }) => {
			calls += 1;
			const key = call?.trigger ? prompt : "final";
			if (!failedOnce.has(key)) {
				failedOnce.add(key);
				throw busy("503 Service Unavailable");
			}
			return { text: call?.trigger ? NOTE : FIELDS };
		}, { model, resolveModelWindow: () => ({ contextWindow: 32_000, maxOutputTokens: 16_000 }), patience: { sleep: noSleep } } as any);
		assert(proposal.rememberRead?.mode === "parts" && proposal.rememberRead.reads >= 2, `the fixture is read in parts, got ${JSON.stringify(proposal.rememberRead)}`);
		assert(calls === failedOnce.size * 2, `each part and the final call failed once and were asked again, got ${calls} calls for ${failedOnce.size} calls asked`);
		pass(`a conversation read in parts: each of the ${failedOnce.size - 1} parts and the final call waited out a 503`);
	}

	// In parts, side by side: one part's call ending never takes down the wait another part is still in.
	{
		// The parts the case above read are kept for this conversation: read them afresh.
		(await import("../src/remember-parts-cache.js")).clearRememberWork(path.join(root, agentId), threadId);
		const failedOnce = new Set<string>();
		const sleeping: Array<() => void> = [];
		const waits: any[] = [];
		const done = buildCheckpointProposal(request, async (prompt: string, _model: unknown, call?: { trigger?: string }) => {
			if (call?.trigger && !failedOnce.has(prompt)) {
				failedOnce.add(prompt);
				throw busy('429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit"}}');
			}
			return { text: call?.trigger ? NOTE : FIELDS };
		}, { model, resolveModelWindow: () => ({ contextWindow: 32_000, maxOutputTokens: 16_000 }), patience: { sleep: () => new Promise<void>((resolve) => sleeping.push(resolve)), onWait: (wait: any) => waits.push(wait) } } as any);
		const until = Date.now() + 5_000;
		while (sleeping.length < 2 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
		assert(sleeping.length >= 2, `two parts wait at once, got ${sleeping.length}`);
		sleeping.shift()!();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert(waits[waits.length - 1] !== null && waits[waits.length - 1]?.nextTryAt, `while a part still waits, the line still says its wait, got ${JSON.stringify(waits.slice(-3))}`);
		const wake = setInterval(() => { for (const resolve of sleeping.splice(0)) resolve(); }, 5);
		try {
			await done;
		} finally {
			clearInterval(wake);
		}
		assert(waits[waits.length - 1] === null, "the line clears once every part answered");
		pass("parts read side by side: one part ending keeps the other part's wait on the line");
	}

	console.log("remember busy wait smoke passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
}
