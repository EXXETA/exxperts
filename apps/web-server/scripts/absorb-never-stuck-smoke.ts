// Memorize never gets stuck, driven end to end through the REAL run on temp
// rooms: a scripted worker and a scripted probe answer the way a model would,
// and the run decides. Every section can run alone (ONLY=<name>), so each
// behaviour is its own red-first command against the base.
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AbsorbRun, AbsorbRunGenerate, AbsorbRunProbe } from "../src/absorb-run.js";
import type { AbsorbGenerateResult } from "../src/persistent-agents.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "absorb-never-stuck-home-"));
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
const { approveAbsorbRun, cancelAbsorbRun, getAbsorbRun, resetAbsorbRunsForTests, setAbsorbFoldRetryPauseForTests, startAbsorbRun } = run;
setAbsorbFoldRetryPauseForTests(0);
run.setAbsorbFoldRateLimitPauseForTests?.(0);
const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
const { IsolatedPersistentAgentWorkerTurnError } = await import("../src/persistent-agent-worker-runtime.js");
const { applyFoldOps } = await import("../src/absorb-ops.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const RUN_CLOCK = () => new Date("2026-09-13T09:00:00.000Z");
const ASSESSMENT = "## What these sessions leave behind\n\n- A few durable points.";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function page(id: string, title: string, marker: string, extra = "", checkpointId?: string): string {
	const meta = checkpointId ? [`<!-- rc_metadata: checkpoint_id=${checkpointId}; session_id=s-1; conversation_id=c-1; density=normal; model=openai-compatible/gpt-5.5; approved_at=2026-09-11T10:00:00.000Z -->`] : [];
	return [`### ${id} | OPEN | 2026-09-11 | ${title}`, ...meta, "", `**Session arc:** ${marker} was settled.`, "", "**Body:**", `- ${marker} is the durable point.${extra}`, "", "**Parked:**", "None", ""].join("\n");
}

function createRoom(name: string, pages: string[]): { agentId: string; l1bPath: string; runtimeDir: string } {
	const created = createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = created.agent.agentId;
	const l1bPath = path.join(root, agentId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, [
		"<!-- exxeta:l1b schema_version=1 -->", "", "## Chronos", "", `- Persistent agent id: ${agentId}`, "- Lifecycle state: ready", "- Last checkpoint: cp_20260912_0001", "- Last checkpoint at: 2026-09-12T09:00:00.000Z", "- Last consolidation: none", "",
		"## Deep Memory", "", "<!-- entries: next=10 -->", "", "### Renewals", "", "<!-- e: id=m-0001 kind=fact saved=2026-09-01 -->", "- The Nordwind contract renews in April.", "",
		"## Active Items", "", "<!-- e: id=m-0002 kind=item saved=2026-09-01 status=open -->", "- Send the draft to legal.", "",
		"## Recent Context", "", pages.join("\n"),
	].join("\n"), { mode: 0o600 });
	return { agentId, l1bPath, runtimeDir: path.join(root, agentId, "runtime") };
}

const sessionOf = (prompt: string) => /Session being folded: (RC-\d+)/.exec(prompt)?.[1] ?? "?";
const fence = (ops: unknown[]) => `\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\``;
const answer = (marker: string): AbsorbGenerateResult => ({ text: `One durable line.\n\n${fence([{ op: "add", topic: "Renewals", kind: "fact", text: `- ${marker} is the durable point.` }])}\n`, usage: { input: 100, output: 20 } });
const providerError = (message: string) => new IsolatedPersistentAgentWorkerTurnError("memorize fold worker", "error", message);

type Script = (attempt: number, prompt: string) => AbsorbGenerateResult | Promise<AbsorbGenerateResult>;
/** What a real model does with a small call: thinking spends the cap and the reply comes back empty, as Opus 5.5 did on the sort. */
const THINKING_ROOM_TOKENS = 4096;
function scripted(scripts: Record<string, Script>, calls: Array<{ id: string; prompt: string; maxTokens?: number }>): AbsorbRunGenerate {
	return async (prompt, _model, options) => {
		const id = sessionOf(prompt);
		const { maxTokens, thinkingLevel } = options as { maxTokens?: number; thinkingLevel?: string };
		calls.push({ id, prompt, maxTokens });
		const script = scripts[id];
		assert(script, `no script for ${id}`);
		const reply = await script(calls.filter((call) => call.id === id).length, prompt);
		const thinks = thinkingLevel !== undefined && thinkingLevel !== "off";
		if (maxTokens !== undefined && ((thinks && maxTokens < THINKING_ROOM_TOKENS) || maxTokens < Math.ceil(reply.text.length / 4))) throw new Error("the fold worker produced no text");
		return reply;
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
const view = (r: AbsorbRun, id: string) => r.sessions.find((session) => session.id === id)!;
const records = (runtimeDir: string): Record<string, unknown> => {
	const file = path.join(runtimeDir, "memorize-page-failures.json");
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")).records : {};
};
const ONLY = process.env.ONLY;
async function section(name: string, body: () => Promise<void>): Promise<void> {
	if (ONLY && ONLY !== name) return;
	resetAbsorbRunsForTests();
	await body();
	console.log(`ok ${name}`);
}

// A readable reply of which nothing lands is filed as its summary at once, in
// this run; a change naming a note memory does not hold is kept in Unsorted.
await section("nothing-lands", async () => {
	const room = createRoom("Nothing Lands Room", [page("RC-0001", "Nothing lands", "NOTHING-POINT"), page("RC-0002", "Unknown id", "UNKNOWN-POINT"), page("RC-0003", "Healthy", "HEALTHY-POINT")]);
	const calls: Array<{ id: string; prompt: string }> = [];
	const nothing = (): AbsorbGenerateResult => ({ text: fence([{ op: "close", id: "m-9999" }]) });
	const unknown = (): AbsorbGenerateResult => ({ text: fence([{ op: "update", id: "m-9999", text: "- UNKNOWN-POINT is kept although its note is gone." }]) });
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": nothing, "RC-0002": unknown, "RC-0003": () => answer("HEALTHY-POINT") }, calls), probe: probeAnswers, now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	const rc1 = calls.filter((call) => call.id === "RC-0001");
	assert(view(done, "RC-0001").outcome === "summarized" && rc1.length >= 2 && rc1[1].prompt.includes("answer with one drop"), `a reply of which nothing lands is asked once more, then placed, got "${view(done, "RC-0001").outcome}" after ${rc1.length}`);
	assert(view(done, "RC-0002").outcome === "folded" && calls.filter((call) => call.id === "RC-0002").length === 1, `an update of an unknown id is folded in one call, got "${view(done, "RC-0002").outcome}"`);
	assert(!calls.some((call) => call.prompt.includes("## Retry Notice")), "no call is ever asked again with the old notice");
	// The fold records say how each op ended, in codes, and never a word of the reply.
	const diagnosticsDir = path.join(root, room.agentId, "events", "maintenance-diagnostics");
	const folds = fs.readdirSync(diagnosticsDir, { recursive: true }).map(String).filter((name) => name.endsWith(".json")).map((name) => fs.readFileSync(path.join(diagnosticsDir, name), "utf-8")).filter((raw) => JSON.parse(raw).process === "memorize-fold");
	const fates = folds.map((raw) => JSON.stringify(JSON.parse(raw).fold?.ops)).sort();
	assert(fates.includes(JSON.stringify([{ i: 0, op: "close", fate: "traced", codes: ["unknown-id"] }])) && fates.includes(JSON.stringify([{ i: 0, op: "update", fate: "redirected", codes: ["unknown-id"] }])), `each fold record carries its ops' fates and codes, got ${fates.join(" | ")}`);
	assert(folds.every((raw) => !raw.includes("UNKNOWN-POINT") && !raw.includes("NOTHING-POINT")) && folds.some((raw) => JSON.parse(raw).fold?.pairs?.subset === 0), "the fold records carry no room text, and the pair counts");
	approveAbsorbRun(room.agentId, started.runId, new Date("2026-09-13T09:05:00.000Z"));
	const written = fs.readFileSync(room.l1bPath, "utf-8");
	assert(!/^### RC-0001 \|/m.test(written) && written.includes("NOTHING-POINT is the durable point.") && !/^### Unsorted$/m.test(written), "the approve removes it from Recent Context and its page is placed under a topic, not Unsorted");
	assert(written.includes("UNKNOWN-POINT is kept although its note is gone."), "the redirected text is in memory");
});

// No Unsorted: a page the model cannot fold is placed by code under the topic
// its words match, or under a topic named after it; never in Unsorted.
await section("never-unsorted", async () => {
	const room = createRoom("Never Unsorted Room", [page("RC-0001", "Renewal terms", "RENEWAL-POINT", " The Nordwind contract renews in April with new terms."), page("RC-0002", "Quantum lab budget", "QUANTUM-POINT")]);
	const prose = (): AbsorbGenerateResult => ({ text: "I folded this conversation into memory for you." });
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": prose, "RC-0002": prose }, []), probe: probeAnswers, now: RUN_CLOCK });
	await settle(room.agentId, started.runId);
	approveAbsorbRun(room.agentId, started.runId, new Date("2026-09-13T09:05:00.000Z"));
	const written = fs.readFileSync(room.l1bPath, "utf-8");
	const topicOf = (marker: string) => [...written.slice(0, written.indexOf(marker)).matchAll(/^### (.+)$/gm)].at(-1)?.[1];
	assert(!/^### Unsorted$/m.test(written), "nothing lands in Unsorted");
	assert(topicOf("RENEWAL-POINT") === "Renewals", `a page whose words match a topic is placed under it, got ${topicOf("RENEWAL-POINT")}`);
	assert(topicOf("QUANTUM-POINT") === "Quantum lab budget", `a page that matches nothing opens a topic named after it, got ${topicOf("QUANTUM-POINT")}`);
});

// The ladder, in the run that reads the page: a page the whole fold cannot
// read is folded in pieces (rung 3); a page whose call is refused while the
// model answers goes down at a high level, in this run, never waiting; what
// nothing folds is placed under the topic one tiny call names (rung 5), as one
// note the card explains; a reply of which nothing lands is asked once more
// and may answer with a drop (rung 2).
await section("ladder", async () => {
	const long = (id: string, title: string, marker: string) => [`### ${id} | OPEN | 2026-09-11 | ${title}`, "", `**Session arc:** ${title} was talked through.`, "", "**Body:**", ...[1, 2, 3, 4].map((n) => `- ${marker}-${n} is a durable point.`), "", "**Parked:**", `- Follow up on ${marker}.`, ""].join("\n");
	const room = createRoom("Ladder Room", [long("RC-0001", "Pieces call", "PIECE"), long("RC-0002", "Refused call", "REFUSE"), page("RC-0003", "Prose call", "PROSE"), page("RC-0004", "Empty call", "EMPTY")]);
	const whole = (prompt: string) => /^### RC-\d+ \|/m.test(prompt);
	const highLevel = (prompt: string) => prompt.includes("## Read at a High Level");
	const pointsIn = (prompt: string, marker: string) => [1, 2, 3, 4].filter((n) => prompt.includes(`- ${marker}-${n} is a durable point.`)).map((n) => ({ op: "add", topic: "Renewals", kind: "fact", text: `- ${marker}-${n} is a durable point.` }));
	const opsFor = (prompt: string, marker: string) => [...pointsIn(prompt, marker), ...(prompt.includes(`Follow up on ${marker}`) ? [{ op: "add", topic: "Follow-ups", kind: "item", text: `- Follow up on ${marker}.` }] : [])];
	const calls: Array<{ id: string; prompt: string }> = [];
	const generate = scripted({
		"RC-0001": (_n, prompt) => (whole(prompt) ? { text: "I folded it for you." } : { text: fence(opsFor(prompt, "PIECE")) }),
		"RC-0002": (_n, prompt) => { if (!highLevel(prompt)) throw providerError("the response was blocked by the content_filter"); return { text: fence(opsFor(prompt, "REFUSE")) }; },
		"RC-0003": () => ({ text: "Nothing to see here." }),
		"RC-0004": (n, prompt) => ({ text: prompt.includes("answer with one drop") ? fence([{ op: "drop", reason: "Nothing new." }]) : fence([{ op: "add", topic: "Renewals", kind: "fact", text: "" }]) }),
		"?": (_n, prompt) => ({ text: prompt.includes("Answer with the one title") ? "Renewals" : "?" }),
	}, calls);
	const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate, probe: probeAnswers, now: RUN_CLOCK }).runId);
	const outcomes = done.sessions.map((session) => `${session.id}:${session.outcome}`).join(",");
	assert(view(done, "RC-0001").outcome === "folded" && view(done, "RC-0002").outcome === "folded", `pages the whole fold could not take fold in pieces in this run, got ${outcomes}`);
	assert(view(done, "RC-0003").outcome === "summarized" && !view(done, "RC-0003").reason && (view(done, "RC-0003").changes ?? []).some((change: any) => change.topic === "Renewals"), `a page nothing folds is placed under the topic the call named, and the card reads it like any other, got ${JSON.stringify(view(done, "RC-0003"))}`);
	assert(view(done, "RC-0004").outcome === "dropped", `a reply of which nothing landed is asked once more and its drop stands, got ${view(done, "RC-0004").outcome}`);
	assert(Object.keys(records(room.runtimeDir)).length === 0 && done.state === "ready" && !done.stop, "nothing waits and nothing is recorded: a refusal while the model answers is the page's own, read in this run");
	approveAbsorbRun(room.agentId, done.runId, new Date("2026-09-13T09:05:00.000Z"));
	const written = fs.readFileSync(room.l1bPath, "utf-8");
	for (const marker of ["PIECE", "REFUSE"]) for (const n of [1, 2, 3, 4]) assert(written.includes(`- ${marker}-${n} is a durable point.`), `${marker}-${n} landed as a note of its own`);
	assert(written.includes("Follow up on PIECE") && !/^### Unsorted$/m.test(written), "the parked piece landed, and nothing is in Unsorted");
	const topicOf = (marker: string) => [...written.slice(0, written.indexOf(marker)).matchAll(/^### (.+)$/gm)].at(-1)?.[1];
	assert(topicOf("PROSE") === "Renewals", `the placed note sits under the topic the call named, got ${topicOf("PROSE")}`);
});

// The one-time sort: notes an older Memorize left in Unsorted go under topics
// at the start of the next run, by one placement call for up to 20 notes, and
// by code for any the reply did not name. The card lists the moves and a note
// can be moved before Save. A room with nothing waiting runs for the sort alone.
await section("sort-unsorted", async () => {
	const unsorted = [
		"### Unsorted", "",
		"<!-- e: id=m-0101 kind=fact saved=2026-09-01 summary=true -->", "- Call about the renewal", "  - The renewal moves to May.", "",
		"<!-- e: id=m-0102 kind=fact saved=2026-09-01 -->", "- Invoices go out on the first working day.", "",
		"<!-- e: id=m-0103 kind=fact saved=2026-09-01 -->", "- The Nordwind contract renews with the April terms each year.", "",
	];
	const withUnsorted = (room: { l1bPath: string }) => fs.writeFileSync(room.l1bPath, fs.readFileSync(room.l1bPath, "utf-8").replace("## Active Items", `${unsorted.join("\n")}\n## Active Items`));
	const sortReply = (_n: number, prompt: string): AbsorbGenerateResult => ({ text: prompt.includes("m-0101") && prompt.includes("For each note") ? "m-0101: Renewals\nm-0102: Billing" : "?" });
	const room = createRoom("Sort Room", [page("RC-0001", "Healthy", "HEALTHY-POINT")]);
	withUnsorted(room);
	const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => answer("HEALTHY-POINT"), "?": sortReply }, []), probe: probeAnswers, now: RUN_CLOCK }).runId);
	const moves = Object.fromEntries((done.sorted ?? []).map((move) => [move.id, move.topic]));
	assert(moves["m-0101"] === "Renewals" && moves["m-0102"] === "Billing" && moves["m-0103"] === "Renewals", `the card lists each note's move, the one the reply did not name placed by code, got ${JSON.stringify(done.sorted)}`);
	run.moveAbsorbRunSortedNote(room.agentId, done.runId, "m-0102", "Invoicing");
	approveAbsorbRun(room.agentId, done.runId, new Date("2026-09-13T09:05:00.000Z"));
	const written = fs.readFileSync(room.l1bPath, "utf-8");
	const topicOf = (marker: string) => [...written.slice(0, written.indexOf(marker)).matchAll(/^### (.+)$/gm)].at(-1)?.[1];
	assert(!/^### Unsorted$/m.test(written) && topicOf("The renewal moves to May.") === "Renewals" && topicOf("Invoices go out") === "Invoicing" && written.includes("HEALTHY-POINT"), `nothing is left in Unsorted, and the moved note is where the person put it, got ${topicOf("Invoices go out")}`);
	assert(/id=m-0101 [^>]*summary=true/.test(written), "a summary note keeps its mark, so a later re-read refines it");
	// Nothing waiting: Memorize runs for the sort alone.
	const alone = createRoom("Sort Alone Room", []);
	withUnsorted(alone);
	const { getAbsorbAvailability } = await import("../src/persistent-agents.js");
	assert(getAbsorbAvailability(alone.agentId).available, `Memorize is available for the sort alone, got ${JSON.stringify(getAbsorbAvailability(alone.agentId))}`);
	const only = await settle(alone.agentId, startAbsorbRun({ agentId: alone.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "?": sortReply, "m-0101": () => answer("The renewal moves to May") }, []), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(only.state === "ready" && (only.sorted ?? []).length === 3, `a room with nothing waiting sorts its Unsorted notes, got ${only.state} ${JSON.stringify(only.sorted)}`);
});

// The sort call comes back empty: each note gets its own placement call, then
// code at a lower floor; the notes that match nothing go under ONE topic, never
// one topic per note (Unsorted under another name).
await section("sort-fails-grouped", async () => {
	const room = createRoom("Sort Fails Room", []);
	fs.writeFileSync(room.l1bPath, fs.readFileSync(room.l1bPath, "utf-8").replace("## Active Items", [
		"### Unsorted", "",
		"<!-- e: id=m-0101 kind=fact saved=2026-09-01 -->", "- Invoices go out on the first working day of the month.", "",
		"<!-- e: id=m-0102 kind=fact saved=2026-09-01 -->", "- Travel is booked through the travel desk, never directly.", "",
		"<!-- e: id=m-0103 kind=fact saved=2026-09-01 -->", "- Expense reports are filed by the fifth.", "",
		"## Active Items",
	].join("\n")));
	const calls: Array<{ id: string; prompt: string }> = [];
	const generate = scripted({ "?": (_n, prompt) => {
		if (prompt.includes("For each note")) throw new Error("the fold worker produced no text");
		return { text: "?" };
	} }, calls);
	const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate, probe: probeAnswers, now: RUN_CLOCK }).runId);
	const sorted = done.sorted ?? [];
	assert(calls.filter((call) => call.prompt.includes("Answer with the one title")).length === 3, `a failed sort asks the placement call once per note, got ${calls.length} calls`);
	assert(sorted.length === 3 && sorted.every((move) => move.topic === "Invoices go out"), `the notes that share no word with any topic open one topic, named by the first one's first words, got ${JSON.stringify(sorted)}`);
	const saved = approveAbsorbRun(room.agentId, done.runId, new Date("2026-09-13T09:05:00.000Z"));
	assert(saved.newTopics === 1, `a topic the sort opened is a new topic on the saved page, got ${saved.newTopics}`);
	const written = fs.readFileSync(room.l1bPath, "utf-8");
	assert(!/^### Unsorted$/m.test(written) && !written.includes("### Invoices go out on the first working day of the month.") && !written.includes("### Travel is booked"), `no Unsorted and no topic per note, got ${[...written.matchAll(/^### (.+)$/gm)].map((m) => m[1]).join(" | ")}`);
	// One real shared word is enough to go under a topic.
	const near = createRoom("Sort Near Room", []);
	fs.writeFileSync(near.l1bPath, fs.readFileSync(near.l1bPath, "utf-8").replace("## Active Items", "### Unsorted\n\n<!-- e: id=m-0101 kind=fact saved=2026-09-01 -->\n- The Nordwind portal is down.\n\n## Active Items"));
	const nearDone = await settle(near.agentId, startAbsorbRun({ agentId: near.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "?": (_n, prompt) => { if (prompt.includes("For each note")) throw new Error("the fold worker produced no text"); return { text: "?" }; } }, []), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(nearDone.sorted?.[0]?.topic === "Renewals", `a note sharing one real word with a topic goes under it, got ${JSON.stringify(nearDone.sorted)}`);
	// Stopwords and words of two letters do not count; an equal score goes to the earlier topic.
	const { parseMemoryDocument } = await import("../src/memory-entries.js");
	const { sortByCode } = await import("../src/memory-placement.js");
	const doc = parseMemoryDocument(["## Deep Memory", "", "### Alpha", "", "<!-- e: id=m-0002 kind=fact saved=2026-09-01 -->", "- Nordwind is on Q3.", "", "### Beta", "", "<!-- e: id=m-0001 kind=fact saved=2026-09-01 -->", "- Harbour is on Q3.", "", "## Active Items", ""].join("\n"));
	assert(sortByCode(doc, "Harbour and Nordwind") === "Alpha", `an equal score goes to the earlier topic, got ${sortByCode(doc, "Harbour and Nordwind")}`);
	assert(sortByCode(doc, "It is on the Q3 list") === null, `stopwords and words of two letters place nothing, got ${sortByCode(doc, "It is on the Q3 list")}`);
});

// A removal the person asked for by naming an entry is done by code before
// Save; one that names nothing memory holds is listed as not done; free text
// is not a request the run claims.
await section("asked-removal", async () => {
	const room = createRoom("Asked Removal Room", [page("RC-0001", "Healthy", "HEALTHY-POINT")]);
	const asked = ["Remove the \"Send the draft to legal\" task.", "Delete the \"Book the venue in Lueneburg\" task.", "Keep the notes short."];
	const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, guidance: { pin: [], drop: [], corrections: [], topics: [], instructions: asked }, generate: scripted({ "RC-0001": () => answer("HEALTHY-POINT") }, []), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(JSON.stringify(done.requests) === JSON.stringify([{ text: asked[0], done: true, entry: "- Send the draft to legal." }, { text: asked[1], done: false }]), `the card's requests are what code did, naming the entry removed, got ${JSON.stringify(done.requests)}`);
	approveAbsorbRun(room.agentId, done.runId, new Date("2026-09-13T09:05:00.000Z"));
	const written = fs.readFileSync(room.l1bPath, "utf-8");
	assert(!written.includes("- Send the draft to legal.") && written.includes("HEALTHY-POINT"), "the task the person asked to remove is gone from memory after Save");
	// A negated or "keep" instruction is guidance, not a removal; quoted words
	// match an entry only as a whole; two matching entries are named as such.
	const guarded = createRoom("Guarded Removal Room", [page("RC-0001", "Healthy", "HEALTHY-POINT")]);
	fs.writeFileSync(guarded.l1bPath, fs.readFileSync(guarded.l1bPath, "utf-8")
		.replace("- The Nordwind contract renews in April.\n", "- The Nordwind contract renews in April.\n\n<!-- e: id=m-0003 kind=fact saved=2026-09-01 -->\n- Nordwind renewal.\n\n<!-- e: id=m-0006 kind=fact saved=2026-09-01 -->\n- Berlin office.\n")
		.replace("- Send the draft to legal.\n", "- Send the draft to legal.\n\n<!-- e: id=m-0004 kind=item saved=2026-09-01 status=open -->\n- Call the Lueneburg venue.\n\n<!-- e: id=m-0005 kind=item saved=2026-09-02 status=open -->\n- Call the Lueneburg venue.\n"));
	const guardedAsked = ["Do not remove the \"Send the draft to legal\" task.", "Keep the \"Send the draft to legal\" task, never close it.", "Remove the \"Nordwind renewal note for April\".", "Close the \"Call the Lueneburg venue\" task.", "Drop the formal tone.", "Remove the note about moving out of the Berlin office next spring.", "Drop the \"formal\" tone.", "Remove \"TODO\" markers from the notes.", "Bring back \"Send the draft to legal\" from the archive.", "Restore the \"Berlin office\" note from the archive."];
	const guardedDone = await settle(guarded.agentId, startAbsorbRun({ agentId: guarded.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, guidance: { pin: [], drop: [], corrections: [], topics: [], instructions: guardedAsked }, generate: scripted({ "RC-0001": () => answer("HEALTHY-POINT") }, []), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(JSON.stringify(guardedDone.requests) === JSON.stringify([{ text: guardedAsked[2], done: false }, { text: guardedAsked[3], done: false, several: true }]), `negated and keep instructions, and a removal verb with no entry named in quotes, or only a short quoted word, are guidance; a part match is no match; two matches say so, got ${JSON.stringify(guardedDone.requests)}`);
	approveAbsorbRun(guarded.agentId, guardedDone.runId, new Date("2026-09-13T09:05:00.000Z"));
	const guardedWritten = fs.readFileSync(guarded.l1bPath, "utf-8");
	assert(/status=open -->\n- Send the draft to legal\./.test(guardedWritten) && guardedWritten.includes("- Nordwind renewal.") && guardedWritten.includes("- Berlin office.") && guardedWritten.split("- Call the Lueneburg venue.").length === 3, "nothing the person did not ask to remove is removed");
	// "Retire" and "archive" are removals too, and an open item is named by its words before the colon: the starter goal
	// the card listed was then done, not left in memory.
	const starter = createRoom("Starter Goal Room", [page("RC-0001", "Healthy", "HEALTHY-POINT")]);
	fs.writeFileSync(starter.l1bPath, fs.readFileSync(starter.l1bPath, "utf-8")
		.replace("- Send the draft to legal.\n", "- Send the draft to legal.\n\n<!-- e: id=m-0007 kind=item saved=2026-09-01 status=open -->\n- Get to know Fernando: current projects, priorities, and how they prefer to work.\n\n<!-- e: id=m-0008 kind=item saved=2026-09-01 status=open -->\n- Book the train: Lisbon to Porto on Friday.\n"));
	const starterAsked = ["Retire the starter goal \"Get to know Fernando\".", "Archive the \"Book the train\" item, it is done."];
	const starterDone = await settle(starter.agentId, startAbsorbRun({ agentId: starter.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, guidance: { pin: [], drop: [], corrections: [], topics: [], instructions: starterAsked }, generate: scripted({ "RC-0001": () => answer("HEALTHY-POINT") }, []), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(JSON.stringify(starterDone.requests) === JSON.stringify([{ text: starterAsked[0], done: true, entry: "- Get to know Fernando: current projects, priorities, and how they prefer to work." }, { text: starterAsked[1], done: true, entry: "- Book the train: Lisbon to Porto on Friday." }]), `a retire or archive naming an item by its label is done by code, got ${JSON.stringify(starterDone.requests)}`);
	approveAbsorbRun(starter.agentId, starterDone.runId, new Date("2026-09-13T09:05:00.000Z"));
	const starterWritten = fs.readFileSync(starter.l1bPath, "utf-8");
	// Two instructions naming the same note: the second finds it already done, never "nothing matched".
	const twice = createRoom("Twice Removal Room", [page("RC-0001", "Healthy", "HEALTHY-POINT")]);
	const twiceAsked = ["Delete \"The Nordwind contract renews in April\".", "Remove the \"The Nordwind contract renews in April\" note as well."];
	const twiceDone = await settle(twice.agentId, startAbsorbRun({ agentId: twice.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, guidance: { pin: [], drop: [], corrections: [], topics: [], instructions: twiceAsked }, generate: scripted({ "RC-0001": () => answer("HEALTHY-POINT") }, []), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(JSON.stringify(twiceDone.requests?.map((request: any) => request.done)) === JSON.stringify([true, true]), `the second request on a removed note is done too, got ${JSON.stringify(twiceDone.requests)}`);
	assert(!/status=open -->\n- Get to know Fernando/.test(starterWritten) && !/status=open -->\n- Book the train/.test(starterWritten) && /status=open -->\n- Send the draft to legal\./.test(starterWritten), "the retired items are no longer open after Save, and the rest are");
	// The scaffold's starter goal as a room holds it: no marker, above the marked items. The card's
	// REMOVED is true only when Save takes it out of what the room reads.
	const scaffolded = createRoom("Scaffolded Starter Room", [page("RC-0001", "Healthy", "HEALTHY-POINT")]);
	fs.writeFileSync(scaffolded.l1bPath, fs.readFileSync(scaffolded.l1bPath, "utf-8").replace("## Active Items\n\n", "## Active Items\n\n- Get to know Sam: current projects, priorities, and how they prefer to work.\n\n"));
	const scaffoldedDone = await settle(scaffolded.agentId, startAbsorbRun({ agentId: scaffolded.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, guidance: { pin: [], drop: [], corrections: [], topics: [], instructions: ["Retire the starter goal \"Get to know Sam\"."] }, generate: scripted({ "RC-0001": () => answer("HEALTHY-POINT") }, []), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(scaffoldedDone.requests?.[0]?.done === true, `the unmarked starter goal is found and retired, got ${JSON.stringify(scaffoldedDone.requests)}`);
	approveAbsorbRun(scaffolded.agentId, scaffoldedDone.runId, new Date("2026-09-13T09:05:00.000Z"));
	const scaffoldedWritten = fs.readFileSync(scaffolded.l1bPath, "utf-8");
	assert(!/(^|-->\n)- Get to know Sam/m.test(scaffoldedWritten.replace(/<!-- e: [^>]*status=done[^>]*-->\n- Get to know Sam/, "")), `after Save the room no longer reads the starter goal as open, got ${scaffoldedWritten.slice(scaffoldedWritten.indexOf("## Active Items"), scaffoldedWritten.indexOf("## Recent Context"))}`);
});

// A page that holds only its dated title (every part was refused at Remember)
// is dropped by code with no call: nothing to keep, no topic invented.
await section("dated-page", async () => {
	const dated = ["### RC-0001 | CLOSED | 2026-09-11 | Conversation of 2026-09-11", "", "**Session arc:** Conversation of 2026-09-11", "", "**Body:**", "- Conversation of 2026-09-11", "", "**Parked:**", "None", ""].join("\n");
	const room = createRoom("Dated Page Room", [dated, page("RC-0002", "Healthy", "HEALTHY-POINT")]);
	const calls: Array<{ id: string; prompt: string }> = [];
	const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0002": () => answer("HEALTHY-POINT") }, calls), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(view(done, "RC-0001").outcome === "dropped" && view(done, "RC-0001").reason === "Its page holds no notes.", `the dated page is dropped with its plain reason, got ${JSON.stringify(view(done, "RC-0001"))}`);
	assert(!calls.some((call) => call.id === "RC-0001" || call.prompt.includes("Conversation of 2026-09-11")), "no call is made for it");
	assert(done.progress.folded === 2, `it counts as read, got ${done.progress.folded}`);
	const saved = approveAbsorbRun(room.agentId, done.runId, new Date("2026-09-13T09:05:00.000Z"));
	assert(saved.notedSessions === 1 && saved.nothingToKeep === 1, `the save counts what it applied: one conversation became notes, one had nothing to keep, got ${JSON.stringify({ noted: saved.notedSessions, nothing: saved.nothingToKeep })}`);
	const written = fs.readFileSync(room.l1bPath, "utf-8");
	assert(!/^### RC-0001 \|/m.test(written) && !written.includes("Conversation of 2026-09-11") && !/^### Unsorted$/m.test(written), "Save removes it from Recent Context and memory gains nothing from it");
});

// The outage rule holds inside the ladder: a ladder call (pieces, the rest,
// the placement) that fails after the patience asks the probe. No answer: the
// page waits whole, nothing filed, the working copy as before the page. An
// answer: the failure is the page's own, and it climbs. A crash mid-ladder
// journals no landed piece. A placement record holds no room text.
await section("ladder-outage", async () => {
	const long = (id: string, marker: string) => [`### ${id} | OPEN | 2026-09-11 | Ladder call`, "", "**Session arc:** It was talked through.", "", "**Body:**", ...[1, 2, 3, 4].map((n) => `- ${marker}-${n} is a durable point.`), "", "**Parked:**", "None", ""].join("\n");
	const spent = () => { throw Object.assign(providerError("terminated"), { patienceSpent: true }); };
	for (const [probe, expected] of [[probeFails, "pending"], [probeAnswers, "summarized"]] as const) {
		const room = createRoom(`Ladder Outage Room ${expected}`, [long("RC-0001", "LADDER")]);
		const calls: Array<{ id: string; prompt: string }> = [];
		// The whole page is prose twice (unreadable), then every ladder call fails after the patience.
		const generate = scripted({ "RC-0001": (n) => (n <= 2 ? { text: "Prose, no list." } : spent()), "?": () => spent() }, calls);
		const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate, probe, now: RUN_CLOCK }).runId);
		const rc1 = view(done, "RC-0001");
		assert(rc1.outcome === expected, `a ladder call that fails after the patience asks the probe: ${probe === probeFails ? "no answer, the page waits" : "an answer, it climbs and is placed"}, got "${rc1.outcome}" after ${calls.length} calls`);
		if (probe === probeFails) assert(done.stop?.kind === "outage" && !(rc1.changes ?? []).length, `the run stops on the outage and the page carries nothing, got ${JSON.stringify({ stop: done.stop, changes: rc1.changes })}`);
		else {
			const diagnosticsDir = path.join(root, room.agentId, "events", "maintenance-diagnostics");
			const placements = fs.readdirSync(diagnosticsDir, { recursive: true }).map(String).filter((name) => name.endsWith(".json")).map((name) => fs.readFileSync(path.join(diagnosticsDir, name), "utf-8")).filter((raw) => JSON.parse(raw).process === "memorize-placement");
			assert(placements.length > 0 && placements.every((raw) => !raw.includes("LADDER")), `a placement record holds no room text, got ${placements.length} record(s)`);
		}
	}
	// A crash mid-ladder: the journal holds the page as it was, with no landed piece.
	const crash = createRoom("Ladder Crash Room", [long("RC-0001", "CRASHPIECE")]);
	const journal = path.join(crash.runtimeDir, "memorize-run.json");
	let piece = 0;
	const hangsOnSecondPiece = scripted({ "RC-0001": (n, prompt) => {
		if (n <= 2) return { text: "Prose, no list." };
		piece += 1;
		if (piece >= 2) return new Promise<AbsorbGenerateResult>(() => {});
		return { text: fence([1, 2, 3, 4].filter((k) => prompt.includes(`CRASHPIECE-${k} is`)).map((k) => ({ op: "add", topic: "Renewals", kind: "fact", text: `- CRASHPIECE-${k} is a durable point.` }))) };
	} }, []);
	const crashed = startAbsorbRun({ agentId: crash.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: hangsOnSecondPiece, probe: probeAnswers, now: RUN_CLOCK });
	const deadline = Date.now() + 30_000;
	while (piece < 2) { assert(Date.now() < deadline, "the second piece is in flight"); await sleep(2); }
	await sleep(20);
	assert(fs.existsSync(journal) && !fs.readFileSync(journal, "utf-8").includes("CRASHPIECE-1 is a durable point.\"") , "the journal holds no piece that landed while the page is in its ladder");
	resetAbsorbRunsForTests(); // the server restarts mid-ladder
	const revived = getAbsorbRun(crash.agentId, crashed.runId);
	assert(view(revived, "RC-0001").outcome === "pending" && !(view(revived, "RC-0001").changes ?? []).length && !view(revived, "RC-0001").reason, `the page revives whole and waits for Continue, with no landed piece and no cause, got ${JSON.stringify(view(revived, "RC-0001"))}`);
	// Continue redoes it (down the ladder, never asked whole again), and the run goes on.
	const continued = await settle(crash.agentId, run.resumeAbsorbRun(crash.agentId, crashed.runId, MODEL, new Date(), { generate: scripted({ "RC-0001": (_n, prompt) => ({ text: fence([1, 2, 3, 4].filter((k) => prompt.includes(`CRASHPIECE-${k} is`)).map((k) => ({ op: "add", topic: "Renewals", kind: "fact", text: `- CRASHPIECE-${k} is a durable point.` }))) }) }, []), probe: probeAnswers }).runId);
	assert(view(continued, "RC-0001").outcome === "folded", `Continue folds the page that was in flight, got ${JSON.stringify(view(continued, "RC-0001"))}`);
});

// The sort's call that cannot reach the model ends the run as a page outage
// does: the notice with its cause, nothing sorted, the notes still in Unsorted.
await section("sort-outage", async () => {
	const { ModelUnreachableError } = await import("../src/model-call-causes.js");
	const room = createRoom("Sort Outage Room", []);
	fs.writeFileSync(room.l1bPath, fs.readFileSync(room.l1bPath, "utf-8").replace("## Active Items", "### Unsorted\n\n<!-- e: id=m-0101 kind=fact saved=2026-09-01 -->\n- Invoices go out on the first working day.\n\n## Active Items"));
	const signedOut: AbsorbRunGenerate = async () => { throw new ModelUnreachableError("signed-out", MODEL); };
	const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: signedOut, probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(done.state === "ready" && done.stop?.kind === "outage" && done.stop.cause === "signed-out" && !(done.sorted ?? []).length, `the sort stops the run with the notice and sorts nothing, got ${JSON.stringify({ state: done.state, stop: done.stop, sorted: done.sorted })}`);
	// The stop names the gateway as AI setup does, so the card never shows its id.
	assert((done.stop as { gateway?: string }).gateway === "Synthetic Gateway", `the stop names the gateway, got ${JSON.stringify(done.stop)}`);
	// Sign in, then Try again: the resume sorts the notes first.
	run.resumeAbsorbRun(room.agentId, done.runId, MODEL, new Date(), { generate: async () => ({ text: "m-0101: Billing" }) });
	const resumed = await settle(room.agentId, done.runId);
	assert(!resumed.stop && JSON.stringify(resumed.sorted) === JSON.stringify([{ id: "m-0101", text: "- Invoices go out on the first working day.", topic: "Billing" }]), `Try again sorts the notes waiting in Unsorted, got ${JSON.stringify({ stop: resumed.stop, sorted: resumed.sorted })}`);
});

// A draft list, prose taking it back, then an empty list as the last fence:
// the fold still takes the draft (no change of behaviour), and the page record
// counts the shape in a code, so a real run can say how often it happens.
await section("earlier-fence", async () => {
	const room = createRoom("Earlier Fence Room", [page("RC-0001", "Retracted", "RETRACTED-POINT", "", "cp-801"), page("RC-0002", "Healthy", "HEALTHY-POINT", "", "cp-802")]);
	const retracted = (): AbsorbGenerateResult => ({ text: `${answer("RETRACTED-POINT").text}\nOn reflection nothing here is durable.\n\n${fence([])}\n` });
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": retracted, "RC-0002": () => answer("HEALTHY-POINT") }, []), probe: probeAnswers, now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	assert(view(done, "RC-0001").outcome === "folded" && view(done, "RC-0002").outcome === "folded", `both pages fold, the first from its draft, got "${view(done, "RC-0001").outcome}"`);
	const diagnosticsDir = path.join(root, room.agentId, "events", "maintenance-diagnostics");
	const pages = fs.readdirSync(diagnosticsDir, { recursive: true }).map(String).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(diagnosticsDir, name), "utf-8"))).filter((record) => record.process === "memorize-page");
	const byKey = new Map(pages.map((record) => [record.page.key, record.page]));
	assert(JSON.stringify(byKey.get("cp-801")?.reader) === JSON.stringify(["earlier-fence"]) && byKey.get("cp-802")?.reader === undefined, `the page whose list came from before a final empty fence says so in a code, the other says nothing, got ${JSON.stringify([...byKey.values()])}`);
});

// A change aimed at a pinned note reaches the card as a new note beside it,
// tagged; a new note that may disagree with memory is tagged too. The pinned
// note is saved as it was.
await section("beside", async () => {
	const room = createRoom("Beside Room", [page("RC-0001", "Pinned", "PINNED-POINT"), page("RC-0002", "Disagrees", "DISAGREE-POINT")]);
	const pinnedLine = "<!-- e: id=m-0001 kind=fact saved=2026-09-01 pinned=true -->";
	fs.writeFileSync(room.l1bPath, fs.readFileSync(room.l1bPath, "utf-8").replace("<!-- e: id=m-0001 kind=fact saved=2026-09-01 -->", pinnedLine), { mode: 0o600 });
	const calls: Array<{ id: string; prompt: string }> = [];
	const started = startAbsorbRun({
		agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, probe: probeAnswers, now: RUN_CLOCK,
		generate: scripted({
			"RC-0001": () => ({ text: fence([{ op: "update", id: "m-0001", text: "- The Nordwind contract renews in May." }]) }),
			"RC-0002": () => ({ text: fence([{ op: "add", topic: "Active Items", kind: "item", text: "- Never send the draft to legal." }]) }),
		}, calls),
	});
	const done = await settle(room.agentId, started.runId);
	const pinnedRow = view(done, "RC-0001").changes ?? [];
	assert(view(done, "RC-0001").outcome === "folded" && pinnedRow.length === 1 && pinnedRow[0].kind === "added" && pinnedRow[0].topic === "Renewals" && pinnedRow[0].beside === "pinned", `the pinned note's change is a new note beside it, tagged, got ${JSON.stringify(pinnedRow)}`);
	const disagreeRow = view(done, "RC-0002").changes ?? [];
	assert(disagreeRow.length === 1 && disagreeRow[0].beside === "may-disagree", `a new note that may disagree with memory is tagged, got ${JSON.stringify(disagreeRow)}`);
	assert(pinnedRow[0].besideOf === "m-0001" && pinnedRow[0].besideLine === "- The Nordwind contract renews in April." && disagreeRow[0].besideOf === "m-0002" && disagreeRow[0].besideLine === "- Send the draft to legal.", `each tagged row names the other note and its first line, got ${JSON.stringify([pinnedRow[0], disagreeRow[0]])}`);
	approveAbsorbRun(room.agentId, started.runId, new Date("2026-09-13T09:05:00.000Z"));
	const written = fs.readFileSync(room.l1bPath, "utf-8");
	// Its text and pin are as they were; it names the new note beside it that disagrees with it.
	assert(written.includes(`${pinnedLine.replace(" -->", ` disagrees=${pinnedRow[0].id} -->`)}\n- The Nordwind contract renews in April.`) && written.includes("- The Nordwind contract renews in May.") && written.includes("- Send the draft to legal.") && written.includes("- Never send the draft to legal."), "the pinned note is saved as it was, both new notes beside the old ones");
});

// A cut-off reply is salvaged from its last complete fence; otherwise asked again; otherwise summarized.
await section("cut-off", async () => {
	const room = createRoom("Cut Off Room", [page("RC-0001", "Salvaged", "SALVAGED-POINT"), page("RC-0002", "Cut twice", "CUT-POINT")]);
	const calls: Array<{ id: string; prompt: string }> = [];
	const salvage = (): AbsorbGenerateResult => ({ text: `${answer("SALVAGED-POINT").text}\nAnd more:\n\`\`\`json\n{"ops":[{"op":"add",`, truncated: true });
	const cut = (): AbsorbGenerateResult => ({ text: 'Narrative.\n```json\n{"ops":[{"op":"add",', truncated: true });
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": salvage, "RC-0002": cut }, calls), probe: probeAnswers, now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	assert(view(done, "RC-0001").outcome === "folded" && view(done, "RC-0001").attempts === 1, `a cut-off reply with a complete fence is salvaged, got "${view(done, "RC-0001").outcome}" after ${view(done, "RC-0001").attempts}`);
	const rc2 = calls.filter((call) => call.id === "RC-0002");
	assert(view(done, "RC-0002").outcome === "summarized" && rc2[1]?.prompt.includes("ran to the output limit"), `a cut-off reply with nothing to salvage is asked again, then placed, got "${view(done, "RC-0002").outcome}"`);
});

// An apply that throws files that page as its summary, and the run goes on.
await section("apply-throws", async () => {
	const room = createRoom("Apply Throws Room", [page("RC-0001", "Throws", "THROWN-POINT"), page("RC-0002", "After", "AFTER-POINT")]);
	run.setAbsorbFoldApplyForTests((doc, ops, ctx) => {
		const applied = applyFoldOps(doc, ops, ctx);
		if (ctx.sessionId === "RC-0001") throw new Error("the applier threw");
		return applied;
	});
	try {
		const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => answer("THROWN-POINT"), "RC-0002": () => answer("AFTER-POINT") }, []), probe: probeAnswers, now: RUN_CLOCK });
		const done = await settle(room.agentId, started.runId);
		assert(done.state === "ready", `an apply that throws does not fail the run, got "${done.state}" ${done.error ?? ""}`);
		assert(view(done, "RC-0001").outcome === "summarized" && view(done, "RC-0002").outcome === "folded", `the page is summarized and the next one folds, got ${JSON.stringify(done.sessions.map((s) => s.outcome))}`);
		const added = (view(done, "RC-0001").changes ?? []).filter((change) => change.kind === "added");
		assert(added.length === 1 && added[0].topic === "Throws", `only the summary note is added for the page whose apply threw, placed under its own topic, got ${JSON.stringify(added)}`);
	} finally {
		run.setAbsorbFoldApplyForTests(null);
	}
});

// An apply that throws on one op keeps the ops that apply, op by op, with no
// new call; the op that threw is kept whole as one note under a topic.
await section("apply-throws-one", async () => {
	const room = createRoom("Apply One Room", [page("RC-0001", "Two points", "GOOD-POINT")]);
	run.setAbsorbFoldApplyForTests((doc, ops, ctx) => {
		if (ops.some((op) => "text" in op && String(op.text).includes("BAD-POINT"))) throw new Error("the applier threw");
		return applyFoldOps(doc, ops, ctx);
	});
	try {
		const calls: Array<{ id: string; prompt: string }> = [];
		const two = (): AbsorbGenerateResult => ({ text: fence([{ op: "add", topic: "Renewals", kind: "fact", text: "- GOOD-POINT is the durable point." }, { op: "add", topic: "Renewals", kind: "fact", text: "- BAD-POINT breaks the applier." }]) });
		const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": two }, calls), probe: probeAnswers, now: RUN_CLOCK }).runId);
		assert(view(done, "RC-0001").outcome === "folded" && calls.length === 1, `the ops that apply are kept with no new call, got "${view(done, "RC-0001").outcome}" after ${calls.length} call(s)`);
		approveAbsorbRun(room.agentId, done.runId, new Date("2026-09-13T09:05:00.000Z"));
		const written = fs.readFileSync(room.l1bPath, "utf-8");
		assert(written.includes("- GOOD-POINT is the durable point.") && written.includes("BAD-POINT breaks the applier.") && !/^### Unsorted$/m.test(written), "the good op is a note of its own and the bad one's text is kept under a topic");
	} finally {
		run.setAbsorbFoldApplyForTests(null);
	}
});

// The window lookup failing reads as unknown: no raw text on the card. The output cap rides every call.
await section("window-unknown", async () => {
	const room = createRoom("Window Room", [page("RC-0001", "Fine", "FINE-POINT")]);
	const calls: Array<{ id: string; prompt: string; maxTokens?: number }> = [];
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => answer("FINE-POINT") }, calls), probe: probeAnswers, resolveModelWindow: () => { throw new Error("model not found: openai-compatible/gpt-5.5"); }, now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	assert(!JSON.stringify(done).includes("model not found"), "a window lookup failure puts no raw text on the card");
	assert(view(done, "RC-0001").outcome === "folded", `and the fold runs as if the window were unknown, got "${view(done, "RC-0001").outcome}"`);
	assert(calls.every((call) => call.maxTokens === 16_000), `every fold call carries the 16k output cap, got ${JSON.stringify(calls.map((call) => call.maxTokens))}`);
});

// A prompt too large for the window is filed as its summary, with no raw text.
await section("oversize", async () => {
	const room = createRoom("Oversize Room", [page("RC-0001", "Too big", "BIG-POINT")]);
	const calls: Array<{ id: string; prompt: string }> = [];
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "?": () => ({ text: "Too big" }) }, calls), probe: probeAnswers, resolveModelWindow: () => ({ contextWindow: 1_000, maxOutputTokens: 200 }), now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	assert(view(done, "RC-0001").outcome === "summarized" && !view(done, "RC-0001").reason && (view(done, "RC-0001").changes ?? []).some((change: any) => change.topic === "Too big"), `an oversize page is placed, and the card reads it like any other, got "${view(done, "RC-0001").outcome}" / "${view(done, "RC-0001").reason}"`);
	// A piece or the rest too large for the window is never sent to be refused.
	assert(calls.every((call) => call.id !== "RC-0001"), `no fold of a piece too large for the window is sent, got ${calls.filter((call) => call.id === "RC-0001").length}`);
});

// A failure the probe shows is the page's own (the model answers) goes down
// the ladder in this run: no record, no waiting, no second run.
await section("second-failure", async () => {
	const room = createRoom("Second Failure Room", [page("RC-0001", "Poison", "POISON-POINT", "", "cp-777"), page("RC-0002", "Healthy", "HEALTHY-POINT"), page("RC-0003", "Dropped", "DROPPED-POINT")]);
	const poison = () => { throw providerError("the content was filtered"); };
	const dropped = () => { throw providerError("terminated"); };
	const one = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": poison, "RC-0002": () => answer("HEALTHY-POINT"), "RC-0003": dropped }, []), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(view(one, "RC-0001").outcome === "summarized" && view(one, "RC-0003").outcome === "summarized" && view(one, "RC-0002").outcome === "folded" && !one.stop, `each failing page is placed in this run, got ${JSON.stringify(one.sessions.map((s) => s.outcome))}`);
	assert(Object.keys(records(room.runtimeDir)).length === 0, "and nothing is recorded");
	const diagnosticsDir = path.join(root, room.agentId, "events", "maintenance-diagnostics");
	const pageKeys = fs.readdirSync(diagnosticsDir, { recursive: true }).map(String).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(diagnosticsDir, name), "utf-8"))).filter((record) => record.process === "memorize-page").map((record) => record.page.key);
	assert(pageKeys.includes("cp-777") && !pageKeys.some((key: string) => key.startsWith("RC-")), `the page diagnostics are keyed by the checkpoint id, never the RC id, got ${pageKeys.join(",")}`);
});

// A dropped connection is told by its own words, never by a sentence that uses the word "terminated".
await section("dropped-words", async () => {
	for (const message of ["terminated", "TypeError: terminated", "fetch failed", "read ECONNRESET", "getaddrinfo ENOTFOUND api.example.com", "getaddrinfo EAI_AGAIN api.example.com", "connect EHOSTUNREACH 10.0.0.1:443", "UND_ERR_SOCKET: other side closed", "socket hang up", "WebSocket error", "websocket connection closed"]) assert(run.connectionDropped(message), `a dropped connection: ${message}`);
	for (const message of ["The response was terminated because the content was filtered", "Output terminated at max_tokens", "Tool call terminated by the user", "502 Bad Gateway", "504 Gateway Timeout", "the content was filtered"]) assert(!run.connectionDropped(message), `not a dropped connection: ${message}`);
});

// A blip (a server error, a dropped connection) passes within a minute: the one
// retry waits it out, so the page folds with no notice. A failure that is no
// blip (a content refusal) is asked again after the short pause, as before.
await section("blip-wait", async () => {
	setAbsorbFoldRetryPauseForTests(20);
	try {
		const SERVICE_UNAVAILABLE = 'Codex error: {"type":"error","error":{"type":"service_unavailable_error","code":null,"message":"Unable to verify model access right now. Please retry.","param":null},"sequence_number":2}';
		const SERVER_ERROR = 'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. You can retry your request.","param":null}}';
		const REFUSAL = "400 invalid_request_error: The response was filtered due to the prompt triggering content management policy";
		for (const [n, message] of ["WebSocket error", SERVICE_UNAVAILABLE, SERVER_ERROR, "read ECONNRESET", REFUSAL].entries()) {
			const refuses = message === REFUSAL;
			// A slow machine only makes a pause longer, so a pause is told by its
			// floor: a blip's retry comes after the long one, and a refusal's well
			// before a long one it never takes.
			const longPauseMs = refuses ? 30_000 : 600;
			run.setAbsorbFoldRateLimitPauseForTests?.(longPauseMs);
			const room = createRoom(`Blip Room ${n}`, [page("RC-0001", "Blip", "BLIP-POINT")]);
			// The blip fails the first call only; the refusal fails every call, and the probe gets no answer.
			const calls: Array<{ id: string; prompt: string }> = [];
			const callTimes: number[] = [];
			let probes = 0;
			const generate = scripted({ "RC-0001": (attempt) => { callTimes.push(Date.now()); if (refuses || attempt === 1) throw providerError(message); return answer("BLIP-POINT"); } }, calls);
			const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate, probe: async (...args) => { probes += 1; return probeFails(...args); }, now: RUN_CLOCK }).runId);
			const pausedMs = callTimes.length === 2 ? callTimes[1] - callTimes[0] : NaN;
			if (refuses) assert(done.stop?.kind === "outage" && view(done, "RC-0001").outcome !== "folded" && calls.length === 2 && probes === 1 && pausedMs < 10_000, `a content refusal is asked again after the short pause, then the probe: got "${view(done, "RC-0001").outcome}" after ${calls.length} call(s), ${probes} probe(s) and a ${pausedMs} ms pause`);
			else assert(!done.stop && view(done, "RC-0001").outcome === "folded" && calls.length === 2 && probes === 0 && pausedMs >= longPauseMs - 5, `a blip is waited out and the page folds with no notice: ${message.slice(0, 40)}, got "${view(done, "RC-0001").outcome}"${done.stop ? " and a stop" : ""} after ${calls.length} call(s), ${probes} probe(s) and a ${pausedMs} ms pause`);
		}
	} finally {
		setAbsorbFoldRetryPauseForTests(0);
		run.setAbsorbFoldRateLimitPauseForTests?.(0);
	}
});

