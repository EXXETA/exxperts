// The use sidecar: how often a room's memory rows come back from a recall,
// counted OUTSIDE the memory file, on a real room in a temp HOME.
//
// What it pins, in the order the code has to get right:
//  1. a room that has never recalled anything has no sidecar and reads as no use;
//  2. two recalls in quick succession write ONCE, after the coalescing window,
//     and a row both returned counts twice while a row one returned counts once;
//  3. a row the size cut left out of the answer is not a row the room used, and
//     neither is one past the result cap;
//  4. a conversation row is never counted, whichever way it is offered;
//  5. an unknown room, a file of garbage and a file of another schema all read
//     as no use, and none of them throws;
//  6. the sidecar is bounded: past the cap the least recently used ids go first;
//  7. an undo of the memory file leaves the sidecar and the archive rows it
//     names untouched — use is use;
//  8. the write is atomic and private: mode 0600, no temp file left behind;
//  9. a counter that cannot be written costs nothing: the recall still answers.
//
// Offline: no model, no network, no port.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "memory-use-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
writePersistentAgentAiProfileState("openai-compatible");
const { appendArchive, readArchive, restoreMemoryFile } = await import("../src/memory-entries-store.js");
const { invalidateRoomCorpus } = await import("../src/memory-search-sources.js");
const { createPersistentRoomMemoryRecallTool } = await import("../src/persistent-room-memory-recall-tool.js");
const { MEMORY_USE_FILE, MEMORY_USE_MAX_IDS, flushMemoryUse, memoryUsePath, readMemoryUse, recordMemoryUse } = await import("../src/memory-use.js");

let passed = 0;
let failed = 0;

function check(name: string, condition: unknown): void {
	if (condition) {
		passed += 1;
		console.log(`  ok  ${name}`);
	} else {
		failed += 1;
		console.log(`  FAIL ${name}`);
	}
}

/** One numbered section; a throw inside it is one failed check, not the end of the run. */
async function section(name: string, run: () => Promise<void> | void): Promise<void> {
	console.log(name);
	try {
		await run();
	} catch (error) {
		failed += 1;
		console.log(`  FAIL ${name} threw: ${error instanceof Error ? error.message : String(error)}`);
	}
}

type RecallRow = { id: string; source: string; shown: boolean };
type RecallDetails = { outcome?: string; matches?: number; returned?: number; resultLimitReached?: number; truncatedForSize?: boolean; rows?: RecallRow[] };

function recallTool(roomId: string, resolveWindow?: () => number | null) {
	return createPersistentRoomMemoryRecallTool({ roomId, runtimeCwd: tempHome, ...(resolveWindow ? { resolveWindow } : {}) });
}

async function recall(tool: ReturnType<typeof createPersistentRoomMemoryRecallTool>, input: { query: string; topic?: string; maxResults?: number }): Promise<{ text: string; details: RecallDetails }> {
	const result: any = await (tool.execute as any)("call-1", input, undefined, undefined, undefined);
	return { text: String(result?.content?.[0]?.text ?? ""), details: (result?.details ?? {}) as RecallDetails };
}

const day = (date: Date) => date.toISOString().slice(0, 10);

// The words each row is found by. Every query below names one of them and
// nothing else, so which rows a recall returns is never a question of ranking.
const WORD_SHARED = "PELICANWHARF";
const WORD_NOTE_ONLY = "OSPREYLEDGER";
const WORD_LONG = "CORMORANTVAULT";
const WORD_CAPPED = "GANNETSPIRE";

