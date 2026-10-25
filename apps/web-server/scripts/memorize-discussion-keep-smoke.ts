// The Memorize first read and its discussion are kept with the room until the
// run starts: a reload comes back to them with no new first read, and two tabs
// asking at once share one first read. A changed memory or Memory model reads
// again. A closed request never ends a read; only Cancel does. Offline: the
// first read is a counted fake.
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

	// A read for another Memory model never joins one still in flight for the old model.
	keep.clearKeptDiscussion(room);
	let releaseOld!: () => void;
	const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
	const forModel = (label: string, gate?: Promise<void>) => async () => {
		reads += 1;
		await gate;
		return { assessmentMarkdown: label, source: { l1bFingerprint: { value: "fp-3" }, generatedAt: "2026-10-10T12:00:00.000Z" } } as any;
	};
	const beforeSwitch = reads;
	const oldRead = keep.firstReadOnce(room, MODEL, "fp-3", forModel("old model's read", oldGate));
	const newReading = keep.firstReadOnce(room, { provider: "openai-codex", model: "gpt-6.1-sol" }, "fp-3", forModel("new model's read"));
	releaseOld();
	const [, newRead] = await Promise.all([oldRead, newReading]);
	assert(Number(reads) === beforeSwitch + 2 && newRead.assessmentMarkdown === "new model's read", `another model reads on its own, got ${reads - beforeSwitch} reads and "${newRead.assessmentMarkdown}"`);

	// A request that closed (a reload, a dropped connection, a proxy's idle
	// limit) never ends the read: the next ask joins it, and the model is asked once.
	keep.clearKeptDiscussion(room);
	const aborted: string[] = [];
	let releaseSlow!: () => void;
	const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
	const slow = (label: string) => (signal: AbortSignal) => new Promise<any>((resolve, reject) => {
		reads += 1;
		signal.addEventListener("abort", () => { aborted.push(label); reject(new Error("aborted")); }, { once: true });
		void slowGate.then(() => resolve({ assessmentMarkdown: label, source: { l1bFingerprint: { value: "fp-4" } }, process: { model: MODEL } }));
	});
	const beforeReload = reads;
	const closed = new AbortController();
	const beforeTheReload = keep.firstReadOnce(room, MODEL, "fp-4", slow("the read before the reload") as any, { signal: closed.signal, ask: "tab-a" } as any).catch(() => "ended");
	closed.abort();
	await new Promise((resolve) => setTimeout(resolve, 5));
	const afterTheReload = keep.firstReadOnce(room, MODEL, "fp-4", slow("a second read") as any, { ask: "tab-a-reloaded" } as any).catch((error: Error) => ({ assessmentMarkdown: `failed: ${error.message}` }));
	releaseSlow();
	const rejoined = await afterTheReload;
	await beforeTheReload;
	assert(aborted.length === 0 && Number(reads) === beforeReload + 1 && rejoined.assessmentMarkdown === "the read before the reload", `a closed request never ends the read: the next ask joins it, got ${reads - beforeReload} reads, aborted ${JSON.stringify(aborted)} and "${rejoined.assessmentMarkdown}"`);
	const keptAfterClose = await keep.firstReadOnce(room, MODEL, "fp-4", read("fp-4"));
	assert(Number(reads) === beforeReload + 1 && keptAfterClose.assessmentMarkdown === "the read before the reload", `the read a closed request left is kept for the next ask, got "${keptAfterClose.assessmentMarkdown}"`);

	// Only an explicit Cancel ends a read: one tab's Cancel ends its own wait at
	// once and keeps the read for the tab still waiting; the last Cancel aborts it.
	keep.clearKeptDiscussion(room);
	const cancelledReads: string[] = [];
	const endless = (signal: AbortSignal) => new Promise<any>((_resolve, reject) => {
		reads += 1;
		signal.addEventListener("abort", () => { cancelledReads.push("aborted"); reject(new Error("aborted")); }, { once: true });
	});
	const beforeCancel = reads;
	const tabA = keep.firstReadOnce(room, MODEL, "fp-5", endless as any, { ask: "tab-a" }).then(() => "answered", () => "cancelled");
	const tabB = keep.firstReadOnce(room, MODEL, "fp-5", endless as any, { ask: "tab-b" }).then(() => "answered", () => "cancelled");
	assert(keep.cancelFirstRead(room, "memorize", "tab-a"), "a Cancel finds the ask it names");
	assert(await tabA === "cancelled" && cancelledReads.length === 0, `one tab's Cancel ends its own wait and keeps the read for the other, got ${JSON.stringify(cancelledReads)}`);
	// Another room's or kind's Cancel with the same id touches nothing here.
	assert(!keep.cancelFirstRead(`${room}-elsewhere`, "memorize", "tab-b") && !keep.cancelFirstRead(room, "review", "tab-b") && cancelledReads.length === 0, "a Cancel only reaches its own room's ask");
	keep.cancelFirstRead(room, "memorize", "tab-b");
	assert(await tabB === "cancelled" && Number(cancelledReads.length) === 1 && Number(reads) === beforeCancel + 1, `the last Cancel aborts the read, got ${JSON.stringify(cancelledReads)} after ${reads - beforeCancel} reads`);
	await keep.firstReadOnce(room, MODEL, "fp-5", read("fp-5"));
	assert(Number(reads) === beforeCancel + 2, `an ask after the Cancel reads afresh, got ${reads - beforeCancel}`);
	// A Cancel that arrives before its own ask: the ask then starts no read.
	keep.clearKeptDiscussion(room);
	const beforeEarly = reads;
	keep.cancelFirstRead(room, "memorize", "tab-c");
	const early = await keep.firstReadOnce(room, MODEL, "fp-5", read("fp-5"), { ask: "tab-c" }).then(() => "answered", () => "cancelled");
	assert(early === "cancelled" && Number(reads) === beforeEarly, `an ask cancelled before it arrived starts no read, got ${early} after ${reads - beforeEarly} reads`);
	assert(keep.firstReadAsk({ ask: "a_lq3x9_k2j4h8" }) === "a_lq3x9_k2j4h8" && keep.firstReadAsk({ ask: "../room" }) === undefined && keep.firstReadAsk({ ask: "x".repeat(101) }) === undefined && keep.firstReadAsk({}) === undefined, "only a short plain id names an ask");

	// A page whose request was cut asks again under the same id. Its cut request
	// closing late never takes the new request off the read, so another tab's
	// Cancel keeps the read for it; the page's own Cancel of that id ends it.
	keep.clearKeptDiscussion(room);
	const cutEnds: string[] = [];
	const cutRead = (signal: AbortSignal) => new Promise<any>((_resolve, reject) => {
		reads += 1;
		signal.addEventListener("abort", () => { cutEnds.push("aborted"); reject(new Error("aborted")); }, { once: true });
	});
	const beforeCut = reads;
	const cutRequest = new AbortController();
	const cutAsk = keep.firstReadOnce(room, MODEL, "fp-6", cutRead as any, { ask: "tab-d", signal: cutRequest.signal }).then(() => "answered", () => "ended");
	const askedAgain = keep.firstReadOnce(room, MODEL, "fp-6", cutRead as any, { ask: "tab-d" }).then(() => "answered", () => "ended");
	const otherTab = keep.firstReadOnce(room, MODEL, "fp-6", cutRead as any, { ask: "tab-e" }).then(() => "answered", () => "ended");
	cutRequest.abort();
	keep.cancelFirstRead(room, "memorize", "tab-e");
	assert(await otherTab === "ended", "the other tab's Cancel ends its own wait");
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert(cutEnds.length === 0 && Number(reads) === beforeCut + 1, `the page that asked again under its id still waits, so the read goes on, got ${JSON.stringify(cutEnds)} after ${reads - beforeCut} reads`);
	assert(keep.cancelFirstRead(room, "memorize", "tab-d") && await askedAgain === "ended" && await cutAsk === "ended" && Number(cutEnds.length) === 1, `the page's Cancel of its id ends the read it joined again, got ${JSON.stringify(cutEnds)}`);
	console.log("memorize discussion keep smoke passed");
} finally {
	fs.rmSync(room, { recursive: true, force: true });
}