// A gateway's bare 403 met by the probe, or by a sort call, is the gateway
// refusing, as chat reads it: the card offers the gateway's key.
const forbidden = (): never => { throw providerError("HTTP 403 Forbidden"); };
await section("gateway-bare-403-probe", async () => {
	const folded = createRoom("Probe 403 Room", [page("RC-0001", "Odd", "ODD-POINT")]);
	const probed = await settle(folded.agentId, startAbsorbRun({ agentId: folded.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => { throw providerError("an odd failure"); } }, []), probe: async () => forbidden(), now: RUN_CLOCK }).runId);
	assert(probed.stop?.cause === "gateway-refused", `the probe's bare 403 stops the run on the gateway refusing, got ${JSON.stringify(probed.stop)}`);
});
await section("gateway-bare-403-sort", async () => {
	const sorting = createRoom("Sort 403 Room", []);
	fs.writeFileSync(sorting.l1bPath, fs.readFileSync(sorting.l1bPath, "utf-8").replace("## Active Items", "### Unsorted\n\n<!-- e: id=m-0101 kind=fact saved=2026-09-01 -->\n- Invoices go out on the first working day.\n\n## Active Items"));
	const sorted = await settle(sorting.agentId, startAbsorbRun({ agentId: sorting.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: async () => forbidden(), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(sorted.stop?.cause === "gateway-refused", `a sort call's bare 403 stops the run on the gateway refusing, got ${JSON.stringify(sorted.stop)}`);
});

// Each cause stops the run with the stop the card reads, whether a page's call (as the shared patience hands it on)
// or the one-time sort met it: the cause, the key, why it was not reached, who can lift a spent limit, and the
// gateway's name, as Review's run builds it.
await section("stop-per-cause", async () => {
	const { ModelUnreachableError } = await import("../src/model-call-causes.js");
	const cases: Array<[string, ConstructorParameters<typeof ModelUnreachableError>[0], string, AbsorbRunProbe, string]> = [
		["a spent quota", "quota", '429 {"error":{"code":"insufficient_quota","type":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}', probeAnswers, '{"kind":"outage","model":{"provider":"openai-compatible","model":"gpt-5.5"},"cause":"quota","quotaWay":{"kind":"gateway","provider":"Synthetic Gateway"},"gateway":"Synthetic Gateway"}'],
		["a refused key", "signed-out", '401 {"error":{"code":"invalid_api_key","type":"invalid_request_error","message":"Incorrect API key provided."}}', probeAnswers, '{"kind":"outage","model":{"provider":"openai-compatible","model":"gpt-5.5"},"cause":"signed-out","key":"refused","gateway":"Synthetic Gateway"}'],
		["a gateway's 403", "gateway-refused", "HTTP 403 Forbidden", async () => forbidden(), '{"kind":"outage","model":{"provider":"openai-compatible","model":"gpt-5.5"},"cause":"gateway-refused","key":"refused","gateway":"Synthetic Gateway"}'],
		["an unreached model", "not-answering", "fetch failed: ECONNREFUSED", probeFails, '{"kind":"outage","model":{"provider":"openai-compatible","model":"gpt-5.5"},"cause":"not-answering","unreached":"connection","gateway":"Synthetic Gateway"}'],
		["a busy model", "still-busy", '429 {"error":{"type":"rate_limit_error","message":"Rate limit reached"}}', probeAnswers, '{"kind":"outage","model":{"provider":"openai-compatible","model":"gpt-5.5"},"cause":"busy","gateway":"Synthetic Gateway"}'],
	];
	for (const [label, detail, words, probe, expected] of cases) {
		const folded = createRoom(`Stop Room ${label}`, [page("RC-0001", "Stop", "STOP-POINT")]);
		const onFold = await settle(folded.agentId, startAbsorbRun({ agentId: folded.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => { throw new ModelUnreachableError(detail, MODEL, providerError(words)); } }, []), probe, now: RUN_CLOCK }).runId);
		const sorting = createRoom(`Stop Sort Room ${label}`, []);
		fs.writeFileSync(sorting.l1bPath, fs.readFileSync(sorting.l1bPath, "utf-8").replace("## Active Items", "### Unsorted\n\n<!-- e: id=m-0101 kind=fact saved=2026-09-01 -->\n- Invoices go out on the first working day.\n\n## Active Items"));
		const onSort = await settle(sorting.agentId, startAbsorbRun({ agentId: sorting.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: async () => { throw providerError(words); }, probe, now: RUN_CLOCK }).runId);
		assert(JSON.stringify(onFold.stop) === expected && JSON.stringify(onSort.stop) === expected, `${label}: the stop, got ${JSON.stringify(onFold.stop)} on a page and ${JSON.stringify(onSort.stop)} on the sort`);
	}
});

// A dropped connection while the model answers is the page's own: retried
// once, then down the ladder and placed in this run, never waiting.
await section("websocket-sentence", async () => {
	const room = createRoom("WebSocket Room", [page("RC-0001", "Socket", "SOCKET-POINT")]);
	const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => { throw providerError("WebSocket error"); } }, []), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(view(done, "RC-0001").outcome === "summarized" && !view(done, "RC-0001").reason && (view(done, "RC-0001").changes ?? []).some((change: any) => change.topic === "Socket") && !done.stop, `the page is placed in this run, got ${JSON.stringify(view(done, "RC-0001"))}`);
});

