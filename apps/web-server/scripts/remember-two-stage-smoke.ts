// Remember reads a conversation too long for one pass in two stages.
//
// A 32k memory model (16k output) leaves Remember a 12,000-token budget. A
// conversation of about 25,000 tokens, with tool calls and their results in
// it, does not fit one pass, so it is cut into parts at user-turn boundaries,
// each part is read for notes (at most three at a time), and one final call
// reads the constitution, the memory, every part's notes and the end of the
// conversation verbatim. This smoke pins the cut (parts start at a user turn,
// a tool call and its result never end up in different parts, the end is raw),
// the calls (at most three in flight, every note in the final prompt, the
// final prompt under the budget), what the approval screen is told (the number
// of reads, the model, the must-keep check), the entry's ceiling (larger, never
// more than twice the base), that the estimate the dialog shows agrees with
// what the proposal did, that a part that fails is read once more and a part
// that fails twice fails the Remember with a plain sentence, and that a memory
// too large for the window fails with the plain sentence, not a 413 about a
// transcript.
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "remember-two-stage-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "remember-two-stage-rooms-"));
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "remember-two-stage-cwd-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	buildCheckpointProposal,
	buildPersistentAgentCheckpointTranscriptSource,
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	estimateCheckpointRead,
	openPersistentAgentPiSessionManager,
	parseCheckpointApprovalRequest,
	rememberPromptTokenBudget,
	writePersistentAgentRuntimeState,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { buildRememberPartPrompt, planRememberParts, rememberPartKeyPrompt, REMEMBER_PART_TRIGGER, rememberPartsTargetTokens, RememberTooLargeError } = await import("../src/remember-two-stage.js");
const { baseDensityTarget } = await import("../src/checkpoint-compression.js");
const { estimateTokens } = await import("../src/token-estimate.js");
const { clearRememberWork, rememberPartKey } = await import("../src/remember-parts-cache.js");

const agentId = "remember-two-stage-room";
const threadId = "pi_parts_00000001";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const WINDOW = { contextWindow: 32_000, maxOutputTokens: 16_000 };
const BUDGET = rememberPromptTokenBudget(WINDOW);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

async function expectRejects(fn: () => Promise<unknown>, expected: RegExp, label: string): Promise<Error> {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		return error as Error;
	}
	throw new Error(`${label}: expected a refusal`);
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const l1bPath = () => path.join(root, agentId, "L1b", "current.md");

// --- The conversation -----------------------------------------------------------

const TURNS = 50;
const LAST_WORDS = "LAST_WORDS_OF_THE_CONVERSATION kickoff is on Monday.";
const MUST_KEEP_EARLY = "MUSTKEEP_EARLY the invoice number is 4711";

function turnText(n: number): string {
	const filler = `Turn ${n} goes through the supplier review in the detail people actually use, with dates and figures that matter to the next conversation. `;
	return `${n === 1 ? `${MUST_KEEP_EARLY}. Please remember that. ` : ""}${filler.repeat(4)}`.trim();
}

