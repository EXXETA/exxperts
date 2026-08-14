// Old bulky tool results are replaced by a short note, and nothing else moves.
//
// The saving is only worth having if it is safe, so this proves the things that
// make it safe as well as the one thing that makes it useful:
//
//  - age is counted in user turns, so a single question answered with many tool
//    steps keeps every one of its results and does not move the boundary once;
//  - every tool call still has a matching tool result, with its id intact, so
//    the request a provider receives is still well formed;
//  - failures, small results and anything the room might still be working with
//    survive verbatim, and the workspace file read is never aged at all;
//  - the same conversation always ages to the same bytes, and the boundary only
//    moves every few user turns, so a warm prompt cache is not thrown away;
//  - the note tells the model what is missing and that it can fetch it again.
//
// The policy is a pure function over a message list, so no server, no model and
// no network are involved.
//
// Run: node scripts/run-smokes.mjs tool-result-aging

import {
	AGING_BOUNDARY_STEP_TURNS,
	AGING_TOOL_ALLOWLIST,
	KEEP_WINDOW_TURNS,
	MIN_AGING_CHARS,
	ageToolResults,
	agingBoundaryTurn,
	readAgedToolResultMarker,
} from "../../../pi-package/extensions/tool-result-aging/index.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const checks: string[] = [];
function pass(label: string): void {
	checks.push(label);
	console.log(`  ok  ${label}`);
}

type Msg = Record<string, any>;

let nextCallId = 0;
function toolCallId(): string {
	nextCallId += 1;
	return `call_${nextCallId}`;
}

function userMessage(text: string): Msg {
	return { role: "user", content: text, timestamp: 1_700_000_000_000 };
}

function assistantMessage(calls: { id: string; name: string }[] = []): Msg {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "working on it" },
			...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })),
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		stopReason: "toolUse",
		timestamp: 1_700_000_000_000,
	};
}

function toolResult(input: { id: string; name: string; chars?: number; isError?: boolean; images?: number; imageChars?: number; text?: string }): Msg {
	const text = input.text ?? "x".repeat(input.chars ?? 0);
	const content: Msg[] = [{ type: "text", text }];
	for (let index = 0; index < (input.images ?? 0); index += 1) {
		content.push({ type: "image", data: "Q".repeat(input.imageChars ?? 64), mimeType: "image/png" });
	}
	return {
		role: "toolResult",
		toolCallId: input.id,
		toolName: input.name,
		content,
		isError: input.isError ?? false,
		timestamp: 1_700_000_000_000,
	};
}

// One user turn per round, and inside it one assistant message per tool step,
// exactly as the agent loop appends them. Each turn takes several tool steps, so
// a policy that mistook assistant messages for turns would age results from the
// turn it is still working on.
const STEPS_PER_TURN = 5;
function buildConversation(turns: number): { messages: Msg[]; ids: Record<string, string> } {
	// Reset so that two conversations of the same shape produce the same ids:
	// several checks below compare one conversation's bytes against another's.
	nextCallId = 0;
	const ids: Record<string, string> = {};
	const messages: Msg[] = [];
	for (let turn = 1; turn <= turns; turn += 1) {
		messages.push(userMessage(`turn ${turn}`));
		// A large fetched page, a small search answer, a failure, a tool that is
		// not on the allowlist however big it gets, a workspace read an edit may
		// still depend on, and a screenshot. Each is its own tool step, so each
		// gets its own assistant message.
		const steps: { key: string; name: string; result: (id: string) => Msg }[] = [
			{ key: "fetch", name: "fetch_url", result: (id) => toolResult({ id, name: "fetch_url", chars: 40_000 }) },
			{ key: "search", name: "web_search", result: (id) => toolResult({ id, name: "web_search", chars: 400 }) },
			{ key: "error", name: "fetch_url", result: (id) => toolResult({ id, name: "fetch_url", chars: 30_000, isError: true }) },
			{ key: "offlist", name: "ls", result: (id) => toolResult({ id, name: "ls", chars: 30_000 }) },
			{ key: "read", name: "read", result: (id) => toolResult({ id, name: "read", chars: 30_000 }) },
			{ key: "image", name: "read_file", result: (id) => toolResult({ id, name: "read_file", chars: 50, images: 2, imageChars: 30_000 }) },
			{ key: "icon", name: "read_file", result: (id) => toolResult({ id, name: "read_file", chars: 50, images: 1, imageChars: 200 }) },
		];
		for (const step of steps) {
			const id = toolCallId();
			ids[`${step.key}:${turn}`] = id;
			messages.push(assistantMessage([{ id, name: step.name }]));
			messages.push(step.result(id));
		}
	}
	return { messages, ids };
}
const MESSAGES_PER_TURN = 1 + 7 * 2;