// The probe asks with no thinking, so a reasoning model does not think its way to the ceiling.
await section("probe-off", async () => {
	const room = createRoom("Probe Off Room", [page("RC-0001", "Poison", "POISON-POINT")]);
	const probeOptions: Array<{ thinkingLevel?: string; timeoutMs?: number }> = [];
	const probe: AbsorbRunProbe = async (prompt, model, options) => { probeOptions.push(options); return probeAnswers(prompt, model, options); };
	await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => { throw providerError("the content was filtered"); } }, []), probe, now: RUN_CLOCK }).runId);
	assert(probeOptions.length >= 1 && probeOptions.every((options) => options.thinkingLevel === "off" && options.timeoutMs === 45_000), `every probe (the fold's, then the ladder's) asks with no thinking within its 45 s, got ${JSON.stringify(probeOptions)}`);
});

// An outage stops the run, records nothing, and says so; a rate limit is an outage whatever the probe says; Try again resumes.
await section("outage", async () => {
	const room = createRoom("Outage Room", [page("RC-0001", "First", "FIRST-POINT"), page("RC-0002", "Second", "SECOND-POINT"), page("RC-0003", "Third", "THIRD-POINT")]);
	let down = true;
	const calls: Array<{ id: string; prompt: string }> = [];
	const maybe = (marker: string) => () => { if (down) throw providerError("fetch failed: ECONNREFUSED"); return answer(marker); };
	const scripts = { "RC-0001": () => answer("FIRST-POINT"), "RC-0002": maybe("SECOND-POINT"), "RC-0003": maybe("THIRD-POINT") };
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted(scripts, calls), probe: async (...args) => (down ? probeFails(...args) : probeAnswers(...args)), now: RUN_CLOCK });
	const stopped = await settle(room.agentId, started.runId);
	assert(stopped.state === "ready" && stopped.stop?.kind === "outage" && stopped.stop.cause === "not-answering", `an outage stops the run with its notice, got ${JSON.stringify(stopped.stop)} in "${stopped.state}"`);
	assert(view(stopped, "RC-0001").outcome === "folded" && view(stopped, "RC-0002").outcome === "pending" && view(stopped, "RC-0003").outcome === "pending", `what finished stays, the rest wait, got ${JSON.stringify(stopped.sessions.map((s) => s.outcome))}`);
	assert(calls.filter((call) => call.id === "RC-0003").length === 0, "no page after the outage is called");
	assert(Object.keys(records(room.runtimeDir)).length === 0, "an outage records nothing, not even its first page");
	assert(stopped.sessions.every((s) => !s.reason), "no page of an outage carries a failure reason");
	down = false;
	const resumed = run.resumeAbsorbRun(room.agentId, started.runId, MODEL);
	assert(resumed.state === "folding" && !resumed.stop, `Try again resumes the same run, got "${resumed.state}"`);
	const after = await settle(room.agentId, started.runId);
	assert(after.state === "ready" && after.sessions.every((s) => s.outcome === "folded"), `the resumed run folds what waited, keeping what finished, got ${JSON.stringify(after.sessions.map((s) => s.outcome))}`);
	assert(calls.filter((call) => call.id === "RC-0001").length === 1, "a finished page is not folded again");
	assert(after.progress.folded === 3, `the progress counts all three, got ${after.progress.folded}`);
});