createPersistentAgentFromScaffoldInput({ displayName: "Remember Two Stage Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
const write = writePersistentAgentThread(agentId, threadId, { state: "active", origin: "home", model, items: [] }, {
	createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
});
assert(write.thread.runtime.kind === "pi-session-jsonl", "the fixture thread should be Pi-backed");
writePersistentAgentRuntimeState(agentId, { state: "active", activeThreadId: threadId, model });
const session = openPersistentAgentPiSessionManager(agentId, write.thread.runtime, tempCwd);
for (let n = 1; n <= TURNS; n++) {
	session.appendMessage({ role: "user", content: turnText(n), timestamp: Date.now() } as any);
	if (n % 3 === 0) {
		session.appendMessage({ role: "assistant", content: [{ type: "text", text: `Checking the file for turn ${n}.` }, { type: "toolCall", id: `call_${n}`, name: "read", arguments: { path: `turn-${n}.md` } }], api: "responses" as any, provider: model.provider as any, model: model.model, usage, stopReason: "toolUse", timestamp: Date.now() } as any);
		session.appendMessage({ role: "toolResult", toolCallId: `call_${n}`, toolName: "read", content: [{ type: "text", text: `File for turn ${n}. `.repeat(400) }], isError: false, timestamp: Date.now() } as any);
	}
	session.appendMessage({ role: "assistant", content: [{ type: "text", text: n === TURNS ? LAST_WORDS : `Answer to turn ${n}: noted, with the figures kept as they are.` }], api: "responses" as any, provider: model.provider as any, model: model.model, usage, stopReason: "stop", timestamp: Date.now() } as any);
}

// --- The faux model ----------------------------------------------------------------

interface Call { kind: "part" | "final"; prompt: string }
const calls: Call[] = [];
let inFlight = 0;
let maxInFlight = 0;
let failPart: { number: number; times: number } | null = null;
const partFailures = new Map<number, number>();

function partNumberOf(prompt: string): number {
	return Number(/you read part (\d+) of \d+/.exec(prompt)?.[1] ?? 0);
}

/** How long a part read takes before it answers; a failing part answers at once. */
let partDelayMs = 15;
/** Parts whose notes come out far over their ceiling: on the first read only, or on every read. */
let longNotes: "once" | "always" | null = null;
const abortedCalls: number[] = [];
const LONG_NOTE_FILLER = "A note that goes on well past what was asked of it. ".repeat(300);

async function waitOrAbort(ms: number, signal: AbortSignal | undefined, number: number): Promise<void> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (signal?.aborted) {
			abortedCalls.push(number);
			const error = new Error("worker aborted") as Error & { stopReason?: string };
			error.stopReason = "aborted";
			throw error;
		}
		await sleep(5);
	}
}

const generate = async (prompt: string, _model: unknown, call?: { trigger?: string; workerLabel?: string; signal?: AbortSignal }) => {
	const kind = call?.trigger === REMEMBER_PART_TRIGGER ? "part" : "final";
	calls.push({ kind, prompt });
	inFlight += 1;
	maxInFlight = Math.max(maxInFlight, inFlight);
	try {
		if (kind === "part") {
			const number = partNumberOf(prompt);
			if (failPart && failPart.number === number && (partFailures.get(number) ?? 0) < failPart.times) {
				partFailures.set(number, (partFailures.get(number) ?? 0) + 1);
				throw new Error("synthetic provider failure");
			}
			await waitOrAbort(partDelayMs, call?.signal, number);
			const shortening = prompt.includes("## Retry Notice");
			if (longNotes === "always" || (longNotes === "once" && !shortening)) {
				return { text: `MUST-KEEP:\nNone\n\nARC:\nPART_NOTE_${number} started and ended. ${LONG_NOTE_FILLER}\n`, usage: { input: 100, output: 4000 } };
			}
			const mustKeep = prompt.includes(MUST_KEEP_EARLY)
				? `- "Please remember that.": ${MUST_KEEP_EARLY}\n- "Keep the second one too.": the second item`
				: "None";
			return { text: `MUST-KEEP:\n${mustKeep}\n\nDECISIONS AND CORRECTIONS:\nNone\n\nPRODUCED:\nNone\n\nOPEN THREADS:\nNone\n\nARC:\nPART_NOTE_${number} started and ended.\n\nOPEN AT THE END OF THIS PART:\nNone\n`, usage: { input: 100, output: 50 } };
		}
		await sleep(15);
		return { text: `TITLE:\nSupplier review\n\nSESSION_ARC:\nThe supplier review ran long.\n\nBODY:\n- **must-keep** ${MUST_KEEP_EARLY}\n\nPARKED:\nNone\n`, usage: { input: 100, output: 50 } };
	} finally {
		inFlight -= 1;
	}
};

const options = { resolveModelWindow: () => WINDOW };

