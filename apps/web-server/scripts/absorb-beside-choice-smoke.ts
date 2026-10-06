// Keep both or Replace, driven end to end through the REAL run on temp rooms:
// a new note shown beside a pinned note, or one that may disagree with a note,
// can take that note's place at the save, and only as the person chose. Every
// section can run alone (ONLY=<name>).
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AbsorbRun, AbsorbRunGenerate, AbsorbRunProbe } from "../src/absorb-run.js";
import type { AbsorbGenerateResult } from "../src/persistent-agents.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "absorb-beside-choice-home-"));
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
const { approveAbsorbRun, editAbsorbRunEntry, getAbsorbRun, keepAbsorbRunEntries, resetAbsorbRunsForTests, resumeAbsorbRun, setAbsorbFoldRetryPauseForTests, startAbsorbRun } = run;
setAbsorbFoldRetryPauseForTests(0);
run.setAbsorbFoldRateLimitPauseForTests(0);
const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
const { contextRender, readArchive } = await import("../src/memory-entries-store.js");
const { parseMemoryDocument, reviewTargetTokens } = await import("../src/memory-entries.js");
const { undoMemorySave } = await import("../src/memory-undo.js");
const { writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
const { flushMemoryUse, readMemoryUse } = await import("../src/memory-use.js");
const { absorbRunSessionLine, changeBesideTag } = await import("../../web-ui/src/memory-v2-copy.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const RUN_CLOCK = () => new Date("2026-09-13T09:00:00.000Z");
const SAVE_AT = new Date("2026-09-13T09:05:00.000Z");
const ASSESSMENT = "## What these sessions leave behind\n\n- A few durable points.";
const APRIL = "- The Nordwind contract renews in April.";
const JUNE = "- The Nordwind maintenance contract renews automatically on 1 June.";
const LEGAL = "- Send the draft to legal.";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function page(id: string, title: string, day = "2026-09-11"): string {
	return [`### ${id} | OPEN | ${day} | ${title}`, "", `**Session arc:** ${title} was settled.`, "", "**Body:**", `- ${title} is the durable point.`, "", "**Parked:**", "None", ""].join("\n");
}

/** A room whose memory holds a pinned note (m-0001), a fact (m-0003) and an open item (m-0002). */
function createRoom(name: string, pages: string[], extraDeep: string[] = [], juneSaved = "2026-09-01"): { agentId: string; l1bPath: string } {
	const created = createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = created.agent.agentId;
	const l1bPath = path.join(root, agentId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, [
		"<!-- exxeta:l1b schema_version=1 -->", "", "## Chronos", "", `- Persistent agent id: ${agentId}`, "- Lifecycle state: ready", "- Last checkpoint: cp_20260912_0001", "- Last checkpoint at: 2026-09-12T09:00:00.000Z", "- Last consolidation: none", "",
		"## Deep Memory", "", "<!-- entries: next=900 -->", "",
		"### Renewals", "", "<!-- e: id=m-0001 kind=fact saved=2026-09-01 pinned=true -->", APRIL, "",
		"### Maintenance terms", "", `<!-- e: id=m-0003 kind=fact saved=${juneSaved} -->`, JUNE, "",
		...extraDeep,
		"## Active Items", "", "<!-- e: id=m-0002 kind=item saved=2026-09-01 status=open -->", LEGAL, "",
		"## Recent Context", "", pages.join("\n"),
	].join("\n"), { mode: 0o600 });
	return { agentId, l1bPath };
}

const sessionOf = (prompt: string) => /Session being folded: (RC-\d+)/.exec(prompt)?.[1] ?? "?";
const fence = (ops: unknown[]): AbsorbGenerateResult => ({ text: `One durable line.\n\n\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\`\n`, usage: { input: 100, output: 20 } });
function scripted(scripts: Record<string, () => AbsorbGenerateResult>): AbsorbRunGenerate {
	return async (prompt) => {
		const script = scripts[sessionOf(prompt)];
		assert(script, `no script for ${sessionOf(prompt)}`);
		return script();
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
async function started(room: { agentId: string }, scripts: Record<string, () => AbsorbGenerateResult>, probe = probeAnswers): Promise<{ runId: string; run: AbsorbRun }> {
	const { runId } = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted(scripts), probe, now: RUN_CLOCK });
	return { runId, run: await settle(room.agentId, runId) };
}
/** The one added row of a conversation. */
const added = (r: AbsorbRun, id: string) => r.sessions.find((session) => session.id === id)!.changes!.find((change) => change.kind === "added")!;
const choose = (room: { agentId: string }, runId: string, entryId: unknown, choice: unknown) => run.chooseAbsorbRunBeside(room.agentId, runId, entryId, choice);
function refused(action: () => unknown, code: string, label: string): void {
	try {
		action();
	} catch (error) {
		assert((error as { code?: string }).code === code, `${label}: refused with ${(error as { code?: string }).code}, expected ${code}`);
		return;
	}
	throw new Error(`${label}: was not refused`);
}
const ONLY = process.env.ONLY;
async function section(name: string, body: () => Promise<void>): Promise<void> {
	if (ONLY && ONLY !== name) return;
	resetAbsorbRunsForTests();
	await body();
	console.log(`ok ${name}`);
}

// Replace on a pinned note, on a note that may disagree, and on an open item;
// one Replace per note; an edit keeps it; the save, the archive, the record and the undo.
await section("replace", async () => {
	const room = createRoom("Replace Room", [page("RC-0001", "May"), page("RC-0002", "June"), page("RC-0003", "July"), page("RC-0004", "Legal")]);
	const { runId, run: ready } = await started(room, {
		"RC-0001": () => fence([{ op: "update", id: "m-0001", text: "- The Nordwind contract renews in May." }]),
		"RC-0002": () => fence([{ op: "update", id: "m-0001", text: "- The Nordwind contract renews in June." }]),
		"RC-0003": () => fence([{ op: "add", topic: "Maintenance terms", kind: "fact", text: "- The Nordwind maintenance contract renews automatically on 1 July." }]),
		"RC-0004": () => fence([{ op: "add", topic: "Active Items", kind: "item", text: "- Never send the draft to legal." }]),
	});
	const [a1, a2, b, c] = [added(ready, "RC-0001"), added(ready, "RC-0002"), added(ready, "RC-0003"), added(ready, "RC-0004")];
	assert(a1.beside === "pinned" && a1.besideOf === "m-0001" && a1.besideLine === APRIL && a2.besideOf === "m-0001" && b.beside === "may-disagree" && b.besideOf === "m-0003" && c.besideOf === "m-0002" && !a1.choice, `each tagged row names its note and starts at Keep both, got ${JSON.stringify([a1, a2, b, c])}`);
	refused(() => choose(room, runId, "m-0001", "replace"), "absorb_run_bad_choice", "a row that is not a tagged add");
	refused(() => choose(room, runId, a1.id, "merge"), "absorb_run_bad_choice", "a choice that is neither");
	const first = choose(room, runId, a1.id, "replace");
	assert(added(first, "RC-0001").choice === "replace" && added(first, "RC-0001").choiceText === APRIL, "Replace is held on the row with the note's text as the person saw it");
	const moved = choose(room, runId, a2.id, "replace");
	assert(!added(moved, "RC-0001").choice && added(moved, "RC-0002").choice === "replace", "one Replace per note: choosing it on a second row takes it from the first");
	const edited = editAbsorbRunEntry(room.agentId, runId, a2.id, "The Nordwind contract renews in July, signed by legal.");
	assert(added(edited, "RC-0002").choice === "replace", "an edit of the row keeps its choice");
	choose(room, runId, b.id, "replace");
	choose(room, runId, c.id, "replace");
	const saved = approveAbsorbRun(room.agentId, runId, SAVE_AT);
	const before = fs.readFileSync(saved.archivedL1bPath, "utf-8");
	const written = fs.readFileSync(room.l1bPath, "utf-8");
	const doc = parseMemoryDocument(written);
	const entry = (id: string) => doc.topics.flatMap((topic) => topic.entries.map((e) => ({ ...e, topic: topic.title }))).find((e) => e.id === id);
	assert(entry("m-0001")?.text === "- The Nordwind contract renews in July, signed by legal." && entry("m-0001")?.pinned === true && entry("m-0001")?.topic === "Renewals", `the pinned note takes the person's words and stays pinned, got ${JSON.stringify(entry("m-0001"))}`);
	assert(!entry(a2.id) && entry(a1.id)?.text === "- The Nordwind contract renews in May.", "the replacing note goes; the row left at Keep both stays beside");
	assert(entry("m-0003")?.text === "- The Nordwind maintenance contract renews automatically on 1 July." && !entry(b.id) && entry("m-0003")?.pinned === false, `the older note takes the new text and keeps its id, got ${JSON.stringify(entry("m-0003"))}`);
	assert(entry("m-0003")?.refs === 1 && entry("m-0003")?.updated === "2026-09-13", `a replaced note is touched like a fold's rewrite, so the ranker reads it as used, got ${JSON.stringify(entry("m-0003"))}`);
	assert(entry("m-0002")?.text === "- Never send the draft to legal." && entry("m-0002")?.kind === "item" && entry("m-0002")?.status === "open" && !entry(c.id), `an open item stays an open item, got ${JSON.stringify(entry("m-0002"))}`);
	const archive = readArchive(room.agentId);
	const version = (id: string, text: string) => archive.find((row) => row.id === id && row.text === text && row.why === "superseded");
	assert(version("m-0001-v1", APRIL) && version("m-0003-v1", JUNE) && version("m-0002-v1", LEGAL), `each old text is archived as a superseded version, got ${JSON.stringify(archive.map((row) => [row.id, row.why, row.text]))}`);
	assert(saved.replacedEntries === 3 && saved.archivedEntries >= saved.replacedEntries, `the saved screen counts the three replaced notes apart, got ${JSON.stringify([saved.replacedEntries, saved.archivedEntries])}`);
	const record = JSON.parse(fs.readFileSync(saved.eventRecordPath, "utf-8"));
	const choices = record.run?.besideChoices ?? [];
	assert(choices.length === 3 && choices.every((choice: { applied: boolean }) => choice.applied) && choices.some((choice: { id: string; other: string }) => choice.id === a2.id && choice.other === "m-0001"), `the save record names each Replace, got ${JSON.stringify(choices)}`);
	assert(["m-0001-v1", "m-0003-v1", "m-0002-v1"].every((id) => record.run.archived.some((row: { id: string }) => row.id === id)), "the archived versions are in the save record, so an undo takes them back");
	undoMemorySave(room.agentId, saved.saveId, new Date("2026-09-13T09:10:00.000Z"));
	assert(fs.readFileSync(room.l1bPath, "utf-8") === before, "an undo brings every replaced note back byte for byte");
	assert(!readArchive(room.agentId).some((row) => /^m-000[123]-v1$/.test(row.id)), "and takes the archived versions back out");
});

// A Replace stands only while what the person chose holds.
await section("replace-guards", async () => {
	// The other note gone: a later conversation closed the item.
	const gone = createRoom("Gone Room", [page("RC-0001", "Legal"), page("RC-0002", "Closed")]);
	const g = await started(gone, {
		"RC-0001": () => fence([{ op: "add", topic: "Active Items", kind: "item", text: "- Never send the draft to legal." }]),
		"RC-0002": () => fence([{ op: "close", id: "m-0002" }]),
	});
	const orphan = added(g.run, "RC-0001");
	assert(orphan.besideOf === "m-0002" && orphan.besideState === "closed" && orphan.besideLine === LEGAL, `a row whose note this update closes says so and names it, got ${JSON.stringify(orphan)}`);
	const orphanLine = changeBesideTag(orphan);
	assert(orphanLine?.replaceLabel === null && /^May disagree with: "Send the draft to legal\."(?: \([^)]*\)\.)? That note is closed by this update\.$/.test(orphanLine.line), `the card's line names the closed note, got ${JSON.stringify(orphanLine)}`);
	refused(() => choose(gone, g.runId, orphan.id, "replace"), "absorb_run_bad_choice", "a Replace of a note this update closes");


	// The other note edited on the card: a Replace chosen before goes back to Keep both.
	const edit = createRoom("Edit Room", [page("RC-0001", "Hours"), page("RC-0002", "Hours again")]);
	const e = await started(edit, {
		"RC-0001": () => fence([{ op: "add", topic: "Support", kind: "fact", text: "- The Nordwind support desk answers within 4 hours on weekdays." }]),
		"RC-0002": () => fence([{ op: "add", topic: "Support", kind: "fact", text: "- The Nordwind support desk answers within 8 hours on weekdays." }]),
	});
	const [x, y] = [added(e.run, "RC-0001"), added(e.run, "RC-0002")];
	assert(y.besideOf === x.id && y.beside === "may-disagree", `a note of this run can be the other note, got ${JSON.stringify(y)}`);
	assert(added(choose(edit, e.runId, y.id, "replace"), "RC-0002").choice === "replace", "Replace is chosen");
	assert(!added(editAbsorbRunEntry(edit.agentId, e.runId, x.id, "The Nordwind support desk answers within 2 hours."), "RC-0002").choice, "an edit of the other note takes the Replace back to Keep both");
	assert(added(choose(edit, e.runId, y.id, "keep-both"), "RC-0002").choice === undefined, "Keep both can be chosen outright");

	// The other note going to the archive: no Replace while it leaves; keeping it brings Replace back; letting it go again resets it.
	const base = createRoom("Leaving Room", [page("RC-0001", "July")], [], "2025-01-01");
	writePersistentRoomMaintenanceSettings(base.agentId, { memoryBudgetTokens: 10_000 });
	const text = fs.readFileSync(base.l1bPath, "utf-8");
	const filler: string[] = [];
	const withFiller = () => text.replace("## Active Items", ["### Filler", "", ...filler, "## Active Items"].join("\n"));
	for (let n = 100; reviewTargetTokens(parseMemoryDocument(withFiller())) < 9_960; n++) filler.push(`<!-- e: id=m-0${n} kind=fact saved=2026-03-${String(1 + (n % 28)).padStart(2, "0")} -->`, `- Filler note ${n}: ${"a detail somebody touched this spring ".repeat(3).trim()}.`, "");
	fs.writeFileSync(base.l1bPath, withFiller(), { mode: 0o600 });
	const l = await started(base, { "RC-0001": () => fence([{ op: "add", topic: "Maintenance terms", kind: "fact", text: "- The Nordwind maintenance contract renews automatically on 1 July." }, { op: "add", topic: "Handover", kind: "fact", text: `- The handover checklist: ${"each step the parties agreed and signed ".repeat(6).trim()}.` }]) });
	const leavingRow = added(l.run, "RC-0001");
	const leavingIds = l.run.demotion.entries.filter((row) => row.leaving).map((row) => row.id);
	assert(leavingIds.includes("m-0003") && leavingRow.besideOf === "m-0003" && leavingRow.besideState === "leaving", `the other note is going to the archive and the row says so, got ${JSON.stringify({ leavingIds, leavingRow })}`);
	refused(() => choose(base, l.runId, leavingRow.id, "replace"), "absorb_run_bad_choice", "a Replace of a note going to the archive");
	keepAbsorbRunEntries(base.agentId, l.runId, { keepIds: ["m-0003"] });
	assert(added(choose(base, l.runId, leavingRow.id, "replace"), "RC-0001").choice === "replace", "a kept note can be replaced");
	const letGo = keepAbsorbRunEntries(base.agentId, l.runId, { keepIds: [] });
	assert(!added(letGo, "RC-0001").choice && added(letGo, "RC-0001").besideState === "leaving", "letting it go again takes the Replace back to Keep both");
});

// The other note changed earlier in the run, the must-keep marker, and a topic left empty.
await section("replace-marker-topic", async () => {
	const room = createRoom("Marker Room", [page("RC-0001", "July"), page("RC-0002", "August")]);
	const { runId, run: ready } = await started(room, {
		"RC-0001": () => fence([{ op: "update", id: "m-0003", text: "- The Nordwind maintenance contract renews automatically on 1 July." }]),
		"RC-0002": () => fence([{ op: "add", topic: "Maintenance windows", kind: "fact", text: "- **must-keep** The Nordwind maintenance contract renews automatically on 1 August." }]),
	});
	const row = added(ready, "RC-0002");
	const pinnedRow = ready.sessions.find((session) => session.id === "RC-0002")!.changes!.find((change) => change.kind === "pinned");
	assert(row.besideOf === "m-0003" && row.besideLine === "- The Nordwind maintenance contract renews automatically on 1 July." && row.newTopic && pinnedRow?.id === row.id, `the add opened a topic, was pinned by its marker, and names the note as it stands now, got ${JSON.stringify(ready.sessions.map((s) => s.changes))}`);
	choose(room, runId, row.id, "replace");
	approveAbsorbRun(room.agentId, runId, SAVE_AT);
	const written = fs.readFileSync(room.l1bPath, "utf-8");
	const doc = parseMemoryDocument(written);
	const target = doc.topics.flatMap((topic) => topic.entries).find((e) => e.id === "m-0003");
	assert(target?.text === "- The Nordwind maintenance contract renews automatically on 1 August." && target.pinned === true, `the must-keep marker pins the note it replaced, without the marker, got ${JSON.stringify(target)}`);
	assert(!/^### Maintenance windows$/m.test(written), "a topic the replacing note opened and left empty is gone");
	const archive = readArchive(room.agentId).filter((entry) => entry.id.startsWith("m-0003-v"));
	assert(archive.length === 2 && archive.some((entry) => entry.text === JUNE) && archive.some((entry) => entry.text.includes("1 July")) && new Set(archive.map((entry) => entry.id)).size === 2, `the fold's before and the person's before are both archived, under their own ids, got ${JSON.stringify(archive.map((entry) => [entry.id, entry.text]))}`);
	const after = getAbsorbRun(room.agentId, runId);
	const rows = after.sessions.find((session) => session.id === "RC-0002")!.changes!;
	assert(rows.find((change) => change.kind === "pinned")?.id === "m-0003" && !rows.find((change) => change.kind === "added")?.newTopic, `the rows tell where the words went, got ${JSON.stringify(rows)}`);
});

// A must-keep note that replaces a note pinned already says nothing new about pins.
await section("replace-pinned-marker", async () => {
	const room = createRoom("Pinned Marker Room", [page("RC-0001", "May")]);
	const { runId, run: ready } = await started(room, { "RC-0001": () => fence([{ op: "update", id: "m-0001", text: "- **must-keep** The Nordwind contract renews in May." }]) });
	const row = added(ready, "RC-0001");
	assert(row.beside === "pinned" && ready.sessions[0].changes!.some((change) => change.kind === "pinned" && change.id === row.id), `the add beside the pinned note was pinned by its marker, got ${JSON.stringify(ready.sessions[0].changes)}`);
	choose(room, runId, row.id, "replace");
	approveAbsorbRun(room.agentId, runId, SAVE_AT);
	const target = parseMemoryDocument(fs.readFileSync(room.l1bPath, "utf-8")).topics.flatMap((topic) => topic.entries).find((e) => e.id === "m-0001");
	assert(target?.text === "- The Nordwind contract renews in May." && target.pinned, `the pinned note takes the words without the marker, got ${JSON.stringify(target)}`);
	assert(!getAbsorbRun(room.agentId, runId).sessions[0].changes!.some((change) => change.kind === "pinned"), "no row says this update pinned a note that was pinned already");
});

// The new note itself closed by a later conversation: no Replace, and one chosen before goes back to Keep both.
await section("replace-closed-add", async () => {
	const self = createRoom("Self Closed Room", [page("RC-0001", "Legal"), page("RC-0002", "Done")]);
	let down = true;
	const s = startAbsorbRun({ agentId: self.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({
		"RC-0001": () => fence([{ op: "add", topic: "Active Items", kind: "item", text: "- Never send the draft to legal." }]),
		"RC-0002": () => {
			if (down) throw new Error("fetch failed: ECONNREFUSED");
			return fence([{ op: "close", id: "m-0900" }]);
		},
	}), probe: async (...args) => (down ? probeFails(...args) : probeAnswers(...args)), now: RUN_CLOCK });
	const selfStopped = await settle(self.agentId, s.runId);
	assert(added(choose(self, s.runId, "m-0900", "replace"), "RC-0001").choice === "replace", `Replace is chosen while the new note is open, got ${JSON.stringify(selfStopped.stop)}`);
	down = false;
	resumeAbsorbRun(self.agentId, s.runId, MODEL);
	const closedLater = added(await settle(self.agentId, s.runId), "RC-0001");
	assert(closedLater.besideOf === "m-0002" && closedLater.besideState === "self-closed" && closedLater.besideLine === LEGAL && !closedLater.choice, `a new note closed later names its other note, says it was closed, and its Replace goes back to Keep both, got ${JSON.stringify(closedLater)}`);
	refused(() => choose(self, s.runId, closedLater.id, "replace"), "absorb_run_bad_choice", "a Replace by a new note this update closes");
});

// Two Replaces in a chain: the newest note replaces the new note that replaces the note in memory.
await section("replace-chain", async () => {
	const FOUR = "- The Nordwind support desk answers within 4 hours on weekdays.";
	const EIGHT = "- The Nordwind support desk answers within 8 hours on weekdays.";
	const TWELVE = "- The Nordwind support desk answers within 12 hours on weekdays.";
	const room = createRoom("Chain Room", [page("RC-0001", "Eight"), page("RC-0002", "Twelve")], ["### Support", "", "<!-- e: id=m-0004 kind=fact saved=2026-09-01 -->", FOUR, ""]);
	const { runId, run: ready } = await started(room, {
		"RC-0001": () => fence([{ op: "add", topic: "Support", kind: "fact", text: EIGHT }]),
		"RC-0002": () => fence([{ op: "add", id: "m-0900", topic: "Support", kind: "fact", text: TWELVE }]),
	});
	const [b, a] = [added(ready, "RC-0001"), added(ready, "RC-0002")];
	assert(b.besideOf === "m-0004" && a.besideOf === b.id, `each row names the note before it, got ${JSON.stringify([b, a])}`);
	choose(room, runId, b.id, "replace");
	choose(room, runId, a.id, "replace");
	const saved = approveAbsorbRun(room.agentId, runId, SAVE_AT);
	const support = parseMemoryDocument(fs.readFileSync(room.l1bPath, "utf-8")).topics.find((topic) => topic.title === "Support")!.entries;
	assert(support.length === 1 && support[0].id === "m-0004" && support[0].text === TWELVE, `the note in memory ends with the newest words, alone, got ${JSON.stringify(support)}`);
	const archive = readArchive(room.agentId);
	assert(archive.some((row) => row.id === "m-0004-v1" && row.text === FOUR) && archive.some((row) => row.id === `${b.id}-v1` && row.text === EIGHT), `both older texts are archived, got ${JSON.stringify(archive.map((row) => [row.id, row.text]))}`);
	const choices = JSON.parse(fs.readFileSync(saved.eventRecordPath, "utf-8")).run.besideChoices;
	assert(choices.length === 2 && choices.every((choice: { applied: boolean }) => choice.applied), `both Replaces are applied, got ${JSON.stringify(choices)}`);
	const after = getAbsorbRun(room.agentId, runId).budget.after;
	assert(after === saved.memoryBudget.reviewTargetEstimatedTokens, `the saved run counts the memory as written, without the notes the Replaces took out, got ${after} against ${saved.memoryBudget.reviewTargetEstimatedTokens}`);
});

// The day each text was learned: the fold's own writes, the card's edit, and a Replace.
await section("learned", async () => {
	const room = createRoom("Learned Room", [page("RC-0001", "July"), page("RC-0002", "Rename")]);
	const dated = fs.readFileSync(room.l1bPath, "utf-8")
		.replace("<!-- e: id=m-0001 kind=fact saved=2026-09-01 pinned=true -->", "<!-- e: id=m-0001 kind=fact saved=2026-09-01 pinned=true learned=2026-09-20 -->")
		.replace("<!-- e: id=m-0003 kind=fact saved=2026-09-01 -->", "<!-- e: id=m-0003 kind=fact saved=2026-09-01 learned=2026-06-01 -->");
	fs.writeFileSync(room.l1bPath, dated, { mode: 0o600 });
	const { runId, run: ready } = await started(room, {
		"RC-0001": () => fence([{ op: "update", id: "m-0003", text: "- The Nordwind maintenance contract renews automatically on 1 July." }, { op: "add", topic: "Handover", kind: "fact", text: "- The handover checklist lives with legal." }]),
		"RC-0002": () => fence([{ op: "update", id: "m-0001", text: "- The Nordwind contract renews in April, every year." }]),
	});
	const handover = ready.sessions[0].changes!.find((change) => change.kind === "added")!;
	editAbsorbRunEntry(room.agentId, runId, handover.id, "The handover checklist lives with legal and finance.");
	const pinnedRow = added(ready, "RC-0002");
	assert(pinnedRow.beside === "pinned" && pinnedRow.besideOf === "m-0001", `a rewording of the pinned note is added beside it, got ${JSON.stringify(pinnedRow)}`);
	choose(room, runId, pinnedRow.id, "replace");
	approveAbsorbRun(room.agentId, runId, SAVE_AT);
	const entries = parseMemoryDocument(fs.readFileSync(room.l1bPath, "utf-8")).topics.flatMap((topic) => topic.entries);
	const entry = (id: string) => entries.find((e) => e.id === id);
	assert(entry("m-0003")?.learned === "2026-09-11" && entry(handover.id)?.learned === "2026-09-11", `a fold's update and add are learned on the page's day, and the card's edit keeps it, got ${JSON.stringify([entry("m-0003"), entry(handover.id)])}`);
	assert(entry("m-0001")?.text === "- The Nordwind contract renews in April, every year." && entry("m-0001")?.learned === "2026-09-20", `a Replace keeps the newer of the two days: the person chose the words, the date never goes back, got ${JSON.stringify(entry("m-0001"))}`);
	const archive = readArchive(room.agentId);
	const row = (id: string) => archive.find((r) => r.id === id);
	assert(row("m-0003-v1")?.learned === "2026-06-01" && row("m-0003-v1")?.until === "2026-09-11", `a rewritten text keeps its own day and says until when it held, got ${JSON.stringify(row("m-0003-v1"))}`);
	assert(row("m-0001-v1")?.learned === "2026-09-20" && row("m-0001-v1")?.until === "2026-09-20", `a replaced pinned text keeps its day, and holds until the day the note now carries, got ${JSON.stringify(row("m-0001-v1"))}`);
});

// Dates decide an older page, folded after a newer one: its text that disagrees
// with a note learned after it goes to the archive as history, the note is
// untouched, and an undo takes the history back out.
await section("older-page", async () => {
	const room = createRoom("Older Page Room", [page("RC-0001", "July", "2026-09-11"), page("RC-0002", "August", "2026-06-10")]);
	const JULY = "- The Nordwind maintenance contract renews automatically on 1 July.";
	const AUGUST = "- The Nordwind maintenance contract renews automatically on 1 August.";
	const MAY = "- The Nordwind maintenance contract renews automatically on 1 May.";
	const { runId, run: ready } = await started(room, {
		"RC-0001": () => fence([{ op: "update", id: "m-0003", text: JULY }]),
		"RC-0002": () => fence([{ op: "supersede", id: "m-0003", text: AUGUST }, { op: "add", topic: "Maintenance terms", kind: "fact", text: MAY }]),
	});
	assert(ready.sessions.every((session) => session.outcome === "folded"), `both pages fold, got ${JSON.stringify(ready.sessions.map((session) => session.outcome))}`);
	assert(!ready.sessions[1].changes?.some((change) => change.kind === "added" || change.kind === "superseded"), `the older page neither rewrites the note nor adds beside it, got ${JSON.stringify(ready.sessions[1].changes)}`);
	const olderRows = ready.sessions[1].changes ?? [];
	assert(olderRows.length === 2 && olderRows.every((change) => change.kind === "history" && change.topic === "Maintenance terms" && !change.beside) && olderRows.map((change) => change.after).sort().join("|") === [AUGUST, MAY].sort().join("|"), `the card lists each older value as an Older row, untagged, got ${JSON.stringify(olderRows)}`);
	assert(olderRows.every((change) => change.of === "m-0003" && change.ofLine === JULY), `each Older row names the note it yielded to, as memory holds it now, got ${JSON.stringify(olderRows)}`);
	assert(absorbRunSessionLine(ready.sessions[1]) === "Memorized · 2 older values kept as history", `the card's line for a page whose text was all older says so, got ${absorbRunSessionLine(ready.sessions[1])}`);
	const saved = approveAbsorbRun(room.agentId, runId, SAVE_AT);
	assert(saved.archivedEntries === 1 && saved.replacedEntries === 1 && saved.historyKept === 2, `the saved screen counts the rewritten text apart from the older values kept as history, got ${saved.archivedEntries} and ${saved.historyKept}`);
	const note = parseMemoryDocument(fs.readFileSync(room.l1bPath, "utf-8")).topics.flatMap((topic) => topic.entries).find((e) => e.id === "m-0003");
	assert(note?.text === JULY && note.learned === "2026-09-11", `the note keeps the newer page's value and day, got ${JSON.stringify(note)}`);
	const history = readArchive(room.agentId).filter((row) => row.why === "history");
	assert(history.length === 2 && history.every((row) => /^m-\d{4}$/.test(row.id) && row.learned === "2026-06-10" && row.until === "2026-09-11" && row.from === "RC-0002" && row.topic === "Maintenance terms"), `each older value is a history row of its own id, learned on its page's day, until the note's day, got ${JSON.stringify(history)}`);
	assert(history.map((row) => row.text).sort().join("|") === [AUGUST, MAY].sort().join("|"), `the history rows hold the older page's words, got ${JSON.stringify(history.map((row) => row.text))}`);
	assert(history.map((row) => row.id).sort().join() === olderRows.map((change) => change.id).sort().join(), "each Older row names its archive row");
	undoMemorySave(room.agentId, saved.saveId, new Date("2026-09-13T09:10:00.000Z"));
	assert(!readArchive(room.agentId).some((row) => row.why === "history"), "an undo takes the history rows back out");
});

// A new note that may disagree with an older one shows the day each was learned on the card.
await section("card-dates", async () => {
	const room = createRoom("Card Dates Room", [page("RC-0001", "July", "2026-09-11")]);
	fs.writeFileSync(room.l1bPath, fs.readFileSync(room.l1bPath, "utf-8").replace("<!-- e: id=m-0003 kind=fact saved=2026-09-01 -->", "<!-- e: id=m-0003 kind=fact saved=2026-09-01 learned=2026-08-02 -->"), { mode: 0o600 });
	const { run: ready } = await started(room, { "RC-0001": () => fence([{ op: "add", topic: "Maintenance terms", kind: "fact", text: "- The Nordwind maintenance contract renews automatically on 1 July." }]) });
	const row = added(ready, "RC-0001");
	assert(row.beside === "may-disagree" && row.besideOf === "m-0003" && row.besideLearned === "2026-08-02" && row.learned === "2026-09-11", `the tagged row carries both days, got ${JSON.stringify(row)}`);
	assert(changeBesideTag(row)?.line === `May disagree with: "${JUNE.slice(2)}" (as of 2 Aug; new note as of 11 Sep)`, `the card's line names both days, got ${JSON.stringify(changeBesideTag(row)?.line)}`);
	const { run: pinnedReady } = await started(createRoom("Card Dates Pinned Room", [page("RC-0001", "April", "2026-09-11")]), { "RC-0001": () => fence([{ op: "update", id: "m-0001", text: "- The Nordwind contract renews in April, with 60 days notice." }]) });
	const pinnedRow = added(pinnedReady, "RC-0001");
	assert(pinnedRow.beside === "pinned" && changeBesideTag(pinnedRow)?.line === `May disagree with your pinned note: "${APRIL.slice(2)}" (new note as of 11 Sep)`, `beside a pinned note, the line names the days it knows, got ${JSON.stringify(changeBesideTag(pinnedRow)?.line)}`);
});

// A pair the person kept though the two may disagree: marked on both notes at
// the save, shown with the day each was learned in the room's own read and
// never in the fold's prompt, and kept through a rewrite that still disagrees.
await section("pair-mark", async () => {
	const room = createRoom("Pair Mark Room", [page("RC-0001", "July", "2026-09-11"), page("RC-0002", "Legal", "2026-09-11")]);
	fs.writeFileSync(room.l1bPath, fs.readFileSync(room.l1bPath, "utf-8").replace("<!-- e: id=m-0003 kind=fact saved=2026-09-01 -->", "<!-- e: id=m-0003 kind=fact saved=2026-09-01 learned=2026-08-02 -->"), { mode: 0o600 });
	const JULY = "- The Nordwind maintenance contract renews automatically on 1 July.";
	const { runId, run: ready } = await started(room, {
		"RC-0001": () => fence([{ op: "add", topic: "Maintenance terms", kind: "fact", text: JULY }]),
		"RC-0002": () => fence([{ op: "add", topic: "Active Items", kind: "item", text: "- Never send the draft to legal." }]),
	});
	const july = added(ready, "RC-0001");
	const legal = added(ready, "RC-0002");
	assert(july.beside === "may-disagree" && legal.beside === "may-disagree" && legal.besideOf === "m-0002", `both new notes may disagree, got ${JSON.stringify([july, legal])}`);
	choose(room, runId, legal.id, "replace");
	approveAbsorbRun(room.agentId, runId, SAVE_AT);
	const entries = () => parseMemoryDocument(fs.readFileSync(room.l1bPath, "utf-8")).topics.flatMap((topic) => topic.entries);
	const entry = (id: string) => entries().find((e) => e.id === id);
	assert(entry("m-0003")?.disagrees === july.id && entry(july.id)?.disagrees === "m-0003", `a kept pair names each other on both notes, got ${JSON.stringify([entry("m-0003"), entry(july.id)])}`);
	assert(entry("m-0002")?.disagrees === undefined && !entries().some((e) => e.disagrees?.includes(legal.id)), "a Replace leaves one note, and no mark");
	const read = contextRender(room.agentId);
	assert(read.includes(`${JUNE} (learned 2026-08-02)`) && read.includes(`${JULY} (learned 2026-09-11)`), `the room's own read gives each note of the pair the day it was learned: ${read}`);
	// The next fold reads the day in each address, once, and no hint.
	fs.writeFileSync(room.l1bPath, `${fs.readFileSync(room.l1bPath, "utf-8").replace(/\s+$/, "")}\n\n${page("RC-0003", "September", "2026-09-20")}`, { mode: 0o600 });
	const prompts: string[] = [];
	const { runId: next } = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: async (prompt) => {
		prompts.push(prompt);
		return fence([{ op: "update", id: "m-0003", text: "- The Nordwind maintenance contract renews automatically on 1 September." }]);
	}, probe: probeAnswers, now: RUN_CLOCK });
	await settle(room.agentId, next);
	const fold = prompts.find((prompt) => sessionOf(prompt) === "RC-0003") ?? "";
	const lineOf = (id: string) => fold.split("\n").find((line) => line.includes(`[${id} ·`)) ?? "";
	assert(lineOf("m-0003") === `- [m-0003 · learned 2026-08-02] ${JUNE.slice(2)}` && lineOf(july.id) === `- [${july.id} · learned 2026-09-11] ${JULY.slice(2)}` && !fold.includes("(learned"), `the fold's prompt carries each day once, in the address, and no hint: ${JSON.stringify([lineOf("m-0003"), lineOf(july.id)])}`);
	approveAbsorbRun(room.agentId, next, SAVE_AT);
	const after = contextRender(room.agentId);
	assert(entry("m-0003")?.disagrees === july.id && after.includes("1 September. (learned 2026-09-20)") && after.includes(`${JULY} (learned 2026-09-11)`), `a rewrite that still disagrees with its pair keeps the mark, and the room's read shows both days: ${after}`);
});