// A run that stopped for an outage and then ended, saved or cancelled, offers
// no Try again: another tab watching it must not show the notice.
await section("ended-stop", async () => {
	const stoppedRun = async (name: string) => {
		const room = createRoom(name, [page("RC-0001", "First", "FIRST-POINT"), page("RC-0002", "Second", "SECOND-POINT")]);
		const scripts = { "RC-0001": () => answer("FIRST-POINT"), "RC-0002": () => { throw providerError("fetch failed: ECONNREFUSED"); } };
		const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted(scripts, []), probe: probeFails, now: RUN_CLOCK });
		const stopped = await settle(room.agentId, started.runId);
		assert(stopped.stop?.kind === "outage", `the run stops for the outage, got ${JSON.stringify(stopped.stop)}`);
		return { room, runId: started.runId };
	};
	const saved = await stoppedRun("Ended Stop Saved Room");
	approveAbsorbRun(saved.room.agentId, saved.runId);
	const afterSave = getAbsorbRun(saved.room.agentId, saved.runId);
	assert(afterSave.state === "saved" && !afterSave.stop, `a saved run carries no outage stop, got ${JSON.stringify(afterSave.stop)} in "${afterSave.state}"`);
	const cancelled = await stoppedRun("Ended Stop Cancelled Room");
	cancelAbsorbRun(cancelled.room.agentId, cancelled.runId);
	const afterCancel = getAbsorbRun(cancelled.room.agentId, cancelled.runId);
	assert(afterCancel.state === "cancelled" && !afterCancel.stop, `a cancelled run carries no outage stop, got ${JSON.stringify(afterCancel.stop)} in "${afterCancel.state}"`);
});

