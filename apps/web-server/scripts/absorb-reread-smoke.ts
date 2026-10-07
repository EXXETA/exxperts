// The summary re-read, driven end to end through the REAL run on temp rooms:
// a summary note in Unsorted is read again after the waiting conversations,
// sorted into topics and archived whole, or left with the model that tried it.
// The save writes `tried` and the archive row, and an undo takes both back.
// Every section can run alone (ONLY=<name>).
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AbsorbRun, AbsorbRunGenerate, AbsorbRunProbe } from "../src/absorb-run.js";
import type { AbsorbGenerateResult } from "../src/persistent-agents.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "absorb-reread-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const appDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2));
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const run = await import("../src/absorb-run.js");
const { approveAbsorbRun, cancelAbsorbRun, getAbsorbRun, resetAbsorbRunsForTests, resumeAbsorbRun, startAbsorbRun } = run;
run.setAbsorbFoldRetryPauseForTests(0);
run.setAbsorbFoldRateLimitPauseForTests(0);
const { createPersistentAgentFromScaffoldInput, createPersistentAgentInstance } = await import("../src/persistent-agents.js");
const { readArchive } = await import("../src/memory-entries-store.js");
const { parseMemoryDocument } = await import("../src/memory-entries.js");
const { undoMemorySave } = await import("../src/memory-undo.js");
const { invalidateRoomCorpus, loadRoomCorpus } = await import("../src/memory-search-sources.js");
const { search } = await import("../src/memory-search-index.js");
const { readPageFailures } = await import("../src/absorb-page-failures.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const OTHER = { provider: "openai-compatible", model: "gpt-5.4", label: "GPT-5.4" };
const KEY = "openai-compatible/gpt-5.5";
const OTHER_KEY = "openai-compatible/gpt-5.4";
const RUN_CLOCK = () => new Date("2026-09-13T09:00:00.000Z");
const SAVE_AT = new Date("2026-09-13T09:05:00.000Z");
const ASSESSMENT = "## What these sessions leave behind\n\n- A few durable points.";
const JUNE = "- The Nordwind maintenance contract renews automatically on 1 June.";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A waiting conversation, made by Remember from a conversation of its own. */
function page(id: string, title: string, day = "2026-09-11", conversationId?: string): string {
	return [`### ${id} | OPEN | ${day} | ${title}`, ...(conversationId ? [`<!-- rc_metadata: conversation_id=${conversationId} checkpoint_id=cp-${conversationId} -->`] : []), "", `**Session arc:** ${title} was settled.`, "", "**Body:**", `- ${title} is the durable point.`, "", "**Parked:**", "None", ""].join("\n");
}

/** A summary note as the filer leaves it: its head, and its points under it. */
function summary(id: string, head: string, points: string[], meta = ""): string[] {
	return [`<!-- e: id=${id} kind=fact saved=2026-09-01${meta} summary=true -->`, `- ${head}`, ...points.map((point) => `  - ${point}`), ""];
}

/** A room whose memory holds a fact (m-0003), an open item (m-0002) and the given Unsorted notes. */
function createRoom(name: string, pages: string[], unsorted: string[], extraDeep: string[] = []): { agentId: string; l1bPath: string } {
	const created = createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = created.agent.agentId;
	const l1bPath = path.join(root, agentId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, [
		"<!-- exxeta:l1b schema_version=1 -->", "", "## Chronos", "", `- Persistent agent id: ${agentId}`, "- Lifecycle state: ready", "- Last checkpoint: cp_20260912_0001", "- Last checkpoint at: 2026-09-12T09:00:00.000Z", "- Last consolidation: none", "",
		"## Deep Memory", "", "<!-- entries: next=900 -->", "",
		"### Maintenance terms", "", "<!-- e: id=m-0003 kind=fact saved=2026-09-01 -->", JUNE, "",
		...extraDeep,
		"### Unsorted", "", ...unsorted,
		"## Active Items", "", "<!-- e: id=m-0002 kind=item saved=2026-09-01 status=open -->", "- Send the draft to legal.", "",
		"## Recent Context", "", pages.join("\n"),
	].join("\n"), { mode: 0o600 });
	return { agentId, l1bPath };
}

const pageOf = (prompt: string) => /Session being folded: (\S+) \(/.exec(prompt)?.[1] ?? "?";
const fence = (ops: unknown[]): AbsorbGenerateResult => ({ text: `One durable line.\n\n\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\`\n`, usage: { input: 100, output: 20 } });
const adds = (...texts: string[]) => fence(texts.map((text) => ({ op: "add", topic: "Accounts", kind: "fact", text })));
type Script = (prompt: string) => AbsorbGenerateResult | Promise<AbsorbGenerateResult>;
function scripted(scripts: Record<string, Script>, prompts: Map<string, string> = new Map()): AbsorbRunGenerate {
	return async (prompt) => {
		const id = pageOf(prompt);
		prompts.set(id, prompt);
		const script = scripts[id];
		assert(script, `no script for ${id}`);
		return script(prompt);
	};
}
const probeAnswers: AbsorbRunProbe = async () => ({ text: "OK" });
const probeFails: AbsorbRunProbe = async () => { throw new Error("fetch failed"); };

async function settle(agentId: string, runId: string): Promise<AbsorbRun> {
	const deadline = Date.now() + 60_000;
	let current = getAbsorbRun(agentId, runId);
	while (["prepass", "folding", "budget"].includes(current.state)) {
		assert(Date.now() < deadline, `the run was still "${current.state}" after 60 seconds`);
		await sleep(2);
		current = getAbsorbRun(agentId, runId);
	}
	return current;
}
async function started(room: { agentId: string }, scripts: Record<string, Script>, options: { model?: typeof MODEL; probe?: AbsorbRunProbe; prompts?: Map<string, string> } = {}): Promise<{ runId: string; run: AbsorbRun }> {
	const { runId } = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: options.model ?? MODEL, generate: scripted(scripts, options.prompts), probe: options.probe ?? probeAnswers, now: RUN_CLOCK });
	return { runId, run: await settle(room.agentId, runId) };
}
const entries = (l1bPath: string) => parseMemoryDocument(fs.readFileSync(l1bPath, "utf-8")).topics.flatMap((topic) => topic.entries.map((entry) => ({ ...entry, topic: topic.title })));
const entry = (l1bPath: string, id: string) => entries(l1bPath).find((candidate) => candidate.id === id);
const withWord = (l1bPath: string, word: string) => entries(l1bPath).filter((candidate) => candidate.text.includes(word));
const ONLY = process.env.ONLY;
async function section(name: string, body: () => Promise<void>): Promise<void> {
	if (ONLY && ONLY !== name) return;
	resetAbsorbRunsForTests();
	await body();
	console.log(`ok ${name}`);
}

