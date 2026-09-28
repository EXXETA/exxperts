// Remember's single-pass prompt, pinned byte for byte.
//
// The full-path reader changed where Remember reads a conversation from, and
// the two-stage path added a second way to read a long one. Neither may touch
// the prompt of an ordinary conversation: that prompt is what the 43 of 50 was
// measured on. So a small conversation with every kind of message a room writes
// (user, assistant with a tool call, its tool result, a bash run, an extension
// message), none of them over 12,000 characters and no
// compaction, is rendered at a fixed clock, and the prompt's sha256 must equal
// the one taken on the code before the reader changed (main at dac10b1a).
//
// Offline: no server, no provider, no network, no port.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "remember-single-pass-pin-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "remember-single-pass-pin-rooms-"));
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "remember-single-pass-pin-cwd-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	buildPersistentAgentCheckpointTranscriptSource,
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	openPersistentAgentPiSessionManager,
	writePersistentAgentRuntimeState,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { buildCheckpointCompressionPrompt } = await import("../src/checkpoint-compression.js");

/** The prompt's sha256 on main at dac10b1a, before the full-path reader. */
const PINNED_PROMPT_SHA256 = "785a8997a1a5ee17192a1960992ab0abfb4a577c8816af63b498363fe544a976";
/** The transcript items' sha256 on the same commit: ids, kinds and texts. */
const PINNED_ITEMS_SHA256 = "10cada81a69d71d49f03ef52fb392a303a05fc52d13413de8cbec958d18c17cb";

const agentId = "remember-pin-room";
const threadId = "pi_pin_00000001";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const FIXED_NOW = new Date("2026-09-20T10:00:00.000Z");
const L1B = "<!-- exxeta:l1b schema_version=1 -->\n\n## Chronos\n\n- Persistent agent id: remember-pin-room\n\n## Recent Context\n\n";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function sha256(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex");
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const longParagraph = "The quarterly figures stay as they are; only the wording of the summary changes. ".repeat(60).trim();

try {
	createPersistentAgentFromScaffoldInput({ displayName: "Remember Pin Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const write = writePersistentAgentThread(agentId, threadId, { state: "active", origin: "home", model, items: [] }, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
	});
	assert(write.thread.runtime.kind === "pi-session-jsonl", "the fixture thread should be Pi-backed");
	writePersistentAgentRuntimeState(agentId, { state: "active", activeThreadId: threadId, model });
	const session = openPersistentAgentPiSessionManager(agentId, write.thread.runtime, tempCwd);
	const t = Date.parse("2026-09-20T09:00:00.000Z");
	session.appendMessage({ role: "user", content: "Please remember that the launch moved to the twelfth of November.", timestamp: t });
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Noted. I will check the plan file." }, { type: "toolCall", id: "call_1", name: "read", arguments: { path: "plan.md" } }],
		api: "responses" as any, provider: model.provider as any, model: model.model, usage, stopReason: "toolUse", timestamp: t + 1,
	} as any);
	session.appendMessage({ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: `# Plan\n\n${longParagraph}` }], isError: false, timestamp: t + 2 } as any);
	session.appendMessage({ role: "assistant", content: [{ type: "text", text: `The plan says: ${longParagraph}` }], api: "responses" as any, provider: model.provider as any, model: model.model, usage, stopReason: "stop", timestamp: t + 3 } as any);
	session.appendMessage({ role: "bashExecution", command: "ls", output: "plan.md\nnotes.md", exitCode: 0, cancelled: false, truncated: false, timestamp: t + 4 } as any);
	session.appendCustomMessageEntry("consult-handoff", "A consult answered: the German figures match the English ones.", true);
	session.appendMessage({ role: "user", content: "Müller signs the German version; Mueller is the same person.", timestamp: t + 5 });
	session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Understood, one signatory." }], api: "responses" as any, provider: model.provider as any, model: model.model, usage, stopReason: "stop", timestamp: t + 6 } as any);

	const source = buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId: threadId, l1b: L1B, runtimeCwd: tempCwd });
	const assembly = buildCheckpointCompressionPrompt({
		agentId,
		conversationId: threadId,
		model,
		density: "standard",
		rememberText: "Keep the launch date.",
		items: source.items,
		l1b: L1B,
		promptTokenBudget: 166_000,
		now: FIXED_NOW,
	});
	const itemsHash = sha256(JSON.stringify(source.items));
	const promptHash = sha256(assembly.prompt);
	if (process.env.REMEMBER_PIN_PRINT === "1") {
		console.log(JSON.stringify({ itemsHash, promptHash, itemCount: source.items.length, promptChars: assembly.prompt.length }));
	}
	assert(itemsHash === PINNED_ITEMS_SHA256, `the transcript items changed for a conversation without a long message or a compaction (got ${itemsHash})`);
	console.log("  ok  the transcript items of an ordinary conversation are unchanged");
	assert(promptHash === PINNED_PROMPT_SHA256, `the single-pass Remember prompt changed for a conversation without a long message or a compaction (got ${promptHash})`);
	console.log("  ok  the single-pass Remember prompt is byte-identical to the pinned one");
	console.log("remember single-pass pin smoke passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
}