// A new note kept beside a pinned note it disagrees with is marked like any
// kept pair; one that only adds to the pinned note is not.
await section("pair-mark-pinned", async () => {
	const saved = async (name: string, text: string) => {
		const room = createRoom(name, [page("RC-0001", "April", "2026-09-11")]);
		fs.writeFileSync(room.l1bPath, fs.readFileSync(room.l1bPath, "utf-8").replace("<!-- e: id=m-0001 kind=fact saved=2026-09-01 pinned=true -->", "<!-- e: id=m-0001 kind=fact saved=2026-09-01 pinned=true learned=2026-08-02 -->"), { mode: 0o600 });
		const { runId, run: ready } = await started(room, { "RC-0001": () => fence([{ op: "update", id: "m-0001", text }]) });
		const row = added(ready, "RC-0001");
		assert(row.beside === "pinned" && row.besideOf === "m-0001", `the text lands beside the pinned note, got ${JSON.stringify(row)}`);
		approveAbsorbRun(room.agentId, runId, SAVE_AT);
		const entries = parseMemoryDocument(fs.readFileSync(room.l1bPath, "utf-8")).topics.flatMap((topic) => topic.entries);
		return { row, pinned: entries.find((e) => e.id === "m-0001"), read: contextRender(room.agentId) };
	};
	const may = await saved("Pair Mark Pinned Room", "- The Nordwind contract renews in May.");
	assert(may.pinned?.disagrees === may.row.id && may.read.includes(`${APRIL} (learned 2026-08-02)`) && may.read.includes("renews in May. (learned 2026-09-11)"), `a kept note that disagrees with the pinned note is marked on both, and the room's read shows both days: ${JSON.stringify(may.pinned)} ${may.read}`);
	const adds = await saved("Pair Mark Pinned Adds Room", "- The Nordwind contract renews in April; the renewal letter goes to procurement.");
	assert(adds.pinned?.disagrees === undefined && !adds.read.includes("(learned"), `a kept note that only adds to the pinned note is not marked: ${JSON.stringify(adds.pinned)}`);
});