// Recent Context ids are handed back once a save empties the section, so the
// summary note's own conversation id (RC-0001) is also the id of the NEW
// waiting conversation. The two never mix: two rows, the entry leaves only
// through its own fold, the record's RC-0001 is the new conversation, and the
// re-read's notes say they came from the old one.
await section("recycled-id", async () => {
	const room = createRoom("Recycled Room", [page("RC-0001", "Pricing", "2026-09-11", "conv-new")], summary("m-0101", "Call about the renewal", ["The zqalpha point is agreed with legal.", "The zqbeta point waits for the budget."], " from=RC-0001 learned=2026-08-01"));
	const prompts = new Map<string, string>();
	const { runId, run: ready } = await started(room, {
		"RC-0001": () => adds("- Pricing zqgamma holds for the year."),
		"m-0101": () => adds("- The zqalpha point is agreed with legal.", "- The zqbeta point waits for the budget."),
	}, { prompts });
	assert(ready.state === "ready" && ready.sessions.length === 1 && ready.sessions[0].id === "RC-0001" && ready.sessions[0].outcome === "folded", `the conversation is the run's only session, got ${JSON.stringify(ready.sessions.map((s) => [s.id, s.outcome]))}`);
	const row = ready.rereads[0];
	assert(ready.rereads.length === 1 && row.id === "m-0101" && row.title === "Call about the renewal" && row.date === "2026-08-01" && row.outcome === "folded", `the re-read is its own row, keyed by the note, got ${JSON.stringify(ready.rereads)}`);
	assert((row.changes ?? []).filter((change) => change.kind === "added").length === 2, `the points the note gave back landed, since the note is not in what its fold reads, got ${JSON.stringify(row.changes)}`);
	assert(ready.progress.total === 1 && ready.progress.folded === 1, `the re-read is not counted among the conversations, got ${JSON.stringify(ready.progress)}`);
	const prompt = prompts.get("m-0101") ?? "";
	assert(/Session being folded: m-0101 \(1 of 1\)/.test(prompt) && prompt.includes("This session is from 2026-08-01.") && /Session being folded: RC-0001 \(1 of 1\)/.test(prompts.get("RC-0001") ?? ""), "the re-read counts among the re-reads, dated with the note's learned day");
	const memoryPart = prompt.slice(0, prompt.indexOf("## Material: Signed-Off Assessment"));
	assert(memoryPart.includes("m-0003") && !memoryPart.includes("m-0101") && !memoryPart.includes("zqalpha"), "the memory the re-read reads, and the entries it can address, leave the note out");
	const saved = approveAbsorbRun(room.agentId, runId, SAVE_AT);
	const before = fs.readFileSync(saved.archivedL1bPath, "utf-8");
	assert(!fs.readFileSync(room.l1bPath, "utf-8").includes("### RC-0001"), "the waiting conversation leaves Recent Context through its own fold");
	assert(!entry(room.l1bPath, "m-0101"), "the sorted note leaves memory");
	const alpha = withWord(room.l1bPath, "zqalpha")[0];
	const gamma = withWord(room.l1bPath, "zqgamma")[0];
	assert(alpha && alpha.from === "RC-0001" && alpha.learned === "2026-08-01" && alpha.topic === "Accounts", `the re-read's notes carry the note's conversation and day, got ${JSON.stringify(alpha)}`);
	assert(gamma && gamma.from === "RC-0001" && gamma.learned === "2026-09-11", `the new conversation's note carries its own day, got ${JSON.stringify(gamma)}`);
	const row101 = readArchive(room.agentId).find((archived) => archived.id === "m-0101");
	assert(row101 && row101.why === "sorted" && row101.summary === true && JSON.stringify(row101.tried) === JSON.stringify([KEY]) && row101.text.includes("zqbeta") && row101.from === "RC-0001", `the note is archived whole as sorted, with the model that tried it, got ${JSON.stringify(row101)}`);
	assert(saved.sortedNotes === 1 && saved.archivedEntries === 0 && JSON.stringify(saved.foldedSessions) === JSON.stringify(["RC-0001"]) && saved.remainingSessions.length === 0, `the saved counts keep the sorted note apart, got ${JSON.stringify([saved.sortedNotes, saved.archivedEntries, saved.foldedSessions])}`);
	const record = JSON.parse(fs.readFileSync(saved.eventRecordPath, "utf-8"));
	const sessions = record.run.sessions as Array<{ id: string; conversationId?: string }>;
	assert(sessions.length === 1 && sessions[0].id === "RC-0001" && sessions[0].conversationId === "conv-new", `the record's RC-0001 is the new conversation, and no re-read is among its sessions, got ${JSON.stringify(sessions)}`);
	assert(record.run.archived.some((archived: { id: string; why: string }) => archived.id === "m-0101" && archived.why === "sorted"), "the record lists the sorted note, so an undo takes it back");
	undoMemorySave(room.agentId, saved.saveId, new Date("2026-09-13T09:10:00.000Z"));
	assert(fs.readFileSync(room.l1bPath, "utf-8") === before, "an undo brings the note back byte for byte, without the tried");
	assert(!readArchive(room.agentId).some((archived) => archived.id === "m-0101"), "and takes its archive row back out");
});

