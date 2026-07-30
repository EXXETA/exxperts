// The two-writers notice (taste pass): when a revise run's target changed
// mid-run, the revision lands beside the file instead of over it — and the
// user must LEARN that, in the conversation, whether they were watching or
// away. This smoke pins the whole visible path, which had no test at all:
//
//   commitReviseArtifactsOntoShelf → conflicts
//     → task_end.reviseConflicts        (live tab renders a system line)
//     → ledger row .reviseConflicts     (survives the process)
//     → task_away_notice.reviseConflicts (the away tab renders the same line)
//
// The sentence itself comes from ONE shared builder that the web UI imports
// directly, so the line the user reads and the line the room's context
// receives can never drift apart again (they already had).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-revise-conflict-"));
const tempHome = path.join(tempRoot, "home");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const notice = await import("../src/revise-conflict-notice.js");
const ledger = await import("../src/persistent-room-task-ledger.js");

const agentsRoot = path.join(tempRoot, "rooms");
const ROOM = "room-conflict";
const storage = { persistentAgentsRoot: agentsRoot } as const;

// ── 1. The one sentence ──────────────────────────────────────────────────────
{
	const sentence = notice.reviseConflictSentence({ name: "deck.html", savedAs: "deck (2).html" });
	// The three facts a user needs: which file, that it was NOT overwritten,
	// and where the work actually went.
	assert(sentence.includes("“deck.html”"), "the sentence names the target file");
	assert(sentence.includes("not overwritten"), "the sentence says the overwrite was refused");
	assert(sentence.includes("“deck (2).html”"), "the sentence says where the revision landed");
	assert(sentence.includes("in Files"), "the sentence points at Files, the place the user can look");
	// A conflict with nowhere to point still tells the truth it has.
	const bare = notice.reviseConflictSentence({ name: "deck.html" });
	assert(bare.includes("not overwritten") && !bare.includes("Files as"), "a conflict without a saved-as claims only what it knows");
	// A junk record must not render as a sentence about a file called "".
	assert(notice.reviseConflictSentence({ name: "  " }).startsWith("“The file”"), "a nameless conflict degrades to a generic subject");
	// Multi-conflict: one sentence per line, no run-on.
	const multi = notice.reviseConflictNotice([{ name: "a.html", savedAs: "a (2).html" }, { name: "b.svg", savedAs: "b (2).svg" }]);
	assert(multi.split("\n").length === 2, "each conflict gets its own line");
}

// ── 2. Tolerant wire/stored reads ────────────────────────────────────────────
{
	assert(notice.readReviseConflicts(undefined).length === 0, "absent conflicts read as none");
	assert(notice.readReviseConflicts("nope").length === 0, "a non-array reads as none");
	const mixed = notice.readReviseConflicts([{ name: "ok.html", savedAs: "ok (2).html" }, { savedAs: "orphan" }, null, { name: "bare.md" }]);
	assert(mixed.length === 2, `junk entries drop, well-formed ones survive, got ${JSON.stringify(mixed)}`);
	assert(mixed[0].name === "ok.html" && mixed[0].savedAs === "ok (2).html", "a full conflict round-trips");
	assert(mixed[1].name === "bare.md" && mixed[1].savedAs === undefined, "a saved-as-less conflict round-trips");
}