// A rate limit waits out one pause and is asked again; still limited, it is an
// outage whatever the probe says. The page goes last next run, and when it
// stops that run too after another page folded, it is filed as its summary.
await section("rate-limit", async () => {
	const room = createRoom("Rate Limit Room", [page("RC-0001", "Limited", "LIMITED-POINT"), page("RC-0002", "Behind", "BEHIND-POINT")]);
	const calls: Array<{ id: string; prompt: string }> = [];
	const limited = () => { throw providerError("litellm.RateLimitError: RateLimitError: OpenAIException - Rate limit reached. Please try again in 12s."); };
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": limited, "RC-0002": () => answer("BEHIND-POINT") }, calls), probe: probeAnswers, now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	assert(done.stop?.cause === "busy", `a rate-limit message is an outage even when the probe answers, got ${JSON.stringify(done.stop)}`);
	assert(Object.keys(records(room.runtimeDir)).length === 0 && view(done, "RC-0001").outcome === "pending", "and records nothing");
	assert(calls.filter((call) => call.id === "RC-0001").length === 2, "it was asked again once, after its pause");
	cancelAbsorbRun(room.agentId, started.runId);
	const second: Array<{ id: string; prompt: string }> = [];
	const next = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": limited, "RC-0002": () => answer("BEHIND-POINT") }, second), probe: probeAnswers, now: RUN_CLOCK });
	const two = await settle(room.agentId, next.runId);
	assert(second[0].id === "RC-0002", `the page that stopped the last run goes last, got ${second.map((call) => call.id).join(",")}`);
	assert(two.stop?.cause === "busy" && view(two, "RC-0001").outcome === "pending" && view(two, "RC-0002").outcome === "folded", `busy is an outage every time: it stops the run after the other page folded, and is never filed, got ${JSON.stringify(two.sessions.map((s) => s.outcome))} stop ${JSON.stringify(two.stop)}`);
});

