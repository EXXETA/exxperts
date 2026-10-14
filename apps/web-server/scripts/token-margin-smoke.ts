// The token safety margin at the "will it fit" checks.
//
// The product estimates tokens as characters / 4. Claude's tokenizer counts
// 1.4 to 1.9 times that on prose, wherever Claude is served, so a check that
// trusts the estimate sends prompts the provider then refuses. The checks that
// decide whether something fits a window count a Claude model's estimate at
// 1.6 times; every other model stays at 1.0. Pinned here:
//   - a Claude conversation whose estimate fits one Remember pass but whose
//     1.6 times does not is read in parts, and the same on GPT is one pass;
//   - the boot gate refuses a Claude room whose 1.6 times does not fit, and
//     lets the same prompt through on GPT;
//   - the switch's need is the measured count or the estimate times the
//     target's factor, whichever is larger, with its margin;
//   - which models count as Claude: the anthropic provider, and a claude-*
//     model id on a gateway or any other provider.
//
// Offline: no server, no provider, no network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "token-margin-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const appDir = path.join(tempHome, ".exxperts", "app");
const cwd = path.join(tempHome, "cwd");
fs.mkdirSync(appDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(appDir, "personalized-agents");

const agents = await import("../src/persistent-agents.js");
const tokens = await import("../src/token-estimate.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const CLAUDE = { provider: "anthropic", model: "claude-sonnet-5-5" };
const GPT = { provider: "openai-codex", model: "gpt-6.1-sol" };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

try {
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Token Margin Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const threadId = "c_margin_0001";
	const write = agents.writePersistentAgentThread(agentId, threadId, { state: "active", origin: "home", model: CLAUDE, items: [] }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd }),
	});
	assert(write.thread.runtime.kind === "pi-session-jsonl", "the conversation is backed by a session file");
	const session = agents.openPersistentAgentPiSessionManager(agentId, write.thread.runtime, cwd);
	for (let n = 1; n <= 40; n++) {
		session.appendMessage({ role: "user", content: `Turn ${n}: ${"we went through the supplier review with its dates and figures. ".repeat(12)}`, timestamp: Date.now() } as any);
		session.appendMessage({ role: "assistant", content: [{ type: "text", text: `Answer ${n}: ${"noted, with the figures kept as they are. ".repeat(10)}` }], api: "responses", provider: CLAUDE.provider, model: CLAUDE.model, usage, stopReason: "stop", timestamp: Date.now() } as any);
	}

	// --- Remember: one pass or parts -------------------------------------------------
	const read = (model: { provider: string; model: string }, contextWindow: number) => agents.estimateCheckpointRead({ agentId, conversationId: threadId, runtimeCwd: cwd }, { model, resolveModelWindow: () => ({ contextWindow, maxOutputTokens: 16_000 }) });
	// The smallest window GPT reads this conversation in one pass, found by halving.
	let low = 20_000;
	let high = 400_000;
	assert(read(GPT, high).mode === "one-pass" && read(GPT, low).mode === "parts", "the search starts with one window too small and one large enough");
	while (high - low > 500) {
		const middle = Math.floor((low + high) / 2);
		if (read(GPT, middle).mode === "one-pass") high = middle;
		else low = middle;
	}
	// A window whose budget is a quarter above what one pass needs: inside 1.6.
	const budgetOf = (contextWindow: number) => agents.rememberPromptTokenBudget({ contextWindow, maxOutputTokens: 16_000 });
	let window = high;
	while (budgetOf(window) < budgetOf(high) * 1.25) window += 100;
	assert(read(GPT, window).mode === "one-pass", `GPT reads it in one pass on a ${window}-token window`);
	const claudeRead = read(CLAUDE, window);
	assert(claudeRead.mode === "parts", `on the same window, a Claude model whose 1.6 times does not fit reads it in parts, got ${JSON.stringify(claudeRead)}`);
	assert(read({ provider: "openai-compatible", model: "claude-sonnet-5-5" }, window).mode === "parts", "a Claude model on a gateway counts the same");
	pass(`a conversation one pass fits on GPT (window ${window}) is read in parts on Claude`);

	// --- The boot gate ------------------------------------------------------------------
	const boot = agents.buildPersistentAgentBootContext({ agentId, conversationId: threadId, sessionId: null, model: CLAUDE });
	const bootTokens = tokens.estimateTokens(boot.systemPrompt);
	const bootWindow = { contextWindow: Math.ceil((bootTokens * 1.3 + 4_000) / 0.85), maxOutputTokens: 4_000 };
	agents.assertPersistentAgentBootPromptFitsWindow({ agentId, model: GPT, systemPrompt: boot.systemPrompt, window: bootWindow });
	let refused = false;
	try {
		agents.assertPersistentAgentBootPromptFitsWindow({ agentId, model: CLAUDE, systemPrompt: boot.systemPrompt, window: bootWindow });
	} catch (error) {
		refused = error instanceof agents.PersistentAgentMemoryOverflowError;
	}
	assert(refused, `the boot gate refuses a Claude room whose prompt fits only at 1.0 times (${bootTokens} estimated on a ${bootWindow.contextWindow}-token window)`);
	pass("the boot gate counts Claude at 1.6 times and GPT as estimated");

	// --- The switch, and which models are Claude ------------------------------------------
	assert(tokens.switchFitNeededTokens({ measured: null, estimated: 10_000, model: CLAUDE, margin: 1.15 }) === 18_400, "the switch to Claude needs the estimate times 1.6, with its margin");
	assert(tokens.switchFitNeededTokens({ measured: null, estimated: 10_000, model: GPT, margin: 1.15 }) === 11_500, "the switch to GPT needs the estimate, with its margin");
	assert(tokens.switchFitNeededTokens({ measured: 20_000, estimated: 10_000, model: CLAUDE, margin: 1.15 }) === 23_000, "a measured count larger than the estimate wins");
	for (const model of [CLAUDE, { provider: "openai-compatible", model: "claude-opus-5-5" }, { provider: "amazon-bedrock", model: "eu.anthropic.claude-sonnet-5-5" }, { provider: "openrouter", model: "anthropic/claude-haiku-4-5" }]) {
		assert(tokens.modelTokenFactor(model) === 1.6, `${model.provider}/${model.model} counts at 1.6`);
	}
	for (const model of [GPT, { provider: "openai-compatible", model: "gpt-5.5" }, { provider: "openai-compatible", model: "mistral-large" }, null]) {
		assert(tokens.modelTokenFactor(model) === 1, `${model ? `${model.provider}/${model.model}` : "no model"} counts as estimated`);
	}
	pass("the switch's need, and which models count as Claude");
	console.log("token margin smoke passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
