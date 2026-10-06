import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-checkpoint-robustness-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-checkpoint-robustness-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const { createPersistentAgentFromScaffoldInput, buildCheckpointProposal, writePersistentAgentThread } = await import("../src/persistent-agents.js");
const { buildCheckpointCompressionPrompt, checkpointCompressionConstitution, CheckpointPromptOverflowError } = await import("../src/checkpoint-compression.js");

const agentId = "checkpoint-robustness-smoke-room";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function expectRejects(fn: () => Promise<unknown>, expected: RegExp, label: string): Promise<Error> {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		return error as Error;
	}
	throw new Error(`${label}: expected error`);
}

function completeFields(body = "- Durable state delta was preserved."): string {
	return `TITLE:\nRobustness smoke checkpoint\n\nSESSION_ARC:\nA short synthetic session moved from setup to a durable decision.\n\nBODY:\n${body}\n\nPARKED:\nNone\n`;
}

function missingBodyFields(): string {
	return `TITLE:\nRobustness smoke checkpoint\n\nSESSION_ARC:\nA short synthetic session moved from setup to a durable decision.\n\nPARKED:\nNone\n`;
}

function legacyUserItems(count: number, charsEach: number): Array<{ kind: "user"; id: string; text: string }> {
	return Array.from({ length: count }, (_, index) => ({
		kind: "user" as const,
		id: `u${index + 1}`,
		text: `Synthetic transcript filler item ${index + 1}. ${"lorem-signal ".repeat(Math.ceil(charsEach / 13)).slice(0, charsEach)}`,
	}));
}