// A summary note with no conversation of its own gives its notes none, never
// its own id: the file writes no empty key.
await section("no-from", async () => {
	const room = createRoom("No From Room", [page("RC-0001", "Pricing")], summary("m-0101", "A page written by hand", ["The zqdelta point is settled."]));
	const { runId } = await started(room, {
		"RC-0001": () => adds("- Pricing zqgamma holds for the year."),
		"m-0101": () => adds("- The zqdelta point is settled."),
	});
	approveAbsorbRun(room.agentId, runId, SAVE_AT);
	const delta = withWord(room.l1bPath, "zqdelta")[0];
	assert(delta && delta.from === undefined && !delta.learned && !/from=/.test(fs.readFileSync(room.l1bPath, "utf-8").split("\n").find((line) => line.includes(delta.id)) ?? ""), `a note with no from gives its points none, got ${JSON.stringify(delta)}`);
});

// What sorts a note and what does not. A reply of empty texts lands nothing;
// a reply that only repeats what memory holds sorts it, and the line it never
// mentioned is found by search in the archived row.
await section("endings", async () => {
	const room = createRoom("Endings Room", [page("RC-0001", "Pricing")], [
		...summary("m-0101", "Empty reply call", ["The zqempty point is open."], " learned=2026-08-01"),
		...summary("m-0102", "Held reply call", ["The maintenance contract renews in June.", "The zqorphan point nobody mentioned."], " learned=2026-08-02"),
		...summary("m-0103", "Dropped call", ["The zqdrop point is small talk."], " learned=2026-08-03"),
		...summary("m-0104", "Unreadable call", ["The zqunread point is open."], " learned=2026-08-04"),
		...summary("m-0105", "Failing call", ["The zqfail point is open."], " learned=2026-08-05"),
	]);
	let failed = 0;
	const prompts = new Map<string, string>();
	const { runId, run: ready } = await started(room, {
		"RC-0001": () => adds("- Pricing zqgamma holds for the year."),
		"m-0101": () => fence([{ op: "add", topic: "Accounts", kind: "fact", text: "" }, { op: "add", topic: "Accounts", kind: "fact", text: "  " }]),
		"m-0102": () => fence([{ op: "add", topic: "Maintenance terms", kind: "fact", text: JUNE }]),
		"m-0103": () => fence([{ op: "drop", reason: "Nothing here to keep." }]),
		"m-0104": () => ({ text: "No list at all." }),
		"m-0105": () => { failed += 1; throw new Error("the provider failed with an internal error"); },
	}, { prompts });
	assert(/Session being folded: m-0103 \(3 of 5\)/.test(prompts.get("m-0103") ?? "") && /Session being folded: RC-0001 \(1 of 1\)/.test(prompts.get("RC-0001") ?? ""), "the re-reads count among themselves, apart from the conversations");
	const outcome = (id: string) => ready.rereads.find((row) => row.id === id)?.outcome;
	assert(outcome("m-0101") === "summarized" && outcome("m-0102") === "folded" && outcome("m-0103") === "dropped" && outcome("m-0104") === "summarized" && outcome("m-0105") === "failed" && failed === 2, `each re-read ends as its reply decides, got ${JSON.stringify(ready.rereads.map((row) => [row.id, row.outcome]))}`);
	assert(ready.state === "ready" && !ready.stop, "a failure the model answered for is the page's, not an outage");
	const held = readPageFailures(createPersistentAgentInstance(room.agentId).runtimeDir());
	assert(![...held.records.keys(), ...held.throttled.keys()].some((key) => key.startsWith("reread:") || key.startsWith("m-")), `a re-read never leaves a failure record, got ${JSON.stringify([...held.records.keys()])}`);
	const saved = approveAbsorbRun(room.agentId, runId, SAVE_AT);
	for (const id of ["m-0101", "m-0103", "m-0104", "m-0105"]) {
		const kept = entry(room.l1bPath, id);
		assert(kept && kept.summary && kept.topic === "Unsorted" && JSON.stringify(kept.tried) === JSON.stringify([KEY]), `${id} is not sorted: it stays, with the model that tried it, got ${JSON.stringify(kept)}`);
	}
	assert(!entry(room.l1bPath, "m-0102") && withWord(room.l1bPath, "zqorphan").length === 0, "a reply that only repeats memory sorts the note, and archives it whole");
	assert(saved.sortedNotes === 1, `one note sorted, got ${saved.sortedNotes}`);
	invalidateRoomCorpus(room.agentId);
	const corpus = loadRoomCorpus(room.agentId);
	const hits = search(corpus.index, "zqorphan");
	assert(hits.some((hit) => hit.doc.id === "m-0102" && hit.doc.source === "archive"), `search finds the line the reply never mentioned in the sorted row, got ${JSON.stringify(hits.map((hit) => [hit.doc.id, hit.doc.source]))}`);
	const sortedHit = hits.find((hit) => hit.doc.id === "m-0102");
	assert(sortedHit?.doc.origin?.includes("sorted into topics") && !sortedHit.doc.origin.includes("make room"), `search and recall say why the row left, got ${JSON.stringify(sortedHit?.doc.origin)}`);
});