// A page whose probe the model is too slow to answer: the same, without a rate limit's words.
await section("slow-probe", async () => {
	const room = createRoom("Slow Probe Room", [page("RC-0001", "Heavy", "HEAVY-POINT"), page("RC-0002", "Behind", "BEHIND-POINT")]);
	const heavy = () => { throw providerError("stream stalled"); };
	let heavyInFlight = false;
	const generate: AbsorbRunGenerate = async (prompt, model, options) => {
		heavyInFlight = sessionOf(prompt) === "RC-0001";
		return scripted({ "RC-0001": heavy, "RC-0002": () => answer("BEHIND-POINT") }, [])(prompt, model, options);
	};
	const slowProbe: AbsorbRunProbe = async (...args) => (heavyInFlight ? probeFails(...args) : probeAnswers(...args));
	const first = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate, probe: slowProbe, now: RUN_CLOCK }).runId);
	assert(first.stop?.cause === "not-answering" && view(first, "RC-0002").outcome === "pending", `a failed probe stops the run, got ${JSON.stringify(first.stop)}`);
	cancelAbsorbRun(room.agentId, first.runId);
	const two = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate, probe: slowProbe, now: RUN_CLOCK }).runId);
	assert(two.stop?.cause === "not-answering" && view(two, "RC-0001").outcome === "pending" && view(two, "RC-0002").outcome === "folded", `the page that stopped a run goes last, so the other folds first; a probe that fails stops the run again, got ${JSON.stringify(two.sessions.map((s) => s.outcome))}`);
});