// A resume holds the note the person chose to replace, like a kept note.
await section("replace-resume", async () => {
	const room = createRoom("Resume Room", [page("RC-0001", "July"), page("RC-0002", "September")]);
	let down = true;
	const scripts = {
		"RC-0001": () => fence([{ op: "add", topic: "Maintenance terms", kind: "fact", text: "- The Nordwind maintenance contract renews automatically on 1 July." }]),
		"RC-0002": () => {
			if (down) throw new Error("fetch failed: ECONNREFUSED");
			return fence([{ op: "update", id: "m-0003", text: "- The Nordwind maintenance contract renews automatically on 1 September." }]);
		},
	};
	const { runId: id } = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted(scripts), probe: async (...args) => (down ? probeFails(...args) : probeAnswers(...args)), now: RUN_CLOCK });
	const stopped = await settle(room.agentId, id);
	assert(stopped.stop?.kind === "outage", `the run stops for the outage, got ${JSON.stringify(stopped.stop)}`);
	const row = added(stopped, "RC-0001");
	assert(added(choose(room, id, row.id, "replace"), "RC-0001").choice === "replace", "a stopped run takes a choice");
	down = false;
	resumeAbsorbRun(room.agentId, id, MODEL);
	const resumed = await settle(room.agentId, id);
	const redirected = added(resumed, "RC-0002");
	assert(redirected.besideOf === "m-0003" && redirected.beside === "may-disagree" && added(resumed, "RC-0001").choice === "replace", `the resumed update of the held note is added beside it, tagged, and the Replace stands, got ${JSON.stringify([redirected, added(resumed, "RC-0001")])}`);
	approveAbsorbRun(room.agentId, id, SAVE_AT);
	const target = parseMemoryDocument(fs.readFileSync(room.l1bPath, "utf-8")).topics.flatMap((topic) => topic.entries).find((e) => e.id === "m-0003");
	assert(target?.text === "- The Nordwind maintenance contract renews automatically on 1 July." && target.pinned === false, `the note takes the words the person chose, and a hold for the folds is no pin, got ${JSON.stringify(target)}`);
});