// A re-read may update a note, and one older than the note it rewrites is
// kept as history until that note's day, like any older page.
await section("update-and-history", async () => {
	const HOURS = "- The Nordwind support hours are 8 per day.";
	const room = createRoom("Update Room", [page("RC-0001", "Pricing")], [
		...summary("m-0101", "Old support call", ["Support hours were 6 per day."], " from=RC-0007 learned=2026-08-01"),
		...summary("m-0102", "New support call", ["Support hours are now 10 per day."], " from=RC-0009 learned=2026-09-25"),
	], ["### Support", "", "<!-- e: id=m-0004 kind=fact saved=2026-09-20 learned=2026-09-20 -->", HOURS, ""]);
	const { runId, run: ready } = await started(room, {
		"RC-0001": () => adds("- Pricing zqgamma holds."),
		"m-0101": () => fence([{ op: "update", id: "m-0004", text: "- The Nordwind support hours are 6 per day." }]),
		"m-0102": () => fence([{ op: "update", id: "m-0004", text: "- The Nordwind support hours are 10 per day." }]),
	});
	const kinds = (id: string) => (ready.rereads.find((row) => row.id === id)?.changes ?? []).map((change) => change.kind);
	assert(JSON.stringify(ready.rereads.map((row) => row.id)) === JSON.stringify(["m-0101", "m-0102"]) && kinds("m-0101").includes("history") && kinds("m-0102").includes("updated"), `the older re-read is history, the newer one an update, got ${JSON.stringify(ready.rereads.map((row) => [row.id, row.changes?.map((change) => change.kind)]))}`);
	approveAbsorbRun(room.agentId, runId, SAVE_AT);
	const hours = entry(room.l1bPath, "m-0004");
	assert(hours && hours.text === "- The Nordwind support hours are 10 per day." && hours.learned === "2026-09-25", `the newer re-read rewrites the note on its own day, got ${JSON.stringify(hours)}`);
	const archive = readArchive(room.agentId);
	const history = archive.find((row) => row.why === "history" && row.text.includes("6 per day"));
	assert(history && history.until === "2026-09-20" && history.learned === "2026-08-01" && history.from === "RC-0007", `the older value is history until the note's day, from the note's conversation, got ${JSON.stringify(history)}`);
	assert(archive.some((row) => row.why === "superseded" && row.text === HOURS) && archive.filter((row) => row.why === "sorted").length === 2, "the note's old text is a superseded version, and both summaries are sorted");
});