// Cancel works while a rate-limited call waits out its pause.
await section("pause-cancel", async () => {
	const room = createRoom("Pause Cancel Room", [page("RC-0001", "Limited", "LIMITED-POINT")]);
	run.setAbsorbFoldRateLimitPauseForTests?.(null);
	try {
		const calls: Array<{ id: string; prompt: string }> = [];
		const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => { throw providerError("429 Too Many Requests"); } }, calls), probe: probeAnswers, now: RUN_CLOCK });
		const deadline = Date.now() + 10_000;
		while (calls.length === 0) { assert(Date.now() < deadline, "the run reached the page"); await sleep(2); }
		await sleep(50);
		const before = Date.now();
		cancelAbsorbRun(room.agentId, started.runId);
		const done = await settle(room.agentId, started.runId);
		assert(done.state === "cancelled" && Date.now() - before < 5_000 && calls.length === 1, `a cancel ends the 30-second pause at once, got "${done.state}" after ${Date.now() - before} ms and ${calls.length} call(s)`);
		assert(!fs.existsSync(path.join(room.runtimeDir, "memorize-page-failures.json")), "and neither records nor notes the page");
	} finally {
		run.setAbsorbFoldRateLimitPauseForTests?.(0);
	}
});

// Try again folds from the card as the person left it: an edited note reaches
// the resumed fold in the person's words and an update shows them as its
// before; a kept note reads as pinned, so a resumed fold cannot rewrite it.
await section("resume-card", async () => {
	const room = createRoom("Resume Card Room", [page("RC-0001", "Alpha", "ALPHA-POINT"), page("RC-0002", "Beta", "BETA-POINT"), page("RC-0003", "Gamma", "GAMMA-POINT")]);
	const { writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
	const { parseMemoryDocument, reviewTargetTokens } = await import("../src/memory-entries.js");
	writePersistentRoomMaintenanceSettings(room.agentId, { memoryBudgetTokens: 10_000 });
	// Old filler notes up to just under the limit, so the first fold's note pushes one out.
	const base = fs.readFileSync(room.l1bPath, "utf-8").replace("<!-- entries: next=10 -->", "<!-- entries: next=900 -->");
	const filler: string[] = [];
	const withFiller = () => base.replace("## Active Items", ["### Filler", "", ...filler, "## Active Items"].join("\n"));
	for (let n = 100; reviewTargetTokens(parseMemoryDocument(withFiller())) < 9_940; n++) filler.push(`<!-- e: id=m-0${n} kind=fact saved=2026-01-${String(1 + (n % 28)).padStart(2, "0")} -->`, `- Filler note ${n}: ${"an old detail that nobody has touched in months ".repeat(3).trim()}.`, "");
	assert(filler.length / 3 < 800, "the filler ids stay below the next entry number");
	fs.writeFileSync(room.l1bPath, withFiller(), { mode: 0o600 });
	const long = `- ALPHA-POINT ${"is a durable point about the renewal terms and the people involved ".repeat(8).trim()}.`;
	// Long enough that, added beside the kept note, it takes the memory over its budget again.
	const gamma = `- GAMMA-POINT rewrote the kept note: ${"it is a durable point about the renewal terms and the people involved ".repeat(8).trim()}.`;
	let down = true;
	let alphaId = "";
	let keptId = "";
	const calls: Array<{ id: string; prompt: string }> = [];
	const scripts: Record<string, Script> = {
		"RC-0001": () => ({ text: `Alpha.\n\n${fence([{ op: "add", topic: "Renewals", kind: "fact", text: long }])}\n` }),
		"RC-0002": () => { if (down) throw providerError("fetch failed: ECONNREFUSED"); return { text: `Beta.\n\n${fence([{ op: "update", id: alphaId, text: "- ALPHA was EDITED by the person, and BETA-POINT adds to it." }])}\n` }; },
		"RC-0003": () => { if (down) throw providerError("fetch failed: ECONNREFUSED"); return { text: `Gamma.\n\n${fence([{ op: "update", id: keptId, text: gamma }])}\n` }; },
	};
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted(scripts, calls), probe: async (...args) => (down ? probeFails(...args) : probeAnswers(...args)), now: RUN_CLOCK });
	const stopped = await settle(room.agentId, started.runId);
	assert(stopped.stop?.kind === "outage" && view(stopped, "RC-0001").outcome === "folded", `the first page folds and the outage stops the run, got ${JSON.stringify(stopped.sessions.map((s) => s.outcome))}`);
	alphaId = (view(stopped, "RC-0001").changes ?? []).find((change) => change.kind === "added")?.id ?? "";
	const leaving = stopped.demotion.entries.find((row) => row.leaving && row.phase === "after");
	assert(alphaId && leaving, `the fold added a note and pushed an old one out, got ${alphaId} and ${JSON.stringify(stopped.demotion.entries.map((row) => [row.id, row.phase, row.leaving]))}`);
	keptId = leaving.id;
	const keptText = leaving.text;
	run.editAbsorbRunEntry(room.agentId, started.runId, alphaId, "ALPHA was EDITED by the person.");
	run.keepAbsorbRunEntries(room.agentId, started.runId, { keepIds: [keptId] });
	down = false;
	run.resumeAbsorbRun(room.agentId, started.runId, MODEL);
	const after = await settle(room.agentId, started.runId);
	const betaPrompt = calls.filter((call) => call.id === "RC-0002").pop()?.prompt ?? "";
	assert(betaPrompt.includes("ALPHA was EDITED by the person."), "the resumed fold reads the person's edit");
	const update = (view(after, "RC-0002").changes ?? []).find((change) => change.id === alphaId);
	assert(update?.kind === "updated" && update.before === "- ALPHA was EDITED by the person.", `the update shows the person's words as its before, got ${JSON.stringify(update)}`);
	// A kept note is not the person's pin: the change is added beside it, untagged, and the page folds (it was filed whole under the S1 rules).
	const beside = view(after, "RC-0003").changes ?? [];
	assert(view(after, "RC-0003").outcome === "folded" && beside.length === 1 && beside[0].kind === "added" && beside[0].after === gamma && !("beside" in beside[0]) && !beside.some((change) => change.id === keptId), `a resumed fold's update of a kept note is added beside it, untagged, got "${view(after, "RC-0003").outcome}" ${JSON.stringify(beside)}`);
	assert(after.demotion.entries.find((row) => row.id === keptId)?.text === keptText || !after.demotion.entries.some((row) => row.id === keptId), "the kept note itself is unchanged");
	const gammaPrompt = calls.filter((call) => call.id === "RC-0003")[0]?.prompt ?? "";
	assert(new RegExp(`\\[${keptId} · pinned`).test(gammaPrompt), "the kept note reads as pinned to the resumed fold");
	// The pin was the folds' only: taking the keep back leaves the note to the budget again.
	const unkept = run.keepAbsorbRunEntries(room.agentId, started.runId, { keepIds: [] });
	assert(unkept.demotion.entries.find((row) => row.id === keptId)?.leaving === true, `a keep taken back after the resume leaves the note to the budget, unpinned, got ${JSON.stringify(unkept.demotion.entries.find((row) => row.id === keptId))} of ${unkept.demotion.entries.length} rows, leaving ${unkept.demotion.counts.leaving}`);
	run.keepAbsorbRunEntries(room.agentId, started.runId, { keepIds: [keptId] });
	approveAbsorbRun(room.agentId, started.runId);
	const saved = fs.readFileSync(room.l1bPath, "utf-8");
	assert(saved.includes(keptText) && saved.includes(gamma.slice(2)), "the kept note is saved as the person kept it, and the resumed fold's text beside it");
});