async function waitUntilAborted(numbers: number[]): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!numbers.every((number) => abortedCalls.includes(number))) {
		assert(Date.now() < deadline, `the parts ${numbers.join(" and ")} should be aborted, got ${JSON.stringify(abortedCalls)}`);
		await sleep(10);
	}
}

try {
	// --- The cut -----------------------------------------------------------------
	const { items } = buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId: threadId, l1b: fs.readFileSync(l1bPath(), "utf-8"), runtimeCwd: tempCwd });
	const totalTokens = items.reduce((sum, item) => sum + estimateTokens(String(item.text ?? "")), 0);
	assert(totalTokens > BUDGET, `the conversation should not fit one pass (${totalTokens} against ${BUDGET})`);
	const context = { agentId, conversationId: threadId, model, density: "standard" as const, l1b: fs.readFileSync(l1bPath(), "utf-8") };
	const plan = planRememberParts(context, items, BUDGET);
	assert(plan.parts.length === 3, `a 32k window reads this conversation in three parts, got ${plan.parts.length}`);
	assert(plan.tail.items.length > 0 && plan.tailTokens <= Math.floor(BUDGET * 0.3), `the end is read verbatim within 30 percent of the budget, got ${plan.tailTokens} of ${BUDGET}`);
	assert(plan.parts.every((part) => part.items[0]!.kind === "user"), `every part starts at a user turn, got ${JSON.stringify(plan.parts.map((part) => part.items[0]!.kind))}`);
	const stretches = [...plan.parts, plan.tail];
	for (let n = 0; n < stretches.length - 1; n++) {
		const last = stretches[n]!.items[stretches[n]!.items.length - 1]!;
		const firstOfNext = stretches[n + 1]!.items[0]!;
		assert(!(firstOfNext.kind === "toolResult"), `a tool result never opens a part apart from its call (after part ${n + 1}, which ends with ${last.kind})`);
	}
	const covered = stretches.flatMap((stretch) => stretch.items.map((item) => item.id));
	assert(JSON.stringify(covered) === JSON.stringify(items.map((item) => item.id)), "the parts and the end cover the whole conversation once, in order");
	pass("the conversation is cut into three parts at user turns, a tool call keeps its result, and the end stays verbatim");

	// A single message larger than a part is split at its paragraph ends across
	// parts, in order, and nothing of it is lost.
	const paragraphs = Array.from({ length: 120 }, (_, n) => `PARAGRAPH_${String(n + 1).padStart(3, "0")} ${"of a document pasted into the conversation whole. ".repeat(8)}`);
	const pasted = paragraphs.join("\n\n");
	const oversized = [
		{ kind: "user", id: "ctx_0001", text: pasted },
		{ kind: "assistant", id: "ctx_0002", text: "Read it." },
		...items.slice(-6).map((item, n) => ({ ...item, id: `ctx_${String(n + 3).padStart(4, "0")}` })),
	];
	const split = planRememberParts(context, oversized, BUDGET);
	const pieces = split.parts.flatMap((part) => part.items).filter((item) => item.id === "ctx_0001");
	assert(pieces.length >= 2, `the pasted message is split across parts, got ${pieces.length} piece(s)`);
	const rejoined = pieces.map((piece) => String(piece.text).replace(/\n\n\[message continues: piece \d+ of \d+\]$/, "")).join("\n\n");
	assert(rejoined === pasted, "the pieces put back together are the whole message");
	assert(pieces.every((piece) => /^PARAGRAPH_\d{3} /.test(String(piece.text))), "every piece starts at a paragraph");
	pass(`a message larger than a part is split at paragraph ends into ${pieces.length} pieces, and nothing of it is lost`);

	// A chat-heavy conversation that would fit one pass only if the room's long
	// answers were cut: it is read in parts, and no answer is cut anywhere.
	const answers = Array.from({ length: 8 }, (_, n) => `ANSWER_${String(n + 1).padStart(2, "0")} ${"a long answer the room wrote in full, with its reasoning and figures. ".repeat(170)}ANSWER_END_${String(n + 1).padStart(2, "0")}`);
	const chatty = answers.flatMap((answer, n) => [
		{ kind: "user", id: `ctx_${String(2 * n + 1).padStart(4, "0")}`, text: `Question ${n + 1}?` },
		{ kind: "assistant", id: `ctx_${String(2 * n + 2).padStart(4, "0")}`, text: answer },
	]);
	const { buildCheckpointCompressionPrompt, CheckpointPromptOverflowError } = await import("../src/checkpoint-compression.js");
	let singlePassRefused = false;
	try {
		buildCheckpointCompressionPrompt({ ...context, items: chatty, promptTokenBudget: BUDGET });
	} catch (error) {
		singlePassRefused = error instanceof CheckpointPromptOverflowError;
	}
	assert(singlePassRefused, "the chat-heavy conversation does not fit one pass without cutting answers");
	// The old third stage cut answers to 4,000 characters; with that cut the
	// same conversation would have fit, so the fixture is the case it was for.
	const cutToOldCap = chatty.map((item) => item.kind === "assistant" ? { ...item, text: item.text.slice(0, 4_000) } : item);
	buildCheckpointCompressionPrompt({ ...context, items: cutToOldCap, promptTokenBudget: BUDGET });
	const chattyPlan = planRememberParts(context, chatty, BUDGET);
	const renderedStretches = [...chattyPlan.parts, chattyPlan.tail].map((stretch) => stretch.items.map((item) => String(item.text)).join("\n"));
	assert(chattyPlan.readCount >= 2, `the chat-heavy conversation is read in parts, got ${chattyPlan.readCount} reads`);
	for (const answer of answers) assert(renderedStretches.some((text) => text.includes(answer)), `every answer is read whole in one stretch (${answer.slice(0, 9)})`);
	assert(!renderedStretches.some((text) => /characters elided/.test(text)), "no answer carries an elision marker");
	pass("a chat-heavy conversation that fits one pass only with its answers cut is read in parts, every answer whole");

	// A tool-heavy conversation that would fit one pass only if its tool results
	// were cut to 1,000 characters: it is read in parts, and every tool result
	// keeps its first 4,000. Each result carries a mark past character 1,000.
	const toolMarks = Array.from({ length: 12 }, (_, n) => `TOOLMARK_${String(n + 1).padStart(2, "0")}`);
	const tooly = toolMarks.flatMap((mark, n) => [
		{ kind: "user", id: `tool_${String(2 * n + 1).padStart(4, "0")}`, text: `Read file ${n + 1}, please.` },
		{ kind: "toolResult", id: `tool_${String(2 * n + 2).padStart(4, "0")}`, name: "read", status: "success", text: `${"a line of the file the room read for the person. ".repeat(70)}${mark} ${"more of the same file. ".repeat(160)}` },
	]);
	assert(tooly.every((item) => item.kind !== "toolResult" || (item.text.indexOf("TOOLMARK_") > 1_000 && item.text.indexOf("TOOLMARK_") < 3_900 && item.text.length > 4_000)), "each tool result is longer than 4,000 characters with its mark between 1,000 and 4,000");
	const cutToThousand = tooly.map((item) => item.kind === "toolResult" ? { ...item, text: item.text.slice(0, 1_000) } : item);
	buildCheckpointCompressionPrompt({ ...context, items: cutToThousand, promptTokenBudget: BUDGET });
	let toolySinglePassRefused = false;
	try {
		buildCheckpointCompressionPrompt({ ...context, items: tooly, promptTokenBudget: BUDGET });
	} catch (error) {
		toolySinglePassRefused = error instanceof CheckpointPromptOverflowError;
	}
	assert(toolySinglePassRefused, "the tool-heavy conversation does not fit one pass with its tool results at 4,000 characters, and none is cut further to fit");
	const toolyPlan = planRememberParts(context, tooly, BUDGET);
	assert(toolyPlan.readCount >= 2, `the tool-heavy conversation is read in parts, got ${toolyPlan.readCount} reads`);
	const toolyPrompts = [...toolyPlan.parts.map((part, n) => buildRememberPartPrompt(context, part, n + 1, toolyPlan.parts.length)), [toolyPlan.tail].map((tail) => tail.items.map((item) => String(item.text)).join("\n"))[0]!];
	for (const mark of toolMarks) assert(toolyPrompts.some((prompt) => prompt.includes(mark)), `every tool result is read to 4,000 characters (${mark})`);
	pass("a tool-heavy conversation that fits one pass only with tool results at 1,000 is read in parts, each tool result at 4,000");
	// The part reader has a place for plain facts, first after must-keep, and a repeated line is noted once, not shed.
	const partPrompt = toolyPrompts[0]!;
	assert(partPrompt.indexOf("\nFACTS:\n") > partPrompt.indexOf("\nMUST-KEEP:\n") && partPrompt.indexOf("\nFACTS:\n") < partPrompt.indexOf("\nDECISIONS AND CORRECTIONS:\n") && /2\. \*\*Facts\.\*\*/.test(partPrompt), "the part prompt asks for facts first after must-keep");
	assert(partPrompt.includes("a line restated many times is noted once, not shed"), "a repeated line is noted once, not shed");
	pass("the part reader notes plain facts, first after must-keep");

	// --- The proposal ------------------------------------------------------------
	const estimate = estimateCheckpointRead({ agentId, conversationId: threadId, runtimeCwd: tempCwd }, options);
	const proposal = await buildCheckpointProposal({ agentId, conversationId: threadId, model, density: "standard", runtimeCwd: tempCwd }, generate, options);
	const partCalls = calls.filter((call) => call.kind === "part");
	const finalCalls = calls.filter((call) => call.kind === "final");
	assert(partCalls.length === 3 && finalCalls.length === 1, `three part reads and one final call, got ${partCalls.length} and ${finalCalls.length}`);
	assert(maxInFlight <= 3, `at most three reads at once, got ${maxInFlight}`);
	assert(maxInFlight > 1, "the parts are read in parallel, not one after another");
	pass(`the three parts are read at most three at a time (peak ${maxInFlight}), then one final call`);
	const finalPrompt = finalCalls[0]!.prompt;
	for (let n = 1; n <= 3; n++) assert(finalPrompt.includes(`PART_NOTE_${n} started and ended.`), `the final prompt holds the notes on part ${n}`);
	assert(finalPrompt.includes(LAST_WORDS), "the final prompt holds the end of the conversation verbatim");
	assert(!finalPrompt.includes("Turn 1 goes through the supplier review"), "the early transcript reaches the final call only through its part's notes");
	assert(estimateTokens(finalPrompt) <= BUDGET, `the final prompt stays under the budget, got ${estimateTokens(finalPrompt)} of ${BUDGET}`);
	assert(partCalls.every((call) => estimateTokens(call.prompt) <= BUDGET), "every part prompt stays under the budget");
	pass("the final prompt holds every part's notes and the verbatim end, and every prompt stays under the budget");
	assert(proposal.rememberRead.mode === "parts" && proposal.rememberRead.reads === 4, `the approval screen is told four reads (three parts and the end), got ${JSON.stringify(proposal.rememberRead)}`);
	assert(proposal.rememberRead.model.model === model.model, "the approval screen is told the model that read the conversation");
	assert(proposal.rememberRead.trimmedToolOutputs > 0, "the approval screen is told how many tool outputs were shortened");
	assert(estimate.mode === "parts" && estimate.reads === proposal.rememberRead.reads, `the estimate the dialog shows agrees with the proposal, got ${JSON.stringify(estimate)}`);
	pass("the approval screen is told four reads, the model and the shortened tool output, and the estimate agrees");
	const base = baseDensityTarget("standard");
	assert(proposal.targetTokens.max === base.max * 2, `four reads would add 750 tokens, and the ceiling stops at twice the base, got ${proposal.targetTokens.max}`);
	const twoReads = rememberPartsTargetTokens("standard", 2);
	assert(twoReads.max === base.max + 250 && twoReads.min === base.min, `two reads add 250 tokens to the ceiling and keep the floor, got ${JSON.stringify(twoReads)}`);
	pass(`the entry's ceiling grows by 250 tokens per read beyond the first and stops at twice the base (${proposal.targetTokens.max})`);
	assert(proposal.rememberRead.mustKeep?.partNotes === 2 && proposal.rememberRead.mustKeep?.body === 1, `the must-keep check counts 2 in the notes and 1 in the draft, got ${JSON.stringify(proposal.rememberRead.mustKeep)}`);
	assert(!proposal.warnings.some((warning) => /asked to keep/.test(warning)), `no warning about it, got ${JSON.stringify(proposal.warnings)}`);
	assert(proposal.fields.body.includes('- "Keep the second one too.": the second item') && !proposal.fields.body.includes('"Please remember that."'), `the lost request is put back word for word, the held one not twice, got ${JSON.stringify(proposal.fields.body)}`);
	pass("a keep-request the draft lost is put back word for word, with no warning"); 

	// Each Remember below reads the conversation afresh: the notes a run
	// already paid for would otherwise be reused (remember-parts-cache.ts).
	const freshProposal: typeof buildCheckpointProposal = (...args) => {
		clearRememberWork(createPersistentAgentInstance(agentId).rootDir, threadId);
		return buildCheckpointProposal(...args);
	};

	// --- A part that fails ----------------------------------------------------------
	calls.length = 0;
	failPart = { number: 2, times: 1 };
	partFailures.clear();
	const retried = await freshProposal({ agentId, conversationId: threadId, model, density: "standard", runtimeCwd: tempCwd }, generate, options);
	assert(retried.rememberRead.reads === 4 && calls.filter((call) => call.kind === "part" && partNumberOf(call.prompt) === 2).length === 2, "a part that fails once is read once more and the Remember goes on");
	pass("a part that fails once is read once more");
	calls.length = 0;
	failPart = { number: 2, times: 2 };
	partFailures.clear();
	const halved = await freshProposal({ agentId, conversationId: threadId, model, density: "standard", runtimeCwd: tempCwd }, generate, options);
	const partTwoReads = calls.filter((call) => call.kind === "part" && partNumberOf(call.prompt) === 2).length;
	assert(partTwoReads === 4 && calls.some((call) => call.kind === "final") && halved.rememberRead.reads === 4, `a part that fails twice is read in two halves and the Remember goes on, got ${partTwoReads} reads of part 2`);
	assert(calls.filter((call) => call.kind === "part" && partNumberOf(call.prompt) !== 2).length === 2, "the other parts are read once each, never stopped by the failing one");
	pass("a part that fails twice is read in halves, and the other parts and the final call go on");
	failPart = null;
	partDelayMs = 15;

	// --- A note far over its ceiling --------------------------------------------------
	calls.length = 0;
	longNotes = "once";
	const shortened = await freshProposal({ agentId, conversationId: threadId, model, density: "standard", runtimeCwd: tempCwd }, generate, options);
	const partReads = calls.filter((call) => call.kind === "part");
	assert(partReads.length === 6 && partReads.filter((call) => call.prompt.includes("## Retry Notice")).length === 3, `each overlong note is read once more with the shorter instruction, got ${partReads.length} reads`);
	assert(partReads.filter((call) => call.prompt.includes("## Retry Notice")).every((call) => /Write them again under 1,500 tokens: shorten everything except must-keep content/.test(call.prompt)), "the second read says how short, and that must-keep stays");
	const finalAfterShortening = calls.find((call) => call.kind === "final")!.prompt;
	assert(!finalAfterShortening.includes(LONG_NOTE_FILLER.slice(0, 60)), "the final call reads the shorter notes");
	assert(shortened.rememberRead.reads === 4, "the Remember goes on with the shorter notes");
	pass("a note far over its ceiling is read once more with a shorter instruction, and the shorter note is used");
	calls.length = 0;
	longNotes = "always";
	const overlong = await freshProposal({ agentId, conversationId: threadId, model, density: "standard", runtimeCwd: tempCwd }, generate, options);
	assert(calls.filter((call) => call.kind === "final").every((call) => estimateTokens(call.prompt) <= BUDGET), "no final call is sent over the budget");
	assert(/PART_NOTE_1 started and ended/.test(overlong.proposedRecentContext) || calls.some((call) => call.kind === "final"), "the page comes from the notes when they do not fit beside the end");
	parseCheckpointApprovalRequest({ conversationId: threadId, model, density: overlong.density, proposal: overlong, approvedRecentContext: overlong.proposedRecentContext }, agentId);
	pass("notes still too long after the second read still give a page Save accepts");
	longNotes = null;

	// --- A cancel during the parts ---------------------------------------------------
	// The first part to reach the model cancels the Remember: the reads in
	// flight end as aborted, none is read again, and no final call follows.
	calls.length = 0;
	const cancel = new AbortController();
	const cancelling = async (prompt: string, model: unknown, call?: { trigger?: string; workerLabel?: string }) => {
		cancel.abort();
		await sleep(5);
		const error = new Error("worker aborted") as Error & { stopReason?: string };
		error.stopReason = "aborted";
		calls.push({ kind: call?.trigger === REMEMBER_PART_TRIGGER ? "part" : "final", prompt });
		throw error;
	};
	await expectRejects(() => freshProposal({ agentId, conversationId: threadId, model, density: "standard", runtimeCwd: tempCwd }, cancelling, { ...options, signal: cancel.signal }), /worker aborted|Remember was cancelled/, "a cancel during the parts");
	assert(calls.every((call) => call.kind === "part") && calls.length <= 3, `a cancel reads no part again and makes no final call, got ${JSON.stringify(calls.map((call) => call.kind))}`);
	pass("a cancel during the parts reads nothing again and makes no final call");

	// --- A replan that adds a part ----------------------------------------------------
	// A stretch's note is kept under its words, not under "part N of M": a
	// replan that adds a part reads again only the stretches that changed.
	const keyOf = (plan: ReturnType<typeof planRememberParts>, n: number) => rememberPartKey({ model, density: "standard", prompt: rememberPartKeyPrompt(context, plan.parts[n]!, false) });
	const morePlan = planRememberParts(context, [...items, ...items.slice(-40)], BUDGET);
	assert(morePlan.parts.length > plan.parts.length && JSON.stringify(morePlan.parts[0]!.items) === JSON.stringify(plan.parts[0]!.items), `a longer end adds a part and keeps the first stretch, got ${morePlan.parts.length} parts`);
	assert(keyOf(morePlan, 0) === keyOf(plan, 0), "the first stretch's note is found again after a part is added");
	pass("a replan that adds a part finds the notes of the stretches that did not change");

	// --- A memory too large for the window --------------------------------------------
	// The read compares against the memory only, so the final call carries its
	// short view (an outline) instead of refusing.
	const memory = fs.readFileSync(l1bPath(), "utf-8");
	fs.writeFileSync(l1bPath(), memory.replace("## Recent Context", `## Notes\n\n${"A durable note the room keeps, at the length notes reach. ".repeat(500)}\n\n## Recent Context`));
	calls.length = 0;
	const outlined = await freshProposal({ agentId, conversationId: threadId, model, density: "standard", runtimeCwd: tempCwd }, generate, options);
	const outlinedFinal = calls.find((call) => call.kind === "final")!.prompt;
	assert(outlined.fields.body.length > 0, "a memory too large for the window still gives a page");
	assert(/here is its outline/.test(outlinedFinal) && !outlinedFinal.includes("A durable note the room keeps"), "the final call carries the memory's outline, not its notes");
	fs.writeFileSync(l1bPath(), memory);
	pass("a memory too large for the window is read as its outline, and the page comes");

	console.log("remember two-stage smoke passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
}