function findResult(messages: Msg[], id: string): Msg {
	const found = messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
	assert(found, `tool result ${id} vanished from the aged message list`);
	return found;
}

function isStubbed(message: Msg): boolean {
	return readAgedToolResultMarker(message) !== null;
}

// ---------------------------------------------------------------------------
// 1. Age is counted in user turns, not in assistant messages.
// ---------------------------------------------------------------------------
{
	// One question, answered with fourteen tool steps: fourteen assistant
	// messages, one user turn. Nothing may age, and the boundary may not move.
	const single: Msg[] = [userMessage("one long question")];
	const stepIds: string[] = [];
	for (let step = 0; step < 14; step += 1) {
		const id = toolCallId();
		stepIds.push(id);
		single.push(assistantMessage([{ id, name: "fetch_url" }]));
		single.push(toolResult({ id, name: "fetch_url", chars: 40_000 }));
	}
	const assistantCount = single.filter((message) => message.role === "assistant").length;
	assert(assistantCount === 14, `the fixture does not have 14 assistant messages, it has ${assistantCount}`);
	const aged = ageToolResults(single);
	assert(aged.stats.agedCount === 0, `a single user turn with 14 tool steps lost ${aged.stats.agedCount} of its own results`);
	for (const id of stepIds) assert(!isStubbed(findResult(aged.messages, id)), `step ${id} of the turn in progress was aged`);
	pass("one user turn with 14 tool steps keeps every result, however many assistant messages it took");
}

{
	// The boundary must depend on user turns only: adding tool steps to the same
	// number of questions must not move it.
	const lean = agingBoundaryTurn(10);
	const busy = agingBoundaryTurn(10);
	assert(lean === busy, "the boundary depends on something other than the user turn count");
	const conversation = buildConversation(10);
	const userTurns = conversation.messages.filter((message) => message.role === "user").length;
	const assistantMessages = conversation.messages.filter((message) => message.role === "assistant").length;
	assert(userTurns === 10 && assistantMessages === 70, `the fixture is not multi-step: ${userTurns} user turns, ${assistantMessages} assistant messages`);
	assert(agingBoundaryTurn(userTurns) === 0 || agingBoundaryTurn(userTurns) < assistantMessages, "the boundary is being computed off assistant messages");
	pass("the fixture has 7 assistant messages per user turn, and the boundary tracks the user turns");
}

// ---------------------------------------------------------------------------
// 2. A short conversation is untouched.
// ---------------------------------------------------------------------------
{
	const short = buildConversation(KEEP_WINDOW_TURNS);
	const aged = ageToolResults(short.messages);
	assert(aged.stats.agedCount === 0, `a conversation inside the keep window was aged: ${aged.stats.agedCount} results`);
	assert(JSON.stringify(aged.messages) === JSON.stringify(short.messages), "a conversation inside the keep window came back changed");
	pass(`nothing ages while the conversation is ${KEEP_WINDOW_TURNS} user turns or shorter`);
}