// At most five a run, oldest first; once per model; one more try on another.
await section("cap-and-models", async () => {
	const unsorted = Array.from({ length: 7 }, (_, n) => summary(`m-01${10 + n}`, `Call ${n}`, [`The zqcap${String.fromCharCode(97 + n)} point is open.`], n === 6 ? "" : ` learned=2026-08-${String(20 - n).padStart(2, "0")}`)).flat();
	const room = createRoom("Cap Room", [page("RC-0001", "Pricing")], unsorted);
	const drops: Record<string, Script> = Object.fromEntries(Array.from({ length: 7 }, (_, n) => [`m-01${10 + n}`, () => fence([{ op: "drop", reason: "Nothing to sort." }])]));
	const first = await started(room, { "RC-0001": () => adds("- Pricing zqgamma holds."), ...drops });
	assert(JSON.stringify(first.run.rereads.map((row) => row.id)) === JSON.stringify(["m-0115", "m-0114", "m-0113", "m-0112", "m-0111"]), `five a run, oldest learned first, got ${JSON.stringify(first.run.rereads.map((row) => [row.id, row.date]))}`);
	approveAbsorbRun(room.agentId, first.runId, SAVE_AT);
	fs.appendFileSync(room.l1bPath, page("RC-0002", "Delivery"));
	resetAbsorbRunsForTests();
	const second = await started(room, { "RC-0002": () => adds("- Delivery zqdelivery takes a week."), ...drops });
	assert(JSON.stringify(second.run.rereads.map((row) => row.id)) === JSON.stringify(["m-0110", "m-0116"]), `the same model reads only what it has not tried, the undated last, got ${JSON.stringify(second.run.rereads.map((row) => row.id))}`);
	approveAbsorbRun(room.agentId, second.runId, SAVE_AT);
	fs.appendFileSync(room.l1bPath, page("RC-0003", "Support"));
	resetAbsorbRunsForTests();
	const third = await started(room, { "RC-0003": () => adds("- Support zqsupport answers in a day."), ...drops }, { model: OTHER });
	assert(third.run.rereads.length === 5 && third.run.rereads[0].id === "m-0115", `another model gets one more try, got ${JSON.stringify(third.run.rereads.map((row) => row.id))}`);
	approveAbsorbRun(room.agentId, third.runId, SAVE_AT);
	assert(JSON.stringify(entry(room.l1bPath, "m-0115")?.tried) === JSON.stringify([KEY, OTHER_KEY]) && JSON.stringify(entry(room.l1bPath, "m-0116")?.tried) === JSON.stringify([KEY]), `tried lists each model once, got ${JSON.stringify([entry(room.l1bPath, "m-0115")?.tried, entry(room.l1bPath, "m-0116")?.tried])}`);
	// Nothing waiting, nothing re-read: the re-reads ride on a run with a conversation.
	resetAbsorbRunsForTests();
	fs.writeFileSync(room.l1bPath, fs.readFileSync(room.l1bPath, "utf-8").replace(/## Recent Context[\s\S]*$/, `## Recent Context\n\n${page("RC-0004", "Dropped by the person")}`));
	const dropped = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: { provider: "openai-compatible", model: "gpt-5.3", label: "GPT-5.3" }, generate: scripted({}), probe: probeAnswers, now: RUN_CLOCK, guidance: { pin: [], drop: [{ session: "RC-0004", reason: "Leave it out." }], corrections: [], topics: [], instructions: [] } });
	const droppedRun = await settle(room.agentId, dropped.runId);
	assert(droppedRun.rereads.length === 0, `a run with no conversation to read re-reads nothing, got ${JSON.stringify(droppedRun.rereads.map((row) => row.id))}`);
});

