// Review never fails while the Memory model can be reached, driven end to end
// through the REAL run on temp rooms with a scripted model: each op is judged
// alone, a group that fails is split down to one topic, Unsorted is always
// read and nothing is left in it, and a restart or an outage keeps what was
// done with Try again for the rest. Every section can run alone (ONLY=<name>).
//
// Offline: no server, no provider, no network, no port.

import { randomUUID } from "node:crypto";
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

// Try again on a card with topics left, while the model answers: only those
// topics are read again, on the same run, with the Memory model as it is now;
// what was tidied, kept and edited stays.
await section("try-again-topics-left", async () => {
	const room = createRoom("Try Again Room", {
		Alpha: [["m-0401", "- Alpha one says the quarterly report goes to the finance desk on the first Monday."], ["m-0402", "- Alpha two is an old note about the 2024 report."]],
		Beta: [["m-0403", "- Beta one says the harbour inspection happens every second Thursday of the month."]],
		Gamma: [["m-0404", "- Gamma one says the crates are sealed at the northern quay before they leave."]],
	});
	const topicsIn = (prompt: string) => [...new Set(notesOf(prompt).map((note) => note.topic))];
	// Cut off whenever Beta or Gamma is in the call: the group is split, and only those two are left.
	const failsOnBetaGamma: ReviewRunGenerate = async (prompt) => {
		if (topicsIn(prompt).some((topic) => topic !== "Alpha")) return { text: "Tidied.\n\n```json\n{\"ops\": [", truncated: true, usage: { input: 100, output: 16_384 } };
		return fence([{ op: "update", id: "m-0401", text: "- Alpha one: the report goes to finance on the first Monday." }, { op: "archive", id: "m-0402", why: "stale" }]);
	};
	const first = await settle(room.agentId, startReviewRun(room.agentId, { depth: "tidy", model: MODEL, generate: failsOnBetaGamma, resolveModelWindow: () => WINDOW, now: RUN_CLOCK }).runId);
	const leftTopics = (run: ReviewRun) => run.leftAsIs.flatMap((row) => row.topics).sort().join(",");
	assert(!first.stop && leftTopics(first) === "Beta,Gamma" && first.changes.some((change) => change.id === "m-0401"), `Alpha is tidied and Beta and Gamma are left, got ${JSON.stringify({ stop: first.stop, left: first.leftAsIs, changes: first.changes.map((change) => change.id) })}`);
	const edited = "- Alpha one, as the person wrote it.";
	review.editReviewRunEntry(room.agentId, first.runId, "m-0401", edited);
	review.keepReviewRunEntries(room.agentId, first.runId, { keepIds: ["m-0402"] });

	// The same failure again: the same card, with the same topics named, and nothing done is lost.
	const MODEL_B = { provider: "openai-compatible", model: "gpt-5.5-mini", label: "GPT-5.5 mini" };
	const failedCalls: string[][] = [];
	let resumeError: Error | null = null;
	try {
		review.resumeReviewRun(room.agentId, first.runId, MODEL_B, RUN_CLOCK(), { generate: async (prompt) => { failedCalls.push(topicsIn(prompt)); throw new Error("provider 500"); } });
	} catch (error) { resumeError = error as Error; }
	assert(!resumeError, `Try again is taken on a card whose topics failed while the model answers, got ${resumeError?.message}`);
	const again = await settle(room.agentId, first.runId);
	assert(failedCalls.length > 0 && failedCalls.every((topics) => !topics.includes("Alpha")), `Try again reads only the topics left, got ${JSON.stringify(failedCalls)}`);
	assert(again.state === "ready" && !again.stop && leftTopics(again) === "Beta,Gamma", `a second failure gives the same card with the topics named, got ${JSON.stringify({ state: again.state, left: again.leftAsIs })}`);
	assert(again.changes.find((change) => change.id === "m-0401")?.after === edited && again.demotion.keepIds.includes("m-0402"), `the edit and the keep stay, got ${JSON.stringify({ changes: again.changes, keep: again.demotion.keepIds })}`);

	// Another model chosen, then Try again: one call, for Beta and Gamma only, on the new model.
	const calls: Array<{ model: string; topics: string[] }> = [];
	review.resumeReviewRun(room.agentId, first.runId, MODEL_B, RUN_CLOCK(), { generate: async (prompt, model) => {
		calls.push({ model: model.model, topics: topicsIn(prompt) });
		return fence(notesOf(prompt).map((note) => ({ op: "update", id: note.id, text: `- ${note.topic} shortened.` })));
	} });
	const done = await settle(room.agentId, first.runId);
	assert(calls.length === 1 && calls[0].model === "gpt-5.5-mini" && calls[0].topics.sort().join(",") === "Beta,Gamma", `one call for the topics left, on the model chosen now, got ${JSON.stringify(calls)}`);
	assert(done.leftAsIs.length === 0 && ["m-0401", "m-0403", "m-0404"].every((id) => done.changes.some((change) => change.id === id)) && done.changes.find((change) => change.id === "m-0401")?.after === edited, `the card holds every tidy with the edit, got ${JSON.stringify(done.changes)}`);
	approveReviewRun(room.agentId, first.runId, SAVE_AT);
	assert(textOf(room.l1bPath, "m-0401") === edited && textOf(room.l1bPath, "m-0402") && textOf(room.l1bPath, "m-0403") === "- Beta shortened.", "Save writes the edit, the kept note and the new tidy");
	// The saved screen's Try again: a new Review asked for only the topics left reads only those.
	const asked: string[] = [];
	const onlyGamma = await settle(room.agentId, startReviewRun(room.agentId, { depth: "tidy", topics: ["Gamma"], model: MODEL, generate: async (prompt) => { asked.push(...topicsIn(prompt)); return fence([]); }, resolveModelWindow: () => WINDOW, now: RUN_CLOCK }).runId);
	assert(onlyGamma.topics.join(",") === "Gamma" && [...new Set(asked)].join(",") === "Gamma", `a Review of the topics left reads only them, got ${JSON.stringify({ topics: onlyGamma.topics, asked })}`);

	// The memory changed underneath the card: Try again refuses before any call.
	const stale = createRoom("Stale Try Again Room", { Beta: [["m-0411", "- Beta one says the harbour inspection happens every second Thursday."]] });
	const staleRun = await settle(stale.agentId, startReviewRun(stale.agentId, { depth: "tidy", model: MODEL, generate: async () => { throw new Error("provider 500"); }, resolveModelWindow: () => WINDOW, now: RUN_CLOCK }).runId);
	fs.writeFileSync(stale.l1bPath, fs.readFileSync(stale.l1bPath, "utf-8").replace("every second Thursday", "every first Thursday"));
	let staleCalls = 0;
	let refused: Error | null = null;
	try { review.resumeReviewRun(stale.agentId, staleRun.runId, MODEL, RUN_CLOCK(), { generate: async () => { staleCalls++; return fence([]); } }); } catch (error) { refused = error as Error; }
	assert(/stale/.test(refused?.message ?? "") && staleCalls === 0, `a memory changed underneath is refused before any call, got ${refused?.message ?? "a resume"}`);

	// A run revived after a restart: Continue reads the topic the restart caught and the one that failed.
	const WORDING: Record<string, (n: number) => string> = {
		Alpha: (n) => `- Alpha invoice ${n} was approved by the finance desk after the quarterly budget review.`,
		Beta: (n) => `- The beta shipment ${n} leaves the northern harbour on schedule with sealed crates.`,
		Gamma: (n) => `- Gamma record ${n} keeps the harbour inspection dates and who signed for each delivery.`,
	};
	const many = (prefix: string, base: number) => Array.from({ length: 90 }, (_, n): [string, string] => [`m-${base + n}`, WORDING[prefix](n)]);
	const SMALL = { contextWindow: 400_000, maxOutputTokens: 4_000 };
	const restarted = createRoom("Revived Try Again Room", { Alpha: many("Alpha", 9000), Beta: many("Beta", 9200), Gamma: many("Gamma", 9400) });
	const answer = (prompt: string) => { const one = notesOf(prompt)[0]; return fence([{ op: "update", id: one.id, text: `- ${one.text.slice(0, 30).trimEnd()}.` }]); };
	const mixed: ReviewRunGenerate = async (prompt) => {
		const topics = topicsIn(prompt);
		if (topics.includes("Gamma")) return new Promise<AbsorbGenerateResult>(() => {});
		if (topics.includes("Beta")) throw new Error("provider 500");
		return answer(prompt);
	};
	const { runId } = startReviewRun(restarted.agentId, { depth: "tidy", model: MODEL, generate: mixed, resolveModelWindow: () => SMALL, now: RUN_CLOCK });
	const deadline = Date.now() + 30_000;
	for (;;) {
		const live = getReviewRun(restarted.agentId, runId);
		if (live.changes.some((change) => change.id === "m-9000") && live.leftAsIs.some((row) => row.topics.includes("Beta"))) break;
		assert(Date.now() < deadline, "Alpha was tidied and Beta left");
		await sleep(2);
	}
	resetReviewRunsForTests();
	const revived = getReviewRun(restarted.agentId, runId);
	assert(revived.stop?.kind === "restart" && leftTopics(revived) === "Beta,Gamma", `the revived card names Beta and Gamma, got ${JSON.stringify(revived.leftAsIs)}`);
	const read: string[] = [];
	review.resumeReviewRun(restarted.agentId, runId, MODEL, RUN_CLOCK(), { generate: async (prompt) => { read.push(...topicsIn(prompt)); return answer(prompt); } });
	const continued = await settle(restarted.agentId, runId);
	assert(continued.leftAsIs.length === 0 && [...new Set(read)].sort().join(",") === "Beta,Gamma" && continued.changes.some((change) => change.id === "m-9000"), `Continue reads Beta and Gamma and keeps Alpha, got ${JSON.stringify({ read: [...new Set(read)], left: continued.leftAsIs })}`);
});