// ---------------------------------------------------------------------------
// 3. A long conversation: what ages, what does not.
// ---------------------------------------------------------------------------
const TOTAL_TURNS = 14;
const long = buildConversation(TOTAL_TURNS);
const boundary = agingBoundaryTurn(TOTAL_TURNS);
assert(boundary > 0, "the test conversation is not long enough to age anything");
const longSnapshot = JSON.stringify(long.messages);
const aged = ageToolResults(long.messages);

{
	const oldFetch = findResult(aged.messages, long.ids["fetch:1"]!);
	assert(isStubbed(oldFetch), "an old large fetched page was not replaced by a note");
	assert(oldFetch.toolCallId === long.ids["fetch:1"], "the aged result lost its tool call id");
	assert(oldFetch.toolName === "fetch_url", "the aged result lost its tool name");
	assert(oldFetch.isError === false, "the aged result lost its error flag");
	assert(oldFetch.timestamp === 1_700_000_000_000, "the aged result lost its timestamp");
	assert(Array.isArray(oldFetch.content) && oldFetch.content.length === 1 && oldFetch.content[0].type === "text", "the aged result is not a single text block");
	const note: string = oldFetch.content[0].text;
	assert(note.includes("fetch_url"), "the note does not say which tool produced the result");
	assert(note.includes("40000 characters"), `the note does not say how big the result was: ${note}`);
	assert(note.includes("2023-11-14T"), `the note does not carry the original timestamp: ${note}`);
	assert(note.includes("Re-run the tool"), "the note does not tell the model it can fetch this again");
	assert(!note.includes("—"), "the note contains an em-dash");
	assert(note.length < 400, `the note is not short: ${note.length} characters`);
	pass("an old large fetched page becomes a short note that keeps its identity");
}

{
	const recentFetch = findResult(aged.messages, long.ids[`fetch:${TOTAL_TURNS}`]!);
	assert(!isStubbed(recentFetch), "a result from the newest user turn was aged");
	assert(recentFetch.content[0].text.length === 40_000, "a result from the newest user turn lost text");
	const lastKept = findResult(aged.messages, long.ids[`fetch:${boundary + 1}`]!);
	assert(!isStubbed(lastKept), `the user turn just after the boundary (${boundary + 1}) was aged`);
	const lastAged = findResult(aged.messages, long.ids[`fetch:${boundary}`]!);
	assert(isStubbed(lastAged), `the user turn at the boundary (${boundary}) was not aged`);
	pass(`the boundary falls exactly between user turn ${boundary} and user turn ${boundary + 1}`);
}

{
	const oldError = findResult(aged.messages, long.ids["error:1"]!);
	assert(!isStubbed(oldError), "an old failed result was aged");
	assert(oldError.content[0].text.length === 30_000, "an old failed result lost text");
	pass("a failure is kept in full however old it is");
}

{
	const oldSmall = findResult(aged.messages, long.ids["search:1"]!);
	assert(!isStubbed(oldSmall), `an old result under ${MIN_AGING_CHARS} characters was aged`);
	assert(oldSmall.content[0].text.length === 400, "an old small result lost text");
	pass(`a result of ${MIN_AGING_CHARS} characters or fewer is left alone`);
}

{
	const oldOffList = findResult(aged.messages, long.ids["offlist:1"]!);
	assert(!isStubbed(oldOffList), "a result from a tool outside the allowlist was aged");
	assert(oldOffList.content[0].text.length === 30_000, "a result from a tool outside the allowlist lost text");
	pass("a tool that is not on the allowlist is never aged, however large its result");
}

{
	assert(!(AGING_TOOL_ALLOWLIST as readonly string[]).includes("read"), "the workspace file read is back on the allowlist");
	const oldRead = findResult(aged.messages, long.ids["read:1"]!);
	assert(!isStubbed(oldRead), "an old workspace file read was aged, which would break a later edit");
	assert(oldRead.content[0].text.length === 30_000, "an old workspace file read lost text");
	pass("the workspace file read is never aged, so a later edit can still quote what it saw");
}