// An outage tries nothing; a resume reads the rest; a run not saved writes nothing.
await section("outage-and-unsaved", async () => {
	const room = createRoom("Outage Room", [page("RC-0001", "Pricing")], [...summary("m-0101", "First call", ["The zqfirst point is open."], " learned=2026-08-01"), ...summary("m-0102", "Second call", ["The zqsecond point is open."], " learned=2026-08-02")]);
	let down = true;
	const scripts: Record<string, Script> = {
		"RC-0001": () => adds("- Pricing zqgamma holds."),
		"m-0101": () => adds("- The zqfirst point is open."),
		"m-0102": () => { if (down) throw new Error("fetch failed"); return adds("- The zqsecond point is open."); },
	};
	const { runId, run: stopped } = await started(room, scripts, { probe: async (...args) => (down ? probeFails(...args) : probeAnswers(...args)) });
	assert(stopped.stop?.kind === "outage" && stopped.rereads.find((row) => row.id === "m-0102")?.outcome === "pending" && stopped.rereads.find((row) => row.id === "m-0101")?.outcome === "folded", `an outage leaves the re-read waiting, got ${JSON.stringify([stopped.stop, stopped.rereads.map((row) => [row.id, row.outcome])])}`);
	down = false;
	resumeAbsorbRun(room.agentId, runId, MODEL);
	const resumed = await settle(room.agentId, runId);
	assert(resumed.rereads.every((row) => row.outcome === "folded") && resumed.progress.folded === 1, `a resume reads the re-read the outage left, got ${JSON.stringify(resumed.rereads.map((row) => [row.id, row.outcome]))}`);
	const saved = approveAbsorbRun(room.agentId, runId, SAVE_AT);
	assert(saved.sortedNotes === 2 && readArchive(room.agentId).filter((row) => row.why === "sorted").every((row) => JSON.stringify(row.tried) === JSON.stringify([KEY])), "both sorted, each tried once");

	// A run stopped by an outage and saved as it is: the waiting note is not tried.
	const second = createRoom("Outage Saved Room", [page("RC-0001", "Pricing")], summary("m-0101", "First call", ["The zqthird point is open."], " learned=2026-08-01"));
	resetAbsorbRunsForTests();
	const outage = await started(second, { "RC-0001": () => adds("- Pricing zqgamma holds."), "m-0101": () => { throw new Error("fetch failed"); } }, { probe: probeFails });
	assert(outage.run.stop?.kind === "outage", "the re-read stopped the run as an outage");
	approveAbsorbRun(second.agentId, outage.runId, SAVE_AT);
	const waiting = entry(second.l1bPath, "m-0101");
	assert(waiting && !waiting.tried, `a note an outage stopped is not tried, got ${JSON.stringify(waiting)}`);

	// A run cancelled after its re-read writes nothing at all.
	const third = createRoom("Unsaved Room", [page("RC-0001", "Pricing")], summary("m-0101", "First call", ["The zqfourth point is open."], " learned=2026-08-01"));
	resetAbsorbRunsForTests();
	const before = fs.readFileSync(third.l1bPath, "utf-8");
	const unsaved = await started(third, { "RC-0001": () => adds("- Pricing zqgamma holds."), "m-0101": () => fence([{ op: "drop", reason: "Nothing." }]) });
	cancelAbsorbRun(third.agentId, unsaved.runId);
	assert(fs.readFileSync(third.l1bPath, "utf-8") === before, "a run not saved leaves the note untried");
});

