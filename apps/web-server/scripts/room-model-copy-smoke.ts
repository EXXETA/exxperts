// The sentences the model per room adds or rewrites, checked where they meet
// the client: every plain Remember refusal the server writes passes through
// the web UI's formatter unchanged; the single pass's 413 says what remains
// and points to Room settings, Model instead of a checkpoint or a room switch;
// the elision warning names tool output, never the person's or the room's
// words; the approval screen names a model, never its wire label.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-model-copy-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(tempHome, "rooms");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

try {
	const agents = await import("../src/persistent-agents.js");
	const twoStage = await import("../src/remember-two-stage.js");
	const compression = await import("../src/checkpoint-compression.js");
	const client = await import("../../web-ui/src/remember-read.js");

	const model = { provider: "openai-codex", model: "gpt-6-sol", label: "ChatGPT Plus/Pro \u2014 GPT-6 Sol" };

	// 1. Remember's own refusals reach the person as written.
	const plain = [
		agents.REMEMBER_GENERATING_MESSAGE,
		agents.REMEMBER_ALREADY_GENERATING_MESSAGE,
		agents.REMEMBER_MEMORY_MODEL_CHANGED_MESSAGE,
		twoStage.rememberWindowTooSmallMessage(model, 272_000),
		twoStage.rememberNotesTooLongMessage(model, 272_000, 3),
	];
	for (const sentence of plain) {
		assert(client.isPlainRememberSentence(sentence), `the client must pass this sentence through unchanged: ${sentence}`);
		assert(!sentence.includes("\u2014"), `a Remember sentence carries a wire label: ${sentence}`);
	}

	// 2. The single pass's 413 says what remains and where to go.
	let overflow: Error | null = null;
	try {
		compression.buildCheckpointCompressionPrompt({
			agentId: "copy-room",
			conversationId: "c_copy",
			model,
			density: "standard",
			l1b: "# Memory\n\nA short synthetic memory.\n",
			items: Array.from({ length: 12 }, (_, index) => ({ kind: "user" as const, id: `u${index}`, text: "synthetic words ".repeat(400) })),
			promptTokenBudget: 1_500,
		});
	} catch (error) {
		overflow = error as Error;
	}
	assert(overflow instanceof compression.CheckpointPromptOverflowError, `an impossible single pass should refuse, got ${overflow?.message}`);
	assert(client.isPlainRememberSentence(overflow.message), `the 413 must read as a plain Remember sentence: ${overflow.message}`);
	assert(/No memory has been written/.test(overflow.message) && /the conversation and the memory are as they were/.test(overflow.message), `the 413 must say what remains: ${overflow.message}`);
	assert(/Room settings, Model/.test(overflow.message) && !/checkpoint earlier|switch the room|larger-context/i.test(overflow.message), `the 413 must point to the Model pane only: ${overflow.message}`);

	// 3. The elision warning is about tool output.
	const trimmed = compression.buildCheckpointCompressionPrompt({
		agentId: "copy-room",
		conversationId: "c_copy",
		model,
		density: "standard",
		l1b: "# Memory\n\nA short synthetic memory.\n",
		items: [
			{ kind: "user", id: "u1", text: "Run the long listing and tell me what matters." },
			{ kind: "toolResult", id: "t1", name: "bash", status: "success", text: "listing-line ".repeat(1_200) },
			{ kind: "assistant", id: "a1", text: "The listing shows two files that matter." },
		],
	});
	// A shortened tool output is a count on the read, not a warning: the
	// approval screen says it in words that name tool output.
	assert(trimmed.telemetry.elidedItemCount === 1, `one shortened tool output should be counted once, got ${trimmed.telemetry.elidedItemCount}`);
	const trimmedSentences = client.rememberReadSentences({ mode: "one-pass", reads: 1, model, trimmedToolOutputs: trimmed.telemetry.elidedItemCount, toolOutputCapChars: 4_000 });
	assert(trimmedSentences.includes("One tool output over 4,000 characters was shortened before reading.") && !trimmedSentences.some((sentence) => /longest message/.test(sentence)), `the read must name tool output: ${JSON.stringify(trimmedSentences)}`);

	// 4. The approval screen names the model the way the app does everywhere.
	const shown = client.rememberModelName(model);
	assert(shown === "GPT-6 Sol", `the approval screen must name the model, not its wire label, got ${shown}`);
	const read = client.rememberReadSentences({ mode: "parts", reads: 3, model, trimmedToolOutputs: 0, toolOutputCapChars: 4_000 });
	assert(read[0] === "Read in 3 parts by GPT-6 Sol.", `the read line, got ${read[0]}`);
	assert(client.rememberEstimateSentence({ mode: "one-pass", reads: 1, model }) === "Remember reads this conversation in one pass on GPT-6 Sol.", "the estimate line names the model plainly");

	console.log("room-model-copy smoke: ok");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