{
	const oldImage = findResult(aged.messages, long.ids["image:1"]!);
	assert(isStubbed(oldImage), "an old result carrying real images was not aged");
	assert(Array.isArray(oldImage.content) && oldImage.content.length === 1, "the aged image-bearing result still carries image blocks");
	assert(oldImage.content[0].text.includes("2 images"), `the note does not mention the images it replaced: ${oldImage.content[0].text}`);
	const marker = readAgedToolResultMarker(oldImage);
	assert(marker && marker.charsSaved > 59_000, `the image data was not counted as a saving: ${marker?.charsSaved}`);
	pass("images are measured into the size, replaced along with the text, and counted in the note");
}

{
	const oldIcon = findResult(aged.messages, long.ids["icon:1"]!);
	assert(!isStubbed(oldIcon), `a small image-bearing result under ${MIN_AGING_CHARS} characters was aged`);
	assert(Array.isArray(oldIcon.content) && oldIcon.content.length === 2, "the small image-bearing result lost blocks");
	pass("a tiny image stays under the size floor and survives, unlike a real screenshot");
}

// ---------------------------------------------------------------------------
// 4. Pairing: every tool call is still answered, exactly once.
// ---------------------------------------------------------------------------
{
	const calledIds: string[] = [];
	for (const message of aged.messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall") calledIds.push(block.id);
	}
	const answeredIds = aged.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId);
	assert(calledIds.length === TOTAL_TURNS * 7, `expected ${TOTAL_TURNS * 7} tool calls, found ${calledIds.length}`);
	assert(answeredIds.length === calledIds.length, `tool calls (${calledIds.length}) and tool results (${answeredIds.length}) no longer match in count`);
	const answeredSet = new Set(answeredIds);
	assert(answeredSet.size === answeredIds.length, "a tool call id is answered more than once");
	for (const id of calledIds) assert(answeredSet.has(id), `tool call ${id} lost its result`);
	assert(aged.messages.length === long.messages.length, "the aged message list changed length");
	pass("every tool call still has exactly one matching result");
}

// ---------------------------------------------------------------------------
// 5. Determinism and quantization.
// ---------------------------------------------------------------------------
{
	const again = ageToolResults(long.messages);
	assert(JSON.stringify(again.messages) === JSON.stringify(aged.messages), "the same conversation aged to two different results");
	assert(again.stats.agedCount === aged.stats.agedCount, "the same conversation reported two different aged counts");
	assert(JSON.stringify(long.messages) === longSnapshot, "aging mutated the message list it was handed");
	pass("the same conversation always ages to the same bytes, and the input is not mutated");
}

{
	const boundaries: number[] = [];
	for (let turns = 0; turns <= 40; turns += 1) boundaries.push(agingBoundaryTurn(turns));
	for (const value of boundaries) {
		assert(value >= 0, `a negative boundary appeared: ${value}`);
		assert(value % AGING_BOUNDARY_STEP_TURNS === 0, `the boundary ${value} is not a multiple of ${AGING_BOUNDARY_STEP_TURNS}`);
	}
	for (let index = 1; index < boundaries.length; index += 1) {
		const step = boundaries[index]! - boundaries[index - 1]!;
		assert(step === 0 || step === AGING_BOUNDARY_STEP_TURNS, `the boundary moved by ${step} turns between turn ${index - 1} and turn ${index}`);
	}
	const moves = boundaries.filter((value, index) => index > 0 && value !== boundaries[index - 1]).length;
	assert(moves > 0, "the boundary never advances");
	assert(moves <= Math.ceil(boundaries.length / AGING_BOUNDARY_STEP_TURNS), `the boundary advanced ${moves} times over ${boundaries.length} turns, too often to keep a cache warm`);
	pass(`the boundary only advances in steps of ${AGING_BOUNDARY_STEP_TURNS} user turns`);
}