// A note sorted away leaves its partner's pair mark; the point it gave back
// forms the pair again with that partner, as a new note that may disagree.
await section("pair", async () => {
	const room = createRoom("Pair Room", [page("RC-0001", "Pricing")], summary("m-0101", "Maintenance call", ["The Nordwind maintenance contract renews automatically on 1 July."], " disagrees=m-0003"));
	fs.writeFileSync(room.l1bPath, fs.readFileSync(room.l1bPath, "utf-8").replace("<!-- e: id=m-0003 kind=fact saved=2026-09-01 -->", "<!-- e: id=m-0003 kind=fact saved=2026-09-01 disagrees=m-0101 -->"));
	const { runId, run: ready } = await started(room, {
		"RC-0001": () => adds("- Pricing zqgamma holds."),
		"m-0101": () => fence([{ op: "add", topic: "Maintenance terms", kind: "fact", text: "- The Nordwind maintenance contract renews automatically on 1 July." }]),
	});
	const added = ready.rereads[0].changes?.find((change) => change.kind === "added");
	assert(added && added.beside === "may-disagree" && added.besideOf === "m-0003", `the point given back forms the pair again with the partner, got ${JSON.stringify(added)}`);
	approveAbsorbRun(room.agentId, runId, SAVE_AT);
	const row = readArchive(room.agentId).find((archived) => archived.id === "m-0101");
	assert(row && row.why === "sorted" && !row.disagrees, `the sorted row is written without its pair mark, got ${JSON.stringify(row)}`);
	assert(entry(room.l1bPath, "m-0003")?.disagrees === added.id, `the partner names only the new note, never the archived one, got ${JSON.stringify(entry(room.l1bPath, "m-0003"))}`);
});

// A summary note the prepass sent to the archive to make room is not re-read:
// the budget pass after the folds would bring it back whole beside the notes
// its re-read made. It is not chosen either, so the five places go to the
// summary notes still in memory.
await section("prepass", async () => {
	const huge = Array.from({ length: 600 }, (_, n) => `The zqhuge${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))} point of the long call is written out in full here, with the reasons.`);
	const room = createRoom("Prepass Room", [page("RC-0001", "Pricing")], [
		`<!-- e: id=m-0101 kind=fact saved=2025-01-01 learned=2025-01-01 summary=true -->`, "- A very long call", ...huge.map((point) => `  - ${point}`), "",
		...["a", "b", "c", "d", "e"].flatMap((letter, n) => summary(`m-010${2 + n}`, `Short call ${letter}`, [`The zqshort${letter} point is agreed.`], ` learned=2026-08-0${1 + n} refs=5`)),
	]);
	const { writePersistentRoomMaintenanceSettings, MEMORY_BUDGET_MIN_TOKENS } = await import("../src/persistent-room-maintenance-settings.js");
	writePersistentRoomMaintenanceSettings(room.agentId, { memoryBudgetTokens: MEMORY_BUDGET_MIN_TOKENS });
	const asked: string[] = [];
	const { runId, run: ready } = await started(room, {
		"RC-0001": () => adds("- Pricing zqgamma holds."),
		"m-0101": () => { asked.push("m-0101"); return adds(...huge.slice(0, 3).map((point) => `- ${point}`)); },
		...Object.fromEntries(["a", "b", "c", "d", "e"].map((letter, n) => [`m-010${2 + n}`, () => { asked.push(`m-010${2 + n}`); return adds(`- The zqshort${letter} point is agreed.`); }])),
	});
	assert(ready.prepass.demoted.some((demoted) => demoted.id === "m-0101"), `the prepass took the long summary note, got ${JSON.stringify(ready.prepass.demoted.map((demoted) => demoted.id))}`);
	const five = ["m-0102", "m-0103", "m-0104", "m-0105", "m-0106"];
	assert(JSON.stringify(ready.rereads.map((row) => row.id)) === JSON.stringify(five) && JSON.stringify(asked) === JSON.stringify(five), `the five places go to the notes still in memory, got ${JSON.stringify([ready.rereads.map((row) => row.id), asked])}`);
	approveAbsorbRun(room.agentId, runId, SAVE_AT);
	const back = entry(room.l1bPath, "m-0101");
	const archived = readArchive(room.agentId).find((row) => row.id === "m-0101");
	assert(entries(room.l1bPath).filter((candidate) => candidate.id !== "m-0101" && candidate.text.includes("zqhuge")).length === 0, "no note carries the long note's points");
	assert((back && back.text.includes("zqhugezf")) || (archived && archived.why === "budget" && archived.text.includes("zqhugezf")), `the long note is whole, in memory or in the archive, got ${JSON.stringify([back?.id, archived?.why])}`);
});

