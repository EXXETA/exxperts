// Review never fails while the Memory model can be reached, driven end to end
// through the REAL run on temp rooms with a scripted model: each op is judged
// alone, a group that fails is split down to one topic, Unsorted is always
// read and nothing is left in it, and a restart or an outage keeps what was
// done with Try again for the rest. Every section can run alone (ONLY=<name>).
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ReviewRun, ReviewRunGenerate } from "../src/review-run.js";
import type { AbsorbGenerateResult } from "../src/persistent-agents.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "review-never-fails-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const appDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2));
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const review = await import("../src/review-run.js");
const { approveReviewRun, getReviewRun, resetReviewRunsForTests, setReviewTidyRetryPauseForTests, startReviewRun } = review;
setReviewTidyRetryPauseForTests(0);
const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
const { parseMemoryDocument } = await import("../src/memory-entries.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const RUN_CLOCK = () => new Date("2026-09-14T09:00:00.000Z");
const SAVE_AT = new Date("2026-09-14T09:05:00.000Z");
const WINDOW = { contextWindow: 400_000, maxOutputTokens: 16_384 };

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A room whose Deep Memory holds the given topics, each a list of [id, text, meta] notes. */
function createRoom(name: string, topics: Record<string, Array<[string, string, string?]>>): { agentId: string; l1bPath: string } {
	const created = createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = created.agent.agentId;
	const l1bPath = path.join(root, agentId, "L1b", "current.md");
	const deep = Object.entries(topics).flatMap(([title, notes]) => [`### ${title}`, "", ...notes.flatMap(([id, text, meta]) => [`<!-- e: id=${id} kind=fact saved=2026-09-01${meta ?? ""} -->`, text, ""])]);
	fs.writeFileSync(l1bPath, [
		"<!-- exxeta:l1b schema_version=1 -->", "", "## Chronos", "", `- Persistent agent id: ${agentId}`, "- Lifecycle state: ready", "- Last checkpoint: cp_20260912_0001", "- Last checkpoint at: 2026-09-12T09:00:00.000Z", "- Last consolidation: none", "",
		"## Deep Memory", "", "<!-- entries: next=900 -->", "", ...deep,
		"## Active Items", "", "## Recent Context", "",
	].join("\n"), { mode: 0o600 });
	return { agentId, l1bPath };
}

const NOTE_ADDRESS = /^(?:\s*(?:[-*+]|\d+[.)])\s+)?\[([^\]\s·]+)(\s+·\s+pinned)?\]\s*([\s\S]*)$/;
/** The notes a tidy prompt lists, by topic, read back the way a model reads them. */
function notesOf(prompt: string): Array<{ id: string; topic: string; text: string }> {
	const material = prompt.split(/\n\n---\n\n/).find((part) => part.trimStart().startsWith("## Material: The Notes To Tidy")) ?? "";
	const rows: Array<{ id: string; topic: string; text: string }> = [];
	let topic = "";
	for (const line of material.split("\n").slice(1)) {
		const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line);
		if (heading) { topic = heading[1]; continue; }
		const row = NOTE_ADDRESS.exec(line.trim());
		if (row) rows.push({ id: row[1], topic, text: row[3] });
	}
	return rows;
}
const fence = (ops: unknown[]): AbsorbGenerateResult => ({ text: `Tidied.\n\n\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\`\n`, usage: { input: 100, output: 20 } });

async function settle(agentId: string, runId: string, withinMs = 60_000): Promise<ReviewRun> {
	const deadline = Date.now() + withinMs;
	let current = getReviewRun(agentId, runId);
	while (["prepass", "tidying", "budget"].includes(current.state)) {
		assert(Date.now() < deadline, `the run was still "${current.state}" after ${withinMs / 1000} seconds`);
		await sleep(2);
		current = getReviewRun(agentId, runId);
	}
	return current;
}
const topicOf = (l1bPath: string, id: string) => parseMemoryDocument(fs.readFileSync(l1bPath, "utf-8")).topics.find((topic) => topic.entries.some((entry) => entry.id === id))?.title;
const textOf = (l1bPath: string, id: string) => parseMemoryDocument(fs.readFileSync(l1bPath, "utf-8")).topics.flatMap((topic) => topic.entries).find((entry) => entry.id === id)?.text;
const ONLY = process.env.ONLY;
async function section(name: string, body: () => Promise<void>): Promise<void> {
	if (ONLY && ONLY !== name) return;
	resetReviewRunsForTests();
	await body();
	console.log(`ok ${name}`);
}

