// The room status says whether a room's memory was ever written
// (memoryStatus.lastMemoryWriteAt), which is what keeps Maintain closed on a
// room whose memory is still the scaffold it was created with: neither
// Memorize nor Review has anything to work on there. Every memory write
// stamps one Chronos line, so the four kinds a room can see are checked here:
// none (a fresh room), a Remember, a note added by hand, and a migration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-memory-write-stamp-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-memory-write-stamp-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	buildPersistentAgentCheckpointTranscriptSource,
	createPersistentAgentFromScaffoldInput,
	getPersistentAgentStatus,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { loadMemoryDocument, writeMemoryDocument } = await import("../src/memory-entries-store.js");
const { applyUserEdit } = await import("../src/memory-entries.js");
const { NOTHING_TO_MAINTAIN_SENTENCE, nothingToMaintain } = await import("../../web-ui/src/memory-surface-copy.js");

const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
let checks = 0;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
	checks += 1;
}

function createRoom(displayName: string): string {
	createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	return displayName.toLowerCase().replace(/ /g, "-");
}

function memoryStatus(agentId: string) {
	return getPersistentAgentStatus(agentId).memoryStatus;
}

function l1bPath(agentId: string): string {
	return path.join(root, agentId, "L1b", "current.md");
}

function remember(agentId: string, at: Date): void {
	const conversationId = `c_${agentId}`;
	const items = [{ kind: "user", id: "u1", text: "A conversation worth remembering." }];
	writePersistentAgentThread(agentId, conversationId, { state: "active", origin: "home", model, items });
	const source = buildPersistentAgentCheckpointTranscriptSource({
		agentId,
		conversationId,
		l1b: fs.readFileSync(l1bPath(agentId), "utf-8"),
		legacyItems: items,
	}).source;
	const recentContext = `### RC-DRAFT | CLOSED | 2026-09-24 | Stamp smoke

**Session arc:** A short conversation is remembered.

**Body:**
- The room now remembers one conversation.

**Parked:**
None
`;
	const parsed = parseCheckpointApprovalRequest({
		conversationId,
		model,
		density: "standard",
		proposal: { agentId, conversationId, sessionId: null, writesMemory: false, density: "standard", source, proposedRecentContext: recentContext },
		approvedRecentContext: recentContext,
	}, agentId);
	writeApprovedCheckpoint(parsed.request, parsed.warnings, at);
}

try {
	// A fresh room: the scaffold only, nothing waiting, Maintain stays closed.
	const fresh = createRoom("Stamp Fresh Room");
	const freshStatus = memoryStatus(fresh);
	assert(freshStatus.lastMemoryWriteAt === null, `a fresh room has no memory write, got ${freshStatus.lastMemoryWriteAt}`);
	assert(freshStatus.recentContextCount === 0, "a fresh room has nothing waiting");
	assert(nothingToMaintain(freshStatus) === true, "a fresh room has nothing to maintain");
	assert(/Remember first/.test(NOTHING_TO_MAINTAIN_SENTENCE), "the blocked sentence names Remember as the way out");
	// Reading the memory without migrating it writes nothing.
	loadMemoryDocument(fresh, { migrate: "in-memory" });
	assert(memoryStatus(fresh).lastMemoryWriteAt === null, "reading the memory is not a write");

	// A Remember stamps its checkpoint, and the waiting conversation opens Maintain.
	const remembered = createRoom("Stamp Remembered Room");
	const rememberedAt = new Date("2026-09-24T08:00:00.000Z");
	remember(remembered, rememberedAt);
	const rememberedStatus = memoryStatus(remembered);
	assert(rememberedStatus.lastMemoryWriteAt === rememberedAt.toISOString(), `a Remember stamps the write, got ${rememberedStatus.lastMemoryWriteAt}`);
	assert(rememberedStatus.recentContextCount === 1, "the remembered conversation is waiting");
	assert(nothingToMaintain(rememberedStatus) === false, "a remembered room can be maintained");

	// A note added by hand, with nothing ever remembered: Review has something to tidy.
	const noted = createRoom("Stamp Noted Room");
	const load = loadMemoryDocument(noted, { migrate: "in-memory" });
	assert(memoryStatus(noted).lastMemoryWriteAt === null, "loading for an edit writes nothing yet");
	const noteAt = new Date("2026-09-24T09:00:00.000Z");
	const next = applyUserEdit(load.doc, { op: "add", topic: "Working style", kind: "practice", text: "Numbers first, one page.", saved: "2026-09-24" }).doc;
	writeMemoryDocument(noted, next, { why: "user_edit", snapshotLabel: "edit", operation: "add", now: noteAt });
	const notedStatus = memoryStatus(noted);
	assert(notedStatus.lastMemoryWriteAt === noteAt.toISOString(), `a note added by hand stamps the write, got ${notedStatus.lastMemoryWriteAt}`);
	assert(notedStatus.recentContextCount === 0 && notedStatus.lastCheckpointId === null, "the noted room never used Remember");
	assert(nothingToMaintain(notedStatus) === false, "a room with a hand-written note can be maintained");

	// A migration of an older memory file is a recorded write too.
	const migrated = createRoom("Stamp Migrated Room");
	const v1 = fs.readFileSync(l1bPath(migrated), "utf-8").replace(/## Active Items\n/, "## Active Items\n\n- Follow up on the older plan.\n");
	fs.writeFileSync(l1bPath(migrated), v1, { mode: 0o600 });
	assert(memoryStatus(migrated).lastMemoryWriteAt === null, "an unmigrated file carries no write stamp");
	const migration = loadMemoryDocument(migrated);
	assert(migration.migrated === true, "the first migrating load writes the migration");
	assert(typeof memoryStatus(migrated).lastMemoryWriteAt === "string", "a migration stamps the write");

	// A status without the field (an older server) never blocks.
	assert(nothingToMaintain({ recentContextCount: 0 }) === false, "a status without the stamp never blocks");
	assert(nothingToMaintain(null) === false, "no status never blocks");

	console.log(`memory write stamp smoke passed (${checks} checks)`);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
}