// The Maintain hint's count: summary notes left in Unsorted after a saved
// re-read, by a line scan of the file on every status refresh. A saved run
// that could not sort a note makes it 1, undo takes it back, and on every
// fixture the scan counts what a parse of the same file counts.
await section("hint-count", async () => {
	const { getPersistentAgentStatus } = await import("../src/persistent-agents.js");
	const { unsortedAfterRereadCount, unsortedAfterRereadTopics } = await import("../src/absorb-reread.js");
	const count = (agentId: string) => getPersistentAgentStatus(agentId).memoryStatus.unsortedAfterReread;
	const room = createRoom("Hint Room", [page("RC-0001", "Pricing")], [
		...summary("m-0101", "Dropped call", ["The zqdrop point is small talk."], " learned=2026-08-01"),
		...summary("m-0102", "Sorted call", ["The zqsorted point is agreed."], " learned=2026-08-02"),
	]);
	assert(count(room.agentId) === 0, `no note was tried yet, got ${count(room.agentId)}`);
	const { runId } = await started(room, {
		"RC-0001": () => adds("- Pricing zqgamma holds."),
		"m-0101": () => fence([{ op: "drop", reason: "Nothing here to keep." }]),
		"m-0102": () => adds("- The zqsorted point is agreed."),
	});
	const saved = approveAbsorbRun(room.agentId, runId, SAVE_AT);
	assert(count(room.agentId) === 1, `the note the save could not sort is counted, the sorted one is not, got ${count(room.agentId)}`);
	undoMemorySave(room.agentId, saved.saveId, new Date("2026-09-13T09:10:00.000Z"));
	assert(count(room.agentId) === 0, `undo takes the try back, got ${count(room.agentId)}`);
	const tried = (id: string, extra = "") => [`<!-- e: id=${id} kind=fact saved=2026-09-01 summary=true tried=${KEY}${extra} -->`, `- Call ${id}`, ""];
	const deep = (...lines: string[]) => ["## Deep Memory", "", "<!-- entries: next=900 -->", "", ...lines];
	const fixtures: Array<[string, string[], number]> = [
		["tried, untried, pinned and a plain note", deep("### Unsorted", "", ...tried("m-0201"), ...tried("m-0202", " pinned=true"), ...summary("m-0203", "Untried", ["x"]), `<!-- e: id=m-0204 kind=fact saved=2026-09-01 tried=${KEY} -->`, "- Not a summary", ""), 2],
		["a lowercase heading", deep("### unsorted", "", ...tried("m-0211")), 1],
		["tried outside Unsorted", deep("### Maintenance terms", "", ...tried("m-0221")), 0],
		["Unsorted outside Deep Memory", [...deep("### Terms", ""), "## Active Items", "", "### Unsorted", "", ...tried("m-0231"), "## Notes", "", "### Unsorted", "", ...tried("m-0232")], 0],
		["a second Deep Memory", [...deep("### Terms", ""), "## Deep Memory", "", "### Unsorted", "", ...tried("m-0241")], 0],
	];
	for (const [name, lines, expected] of fixtures) {
		const l1b = ["<!-- exxeta:l1b schema_version=1 -->", "", "## Chronos", "", "- Last checkpoint: none", "", ...lines, "## Recent Context", ""].join("\n");
		fs.writeFileSync(room.l1bPath, l1b);
		const parsed = unsortedAfterRereadTopics(parseMemoryDocument(l1b)).reduce((sum, topic) => sum + topic.count, 0);
		assert(count(room.agentId) === expected && unsortedAfterRereadCount(l1b) === parsed, `${name}: the status counts ${expected} and the scan equals the parse, got ${JSON.stringify([count(room.agentId), unsortedAfterRereadCount(l1b), parsed])}`);
	}
});

console.log("absorb-reread smoke passed");