// One refused op does not cost the group: the valid ops apply, the refused
// one is dropped with a trace, and the group is not asked again.
await section("per-op", async () => {
	const room = createRoom("Per Op Room", { Renewals: [
		["m-0101", "- The Nordwind contract renews automatically every year on the first of June, as agreed in the original contract."],
		["m-0102", "- Renewal invoices go out on the first working day."],
		["m-0103", "- The **must-keep** renewal owner is Dana.", " pinned=true"],
	] });
	const calls: string[] = [];
	const generate: ReviewRunGenerate = async (prompt) => {
		calls.push(prompt);
		return fence([
			{ op: "update", id: "m-0101", text: "- The Nordwind contract renews every year on 1 June." },
			{ op: "archive", id: "m-0103", why: "stale" },
		]);
	};
	const { runId } = startReviewRun(room.agentId, { depth: "tidy", model: MODEL, generate, resolveModelWindow: () => WINDOW, now: RUN_CLOCK });
	const run = await settle(room.agentId, runId);
	assert(run.leftAsIs.length === 0 && calls.length === 1, `the group is tidied in one call, its refused op dropped, got ${JSON.stringify(run.leftAsIs)} after ${calls.length} call(s)`);
	assert(run.changes.some((change) => change.id === "m-0101") && !run.changes.some((change) => change.id === "m-0103"), `the valid op applies and the refused one does not, got ${JSON.stringify(run.changes.map((change) => [change.kind, change.id]))}`);
	approveReviewRun(room.agentId, runId, SAVE_AT);
	assert(textOf(room.l1bPath, "m-0101") === "- The Nordwind contract renews every year on 1 June." && textOf(room.l1bPath, "m-0103"), "the tidied note is saved and the pinned one stays");
});

// A group that fails while the model answers (a cut reply here) is split in
// two and each half is read again, down to one topic; only a one-topic group
// that still fails is left as it was.
await section("split", async () => {
	const room = createRoom("Split Room", {
		Renewals: [["m-0201", "- The Nordwind contract renews automatically every year on the first of June, as agreed."], ["m-0202", "- Renewal invoices go out on the first working day."]],
		Billing: [["m-0203", "- Invoices are paid within thirty days of the date written on the invoice itself."], ["m-0204", "- Billing questions go to the finance desk."]],
		Hopeless: [["m-0205", "- This topic is cut off whenever it is read, alone or not, every single time."], ["m-0206", "- A second note."]],
	});
	const seen: string[][] = [];
	const generate: ReviewRunGenerate = async (prompt) => {
		const notes = notesOf(prompt);
		const topics = [...new Set(notes.map((note) => note.topic))];
		seen.push(topics);
		if (topics.length > 1 || topics.includes("Hopeless")) return { text: "Tidied.\n\n```json\n{\"ops\": [{\"op\": \"update\",", truncated: true, usage: { input: 100, output: 16_384 } };
		const first = notes[0];
		return fence([{ op: "update", id: first.id, text: `- ${first.text.slice(0, 40).trimEnd()}.` }]);
	};
	const { runId } = startReviewRun(room.agentId, { depth: "tidy", model: MODEL, generate, resolveModelWindow: () => WINDOW, now: RUN_CLOCK });
	const run = await settle(room.agentId, runId);
	assert(seen.some((topics) => topics.length > 1), `the topics were first read together, got ${JSON.stringify(seen)}`);
	assert(run.changes.some((change) => change.id === "m-0201") && run.changes.some((change) => change.id === "m-0203"), `each half is read again alone and tidied, got ${JSON.stringify(run.changes.map((change) => change.id))} after ${JSON.stringify(seen)}`);
	assert(JSON.stringify(run.leftAsIs.map((row) => row.topics)) === JSON.stringify([["Hopeless"]]), `only the one topic that still fails is left as it was, got ${JSON.stringify(run.leftAsIs)}`);
});

