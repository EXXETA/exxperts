// Remember reads the whole conversation, whole.
//
// Before the full-path reader, Remember read the runtime's view of a session:
// after a compaction that view opens with the compaction's summary and has
// lost every message before the kept ones; it was cut to its FIRST 500
// messages, so a long session lost its end (the decisions, the parked threads)
// without a word; and every message was cut to its first 12,000 characters, a
// pasted document or a long answer included. This smoke builds a conversation
// of 650 messages with two compactions, one 30,000-character user message and
// one 20,000-character answer, and pins what Remember reads now: every
// message, in order, pre-compaction ones included; no compaction summary; the
// long texts complete; tool output still bounded (it is the room's machinery,
// and the prompt caps it lower anyway). Then the stale guard: a proposal is
// refused at approval after a new message, and after a leaf change that adds
// no message (a model change), because a switch must stale an open proposal.
// Last, Remember's own budget and output cap on the windows that matter.
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "remember-full-path-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "remember-full-path-rooms-"));
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "remember-full-path-cwd-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	buildCheckpointProposal,
	buildPersistentAgentCheckpointTranscriptSource,
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	openPersistentAgentPiSessionManager,
	parseCheckpointApprovalRequest,
	rememberPromptTokenBudget,
	rememberWorkerMaxOutputTokens,
	writeApprovedCheckpoint,
	writePersistentAgentRuntimeState,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

const agentId = "remember-full-path-room";
const threadId = "pi_full_00000001";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const MESSAGE_COUNT = 650;
const LONG_USER_AT = 120;
const LONG_ASSISTANT_AT = 521;
const SUMMARY_MARKER = "COMPACTION_SUMMARY_ONLY_MARKER";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

function expectThrows(fn: () => unknown, expected: RegExp, label: string): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		return;
	}
	throw new Error(`${label}: expected a refusal`);
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A text of exactly `length` characters that starts and ends with its own markers, so a cut anywhere shows. */
function longText(length: number, head: string, tail: string): string {
	const filler = "Paragraph of a long pasted document, kept at the length people paste. ";
	const body = filler.repeat(Math.ceil(length / filler.length)).slice(0, length - head.length - tail.length - 2);
	return `${head} ${body} ${tail}`;
}

function messageText(n: number): string {
	if (n === LONG_USER_AT) return longText(30_000, "LONG_USER_HEAD", "LONG_USER_TAIL");
	if (n === LONG_ASSISTANT_AT) return longText(20_000, "LONG_ASSISTANT_HEAD", "LONG_ASSISTANT_TAIL");
	return `message ${n} of the long conversation`;
}

function l1b(): string {
	return fs.readFileSync(path.join(root, agentId, "L1b", "current.md"), "utf-8");
}

function approve(proposalSource: unknown): void {
	const parsed = parseCheckpointApprovalRequest({
		conversationId: threadId,
		model,
		density: "standard",
		proposal: { agentId, conversationId: threadId, sessionId: null, writesMemory: false, source: proposalSource },
		approvedRecentContext: "### RC-DRAFT | CLOSED | 2026-09-20 | Long conversation\n\n**Session arc:** A long conversation was read whole.\n\n**Body:**\n- Everything was read.\n\n**Parked:**\nNone\n",
	}, agentId);
	writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date("2026-09-20T12:00:00.000Z"), { runtimeCwd: tempCwd });
}