// A keep is not a pin: a new note the person kept, then put in another note's
// place, leaves that note unpinned; the keep's use goes to the note that holds
// the kept words now.
await section("kept-add-replace", async () => {
	const room = createRoom("Kept Add Room", [page("RC-0001", "July")]);
	writePersistentRoomMaintenanceSettings(room.agentId, { memoryBudgetTokens: 10_000 });
	const text = fs.readFileSync(room.l1bPath, "utf-8");
	const filler: string[] = [];
	const withFiller = () => text.replace("## Active Items", ["### Filler", "", ...filler, "## Active Items"].join("\n"));
	for (let n = 100; reviewTargetTokens(parseMemoryDocument(withFiller())) < 9_996; n++) filler.push(`<!-- e: id=m-0${n} kind=fact saved=2026-03-${String(1 + (n % 28)).padStart(2, "0")} -->`, `- Filler note ${n}: ${"a detail somebody touched this spring ".repeat(3).trim()}.`, "");
	fs.writeFileSync(room.l1bPath, withFiller(), { mode: 0o600 });
	const { runId, run: ready } = await started(room, { "RC-0001": () => fence([{ op: "add", topic: "Support", kind: "fact", text: "- The Nordwind maintenance contract renews automatically on 1 July." }]) });
	const a = added(ready, "RC-0001");
	// With the other topics protected, the new note is what leaves for the budget.
	const topicsKept = keepAbsorbRunEntries(room.agentId, runId, { keepTopics: ["Deep Memory/Filler", "Deep Memory/Maintenance terms"] });
	assert(a.besideOf === "m-0003" && topicsKept.demotion.entries.some((row) => row.id === a.id && row.leaving), `the new note may disagree with m-0003 and leaves for the budget, got ${JSON.stringify({ besideOf: a.besideOf, leaving: topicsKept.demotion.entries.filter((row) => row.leaving).map((row) => row.id) })}`);
	keepAbsorbRunEntries(room.agentId, runId, { keepIds: [a.id], keepTopics: ["Deep Memory/Filler", "Deep Memory/Maintenance terms"] });
	assert(added(choose(room, runId, a.id, "replace"), "RC-0001").choice === "replace", "the kept note can take m-0003's place");
	approveAbsorbRun(room.agentId, runId, SAVE_AT);
	const saved = parseMemoryDocument(fs.readFileSync(room.l1bPath, "utf-8")).topics.flatMap((topic) => topic.entries);
	const target = saved.find((e) => e.id === "m-0003");
	assert(target?.text === "- The Nordwind maintenance contract renews automatically on 1 July." && target.pinned === false, `the note takes the kept words and is not pinned: the person kept a note, never pinned one, got ${JSON.stringify(target)}`);
	flushMemoryUse(room.agentId);
	const use = readMemoryUse(room.agentId).notes;
	assert(use["m-0003"]?.hits === 1 && !use[a.id], `the keep's use goes to the note that holds the kept words, got ${JSON.stringify(use)}`);
});

fs.rmSync(tempHome, { recursive: true, force: true });
console.log("absorb-beside-choice smoke passed");