// A resumed fold that pins a kept note itself, because the conversation asks
// for it, makes a change the card shows, and that pin stays after the folds.
await section("resume-pin", async () => {
	const asked = "The user asked to pin the old filler detail for good.";
	const room = createRoom("Resume Pin Room", [page("RC-0001", "Alpha", "ALPHA-POINT"), page("RC-0002", "Beta", "BETA-POINT", ` ${asked}`)]);
	const { writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
	const { parseMemoryDocument, reviewTargetTokens } = await import("../src/memory-entries.js");
	writePersistentRoomMaintenanceSettings(room.agentId, { memoryBudgetTokens: 10_000 });
	const base = fs.readFileSync(room.l1bPath, "utf-8").replace("<!-- entries: next=10 -->", "<!-- entries: next=900 -->");
	const filler: string[] = [];
	const withFiller = () => base.replace("## Active Items", ["### Filler", "", ...filler, "## Active Items"].join("\n"));
	for (let n = 100; reviewTargetTokens(parseMemoryDocument(withFiller())) < 9_940; n++) filler.push(`<!-- e: id=m-0${n} kind=fact saved=2026-01-${String(1 + (n % 28)).padStart(2, "0")} -->`, `- Filler note ${n}: ${"an old detail that nobody has touched in months ".repeat(3).trim()}.`, "");
	fs.writeFileSync(room.l1bPath, withFiller(), { mode: 0o600 });
	const long = `- ALPHA-POINT ${"is a durable point about the renewal terms and the people involved ".repeat(8).trim()}.`;
	let down = true;
	let keptId = "";
	const scripts: Record<string, Script> = {
		"RC-0001": () => ({ text: `Alpha.\n\n${fence([{ op: "add", topic: "Renewals", kind: "fact", text: long }])}\n` }),
		"RC-0002": () => { if (down) throw providerError("fetch failed: ECONNREFUSED"); return { text: `Beta.\n\n${fence([{ op: "pin", id: keptId, because: asked }])}\n` }; },
	};
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted(scripts, []), probe: async (...args) => (down ? probeFails(...args) : probeAnswers(...args)), now: RUN_CLOCK });
	const stopped = await settle(room.agentId, started.runId);
	const leaving = stopped.demotion.entries.find((row) => row.leaving && row.phase === "after");
	assert(stopped.stop?.kind === "outage" && leaving, `the first fold pushed an old note out and the outage stopped the run, got ${JSON.stringify(stopped.sessions.map((s) => s.outcome))}`);
	keptId = leaving.id;
	run.keepAbsorbRunEntries(room.agentId, started.runId, { keepIds: [keptId] });
	down = false;
	run.resumeAbsorbRun(room.agentId, started.runId, MODEL);
	const after = await settle(room.agentId, started.runId);
	assert(view(after, "RC-0002").outcome === "folded" && (view(after, "RC-0002").changes ?? []).some((change) => change.kind === "pinned" && change.id === keptId), `the resumed fold's pin is a change on the card, got ${JSON.stringify(view(after, "RC-0002"))}`);
	const unkept = run.keepAbsorbRunEntries(room.agentId, started.runId, { keepIds: [] });
	assert(unkept.demotion.entries.find((row) => row.id === keptId)?.leaving !== true, "a keep taken back leaves the note the fold pinned in memory, pinned");
	approveAbsorbRun(room.agentId, started.runId);
	const saved = fs.readFileSync(room.l1bPath, "utf-8");
	assert(new RegExp(`id=${keptId}\\b[^\\n]*pinned=true`).test(saved), "the note the resumed fold pinned is saved pinned");
});


// A page in flight when the app restarted carries its own record, on any
// model: the next run never asks the fold call for it again, so a page that
// brings the server down cannot loop. It goes straight down the ladder.
await section("restarted-record", async () => {
	const room = createRoom("Restarted Record Room", [page("RC-0001", "Crasher", "CRASH-POINT", "", "cp-555"), page("RC-0002", "Healthy", "HEALTHY-POINT")]);
	fs.mkdirSync(room.runtimeDir, { recursive: true });
	fs.writeFileSync(path.join(room.runtimeDir, "memorize-page-failures.json"), JSON.stringify({ schemaVersion: 1, records: { "cp-555": { at: "2026-09-12T09:00:00.000Z", provider: "openai-compatible", model: "gpt-5.4", code: "restarted" } }, throttled: {} }));
	const calls: Array<{ id: string; prompt: string }> = [];
	const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => answer("CRASH-POINT"), "RC-0002": () => answer("HEALTHY-POINT") }, calls), probe: probeAnswers, now: RUN_CLOCK }).runId);
	// The whole-page fold reads the whole memory; the ladder's rungs read less of it.
	assert(!calls.some((call) => call.id === "RC-0001" && call.prompt.includes("The Nordwind contract renews in April.")), `no whole-page fold call for a page the restart caught, got ${calls.map((call) => call.id).join(",")}`);
	assert(view(done, "RC-0001").outcome !== "failed" && view(done, "RC-0002").outcome === "folded", `the page does not wait again, got "${view(done, "RC-0001").outcome}"`);
	assert(Object.keys(records(room.runtimeDir)).length === 0, "and its record is gone");
	// Caught by a restart a second time, in the ladder: no fold call at all, only the placement.
	const again = createRoom("Restarted Twice Room", [page("RC-0001", "Crasher", "CRASH-POINT", "", "cp-556")]);
	fs.mkdirSync(again.runtimeDir, { recursive: true });
	fs.writeFileSync(path.join(again.runtimeDir, "memorize-page-failures.json"), JSON.stringify({ schemaVersion: 1, records: { "cp-556": { at: "2026-09-12T09:00:00.000Z", provider: "openai-compatible", model: "gpt-5.5", code: "restarted-twice" } }, throttled: {} }));
	const againCalls: Array<{ id: string; prompt: string }> = [];
	const twice = await settle(again.agentId, startAbsorbRun({ agentId: again.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => answer("CRASH-POINT"), "?": () => ({ text: "Renewals" }) }, againCalls), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(againCalls.length === 0 && view(twice, "RC-0001").outcome === "summarized" && !view(twice, "RC-0001").reason, `a page a restart caught twice is placed as one note by code, with no call at all, got ${againCalls.map((call) => call.id).join(",")} and "${view(twice, "RC-0001").outcome}"`);
	// With no call, a model that cannot be reached does not hold it: it is placed all the same.
	const down = createRoom("Restarted Twice Down Room", [page("RC-0001", "Crasher", "DOWN-POINT", "", "cp-557")]);
	fs.mkdirSync(down.runtimeDir, { recursive: true });
	fs.writeFileSync(path.join(down.runtimeDir, "memorize-page-failures.json"), JSON.stringify({ schemaVersion: 1, records: { "cp-557": { at: "2026-09-12T09:00:00.000Z", provider: "openai-compatible", model: "gpt-5.5", code: "restarted-twice" } }, throttled: {} }));
	const spent = () => { throw Object.assign(providerError("terminated"), { patienceSpent: true }); };
	const stopped = await settle(down.agentId, startAbsorbRun({ agentId: down.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "?": () => spent() }, []), probe: probeFails, now: RUN_CLOCK }).runId);
	assert(!stopped.stop && view(stopped, "RC-0001").outcome === "summarized", `a page a restart caught twice is placed with no call, whatever the model, got ${JSON.stringify({ stop: stopped.stop, outcome: view(stopped, "RC-0001").outcome })}`);
});

// A provider that says the request is too large: the page is kept as its summary at once, never an outage.
await section("too-large", async () => {
	const room = createRoom("Too Large Room", [page("RC-0001", "Huge", "HUGE-POINT"), page("RC-0002", "Behind", "BEHIND-POINT")]);
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => { throw providerError("Request too large for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Requested 41290. rate_limit_exceeded"); }, "RC-0002": () => answer("BEHIND-POINT"), "?": () => ({ text: "Huge" }) }, []), probe: probeFails, now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	assert(!done.stop && view(done, "RC-0001").outcome === "summarized" && view(done, "RC-0002").outcome === "folded", `a request too large is summarized and the run goes on, got ${JSON.stringify(done.sessions.map((s) => s.outcome))} stop ${JSON.stringify(done.stop)}`);
	assert(!view(done, "RC-0001").reason, `a page placed as one note carries no sentence about it, got ${view(done, "RC-0001").reason}`);
	assert(Object.keys(records(room.runtimeDir)).length === 0, "and nothing is recorded");
});

// A record is written when its page ends, so a restart mid-run keeps it; a cancel keeps it too.
await section("cancel-flush", async () => {
	const room = createRoom("Cancel Room", [page("RC-0001", "Poison", "POISON-POINT"), page("RC-0002", "Slow", "SLOW-POINT")]);
	let release = () => {};
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	let reachedSlow = false;
	const slow: AbsorbRunGenerate = async (prompt, model, options) => {
		if (sessionOf(prompt) !== "RC-0002") throw providerError("the content was filtered");
		reachedSlow = true;
		await new Promise<void>((resolve) => { options.signal.addEventListener("abort", () => resolve()); void blocked.then(resolve); });
		throw new IsolatedPersistentAgentWorkerTurnError("memorize fold worker", "aborted", "cancelled");
	};
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: slow, probe: probeAnswers, now: RUN_CLOCK });
	const deadline = Date.now() + 30_000;
	while (!reachedSlow) { assert(Date.now() < deadline, "the run reached the slow page"); await sleep(2); }
	assert(Object.keys(records(room.runtimeDir)).length === 0, "the failed page was placed, not recorded");
	cancelAbsorbRun(room.agentId, started.runId);
	release();
	await settle(room.agentId, started.runId).catch(() => undefined);
	assert(Object.keys(records(room.runtimeDir)).length === 0, "a cancel records neither the placed page nor the one in flight");
});

// Titles the sort names in another case or spacing open one topic, not two.
await section("sort-one-topic-whatever-the-case", async () => {
	const room = createRoom("Sort Case Room", []);
	fs.writeFileSync(room.l1bPath, fs.readFileSync(room.l1bPath, "utf-8").replace("## Active Items", "### Unsorted\n\n<!-- e: id=m-0101 kind=fact saved=2026-09-01 -->\n- Invoices go out on the first.\n\n<!-- e: id=m-0102 kind=fact saved=2026-09-01 -->\n- Late invoices get a reminder.\n\n<!-- e: id=m-0103 kind=fact saved=2026-09-01 -->\n- Credit notes need approval.\n\n## Active Items"));
	const sortReply = (_n: number, prompt: string): AbsorbGenerateResult => ({ text: prompt.includes("For each note") ? "m-0101: Invoicing rules\nm-0102: invoicing Rules\nm-0103:  Invoicing  rules" : "?" });
	const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "?": sortReply }, []), probe: probeAnswers, now: RUN_CLOCK }).runId);
	const topics = new Set((done.sorted ?? []).map((move) => move.topic));
	assert(topics.size === 1, `one topic, got ${JSON.stringify([...topics])}`);
});

// The discussion a run came from is kept until the run can come back from a
// restart as a card: a restart during the sort finds it still there.
await section("discussion-kept-until-folds", async () => {
	const room = createRoom("Kept Discussion Room", [page("RC-0001", "Healthy", "HEALTHY-POINT")]);
	fs.writeFileSync(room.l1bPath, fs.readFileSync(room.l1bPath, "utf-8").replace("## Active Items", "### Unsorted\n\n<!-- e: id=m-0101 kind=fact saved=2026-09-01 -->\n- Invoices go out on the first working day.\n\n## Active Items"));
	const kept = path.join(room.runtimeDir, "memorize-discussion.json");
	fs.writeFileSync(kept, JSON.stringify({ read: { assessmentMarkdown: ASSESSMENT } }));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let sorting = false;
	const sortReply = async (): Promise<AbsorbGenerateResult> => { sorting = true; await gate; return { text: "m-0101: Billing" }; };
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => answer("HEALTHY-POINT"), "?": sortReply }, []), probe: probeAnswers, now: RUN_CLOCK });
	const deadline = Date.now() + 30_000;
	while (!sorting) { assert(Date.now() < deadline, "the run reached the sort"); await sleep(2); }
	assert(fs.existsSync(kept), "during the sort the discussion is still kept");
	release();
	const done = await settle(room.agentId, started.runId);
	assert(done.state === "ready" && !fs.existsSync(kept), `once the folds begin the discussion goes, got ${done.state} and ${fs.existsSync(kept) ? "a kept discussion" : "none"}`);
});

fs.rmSync(tempHome, { recursive: true, force: true });
console.log("absorb-never-stuck smoke passed");