try {
	createPersistentAgentFromScaffoldInput({ displayName: "Remember Full Path Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const write = writePersistentAgentThread(agentId, threadId, { state: "active", origin: "home", model, items: [] }, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
	});
	assert(write.thread.runtime.kind === "pi-session-jsonl", "the fixture thread should be Pi-backed");
	writePersistentAgentRuntimeState(agentId, { state: "active", activeThreadId: threadId, model });
	const session = openPersistentAgentPiSessionManager(agentId, write.thread.runtime, tempCwd);

	// 650 messages, alternating, with a compaction after message 200 (keeping
	// from 180) and after message 450 (keeping from 430). A tool call and its
	// 20,000-character result sit near the start, outside the 650 count.
	const ids: string[] = [];
	for (let n = 1; n <= MESSAGE_COUNT; n++) {
		const text = messageText(n);
		ids.push(n % 2 === 1
			? session.appendMessage({ role: "user", content: text, timestamp: Date.now() } as any)
			: session.appendMessage({ role: "assistant", content: [{ type: "text", text }], api: "responses" as any, provider: model.provider as any, model: model.model, usage, stopReason: "stop", timestamp: Date.now() } as any));
		if (n === 2) {
			session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call_big", name: "read", arguments: { path: "big.json" } }], api: "responses" as any, provider: model.provider as any, model: model.model, usage, stopReason: "toolUse", timestamp: Date.now() } as any);
			session.appendMessage({ role: "toolResult", toolCallId: "call_big", toolName: "read", content: [{ type: "text", text: "x".repeat(20_000) }], isError: false, timestamp: Date.now() } as any);
		}
		if (n === 200) session.appendCompaction(`Summary one. ${SUMMARY_MARKER}`, ids[179]!, 150_000);
		if (n === 450) session.appendCompaction(`Summary two. ${SUMMARY_MARKER}`, ids[429]!, 160_000);
	}
	const modelView = session.buildSessionContext().messages;
	assert(modelView.length < 300, `the runtime's own view should have lost most of the conversation, or the fixture proves nothing (got ${modelView.length} messages)`);

	const { items, source } = buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId: threadId, l1b: l1b(), runtimeCwd: tempCwd });
	const words = items.filter((item) => item.kind === "user" || item.kind === "assistant" && !String(item.text).startsWith("[tool call requested"));
	assert(words.length === MESSAGE_COUNT, `every one of the ${MESSAGE_COUNT} messages is read, got ${words.length}`);
	for (let n = 1; n <= MESSAGE_COUNT; n++) {
		assert(words[n - 1]!.text === messageText(n), `message ${n} is read in its place and whole`);
	}
	pass(`all ${MESSAGE_COUNT} messages are read in order, the ones before both compactions included, past the old 500 cap`);
	assert(!items.some((item) => String(item.text ?? "").includes(SUMMARY_MARKER)), "no compaction summary is read");
	pass("the compaction summaries are left out");
	const longUser = words[LONG_USER_AT - 1]!;
	const longAssistant = words[LONG_ASSISTANT_AT - 1]!;
	assert(longUser.text!.length === 30_000 && longUser.text!.endsWith("LONG_USER_TAIL"), `the 30,000-character user message is read whole, got ${longUser.text!.length} characters`);
	assert(longAssistant.text!.length === 20_000 && longAssistant.text!.endsWith("LONG_ASSISTANT_TAIL"), `the 20,000-character answer is read whole, got ${longAssistant.text!.length} characters`);
	pass("the 30,000-character user message and the 20,000-character answer are read whole");
	const toolResult = items.find((item) => item.kind === "toolResult");
	assert(toolResult && /\[checkpoint transcript item truncated to 12000 characters\]$/.test(String(toolResult.text)), "tool output keeps its bound");
	pass("tool output keeps its 12,000-character bound");
	assert(items.map((item) => item.id).every((id, index) => id === `ctx_${String(index + 1).padStart(4, "0")}`), "item ids number the path in order");
	assert(source.transcriptItemCount === items.length, "the source counts every item it read");

	// The prompt carries the whole conversation too (no budget: one pass).
	let prompt = "";
	await buildCheckpointProposal({ agentId, conversationId: threadId, model, density: "standard" }, async (text) => {
		prompt = text;
		return { text: "TITLE:\nLong\n\nSESSION_ARC:\nRead whole.\n\nBODY:\n- Read.\n\nPARKED:\nNone\n" };
	});
	assert(prompt.includes("message 1 of the long conversation") && prompt.includes(`message ${MESSAGE_COUNT} of the long conversation`), "the prompt holds the first and the last message");
	assert(prompt.includes("LONG_USER_TAIL") && prompt.includes("LONG_ASSISTANT_TAIL"), "the prompt holds the long messages' tails");
	assert(!prompt.includes(SUMMARY_MARKER), "the prompt holds no compaction summary");
	pass("the rendered prompt holds the first message, the last, and the long messages' tails, and no summary");

	// The stale guard: a new message, then a leaf change that adds no message.
	const beforeMessage = buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId: threadId, l1b: l1b(), runtimeCwd: tempCwd }).source;
	session.appendMessage({ role: "user", content: "one more thing", timestamp: Date.now() } as any);
	expectThrows(() => approve(beforeMessage), /transcript fingerprint changed; this memory proposal is stale/, "a proposal after a new message");
	pass("a proposal is stale after a new message");
	const beforeLeafMove = buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId: threadId, l1b: l1b(), runtimeCwd: tempCwd });
	session.appendModelChange("openai-compatible", "claude-opus-4.6");
	const afterLeafMove = buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId: threadId, l1b: l1b(), runtimeCwd: tempCwd });
	assert(afterLeafMove.source.transcriptFingerprint.value === beforeLeafMove.source.transcriptFingerprint.value, "a model change adds no transcript item");
	expectThrows(() => approve(beforeLeafMove.source), /session leaf changed; this memory proposal is stale/, "a proposal after a model change");
	pass("a proposal is stale after a model change that adds no message, by the leaf check");

	// Remember's own budget and output cap.
	const budgets = [
		{ window: { contextWindow: 1_000_000, maxOutputTokens: 128_000 }, budget: 846_000, cap: 16_000 },
		{ window: { contextWindow: 272_000, maxOutputTokens: 128_000 }, budget: 227_200, cap: 16_000 },
		{ window: { contextWindow: 200_000, maxOutputTokens: 64_000 }, budget: 166_000, cap: 16_000 },
		{ window: { contextWindow: 32_000, maxOutputTokens: 16_000 }, budget: 12_000, cap: 16_000 },
		{ window: { contextWindow: 32_000, maxOutputTokens: 4_096 }, budget: 23_200, cap: 4_096 },
	];
	for (const row of budgets) {
		const budget = rememberPromptTokenBudget(row.window);
		const cap = rememberWorkerMaxOutputTokens(row.window);
		assert(budget === row.budget, `the Remember budget on ${JSON.stringify(row.window)} is ${row.budget}, got ${budget}`);
		assert(cap === row.cap, `the Remember output cap on ${JSON.stringify(row.window)} is ${row.cap}, got ${cap}`);
	}
	pass("Remember's budget is the shared one on 200k and larger windows, and leaves its 16k output plus 4k under a small window");

	console.log("remember full path smoke passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
}