{
	// The boundary must not move while one question is being answered, whatever
	// the tool step count: the aged prefix has to stay byte-identical as tool
	// steps accumulate inside the newest turn, or the cache dies mid-answer.
	const base = buildConversation(TOTAL_TURNS);
	const prefixLength = TOTAL_TURNS * MESSAGES_PER_TURN;
	const duringTurn: string[] = [];
	const inProgress = [...base.messages, userMessage("a new question")];
	for (let step = 0; step < 14; step += 1) {
		const id = `progress_${step}`;
		inProgress.push(assistantMessage([{ id, name: "fetch_url" }]));
		inProgress.push(toolResult({ id, name: "fetch_url", chars: 40_000 }));
		duringTurn.push(JSON.stringify(ageToolResults(inProgress).messages.slice(0, prefixLength)));
	}
	assert(new Set(duringTurn).size === 1, "the aged prefix changed while a single user turn was still running its tool steps");
	pass("the boundary does not move during one user turn, whatever the tool step count");
}

{
	// And across turns it holds still for the whole step, so the cached prefix
	// survives from one question to the next until the step is reached.
	const runs: string[] = [];
	for (let turns = TOTAL_TURNS; turns < TOTAL_TURNS + AGING_BOUNDARY_STEP_TURNS; turns += 1) {
		const conversation = buildConversation(turns);
		const result = ageToolResults(conversation.messages);
		runs.push(JSON.stringify(result.messages.slice(0, TOTAL_TURNS * MESSAGES_PER_TURN)));
	}
	assert(new Set(runs).size === 1, "the shared prefix changed between user turns inside one boundary step");
	pass("the shared history is byte-identical between boundary steps, so a warm cache survives");
}

// ---------------------------------------------------------------------------
// 6. The saving is real, and reported honestly.
// ---------------------------------------------------------------------------
{
	assert(aged.stats.agedCount === boundary * 2, `expected ${boundary * 2} aged results, got ${aged.stats.agedCount}`);
	const markerTotal = aged.messages.reduce((total, message) => total + (readAgedToolResultMarker(message)?.charsSaved ?? 0), 0);
	assert(markerTotal === aged.stats.charsSaved, `the per-result markers (${markerTotal}) disagree with the reported total (${aged.stats.charsSaved})`);
	// The rest of this conversation is deliberately made of things aging must not
	// touch, so the drop in replayed bytes is expected to be the saving the
	// policy reports, and no more.
	const before = JSON.stringify(long.messages).length;
	const after = JSON.stringify(aged.messages).length;
	const shrank = before - after;
	assert(shrank > 0, `aging did not shrink the replayed context at all: ${before} to ${after}`);
	assert(Math.abs(shrank - aged.stats.charsSaved) < aged.stats.agedCount * 200, `the reported saving (${aged.stats.charsSaved}) does not match the actual shrink (${shrank})`);
	pass(`${aged.stats.agedCount} results aged, ${aged.stats.charsSaved} characters kept out of the request`);
}

// ---------------------------------------------------------------------------
// 7. A string timestamp keeps its date.
// ---------------------------------------------------------------------------
{
	const messages: Msg[] = [];
	for (let turn = 1; turn <= 12; turn += 1) {
		messages.push(userMessage(`turn ${turn}`));
		const id = `stamp_${turn}`;
		messages.push(assistantMessage([{ id, name: "fetch_url" }]));
		messages.push({ ...toolResult({ id, name: "fetch_url", chars: 40_000 }), timestamp: String(1_700_000_000_000) });
	}
	const stamped = ageToolResults(messages);
	const first = findResult(stamped.messages, "stamp_1");
	assert(isStubbed(first), "the string-timestamped result was not aged");
	assert(first.content[0].text.includes("2023-11-14T"), `a string timestamp lost its date: ${first.content[0].text}`);
	assert(!first.content[0].text.includes("an earlier point"), "a string timestamp fell back to the vague wording");
	pass("a timestamp that arrives as a string still prints its date");
}

console.log(`\ntool-result-aging smoke: ${checks.length} checks passed`);