// Unsorted is always read when it holds a note, whatever the first read
// named, and nothing is left in it: a note the reply did not file is placed
// by code under the topic its words match.
await section("unsorted", async () => {
	const room = createRoom("Unsorted Review Room", {
		Renewals: [["m-0301", "- The Nordwind contract renews automatically every year on the first of June."]],
		Billing: [["m-0302", "- Invoices are paid within thirty days."]],
		Unsorted: [["m-0303", "- The Nordwind contract renewal moves to the first of June next year.", " summary=true"], ["m-0304", "- Invoices for Nordwind now go out on the first working day."]],
	});
	const seen: string[] = [];
	const generate: ReviewRunGenerate = async (prompt) => {
		const notes = notesOf(prompt);
		seen.push(...notes.map((note) => note.topic));
		return fence(notes.some((note) => note.id === "m-0304") ? [{ op: "move", id: "m-0304", topic: "Billing" }] : []);
	};
	const { runId } = startReviewRun(room.agentId, { depth: "tidy", topics: ["Renewals"], model: MODEL, generate, resolveModelWindow: () => WINDOW, now: RUN_CLOCK });
	const run = await settle(room.agentId, runId);
	assert(seen.includes("Unsorted") && run.topics.includes("Unsorted"), `Unsorted is read although the first read named only Renewals, got ${JSON.stringify(run.topics)}`);
	assert(run.changes.some((change) => change.id === "m-0303" && change.kind === "moved" && change.after === "Renewals"), `the note the reply left in Unsorted is placed by code, and the card says where, got ${JSON.stringify(run.changes)}`);
	approveReviewRun(room.agentId, runId, SAVE_AT);
	assert(topicOf(room.l1bPath, "m-0303") === "Renewals" && topicOf(room.l1bPath, "m-0304") === "Billing" && !/^### Unsorted$/m.test(fs.readFileSync(room.l1bPath, "utf-8")), "nothing is left in Unsorted after the save");
});

// A restart while a group is in flight keeps the groups that finished, as a
// card with Continue; Continue reads the rest; an outage's Try again does the
// same; Save deletes the journal.
await section("restart-and-resume", async () => {
	const WORDING: Record<string, (n: number) => string> = {
		Alpha: (n) => `- Alpha invoice ${n} was approved by the finance desk after the quarterly budget review.`,
		Beta: (n) => `- The beta shipment ${n} leaves the northern harbour on schedule with sealed crates.`,
	};
	const many = (prefix: string, base: number) => Array.from({ length: 90 }, (_, n): [string, string] => [`m-${base + n}`, WORDING[prefix](n)]);
	// A small output cap keeps the two topics in groups of their own.
	const SMALL = { contextWindow: 400_000, maxOutputTokens: 4_000 };
	const room = createRoom("Restart Review Room", { Alpha: many("Alpha", 1000), Beta: many("Beta", 2000) });
	const journal = path.join(path.dirname(path.dirname(room.l1bPath)), "runtime", "review-run.json");
	const answer = (prompt: string) => {
		const first = notesOf(prompt)[0];
		return fence([{ op: "update", id: first.id, text: `- ${first.text.slice(0, 30).trimEnd()}.` }]);
	};
	const hangsOnBeta: ReviewRunGenerate = async (prompt) => (notesOf(prompt).some((note) => note.topic === "Beta") ? new Promise<AbsorbGenerateResult>(() => {}) : answer(prompt));
	const { runId } = startReviewRun(room.agentId, { depth: "tidy", model: MODEL, generate: hangsOnBeta, resolveModelWindow: () => SMALL, now: RUN_CLOCK });
	const deadline = Date.now() + 30_000;
	while (!getReviewRun(room.agentId, runId).changes.some((change) => change.id === "m-1000")) { assert(Date.now() < deadline, "Alpha was tidied"); await sleep(2); }
	assert(fs.existsSync(journal), "the run is journaled while it works");
	resetReviewRunsForTests(); // the server restarts with Beta in flight
	const revived = getReviewRun(room.agentId, runId);
	assert(revived.state === "ready" && revived.stop?.kind === "restart" && revived.changes.some((change) => change.id === "m-1000") && revived.leftAsIs.some((row) => row.topics.includes("Beta")), `after a restart the card keeps Alpha's tidy and offers Continue for Beta, got ${JSON.stringify({ state: revived.state, stop: revived.stop, left: revived.leftAsIs })}`);
	// A second restart, during the resumed tidy: the card comes back again with Alpha kept.
	let resumedOnBeta = false;
	review.resumeReviewRun(room.agentId, runId, MODEL, RUN_CLOCK(), { generate: async (prompt) => { if (notesOf(prompt).some((note) => note.topic === "Beta")) resumedOnBeta = true; return hangsOnBeta(prompt, MODEL, {} as never); } });
	while (!resumedOnBeta) { assert(Date.now() < deadline, "the resumed tidy reads Beta"); await sleep(2); }
	resetReviewRunsForTests();
	const again = getReviewRun(room.agentId, runId);
	assert(again.state === "ready" && again.stop?.kind === "restart" && again.changes.some((change) => change.id === "m-1000") && again.leftAsIs.some((row) => row.topics.includes("Beta")) && fs.existsSync(journal), `after a second restart the card keeps Alpha's tidy and offers Continue for Beta again, got ${JSON.stringify({ state: again.state, stop: again.stop, left: again.leftAsIs })}`);
	review.resumeReviewRun(room.agentId, runId, MODEL, RUN_CLOCK(), { generate: async (prompt) => answer(prompt) });
	const done = await settle(room.agentId, runId);
	assert(!done.stop && done.leftAsIs.length === 0 && done.changes.some((change) => change.id === "m-2000") && done.changes.some((change) => change.id === "m-1000"), `Continue reads Beta and keeps Alpha, got ${JSON.stringify({ stop: done.stop, left: done.leftAsIs, changes: done.changes.map((change) => change.id) })}`);
	approveReviewRun(room.agentId, runId, SAVE_AT);
	assert(textOf(room.l1bPath, "m-1000")?.endsWith(".") && textOf(room.l1bPath, "m-2000")?.length! < 60 && !fs.existsSync(journal), "Save writes both tidies and deletes the journal");
	// An outage stops the run; Try again reads only the groups not done.
	resetReviewRunsForTests();
	const { ModelUnreachableError } = await import("../src/model-call-causes.js");
	const second = createRoom("Outage Review Room", { Alpha: many("Alpha", 3000), Beta: many("Beta", 4000) });
	const downOnBeta: ReviewRunGenerate = async (prompt) => { if (notesOf(prompt).some((note) => note.topic === "Beta")) throw new ModelUnreachableError("not-answering", MODEL); return answer(prompt); };
	const outage = await settle(second.agentId, startReviewRun(second.agentId, { depth: "tidy", model: MODEL, generate: downOnBeta, resolveModelWindow: () => SMALL, now: RUN_CLOCK }).runId);
	assert(outage.stop?.kind === "outage", `the run stops on the outage, got ${JSON.stringify(outage.stop)}`);
	const seen: string[] = [];
	review.resumeReviewRun(second.agentId, outage.runId, MODEL, RUN_CLOCK(), { generate: async (prompt) => { seen.push(...new Set(notesOf(prompt).map((note) => note.topic))); return answer(prompt); } });
	const resumed = await settle(second.agentId, outage.runId);
	assert(!resumed.stop && resumed.leftAsIs.length === 0 && JSON.stringify(seen) === JSON.stringify(["Beta"]), `Try again reads only Beta, got ${JSON.stringify({ seen, left: resumed.leftAsIs })}`);
	// A group still waiting on a busy model stops at once when another learns it cannot be reached.
	const third = createRoom("Siblings Review Room", { Alpha: many("Alpha", 5000), Beta: many("Beta", 6000) });
	const waitsOnAlpha: ReviewRunGenerate = (prompt, _model, options) => notesOf(prompt).some((note) => note.topic === "Beta")
		? sleep(20).then(() => { throw new ModelUnreachableError("not-answering", MODEL); })
		: new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));
	const stopped = await settle(third.agentId, startReviewRun(third.agentId, { depth: "tidy", model: MODEL, generate: waitsOnAlpha, resolveModelWindow: () => SMALL, now: RUN_CLOCK }).runId, 5_000);
	assert(stopped.stop?.kind === "outage" && stopped.leftAsIs.some((row) => row.topics.includes("Alpha") && row.reason === review.REVIEW_TIDY_NOT_REACHED), `Alpha stops waiting and waits for Try again, got ${JSON.stringify({ stop: stopped.stop, left: stopped.leftAsIs })}`);
	// A note the person kept on the card is left as they left it by Try again.
	const { writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
	const long = (base: number) => Array.from({ length: 260 }, (_, n): [string, string] => [`m-${base + n}`, `- Gamma record ${n} keeps the long account of the harbour inspection, the crates, the seals, the dates and the people who signed for each delivery at the northern quay.`]);
	const fourth = createRoom("Kept Review Room", { Alpha: many("Alpha", 7000), Gamma: long(8000) });
	writePersistentRoomMaintenanceSettings(fourth.agentId, { memoryBudgetTokens: 10_000 });
	const downOnGamma: ReviewRunGenerate = async (prompt) => { if (notesOf(prompt).some((note) => note.topic === "Gamma")) throw new ModelUnreachableError("not-answering", MODEL); return answer(prompt); };
	const paused = await settle(fourth.agentId, startReviewRun(fourth.agentId, { depth: "tidy", model: MODEL, generate: downOnGamma, resolveModelWindow: () => SMALL, now: RUN_CLOCK }).runId);
	const keptRow = paused.demotion.entries.find((row) => row.topic === "Gamma" && row.leaving);
	assert(paused.stop?.kind === "outage" && keptRow, `the run stops with Gamma notes leaving for the budget, got ${JSON.stringify({ stop: paused.stop, rows: paused.demotion.entries.length })}`);
	review.keepReviewRunEntries(fourth.agentId, paused.runId, { keepIds: [keptRow!.id] });
	const asked: string[] = [];
	review.resumeReviewRun(fourth.agentId, paused.runId, MODEL, RUN_CLOCK(), { generate: async (prompt) => { asked.push(...notesOf(prompt).map((note) => note.id)); return fence(notesOf(prompt).map((note) => ({ op: "update", id: note.id, text: "- Shortened." }))); } });
	const after = await settle(fourth.agentId, paused.runId);
	assert(!after.stop && asked.length > 0 && !asked.includes(keptRow!.id), `Try again reads Gamma without the kept note, got ${JSON.stringify({ stop: after.stop, asked: asked.length, kept: asked.includes(keptRow!.id) })}`);
	approveReviewRun(fourth.agentId, paused.runId, SAVE_AT);
	assert(textOf(fourth.l1bPath, keptRow!.id) === keptRow!.text, `the kept note is saved as the person left it, got ${JSON.stringify(textOf(fourth.l1bPath, keptRow!.id))}`);
});