function proposalInput(conversationId: string, items: Array<{ kind: "user"; id: string; text: string }>) {
	writePersistentAgentThread(agentId, conversationId, { state: "active", origin: "home", model, items });
	return { agentId, conversationId, model, density: "standard", items };
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Checkpoint Robustness Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	const l1b = fs.readFileSync(path.join(root, agentId, "L1b", "current.md"), "utf-8");
	const promptBase = { agentId, conversationId: "c_pure", model, density: "standard" as const, l1b };

	// 1. Static per-kind cap: tool-result bodies are capped with a declared marker.
	const longToolBody = "tool-output ".repeat(1200).trim(); // ~14k chars
	const capped = buildCheckpointCompressionPrompt({
		...promptBase,
		items: [
			{ kind: "user", id: "u1", text: "Please inspect the repository and summarize." },
			{ kind: "toolResult", id: "t1", name: "bash", status: "success", text: longToolBody },
		],
	});
	assert(capped.telemetry.reductionStage === "standard", "default rendering should report the standard reduction stage");
	assert(capped.telemetry.elidedItemCount === 1, "long tool result should be counted as elided");
	assert(capped.telemetry.elidedChars === longToolBody.length - 4_000, "elided char count should match the 4k cap");
	assert(capped.prompt.includes("characters elided from this item"), "capped tool result should carry a declared elision marker");
	assert(!capped.prompt.includes(longToolBody), "full tool body must not reach the prompt");

	// 2. Budget pressure tightens tool results first.
	const manyToolItems = Array.from({ length: 10 }, (_, index) => ({
		kind: "toolResult" as const,
		id: `t${index + 1}`,
		name: "bash",
		status: "success",
		text: "tool-output ".repeat(1100).trim(),
	}));
	const tightened = buildCheckpointCompressionPrompt({ ...promptBase, items: manyToolItems, promptTokenBudget: 8_000 });
	assert(tightened.telemetry.reductionStage === "tight-tool-results", "budget pressure should escalate to tight-tool-results");
	assert(tightened.telemetry.promptEstimatedTokens <= 8_000, "tightened prompt should fit the budget");
	assert(tightened.telemetry.promptTokenBudget === 8_000, "telemetry should expose the prompt token budget");

	// 3. Heavier pressure never cuts what the room said: past the tool-result
	// stages the single pass refuses, and Remember reads the conversation in
	// parts instead (remember-two-stage-smoke).
	const chattyItems = [
		...manyToolItems,
		...Array.from({ length: 8 }, (_, index) => ({ kind: "assistant" as const, id: `a${index + 1}`, text: "assistant-detail ".repeat(700).trim() })),
	];
	try {
		buildCheckpointCompressionPrompt({ ...promptBase, items: chattyItems, promptTokenBudget: 15_000 });
		throw new Error("a prompt that fits only with assistant text cut should refuse the single pass");
	} catch (error) {
		assert(error instanceof CheckpointPromptOverflowError, `assistant text is never cut to fit; the single pass refuses instead, got ${(error as Error).message}`);
	}

	// 4. Impossible budget refuses with guidance instead of truncating silently.
	try {
		buildCheckpointCompressionPrompt({ ...promptBase, items: manyToolItems, promptTokenBudget: 1_200 });
		throw new Error("impossible budget should throw CheckpointPromptOverflowError");
	} catch (error) {
		assert(error instanceof CheckpointPromptOverflowError, `impossible budget should throw the overflow error, got ${(error as Error).message}`);
		assert(error.statusCode === 413, "overflow error should carry statusCode 413");
		assert(/^This conversation is too long for \S+ to remember in one read/.test(error.message), "overflow error should name the memory model in the plain Remember sentence");
		assert(/No memory has been written/.test(error.message), "overflow error should reassure that no memory was written");
		assert(/Room settings, Model/.test(error.message) && !/checkpoint earlier|switch the room/i.test(error.message), "overflow error should point to the Model pane, not to a checkpoint or a room switch");
	}

	// 5. Short-session gates behave as before (thresholds now expressed in est tokens).
	const veryShort = buildCheckpointCompressionPrompt({ ...promptBase, items: [{ kind: "user", id: "u1", text: "hello there" }] });
	assert(veryShort.shortSessionMode === "very-short", "tiny transcript should stay very-short");
	const short = buildCheckpointCompressionPrompt({ ...promptBase, items: [{ kind: "user", id: "u1", text: "context ".repeat(300).trim() }] });
	assert(short.shortSessionMode === "short", "~2.4k-char transcript should stay short");
	const normal = buildCheckpointCompressionPrompt({ ...promptBase, items: [{ kind: "user", id: "u1", text: "context ".repeat(1300).trim() }] });
	assert(normal.shortSessionMode === "none", "~10k-char transcript should stay none");

	// 6. Missing required field triggers exactly one retry with a Retry Notice.
	const retryPrompts: string[] = [];
	const retryProposal = await buildCheckpointProposal(proposalInput("c_retry_0001", legacyUserItems(3, 2_000)), async (prompt) => {
		retryPrompts.push(prompt);
		return { text: retryPrompts.length === 1 ? missingBodyFields() : completeFields() };
	});
	assert(retryPrompts.length === 2, "missing BODY should trigger exactly one retry");
	assert(/## Retry Notice/.test(retryPrompts[1]), "retry prompt should carry the Retry Notice section");
	assert(/missing required field\(s\): BODY/.test(retryPrompts[1]), "retry notice should name the missing field");
	assert(retryProposal.compressionAttempts === 2, "proposal should report two compression attempts");
	assert(retryProposal.fields.body.length > 0, "retry should recover the BODY field");
	assert(retryProposal.warnings.some((warning) => /regenerated once/.test(warning)), "proposal warnings should record the retry");

	// 7. Persistent missing required field fails guided after the retry.
	let stubbornCalls = 0;
	await expectRejects(
		() => buildCheckpointProposal(proposalInput("c_stubborn_0001", legacyUserItems(3, 2_000)), async () => {
			stubbornCalls += 1;
			return { text: missingBodyFields() };
		}),
		/did not produce required field\(s\) BODY after 2 attempt\(s\)/,
		"persistently missing BODY should fail guided",
	);
	assert(stubbornCalls === 2, "guided failure should stop after the single retry");

	// 8. A transcript too large for one pass on a small window is read in
	// parts instead of refused (remember-two-stage-smoke pins the parts).
	let partsCalls = 0;
	const partsProposal = await buildCheckpointProposal(
		proposalInput("c_overflow_0001", legacyUserItems(12, 11_000)),
		async () => {
			partsCalls += 1;
			return { text: completeFields() };
		},
		{ resolveModelWindow: () => ({ contextWindow: 32_000, maxOutputTokens: 8_000 }) },
	);
	assert(partsProposal.rememberRead.mode === "parts" && partsProposal.rememberRead.reads > 1, `a transcript over the small window's budget is read in parts, got ${JSON.stringify(partsProposal.rememberRead)}`);
	assert(partsCalls >= 3, `the parts and the final call each reach the worker, got ${partsCalls} calls`);

	// 9. Large windows pass the guard and record the budget.
	const okProposal = await buildCheckpointProposal(
		proposalInput("c_ok_0000001", legacyUserItems(12, 11_000)),
		async () => ({ text: completeFields(), usage: { input: 100, output: 50, totalTokens: 150, cost: 0.01 } }),
		{ resolveModelWindow: () => ({ contextWindow: 200_000, maxOutputTokens: 8_000 }) },
	);
	assert(okProposal.compressionAttempts === 1, "clean output should need a single attempt");
	assert(okProposal.compressionTelemetry.promptTokenBudget === 166_000, "budget should be floor(0.85 * window) minus the output reserve");
	assert(okProposal.compressionUsage?.totalTokens === 150, "usage should pass through unmerged on a single attempt");

	// 10. Constitution carries the memory rules and the output contract is unchanged.
	const constitution = checkpointCompressionConstitution();
	assert(constitution.includes("## Must-Keep: Explicit Remember Requests"), "constitution should carry the must-keep section");
	assert(constitution.includes("## Sensitive Material"), "constitution should carry the sensitive-material section");
	assert(/\*\*must-keep\*\* is reserved for explicit user remember-requests/.test(constitution), "must-keep should be defined in the fidelity-marking vocabulary");
	assert(constitution.includes("elision markers"), "constitution should explain transcript elision markers");
	for (const label of ["TITLE:", "SESSION_ARC:", "BODY:", "PARKED:"]) {
		assert(constitution.includes(label), `output contract label ${label} must stay unchanged`);
	}

	// 11. Operator steering is framed as must-keep; short-session caps declare the exemption.
	const steered = buildCheckpointCompressionPrompt({
		...promptBase,
		items: [{ kind: "user", id: "u1", text: "quick note" }],
		rememberText: "Keep the migration deadline of 2026-08-01.",
	});
	assert(steered.prompt.includes("must-keep for this checkpoint"), "operator steering should be framed as must-keep");
	assert(steered.prompt.includes("Must-keep material remains exempt from these caps"), "short-session caps should declare the must-keep exemption");
	const unsteered = buildCheckpointCompressionPrompt({ ...promptBase, items: [{ kind: "user", id: "u1", text: "quick note" }] });
	assert(unsteered.prompt.includes("No optional operator steering was provided"), "absent steering should keep the neutral provenance block");

	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
	console.log("checkpoint worker robustness smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