/** A room with three migrated notes and two archive rows, built the way a room is built. */
function buildRoom(name: string): string {
	const scaffold = createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const roomId = scaffold.agent.agentId;
	const l1bPath = path.join(root, roomId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		`- Persistent agent id: ${roomId}`,
		"- Lifecycle state: ready",
		"",
		"## Deep Memory",
		"",
		"<!-- entries: next=100 -->",
		"",
		"### Commercial terms",
		"",
		"<!-- e: id=m-0001 kind=fact saved=2026-08-02 -->",
		`- The ${WORD_SHARED} contract renews annually, and ${WORD_NOTE_ONLY} is its reference.`,
		"",
		"<!-- e: id=m-0002 kind=fact saved=2026-08-03 -->",
		`- The ${WORD_LONG} ledger closes each spring.`,
		"",
		"### Delivery",
		"",
		"<!-- e: id=m-0003 kind=fact saved=2026-08-04 -->",
		`- Delivery windows are six weeks from ${WORD_CAPPED} signature.`,
		"",
		"## Active Items",
		"",
		"## Recent Context",
		"",
	].join("\n"), { mode: 0o600 });
	// The second archive row is longer than the smallest answer a recall may
	// give, so a recall that finds it and a note together can show only one of
	// the two: the size cut is forced by the row, not by the window.
	const longText = `- ${WORD_LONG} ${"The vault ledger held every closing figure of the year. ".repeat(180)}`.trim();
	appendArchive(roomId, [
		{ entry: { id: "m-0011", kind: "fact", saved: "2026-01-10", pinned: false, text: `- The ${WORD_SHARED} rebate was two percent in the ${WORD_CAPPED} year.` }, why: "budget", topic: "Commercial terms", section: "Deep Memory", archived: "2026-03-04" },
		{ entry: { id: "m-0012", kind: "fact", saved: "2026-02-10", pinned: false, text: longText }, why: "superseded", topic: "Commercial terms", section: "Deep Memory", archived: "2026-07-19" },
	], new Date("2026-09-01T09:00:00.000Z"));
	invalidateRoomCorpus(roomId);
	return roomId;
}

