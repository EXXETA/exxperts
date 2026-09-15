// Memory provenance smoke: the Memory view's receipts and history timeline are
// composed from the immutable event records, read-only. Verifies (1) an RC
// entry admitted through the checkpoint gate carries the record's approvedAt,
// (2) an entry with no event record gets NO receipt (never a guessed one),
// (3) the history timeline renders checkpoint and learn events newest first,
// with the checkpoint keeping its title after the RC entry is consolidated away,
// (4) the receipt's conversation link follows the recorded chain (checkpoint id
// → record → closed thread file) and disappears honestly when the file is gone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-memory-provenance-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-memory-provenance-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	buildPersistentAgentCheckpointTranscriptSource,
	createPersistentAgentFromScaffoldInput,
	fingerprintL1bSource,
	getPersistentAgentStatus,
	parseAbsorbApprovalRequest,
	parseCheckpointApprovalRequest,
	writeApprovedAbsorb,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { ABSORB_CONSOLIDATION_WORKER_TYPE, ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER, extractTopLevelSectionBody } = await import("../src/absorb-consolidation.js");
const { buildRoomMemory, readConversationTranscript, readMemoryEventDiff, readMemorySnapshotAt } = await import("../src/memory-api.js");

const agentId = "memory-provenance-smoke-room";
const l1bPath = path.join(root, agentId, "L1b", "current.md");
const CHECKPOINT_TITLE = "Memory provenance smoke session";
const T1 = "2026-05-18T10:00:00.000Z";
const T2 = "2026-05-18T20:00:00.000Z";
const T3 = "2026-05-18T21:00:00.000Z";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readL1b(): string {
	return fs.readFileSync(l1bPath, "utf-8");
}

function approvedEntry(title: string): string {
	return `### RC-DRAFT | CLOSED | 2026-05-18 | ${title}\n\n**Session arc:** A short session produced one checkpointable state delta.\n\n**Body:**\nKey durable signal for the provenance smoke.\n\n**Parked:**\nNone\n`;
}

function checkpointRequest(title: string) {
	const conversationId = `c_${Math.random().toString(36).slice(2, 8)}`;
	const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
	const transcriptItem = { kind: "user", id: "u1", text: `Synthetic checkpoint transcript for ${conversationId}.` };
	writePersistentAgentThread(agentId, conversationId, { state: "active", origin: "home", model, items: [transcriptItem] });
	const source = buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId, l1b: readL1b(), legacyItems: [transcriptItem] }).source;
	return parseCheckpointApprovalRequest({
		conversationId,
		model,
		density: "compact",
		proposal: { agentId, conversationId, sessionId: null, writesMemory: false, source },
		approvedRecentContext: approvedEntry(title),
	}, agentId);
}

function candidateL1b(): string {
	// Chronos is system-managed: a faithful candidate carries the source's
	// Chronos through unchanged, so the fixture splices it from the live L1b.
	const chronos = extractTopLevelSectionBody(readL1b(), "Chronos");
	if (chronos == null) throw new Error("source L1b should have a Chronos section");
	return `<!-- exxeta:l1b schema_version=1 -->\n\n## Chronos\n\n${chronos.trim()}\n\n## Deep Memory\n\n- Synthetic user validates memory provenance receipts.\n- The provenance smoke durable understanding is consolidated.\n\n## Active Items\n\n### High Priority\n\n- Keep provenance read-only.\n\n## Recent Context\n\n${ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER}\n`;
}

