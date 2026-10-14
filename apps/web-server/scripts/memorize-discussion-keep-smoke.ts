// The Memorize first read and its discussion are kept with the room until the
// run starts: a reload comes back to them with no new first read, and two tabs
// asking at once share one first read. A changed memory or Memory model reads
// again. Offline: the first read is a counted fake.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const keep = await import("../src/memorize-discussion-keep.js");
const room = fs.mkdtempSync(path.join(os.tmpdir(), "memorize-keep-"));
fs.mkdirSync(path.join(room, "runtime"), { recursive: true });
const MODEL = { provider: "anthropic", model: "claude-opus-5-5" };
let reads = 0;
let release!: () => void;
const read = (fingerprint: string, gate?: Promise<void>) => async () => {
	reads += 1;
	await gate;
	return { assessmentMarkdown: `read ${reads}`, source: { l1bFingerprint: { value: fingerprint }, generatedAt: "2026-10-10T12:00:00.000Z" }, process: { model: MODEL } } as any;
};

try {
	// Two tabs at once: one first read.
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const first = keep.firstReadOnce(room, MODEL, "fp-1", read("fp-1", gate));
	const second = keep.firstReadOnce(room, MODEL, "fp-1", read("fp-1", gate));
	release();
	const [a, b] = await Promise.all([first, second]);
	assert(Number(reads) === 1 && a.assessmentMarkdown === "read 1" && b.assessmentMarkdown === "read 1", `two tabs share one first read, got ${reads} reads`);

	// The discussion is kept; a reload gets the read and the turns back, with no new read.
	keep.keepDiscussionTurns(room, "fp-1", [{ role: "user", content: "Keep the Nordwind floor price." }, { role: "assistant", content: "I will keep it." }], { state: "ok" });
	const reloaded = await keep.firstReadOnce(room, MODEL, "fp-1", read("fp-1"));
	assert(Number(reads) === 1 && reloaded.keptDiscussion?.messages.length === 2 && reloaded.keptDiscussion.messages[0]!.content === "Keep the Nordwind floor price.", `a reload comes back to the discussion with no new read, got ${reads} reads and ${JSON.stringify(reloaded.keptDiscussion)}`);

	// A changed memory reads again, and the old discussion goes.
	const changed = await keep.firstReadOnce(room, MODEL, "fp-2", read("fp-2"));
	assert(Number(reads) === 2 && !changed.keptDiscussion, `a changed memory reads again, got ${reads} reads`);
	// So does another Memory model.
	await keep.firstReadOnce(room, { provider: "openai-codex", model: "gpt-6.1-sol" }, "fp-2", read("fp-2"));
	assert(Number(reads) === 3, `another Memory model reads again, got ${reads}`);

	// A Reassess while another tab's first read is in flight reads with its
	// feedback, never joins that read, and the older read finishing last does
	// not overwrite what the Reassess kept.
	keep.clearKeptDiscussion(room);
	let releasePlain!: () => void;
	const plainGate = new Promise<void>((resolve) => { releasePlain = resolve; });
	const labelled = (label: string, gate?: Promise<void>) => async () => {
		reads += 1;
		await gate;
		return { assessmentMarkdown: label, source: { l1bFingerprint: { value: "fp-2" }, generatedAt: "2026-10-10T12:00:00.000Z" }, process: { model: MODEL } } as any;
	};
	const before = reads;
	const plain = keep.firstReadOnce(room, MODEL, "fp-2", labelled("plain read", plainGate));
	const reassessed = await keep.firstReadOnce(room, MODEL, "fp-2", labelled("read with the feedback"), { fresh: true });
	assert(Number(reads) === before + 2 && reassessed.assessmentMarkdown === "read with the feedback", `a Reassess reads on its own with the feedback, got ${reads - before} reads and "${reassessed.assessmentMarkdown}"`);
	releasePlain();
	await plain;
	const afterReassess = await keep.firstReadOnce(room, MODEL, "fp-2", labelled("a third read"));
	assert(Number(reads) === before + 2 && afterReassess.assessmentMarkdown === "read with the feedback", `the read kept is the Reassess's, got "${afterReassess.assessmentMarkdown}" after ${reads - before} reads`);

	// The run starts: nothing is kept any more.
	keep.clearKeptDiscussion(room);
	const beforeStart = reads;
	await keep.firstReadOnce(room, MODEL, "fp-2", read("fp-2"));
	assert(Number(reads) === beforeStart + 1, `after the run starts, Memorize reads afresh, got ${reads - beforeStart}`);
	// Review keeps its own first read and discussion beside Memorize's: a Review
	// read (which names no model of its own) is kept for the model it was read
	// with, and neither serves the other.
	keep.clearKeptDiscussion(room);
	let reviewReads = 0;
	const reviewRead = async () => { reviewReads += 1; return { assessmentMarkdown: `review read ${reviewReads}`, source: { l1bFingerprint: { value: "fp-2" } } } as any; };
	const firstReview = await keep.firstReadOnce(room, MODEL, "fp-2", reviewRead, { kind: "review" });
	keep.keepDiscussionTurns(room, "fp-2", [{ role: "user", content: "Leave the Atlas topic as it is." }, { role: "assistant", content: "I will leave it." }], { state: "ok" }, "review");
	const reloadedReview = await keep.firstReadOnce(room, MODEL, "fp-2", reviewRead, { kind: "review" });
	assert(Number(reviewReads) === 1 && firstReview.assessmentMarkdown === "review read 1" && reloadedReview.keptDiscussion?.messages[0]?.content === "Leave the Atlas topic as it is.", `a Review reload comes back to its read and turns, got ${reviewReads} reads and ${JSON.stringify(reloadedReview.keptDiscussion)}`);
	const memorizeAfter = reads;
	await keep.firstReadOnce(room, MODEL, "fp-2", read("fp-2"));
	assert(Number(reads) === memorizeAfter + 1, "a Review read never serves Memorize");
	await keep.firstReadOnce(room, { provider: "openai-codex", model: "gpt-6.1-sol" }, "fp-2", reviewRead, { kind: "review" });
	assert(Number(reviewReads) === 2, `another Memory model reads Review again, got ${reviewReads}`);
	keep.clearKeptDiscussion(room, "review");
	await keep.firstReadOnce(room, { provider: "openai-codex", model: "gpt-6.1-sol" }, "fp-2", reviewRead, { kind: "review" });
	assert(Number(reviewReads) === 3, "Review's run start clears its own");
	console.log("memorize discussion keep smoke passed");
} finally {
	fs.rmSync(room, { recursive: true, force: true });
}