try {
	const roomId = buildRoom("Memory Use Smoke Room");
	const tool = recallTool(roomId);
	// Named by hand rather than asked for, so a path helper that cannot answer
	// fails its own check and not every one after it.
	const sidecarPath = path.join(root, roomId, "runtime", MEMORY_USE_FILE);
	const runtimeDir = path.dirname(sidecarPath);

	await section("1. no recall, no sidecar", () => {
		check("the sidecar lives under the room's runtime directory", memoryUsePath(roomId) === sidecarPath);
		check("no file exists before any recall", !fs.existsSync(sidecarPath));
		const use = readMemoryUse(roomId);
		check("a room that never recalled reads as no use", Object.keys(use.notes).length === 0 && Object.keys(use.archive).length === 0);
	});

	await section("2. two recalls, one write", async () => {
		const first = await recall(tool, { query: WORD_SHARED, maxResults: 25 });
		const second = await recall(tool, { query: WORD_NOTE_ONLY, maxResults: 25 });
		check("the first recall returns the note and the archive row that share the word", first.details.outcome === "ok" && (first.details.rows ?? []).every((row) => row.shown) && (first.details.rows ?? []).map((row) => row.id).sort().join(",") === "m-0001,m-0011");
		check("the second recall returns the note alone", second.details.outcome === "ok" && (second.details.rows ?? []).map((row) => row.id).join(",") === "m-0001");
		const existedBeforeFlush = fs.existsSync(sidecarPath);
		const before = new Date();
		flushMemoryUse(roomId);
		const after = new Date();
		check("the coalescing window had not fired when the flush was asked for", !existedBeforeFlush);
		check("the flush writes the file", fs.existsSync(sidecarPath));
		const use = readMemoryUse(roomId);
		const today = [day(before), day(after)];
		check("a note both recalls returned counts twice, dated today", use.notes["m-0001"]?.hits === 2 && today.includes(use.notes["m-0001"]?.last ?? ""));
		check("an archive row one recall returned counts once, dated today", use.archive["m-0011"]?.hits === 1 && today.includes(use.archive["m-0011"]?.last ?? ""));
		check("nothing else was counted", Object.keys(use.notes).join(",") === "m-0001" && Object.keys(use.archive).join(",") === "m-0011");
		const raw = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
		check("the file carries schema 1 and an updatedAt", raw.schemaVersion === 1 && typeof raw.updatedAt === "string" && !Number.isNaN(Date.parse(raw.updatedAt)));
	});

	await section("3. a row that was not shown is not a row that was used", async () => {
		// The long archive row and a short note share a word; whichever the
		// search ranks first fills the answer on its own, so the other is matched
		// but not shown.
		const cut = await recall(recallTool(roomId, () => 1_000), { query: WORD_LONG, maxResults: 25 });
		const rows = cut.details.rows ?? [];
		const shownIds = rows.filter((row) => row.shown).map((row) => row.id);
		const hiddenIds = rows.filter((row) => !row.shown).map((row) => row.id);
		check("the size cut left one of the two matched rows out", cut.details.outcome === "ok" && cut.details.truncatedForSize === true && rows.length === 2 && shownIds.length === 1 && hiddenIds.length === 1);
		// Past the result cap: two rows match, one is asked for.
		const capped = await recall(tool, { query: WORD_CAPPED, maxResults: 1 });
		const cappedRows = capped.details.rows ?? [];
		check("the result cap left one of the two matched rows out", capped.details.outcome === "ok" && capped.details.matches === 2 && capped.details.resultLimitReached === 1 && cappedRows.length === 1 && cappedRows[0]?.shown === true);
		flushMemoryUse(roomId);
		const use = readMemoryUse(roomId);
		const countOf = (id: string) => use.notes[id]?.hits ?? use.archive[id]?.hits ?? 0;
		check("the shown row of the size-cut recall was counted", shownIds.every((id) => countOf(id) === 1));
		check("the row the size cut hid was not counted", hiddenIds.every((id) => countOf(id) === 0));
		check("the row past the result cap was not counted", countOf(cappedRows[0]!.id) === 1 && ["m-0003", "m-0011"].filter((id) => id !== cappedRows[0]!.id).every((id) => countOf(id) === (id === "m-0011" ? 1 : 0)));
	});

	await section("4. a conversation row is never counted", () => {
		const noteIds = new Set(["m-0001", "m-0002", "m-0003"]);
		const archiveIds = new Set(readArchive(roomId).map((entry) => entry.id));
		const use = readMemoryUse(roomId);
		check("every counted note id is a note the memory holds", Object.keys(use.notes).every((id) => noteIds.has(id)));
		check("every counted archive id is a row the archive holds", Object.keys(use.archive).every((id) => archiveIds.has(id)));
		recordMemoryUse(roomId, [{ id: "RC-0001", source: "conversation" as any }, { id: "RC-0002", source: "" as any }]);
		flushMemoryUse(roomId);
		const again = readMemoryUse(roomId);
		check("a row offered with any other source is dropped before it is counted", JSON.stringify(again) === JSON.stringify(use));
	});

	await section("5. what cannot be read reads as no use", () => {
		const empty = (use: { notes: object; archive: object }) => Object.keys(use.notes).length === 0 && Object.keys(use.archive).length === 0;
		check("an unknown room reads as no use", empty(readMemoryUse("no-such-room-at-all")));
		check("an id that is not an id reads as no use rather than throwing", empty(readMemoryUse("../escape")));
		const kept = fs.readFileSync(sidecarPath);
		fs.writeFileSync(sidecarPath, "{ this is not json", { mode: 0o600 });
		check("a file of garbage reads as no use", empty(readMemoryUse(roomId)));
		fs.writeFileSync(sidecarPath, JSON.stringify({ schemaVersion: 2, updatedAt: new Date().toISOString(), notes: { "m-0001": { hits: 9, last: "2026-09-01" } }, archive: {} }), { mode: 0o600 });
		check("a file of another schema reads as no use", empty(readMemoryUse(roomId)));
		fs.writeFileSync(sidecarPath, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), notes: { "m-0001": { hits: 2, last: "2026-09-01" }, "m-0002": { hits: 0, last: "2026-09-01" }, "m-0003": { hits: 1.5, last: "2026-09-01" }, "m-0004": { hits: 1, last: "yesterday" }, "m-0005": "x" }, archive: { "m-0011": { hits: 1, last: "2026-09-02" } } }), { mode: 0o600 });
		const filtered = readMemoryUse(roomId);
		check("a row that is not a row is dropped and the rest are kept", Object.keys(filtered.notes).join(",") === "m-0001" && filtered.notes["m-0001"]?.hits === 2 && filtered.archive["m-0011"]?.hits === 1);
		fs.writeFileSync(sidecarPath, kept, { mode: 0o600 });
	});

	await section("6. the sidecar is bounded", () => {
		const boundedRoom = buildRoom("Memory Use Bounded Room");
		const older = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
		const now = new Date();
		const oldIds = Array.from({ length: 100 }, (_, index) => `m-old-${index}`);
		const newIds = Array.from({ length: MEMORY_USE_MAX_IDS }, (_, index) => `m-new-${index}`);
		recordMemoryUse(boundedRoom, oldIds.map((id) => ({ id, source: "note" as const })), { now: older });
		recordMemoryUse(boundedRoom, newIds.slice(0, 2_500).map((id) => ({ id, source: "note" as const })), { now });
		recordMemoryUse(boundedRoom, newIds.slice(2_500).map((id) => ({ id, source: "archive" as const })), { now });
		flushMemoryUse(boundedRoom);
		const use = readMemoryUse(boundedRoom);
		const total = Object.keys(use.notes).length + Object.keys(use.archive).length;
		check(`exactly ${MEMORY_USE_MAX_IDS} ids remain of ${MEMORY_USE_MAX_IDS + 100} recorded`, total === MEMORY_USE_MAX_IDS);
		check("the ids kept are the most recently used", oldIds.every((id) => !use.notes[id]) && newIds.every((id) => use.notes[id] || use.archive[id]));
		// The next write past the cap keeps taking from the oldest end.
		recordMemoryUse(boundedRoom, [{ id: "m-newest", source: "note" }], { now: new Date(now.getTime() + 24 * 60 * 60 * 1000) });
		flushMemoryUse(boundedRoom);
		const next = readMemoryUse(boundedRoom);
		check("a later write past the cap keeps the newest and stays at the cap", next.notes["m-newest"]?.hits === 1 && Object.keys(next.notes).length + Object.keys(next.archive).length === MEMORY_USE_MAX_IDS);
	});

	await section("7. an undo leaves the sidecar alone", () => {
		const l1bPath = path.join(root, roomId, "L1b", "current.md");
		const sidecarBefore = fs.readFileSync(sidecarPath);
		const eventsDir = path.join(root, roomId, "events", "memory-edit");
		restoreMemoryFile(roomId, {
			restoredL1b: fs.readFileSync(l1bPath, "utf-8"),
			snapshotLabel: "undo",
			writeEventRecord: (recorded) => {
				fs.mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
				const eventRecordPath = path.join(eventsDir, `${recorded.writeId}.json`);
				fs.writeFileSync(eventRecordPath, JSON.stringify({ writeId: recorded.writeId }), { mode: 0o600 });
				return { eventRecordPath, eventRelPath: path.relative(path.join(root, roomId), eventRecordPath) };
			},
		});
		check("the sidecar's bytes are unchanged by an undo", fs.readFileSync(sidecarPath).equals(sidecarBefore));
		const archiveIds = new Set(readArchive(roomId).map((entry) => entry.id));
		const use = readMemoryUse(roomId);
		check("every archive row the sidecar names still reads fine", Object.keys(use.archive).length > 0 && Object.keys(use.archive).every((id) => archiveIds.has(id)));
	});

	await section("8. the write is atomic and private", () => {
		// Windows has no file modes to read back, so the check runs where they exist.
		if (process.platform !== "win32") check("the sidecar is mode 0600", (fs.statSync(sidecarPath).mode & 0o777) === 0o600);
		const leftovers = fs.readdirSync(runtimeDir).filter((name) => name.startsWith(MEMORY_USE_FILE) && name !== MEMORY_USE_FILE);
		check("no temp file is left in runtime/", leftovers.length === 0);
	});

	// chmod has no teeth on Windows or as root (the Linux gate runs as root), so
	// the refusal is only forced where the file system will honour it.
	const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
	if (canForceFsRefusal) await section("9. a counter that cannot be written costs nothing", async () => {
		fs.chmodSync(runtimeDir, 0o500);
		try {
			const before = fs.readFileSync(sidecarPath);
			const result = await recall(tool, { query: WORD_SHARED, maxResults: 25 });
			let threw = false;
			try {
				flushMemoryUse(roomId);
			} catch {
				threw = true;
			}
			check("the recall answers as it always does", result.details.outcome === "ok" && (result.details.rows ?? []).length === 2 && result.text.startsWith("[MEMORY RECALL: 2 of 2 matching rows]"));
			check("the failed flush neither throws nor changes the file", !threw && fs.readFileSync(sidecarPath).equals(before));
			const leftovers = fs.readdirSync(runtimeDir).filter((name) => name.startsWith(MEMORY_USE_FILE) && name !== MEMORY_USE_FILE);
			check("no temp file is left behind by the failed write", leftovers.length === 0);
		} finally {
			fs.chmodSync(runtimeDir, 0o700);
		}
	});
} catch (error) {
	failed += 1;
	console.error(`memory-use-smoke: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}

console.log(`memory-use-smoke: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exitCode = 1;