function absorbRequest(recentContextEntryCount: number) {
	const sourceL1b = readL1b();
	return parseAbsorbApprovalRequest({
		proposal: {
			agentId,
			writesMemory: false,
			process: { type: ABSORB_CONSOLIDATION_WORKER_TYPE, model: { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" } },
			availability: { recentContextEntryCount },
			source: { l1bFingerprint: fingerprintL1bSource(sourceL1b), generatedAt: T2 },
			fields: { candidateL1b: candidateL1b() },
			review: { keyMetrics: { recentContextEntriesBefore: recentContextEntryCount, recentContextEntriesAfter: 0, stableMemoryDeltaBytes: 50, stableMemoryDeltaTokens: 12 } },
		},
	}, agentId);
}

function detail() {
	return buildRoomMemory(getPersistentAgentStatus(agentId));
}

/** Add a Recent Context entry that never passed the checkpoint gate. The
 * scaffold keeps Recent Context as the last section, so appending at the end
 * of the file lands inside it. */
function appendSyntheticEntry(index: number): void {
	const base = readL1b();
	const lastSection = base.lastIndexOf("\n## ");
	assert(base.slice(lastSection + 1).startsWith("## Recent Context"), "Recent Context should be the last L1b section");
	fs.writeFileSync(
		l1bPath,
		`${base.trimEnd()}\n\n### RC-${String(index).padStart(4, "0")} | OPEN | 2026-05-18 | Hand-added entry without a record ${index}\n\n**Body:**\nThis entry never passed the checkpoint gate.\n`,
		"utf-8",
	);
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Memory Provenance Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});

	// 1. A checkpointed entry carries the event record's exact approval time.
	const cp1 = checkpointRequest(CHECKPOINT_TITLE);
	writeApprovedCheckpoint(cp1.request, cp1.warnings, new Date(T1));
	let d = detail();
	assert(d.recentSessions.length === 1, `one recent session expected, got ${d.recentSessions.length}`);
	assert(d.recentSessions[0].approvedAt === T1, `checkpointed entry should carry approvedAt=${T1}, got ${d.recentSessions[0].approvedAt}`);
	assert(d.recentSessions[0].content.includes("Key durable signal for the provenance smoke"), "session should carry its full saved text");
	assert(!d.recentSessions[0].content.startsWith("###"), "session content should not repeat its heading line");
	assert(!d.recentSessions[0].content.includes("rc_metadata"), "session content should not expose the rc_metadata identity comment");
	assert(d.history.length === 1 && d.history[0].kind === "checkpoint", "history should hold the checkpoint event");
	assert(d.history[0].ts === Date.parse(T1), "history checkpoint ts should be the approval time");
	assert(d.history[0].title === CHECKPOINT_TITLE, `history checkpoint should carry the entry title, got ${d.history[0].title}`);

	// 1b. The receipt's conversation link follows the recorded chain: the entry
	// names its checkpoint id, the record names the closed thread, and the
	// transcript reader returns the stored items — while an unknown checkpoint
	// id honestly returns stored:false.
	assert(d.recentSessions[0].checkpointId, "gated entry should carry its checkpoint id");
	assert(d.recentSessions[0].conversation === true, "stored conversation should be offered on the receipt");
	const transcript = readConversationTranscript(agentId, d.recentSessions[0].checkpointId!);
	assert(transcript && transcript.stored === true, "transcript should be stored for a fresh checkpoint");
	assert(transcript.stored && transcript.items.some((item) => item.kind === "user" && item.text?.includes("Synthetic checkpoint transcript")), "transcript should carry the stored user item");
	const unknown = readConversationTranscript(agentId, "cp_20990101T000000Z_zzzzzz");
	assert(unknown && unknown.stored === false && unknown.reason === "no-record", `unknown checkpoint id must be stored:false/no-record, got ${JSON.stringify(unknown)}`);

	// 2. An RC entry with no event record gets no receipt — never a guessed one.
	appendSyntheticEntry(2);
	d = detail();
	assert(d.recentSessions.length === 2, `two recent sessions expected, got ${d.recentSessions.length}`);
	const synthetic = d.recentSessions.find((s) => s.title.includes("Hand-added"));
	const gated = d.recentSessions.find((s) => s.title === CHECKPOINT_TITLE);
	assert(synthetic && synthetic.approvedAt === null, "record-less entry must have approvedAt null");
	assert(synthetic.checkpointId === null && synthetic.conversation === false, "record-less entry must offer no conversation");
	assert(gated && gated.approvedAt === T1, "checkpointed entry keeps its receipt next to a record-less one");

	// 3. Learn consolidates: history gains the learn event, sessions empty out,
	// and the checkpoint keeps its title even though the RC entry is gone.
	// (Absorb requires at least 5 RC entries, so pad with more record-less ones.)
	for (let i = 3; i <= 5; i++) appendSyntheticEntry(i);
	const absorb = absorbRequest(5);
	writeApprovedAbsorb(absorb.request, absorb.warnings, new Date(T2));

	// 3a. What the Learn changed, while it is the latest event: before = its
	// own archived snapshot, after = today's document, verified by the
	// fingerprint the record stored at write time.
	d = detail();
	const learnEvent = d.history.find((e) => e.kind === "learn");
	assert(learnEvent && learnEvent.id && learnEvent.diffable === true, `learn event should be diffable with an id, got ${JSON.stringify(learnEvent)}`);
	let diff = readMemoryEventDiff(agentId, "learn", learnEvent.id!);
	assert(diff, "learn diff should resolve from the stored snapshots");
	assert(diff.afterBasis === "current" && diff.afterVerified === true, `latest learn should diff against today's verified document, got ${JSON.stringify({ afterBasis: diff.afterBasis, afterVerified: diff.afterVerified })}`);
	// The diff speaks in notes: neither side has entry ids yet, so both are
	// paired the way the first migrating save would number them. The
	// candidate's Deep Memory is prose under no heading, which is the implicit
	// "General" topic; the consolidated sessions leave the waiting list.
	assert(diff.notes === true && !("sections" in diff), `an unmigrated room's Learn still reads as notes, got ${JSON.stringify({ notes: diff.notes, sections: diff.sections })}`);
	const consolidatedTitles = [CHECKPOINT_TITLE, ...[2, 3, 4, 5].map((i) => `Hand-added entry without a record ${i}`)];
	assert(JSON.stringify(diff.conversations) === JSON.stringify({ left: consolidatedTitles, joined: [] }), `the consolidated sessions left the waiting list, in document order, got ${JSON.stringify(diff.conversations)}`);
	const deepDiff = diff.topics.find((t) => t.section === "General");
	assert(deepDiff && deepDiff.changes.some((c) => String(c.after ?? "").includes("provenance smoke durable understanding is consolidated")), `the consolidated knowledge lands under the topic it went into, got ${JSON.stringify(diff.topics)}`);
	assert(diff.topics.every((t) => t.changes.every((c) => !String(c.after ?? "").includes("Hand-added entry without a record 3"))), "no row's after side still holds the consolidated session");
	assert(readMemoryEventDiff(agentId, "learn", "ab_20990101T000000Z_zzzzzz") === null, "unknown event id must resolve to null");

	const cp2 = checkpointRequest("Post-learn session");
	writeApprovedCheckpoint(cp2.request, cp2.warnings, new Date(T3));

	// 3b. Once a later event is recorded, the same diff serves the next
	// archived snapshot as the after side — still hash-verified.
	diff = readMemoryEventDiff(agentId, "learn", learnEvent.id!);
	assert(diff && diff.afterBasis === "next-archive" && diff.afterVerified === true, `learn diff should follow the archive chain once a later event exists, got ${JSON.stringify(diff && { afterBasis: diff.afterBasis, afterVerified: diff.afterVerified })}`);
	d = detail();
	assert(d.history.length === 3, `three history events expected, got ${d.history.length}`);
	assert(d.history[0].kind === "checkpoint" && d.history[0].ts === Date.parse(T3), "newest event first");
	assert(d.history[1].kind === "learn" && d.history[1].ts === Date.parse(T2), "learn event in the middle");
	assert(d.history[1].sessions === 5, `learn should report 5 consolidated sessions, got ${d.history[1].sessions}`);
	assert(typeof d.history[1].deepTokensBefore === "number" && typeof d.history[1].deepTokensAfter === "number", "learn should carry deep-memory sizes");
	// RC ids restart after a consolidation, so the post-learn checkpoint reuses
	// RC-0001. The consolidated checkpoint must NOT borrow the new entry's
	// title (false provenance); with no record title left, it goes quiet.
	assert(d.history[0].title === "Post-learn session", `newest checkpoint should carry the live entry's title, got ${JSON.stringify(d.history[0])}`);
	assert(d.history[2].kind === "checkpoint" && d.history[2].title === CHECKPOINT_TITLE, `consolidated checkpoint keeps the title its own record stored and never borrows a reused RC id's, got ${JSON.stringify(d.history[2])}`);
	assert(d.recentSessions.length === 1 && d.recentSessions[0].approvedAt === T3, `post-learn session should carry its own receipt ${T3}, got ${JSON.stringify(d.recentSessions[0]?.approvedAt)}`);

	// 4. A hand-added impostor reusing a consolidated (or live) RC label must
	// not steal anyone's receipt, and no history event may borrow its title:
	// the join key is the gate-written checkpoint_id, not the reusable label.
	appendSyntheticEntry(1);
	d = detail();
	const impostor = d.recentSessions.find((s) => s.title.startsWith("Hand-added"));
	const genuine = d.recentSessions.find((s) => s.title === "Post-learn session");
	assert(impostor && impostor.approvedAt === null, `impostor reusing RC-0001 must get no receipt, got ${JSON.stringify(impostor?.approvedAt)}`);
	assert(genuine && genuine.approvedAt === T3, "the genuine entry keeps its receipt next to the impostor");
	assert(d.history[0].title === "Post-learn session", "history keeps the genuine title with an impostor present");
	assert(d.history[2].title === CHECKPOINT_TITLE, `consolidated checkpoint must not borrow the impostor's title, got ${JSON.stringify(d.history[2].title)}`);

	// 4b. Time travel resolves each moment to the recorded state that was live
	// then: before the first checkpoint the entry isn't there yet; between the
	// checkpoint and the Learn the pre-learn sessions are; after the last event
	// it is honestly today's document.
	const beforeAll = readMemorySnapshotAt(agentId, Date.parse(T1) - 3_600_000);
	assert(beforeAll && beforeAll.basis === "archive" && !beforeAll.content.includes(CHECKPOINT_TITLE), `pre-checkpoint snapshot must not hold the checkpointed entry, got ${JSON.stringify(beforeAll && { basis: beforeAll.basis, holds: beforeAll.content.includes(CHECKPOINT_TITLE) })}`);
	const preLearn = readMemorySnapshotAt(agentId, Date.parse(T1) + 3_600_000);
	assert(preLearn && preLearn.basis === "archive" && preLearn.boundaryTs === Date.parse(T2), "mid-window snapshot should come from the Learn's archive");
	assert(preLearn.content.includes(CHECKPOINT_TITLE) && preLearn.content.includes("Hand-added entry without a record 5"), "pre-learn snapshot should hold the not-yet-consolidated sessions");
	assert(!preLearn.content.includes("rc_metadata"), "snapshots must not expose identity comments");
	// The snapshot carries the same shapes the live view renders, derived from
	// the archived text: map rows, per-area bodies, sessions with receipts.
	assert(preLearn.memoryMap.some((r) => r.area.startsWith("Recent sessions")), "past map should carry the pending-sessions row");
	assert(typeof preLearn.areas["Deep Memory"] === "string" && typeof preLearn.areas["Timeline"] === "string", "past areas should carry readable section bodies");
	assert(preLearn.composition.recent > 0, "past composition should measure the pending sessions");
	const pastGated = preLearn.recentSessions.find((s) => s.title === CHECKPOINT_TITLE);
	assert(pastGated && pastGated.approvedAt === T1, "a past session keeps its gate receipt");
	assert(preLearn.recentSessions.filter((s) => s.title.startsWith("Hand-added")).every((s) => s.approvedAt === null), "past record-less sessions stay receipt-less");
	const today = readMemorySnapshotAt(agentId, Date.parse(T3) + 3_600_000);
	assert(today && today.basis === "current" && today.content.includes("Post-learn session"), "post-history snapshot is honestly today's document");

	// 5. When the closed-thread file is gone, the receipt stops offering the
	// conversation and the reader says so — never a dead link, never a guess.
	fs.rmSync(path.join(root, agentId, "runtime", "threads", `${cp2.request.conversationId}.json`));
	d = detail();
	const orphaned = d.recentSessions.find((s) => s.title === "Post-learn session");
	assert(orphaned && orphaned.approvedAt === T3 && orphaned.conversation === false, `receipt must stay while the conversation link disappears, got ${JSON.stringify({ approvedAt: orphaned?.approvedAt, conversation: orphaned?.conversation })}`);
	assert(orphaned.checkpointId, "orphaned entry still names its checkpoint id");
	const gone = readConversationTranscript(agentId, orphaned.checkpointId!);
	assert(gone && gone.stored === false && gone.reason === "no-thread", `deleted thread must read stored:false/no-thread, got ${JSON.stringify(gone)}`);

	console.log("memory-provenance smoke passed: receipts join on gate-written checkpoint ids, record-less and impostor entries stay receipt-less, history renders newest first, conversation links follow the recorded chain only while the thread file exists, learn diffs serve hash-verified before/after snapshots, and time travel resolves each moment to its recorded state");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(root, { recursive: true, force: true });
}