// A tidy call the provider refuses as a bad request is not sent again as it
// was, a group is split only when it was too large or refused, and the same
// failure twice in a row stops the run with what is left on the card.
await section("same-failure-stops", async () => {
	const WORDING: Record<string, (n: number) => string> = {
		Alpha: (n) => `- Alpha invoice ${n} was approved by the finance desk after the quarterly budget review.`,
		Beta: (n) => `- The beta shipment ${n} leaves the northern harbour on schedule with sealed crates.`,
		Gamma: (n) => `- Gamma record ${n} keeps the harbour inspection dates and who signed for each delivery.`,
		Delta: (n) => `- Delta order ${n} ships from the southern depot once the customs papers are stamped.`,
		Epsilon: (n) => `- Epsilon ticket ${n} is closed after the customer confirms the fix in writing.`,
		Zeta: (n) => `- Zeta contract ${n} renews each spring unless one side gives notice in writing.`,
	};
	const many = (prefix: string, base: number) => Array.from({ length: 90 }, (_, n): [string, string] => [`m-${base + n}`, WORDING[prefix](n)]);
	const SMALL = { contextWindow: 400_000, maxOutputTokens: 4_000 };
	const topicsIn = (prompt: string) => [...new Set(notesOf(prompt).map((note) => note.topic))];

	// A plain 400 on one group: one call, no resend, no split; the topics are left with the reason.
	const small = createRoom("Bad Request Room", { Alpha: [["m-0501", "- Alpha one."]], Beta: [["m-0502", "- Beta one."]], Gamma: [["m-0503", "- Gamma one."]] });
	let badCalls = 0;
	const bad = await settle(small.agentId, startReviewRun(small.agentId, { depth: "tidy", model: MODEL, generate: async () => { badCalls++; throw new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Bad request"}}'); }, resolveModelWindow: () => WINDOW, now: RUN_CLOCK }).runId);
	assert(badCalls === 1 && bad.leftAsIs.flatMap((row) => row.topics).sort().join(",") === "Alpha,Beta,Gamma", `a 400 is asked once and the group is not split, got ${JSON.stringify({ calls: badCalls, left: bad.leftAsIs })}`);
	// The same refusal in Mistral's words, or with its status on the error itself: one call each.
	for (const [label, refusal, name] of [
		["Mistral's 400", () => new Error('Mistral API error (400): {"object":"error","message":"Bad request","type":"invalid_request_error"}'), "Mistral Refusal Room"],
		["a 400 on the error", () => Object.assign(new Error("Bad request"), { status: 400 }), "Status Refusal Room"],
		["a 400 on the error's statusCode", () => Object.assign(new Error("Bad request"), { statusCode: 400 }), "Status Code Refusal Room"],
		["a 400 only as the runtime's errorStatus", () => Object.assign(new Error("Bad request"), { errorStatus: 400 }), "Error Status Refusal Room"],
	] as const) {
		const refusedRoom = createRoom(name, { Alpha: [["m-0531", "- Alpha one."]] });
		let refusedCalls = 0;
		const refusedRun = await settle(refusedRoom.agentId, startReviewRun(refusedRoom.agentId, { depth: "tidy", model: MODEL, generate: async () => { refusedCalls++; throw refusal(); }, resolveModelWindow: () => WINDOW, now: RUN_CLOCK }).runId);
		assert(refusedCalls === 1 && refusedRun.leftAsIs.length === 1, `${label} is asked once, got ${JSON.stringify({ calls: refusedCalls, left: refusedRun.leftAsIs })}`);
	}

	// The same 400 on every group of six: the run stops after the groups already in flight.
	const big = createRoom("Same Failure Room", { Alpha: many("Alpha", 5100), Beta: many("Beta", 5200), Gamma: many("Gamma", 5300), Delta: many("Delta", 5400), Epsilon: many("Epsilon", 5500), Zeta: many("Zeta", 5600) });
	let bigCalls = 0;
	const stopped = await settle(big.agentId, startReviewRun(big.agentId, { depth: "tidy", model: MODEL, generate: async () => { bigCalls++; throw new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Bad request"}}'); }, resolveModelWindow: () => SMALL, now: RUN_CLOCK }).runId);
	assert(bigCalls <= review.REVIEW_GROUPS_IN_FLIGHT + 1 && (stopped.stop as any)?.kind === "failing" && stopped.leftAsIs.flatMap((row) => row.topics).length === 6, `the same failure twice stops the run, got ${JSON.stringify({ calls: bigCalls, stop: stopped.stop, left: stopped.leftAsIs.flatMap((row) => row.topics) })}`);
	// The same 400 with a new request id each time, as a gateway's body adds one to the words: still the same failure, so the run stops.
	const withIds = createRoom("Request Id Room", { Alpha: many("Alpha", 6100), Beta: many("Beta", 6200), Gamma: many("Gamma", 6300), Delta: many("Delta", 6400), Epsilon: many("Epsilon", 6500), Zeta: many("Zeta", 6600) });
	let idCalls = 0;
	const idStopped = await settle(withIds.agentId, startReviewRun(withIds.agentId, { depth: "tidy", model: MODEL, generate: async () => { idCalls++; throw new Error(`400 status code (no body)\n{"message":"Bad request","request_id":"${randomUUID()}"}`); }, resolveModelWindow: () => SMALL, now: RUN_CLOCK }).runId);
	assert(idCalls <= review.REVIEW_GROUPS_IN_FLIGHT + 1 && (idStopped.stop as any)?.kind === "failing" && idStopped.leftAsIs.flatMap((row) => row.topics).length === 6, `two failures that differ only in a request id stop the run, got ${JSON.stringify({ calls: idCalls, stop: idStopped.stop, left: idStopped.leftAsIs.flatMap((row) => row.topics) })}`);

	// A server error on one group: asked once more, then left as it was; one group failing is not a pattern.
	const fiveHundred = createRoom("Server Error Room", { Alpha: [["m-0511", "- Alpha one."]] });
	let serverCalls = 0;
	const leftOnRetry = await settle(fiveHundred.agentId, startReviewRun(fiveHundred.agentId, { depth: "tidy", model: MODEL, generate: async () => { serverCalls++; throw new Error("provider 500"); }, resolveModelWindow: () => WINDOW, now: RUN_CLOCK }).runId);
	assert(serverCalls === 2 && !leftOnRetry.stop && leftOnRetry.leftAsIs.length === 1, `one group's server error buys one more call and leaves it, got ${JSON.stringify({ calls: serverCalls, stop: leftOnRetry.stop })}`);

	// A refusal still splits: the topic it was about is left, the other one is tidied.
	const refusing = createRoom("Refusal Room", { Alpha: [["m-0521", "- Alpha one says the report goes to finance on Mondays."]], Beta: [["m-0522", "- Beta one says something the model refuses."]] });
	const asked: string[][] = [];
	const refusedRun = await settle(refusing.agentId, startReviewRun(refusing.agentId, { depth: "tidy", model: MODEL, generate: async (prompt) => {
		const topics = topicsIn(prompt);
		asked.push(topics);
		if (topics.includes("Beta")) throw new Error("The model refused to answer this request.");
		return fence([{ op: "update", id: "m-0521", text: "- Alpha one: finance on Mondays." }]);
	}, resolveModelWindow: () => WINDOW, now: RUN_CLOCK }).runId);
	assert(!refusedRun.stop && refusedRun.changes.some((change) => change.id === "m-0521") && refusedRun.leftAsIs.flatMap((row) => row.topics).join(",") === "Beta", `a refusal is split down to its topic, got ${JSON.stringify({ asked, stop: refusedRun.stop, left: refusedRun.leftAsIs })}`);
});

// Review's first read never blocks Review: a call that fails while the model
// answers (a bad request, a refusal, an empty or unreadable reply) gives the
// missing-read answer, as Memorize's does; only an unreachable model is an error.
await section("first-read-missing", async () => {
	const { default: Fastify } = await import("fastify");
	const { registerReviewAssessRoutes } = await import("../src/review-assess-routes.js");
	const { ModelUnreachableError } = await import("../src/model-call-causes.js");
	const room = createRoom("First Read Room", { Alpha: [["m-0601", "- Alpha one says the report goes to finance on Mondays."]], Beta: [["m-0602", "- Beta one says the crates leave on Thursdays."]] });
	const ask = async (generate: () => Promise<{ text: string }>, agentId = room.agentId) => {
		const app = Fastify();
		registerReviewAssessRoutes(app, { room: (id) => ({ id }), errorReply: (reply: any, error: any) => reply.code(error?.statusCode ?? 500).send({ error: error?.message, code: error?.code }), modelLock: () => MODEL, generate });
		const answer = await app.inject({ method: "POST", url: `/api/persistent-agents/${agentId}/review/assess`, payload: {} });
		await app.close();
		return { status: answer.statusCode, body: answer.json() as any };
	};
	for (const [label, generate] of [
		["a bad request", async () => { throw new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Bad request"}}'); }],
		["a refusal", async () => { throw new Error("The model refused to answer this request."); }],
		["an empty reply", async () => ({ text: "   " })],
		["an unreadable reply", async () => ({ text: "<<<garbage>>> {{{" })],
	] as const) {
		const answer = await ask(generate as () => Promise<{ text: string }>);
		assert(answer.status === 200 && answer.body.firstReadMissing === true && answer.body.assessmentMarkdown === "None.", `${label} gives the missing first read, got ${JSON.stringify(answer)}`);
	}
	const unreachable = await ask(async () => { throw new ModelUnreachableError("not-answering", MODEL); });
	assert(unreachable.status === 503 && unreachable.body.code === "model_unreachable", `an unreachable model is still its notice, got ${JSON.stringify(unreachable)}`);
	// A room with a note said twice: the missing read names no topics, so going on without it tidies every topic, as the page's own missing read does.
	const twice = "- The quarterly report goes to the finance desk every Monday morning.";
	const finding = createRoom("Finding Room", { Alpha: [["m-0611", twice]], Beta: [["m-0612", "- Beta one says the crates leave on Thursdays."]], Gamma: [["m-0613", twice]] });
	const missingWithFinding = await ask(async () => { throw new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Bad request"}}'); }, finding.agentId);
	assert(missingWithFinding.body.firstReadMissing === true && missingWithFinding.body.fields.saysTheSameTwice.length === 1 && missingWithFinding.body.fields.topics.length === 0, `a missing read names no topics to tidy, got ${JSON.stringify(missingWithFinding.body.fields)}`);
});

// A stop on a company gateway names it as AI setup does, so the card never shows its id.
await section("gateway-named", async () => {
	const { ModelUnreachableError } = await import("../src/model-call-causes.js");
	const notes = Array.from({ length: 30 }, (_, n): [string, string] => [`m-${3000 + n}`, `- Alpha invoice ${n} was approved by the finance desk after the quarterly budget review.`]);
	const room = createRoom("Gateway Review Room", { Alpha: notes });
	const signedOut: ReviewRunGenerate = async () => { throw new ModelUnreachableError("signed-out", MODEL); };
	const stopped = await settle(room.agentId, startReviewRun(room.agentId, { depth: "tidy", model: MODEL, generate: signedOut, resolveModelWindow: () => WINDOW, now: RUN_CLOCK }).runId);
	assert(stopped.stop?.cause === "signed-out" && (stopped.stop as { gateway?: string }).gateway === "Synthetic Gateway", `the stop names the gateway, got ${JSON.stringify(stopped.stop)}`);
});

// Each cause stops the run with the stop the card reads: the cause, the key, why it was not reached, who can lift a
// spent limit, and the gateway's name, as Memorize's run builds it.
await section("stop-per-cause", async () => {
	const { ModelUnreachableError } = await import("../src/model-call-causes.js");
	const { IsolatedPersistentAgentWorkerTurnError } = await import("../src/persistent-agent-worker-runtime.js");
	const last = (words: string) => new IsolatedPersistentAgentWorkerTurnError("review tidy worker", "error", words);
	const cases: Array<[string, ConstructorParameters<typeof ModelUnreachableError>[0], string, string]> = [
		["a spent quota", "quota", '429 {"error":{"code":"insufficient_quota","type":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}', '{"kind":"outage","model":{"provider":"openai-compatible","model":"gpt-5.5"},"cause":"quota","quotaWay":{"kind":"gateway","provider":"Synthetic Gateway"},"gateway":"Synthetic Gateway"}'],
		["a refused key", "signed-out", '401 {"error":{"code":"invalid_api_key","type":"invalid_request_error","message":"Incorrect API key provided."}}', '{"kind":"outage","model":{"provider":"openai-compatible","model":"gpt-5.5"},"cause":"signed-out","key":"refused","gateway":"Synthetic Gateway"}'],
		["a gateway's 403", "gateway-refused", "HTTP 403 Forbidden", '{"kind":"outage","model":{"provider":"openai-compatible","model":"gpt-5.5"},"cause":"gateway-refused","key":"refused","gateway":"Synthetic Gateway"}'],
		["an unreached model", "not-answering", "fetch failed: ECONNREFUSED", '{"kind":"outage","model":{"provider":"openai-compatible","model":"gpt-5.5"},"cause":"not-answering","unreached":"connection","gateway":"Synthetic Gateway"}'],
		["a busy model", "still-busy", '429 {"error":{"type":"rate_limit_error","message":"Rate limit reached"}}', '{"kind":"outage","model":{"provider":"openai-compatible","model":"gpt-5.5"},"cause":"busy","gateway":"Synthetic Gateway"}'],
	];
	const notes = Array.from({ length: 30 }, (_, n): [string, string] => [`m-${3100 + n}`, `- Alpha invoice ${n} was approved by the finance desk after the quarterly budget review.`]);
	for (const [label, detail, words, expected] of cases) {
		const room = createRoom(`Stop Review Room ${label}`, { Alpha: notes });
		const stops: ReviewRunGenerate = async () => { throw new ModelUnreachableError(detail, MODEL, last(words)); };
		const stopped = await settle(room.agentId, startReviewRun(room.agentId, { depth: "tidy", model: MODEL, generate: stops, resolveModelWindow: () => WINDOW, now: RUN_CLOCK }).runId);
		assert(JSON.stringify(stopped.stop) === expected, `${label}: the stop, got ${JSON.stringify(stopped.stop)}`);
	}
});

// A journal a restart cannot use, in a folder where its delete fails: the
// delete is ignored and the room reads as having no run, for both runs.
await section("unusable-journal", async () => {
	const room = createRoom("Unusable Journal Room", { Alpha: [["m-0001", "- One note."]] });
	const runtimeDir = path.join(path.dirname(path.dirname(room.l1bPath)), "runtime");
	fs.mkdirSync(runtimeDir, { recursive: true });
	for (const name of ["review-run.json", "memorize-run.json"]) fs.writeFileSync(path.join(runtimeDir, name), JSON.stringify({ schemaVersion: 1, slot: { run: { runId: "r_old", agentId: room.agentId, state: "prepass" } } }));
	// portability-ok: the run must read as absent whether or not the delete is refused
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