// A journal a restart cannot use, in a folder where its delete fails: the
// delete is ignored and the room reads as having no run, for both runs.
await section("unusable-journal", async () => {
	const room = createRoom("Unusable Journal Room", { Alpha: [["m-0001", "- One note."]] });
	const runtimeDir = path.join(path.dirname(path.dirname(room.l1bPath)), "runtime");
	fs.mkdirSync(runtimeDir, { recursive: true });
	for (const name of ["review-run.json", "memorize-run.json"]) fs.writeFileSync(path.join(runtimeDir, name), JSON.stringify({ schemaVersion: 1, slot: { run: { runId: "r_old", agentId: room.agentId, state: "prepass" } } }));
	fs.chmodSync(runtimeDir, 0o500);
	try {
		const absorb = await import("../src/absorb-run.js");
		let threw: unknown = null;
		try {
			assert(!review.hasActiveReviewRun(room.agentId) && !absorb.hasActiveAbsorbRun(room.agentId), "neither run holds the room");
		} catch (error) { threw = error; }
		assert(!threw, `a journal whose delete fails is ignored, got ${String(threw)}`);
	} finally {
		fs.chmodSync(runtimeDir, 0o700);
	}
});

// The discussion a run came from is kept until the run is journaled, so a
// restart during planning leaves the person their discussion.
await section("discussion-kept-until-journaled", async () => {
	const room = createRoom("Review Kept Room", { Renewals: [["m-0901", "- The Nordwind contract renews every year in June."], ["m-0902", "- Renewal invoices go out on the first working day."]] });
	const kept = path.join(root, room.agentId, "runtime", "review-discussion.json");
	fs.mkdirSync(path.dirname(kept), { recursive: true });
	fs.writeFileSync(kept, JSON.stringify({ read: { assessmentMarkdown: "a read" } }));
	let keptAtFirstCall: boolean | null = null;
	const generate: ReviewRunGenerate = async () => {
		keptAtFirstCall ??= fs.existsSync(kept);
		return fence([]);
	};
	const { runId } = startReviewRun(room.agentId, { depth: "tidy", model: MODEL, generate, resolveModelWindow: () => WINDOW, now: RUN_CLOCK });
	await settle(room.agentId, runId);
	assert(keptAtFirstCall === false && !fs.existsSync(kept), `once the run is journaled the discussion goes, got ${keptAtFirstCall}`);
});