// ── 3. The ledger carries conflicts, so an away user can still be told ───────
{
	ledger.createTaskLedgerRecord({ taskId: "tsk-conflict", roomId: ROOM, conversationId: "c1", templateId: "deck-html", templateVersion: 1, title: "make it shorter" }, storage);
	// `noticed: false` = the terminal frame reached nobody (the tab was closed).
	const finalized = ledger.finalizeTaskLedgerRecord(ROOM, "tsk-conflict", {
		outcome: "ok",
		summary: "Shortened the deck.",
		artifacts: [{ relativePath: "files/deck (2).html", bytes: 10, extension: ".html" }],
		noticed: false,
		reviseConflicts: [{ name: "deck.html", savedAs: "deck (2).html" }],
	}, storage);
	assert(finalized?.reviseConflicts?.length === 1, "the ledger row keeps the conflict structurally, not only inside the summary");
	assert(finalized?.reviseConflicts?.[0]?.name === "deck.html", "the conflict's target survives the write");

	// A clean revise stores nothing — absence must stay absence.
	ledger.createTaskLedgerRecord({ taskId: "tsk-clean", roomId: ROOM, conversationId: "c1", templateId: "deck-html", templateVersion: 1, title: "tidy" }, storage);
	const clean = ledger.finalizeTaskLedgerRecord(ROOM, "tsk-clean", { outcome: "ok", summary: "Done.", artifacts: [], noticed: true }, storage);
	assert(clean?.reviseConflicts === undefined, "a run with no conflicts stores no conflict field");

	// The away selection must surface the row WITH its conflicts: this is the
	// only path by which a conflict that happened with the tab closed ever
	// reaches the user — task frames never replay.
	const rows = ledger.listTaskLedgerRecords(ROOM, storage);
	const away = ledger.selectTaskLedgerAwayNotices(rows, 5);
	const awayRow = away.notices.find((row) => row.taskId === "tsk-conflict");
	assert(awayRow, "an un-noticed terminal row is owed an away notice");
	assert(awayRow?.reviseConflicts?.length === 1, "the away notice's row carries the conflict the user never saw");
	assert(!away.notices.some((row) => row.taskId === "tsk-clean"), "a row already noticed live is not re-announced");
	// The rendered away line is the SAME sentence the live path shows.
	assert(notice.reviseConflictSentence(awayRow!.reviseConflicts![0]) === notice.reviseConflictSentence({ name: "deck.html", savedAs: "deck (2).html" }), "the away line and the live line are one sentence");
}

// ── 4. The commit gate really produces what the notice reports ───────────────
{
	const shelf = await import("../src/persistent-room-shelf.js");
	const crypto = await import("node:crypto");
	const artifactRoot = path.join(tempRoot, "artifacts");
	const roomFiles = shelf.persistentRoomShelfDirPath(ROOM);
	fs.mkdirSync(roomFiles, { recursive: true });
	fs.writeFileSync(path.join(roomFiles, "deck.html"), "<h1>original</h1>");
	const baselineHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(roomFiles, "deck.html"))).digest("hex");
	const taskFolder = path.join(artifactRoot, "tasks", "tsk-gate");
	fs.mkdirSync(taskFolder, { recursive: true });
	fs.writeFileSync(path.join(taskFolder, "deck.html"), "<h1>revised</h1>");
	// The target changes UNDER the run — the two-writers case.
	fs.writeFileSync(path.join(roomFiles, "deck.html"), "<h1>hand-edited meanwhile</h1>");
	const committed = shelf.commitReviseArtifactsOntoShelf(
		ROOM,
		artifactRoot,
		[{ relativePath: "tasks/tsk-gate/deck.html", bytes: 17, extension: ".html" }],
		[{ name: "deck.html", baselineHash, outputName: "deck.html" }],
	);
	assert(committed.conflicts.length === 1, `a changed target must refuse the overwrite, got ${JSON.stringify(committed.conflicts)}`);
	const conflict = committed.conflicts[0];
	assert(conflict.name === "deck.html", "the conflict names the canonical file");
	assert(conflict.savedAs && conflict.savedAs !== "deck.html", `the revision lands under a different name, got ${conflict.savedAs}`);
	// The gate's own output feeds the sentence with no adaptation.
	const sentence = notice.reviseConflictSentence(conflict);
	assert(sentence.includes(conflict.savedAs!), "the notice names the file the gate actually wrote");
	assert(fs.readFileSync(path.join(roomFiles, "deck.html"), "utf-8") === "<h1>hand-edited meanwhile</h1>", "the user's edit survives untouched");
	assert(fs.readFileSync(path.join(roomFiles, conflict.savedAs!), "utf-8") === "<h1>revised</h1>", "the revision is on the shelf under its collision name");
}

console.log("revise conflict notice smoke passed");