// Notes the tidy left in Unsorted that share no word with any topic open one
// topic together, as Memorize's sort does, never one topic each.
await section("unsorted-tail-one-topic", async () => {
	const room = createRoom("Review Unsorted Room", {
		Renewals: [["m-0951", "- The Nordwind contract renews every year in June."]],
		Unsorted: [["m-0952", "- The client prefers mornings for calls."], ["m-0953", "- Quarterly offsite happens in Lisbon."], ["m-0954", "- Coffee machine needs descaling monthly."]],
	});
	const { runId } = startReviewRun(room.agentId, { depth: "tidy", model: MODEL, generate: async () => fence([]), resolveModelWindow: () => WINDOW, now: RUN_CLOCK });
	await settle(room.agentId, runId);
	approveReviewRun(room.agentId, runId, SAVE_AT);
	const homes = new Set(["m-0952", "m-0953", "m-0954"].map((id) => topicOf(room.l1bPath, id)));
	assert(homes.size === 1 && !homes.has("Unsorted") && !homes.has(undefined), `the unmatched notes share one topic, got ${JSON.stringify([...homes])}`);
});

// While Review tidies, Memorize does not start: the two would read the same
// memory and the one saved second would be refused, its calls paid for nothing.
await section("no-memorize-while-reviewing", async () => {
	const room = createRoom("Review Busy Room", { Renewals: [["m-0961", "- The Nordwind contract renews every year in June."], ["m-0962", "- Renewal invoices go out on the first working day."]] });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let tidying = false;
	const { runId } = startReviewRun(room.agentId, { depth: "tidy", model: MODEL, generate: async () => { tidying = true; await gate; return fence([]); }, resolveModelWindow: () => WINDOW, now: RUN_CLOCK });
	const deadline = Date.now() + 30_000;
	while (!tidying) { assert(Date.now() < deadline, "the review reached its tidy call"); await sleep(2); }
	const { startAbsorbRun } = await import("../src/absorb-run.js");
	let refused: any = null;
	try { startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: "## A read", model: MODEL, generate: async () => ({ text: "" }), probe: async () => ({ text: "OK" }), now: RUN_CLOCK }); } catch (error) { refused = error; }
	release();
	await settle(room.agentId, runId);
	assert(refused?.code === "absorb_review_active" && refused.statusCode === 409, `Memorize is refused while Review tidies, got ${refused?.code ?? "a start"}`);
});

fs.rmSync(tempHome, { recursive: true, force: true });
console.log("review-never-fails smoke passed");
