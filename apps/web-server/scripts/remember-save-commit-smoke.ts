// A Remember save is one step: it either landed or it did not.
//
// The save writes several files (the archive copy, the memory file, the fresh
// conversation, the old one closed, agent.json, the event record). A crash
// between two of them used to leave a room half saved: the page in memory with
// the conversation still open (Save again said "Nothing was saved"; Remember
// again wrote the page twice), or a conversation with no event record (never
// indexed, never listed). This smoke crashes the save after each write, then
// makes the next request, and pins the one rule: before the memory file is
// written nothing is saved and Save works again; after it, the room finishes
// the save itself. It also pins that no turn can reach a conversation whose
// save is half done, that a conversation written to anyway keeps its page and
// stays open, and that a Memorize or an edit saved between propose and Save
// leaves the proposal valid.
//
// Offline: fake proposal text, no model, no server. The crash is a write that
// throws, injected by path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PersistentAgentPiSessionJsonlThreadRuntime } from "../src/persistent-agents.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "remember-save-commit-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "remember-save-commit-cwd-"));
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

const {
	beginPersistentAgentTurn,
	buildCheckpointProposal,
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	finishPersistentAgentTurn,
	getPersistentAgentRuntimeState,
	getPersistentAgentStatus,
	getPersistentAgentThread,
	openPersistentAgentPiSessionManager,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { appendArchive, loadMemoryDocument, readArchive, restoreMemoryFile, writeMemoryDocument } = await import("../src/memory-entries-store.js");
const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
writePersistentAgentAiProfileState("openai-compatible");

const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

// --- The crash: the first write whose path matches throws, and so does every
// write after it until the "process" is back (a crashed process writes nothing).
// A torn crash first writes half of that file, as a process killed mid-write does.

const realWriteFileSync = fs.writeFileSync;
const realRenameSync = fs.renameSync;
function crashOnWrite(pattern: RegExp, options: { torn?: boolean } = {}): { restore(): void; hit(): boolean } {
	let fired = false;
	const strike = (target: unknown, data?: unknown) => {
		if (fired || pattern.test(String(target))) {
			if (!fired && options.torn && typeof data === "string") realWriteFileSync(target as string, data.slice(0, Math.floor(data.length / 2)));
			fired = true;
			throw new Error(`injected crash writing ${path.basename(String(target))}`);
		}
	};
	(fs as any).writeFileSync = (file: any, ...rest: any[]) => { strike(file, rest[0]); return (realWriteFileSync as any)(file, ...rest); };
	(fs as any).renameSync = (from: any, to: any) => { strike(to); return realRenameSync(from, to); };
	return {
		restore() { (fs as any).writeFileSync = realWriteFileSync; (fs as any).renameSync = realRenameSync; },
		hit: () => fired,
	};
}

// --- A room with one conversation and its proposal ---------------------------

let rooms = 0;
async function roomWithProposal(label: string) {
	rooms += 1;
	const displayName = `Commit Smoke ${label} ${rooms}`;
	createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	const instance = createPersistentAgentInstance(agentId);
	const threadId = `pi_commit_${rooms}`;
	const written = writePersistentAgentThread(agentId, threadId, {
		state: "active",
		origin: "home",
		model,
		items: [{ kind: "user", id: "u1", text: "We chose the blue logo." }],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
	});
	const runtime = written.thread.runtime as PersistentAgentPiSessionJsonlThreadRuntime;
	openPersistentAgentPiSessionManager(agentId, runtime, tempCwd).appendMessage({ role: "user", content: "We chose the blue logo.", timestamp: Date.now() });
	const proposal = await buildCheckpointProposal({
		agentId,
		conversationId: threadId,
		model,
		density: "standard",
		items: [{ kind: "user", text: "We chose the blue logo." }],
		runtimeCwd: tempCwd,
	}, async () => ({
		text: "TITLE:\nThe logo\n\nSESSION_ARC:\nWe picked a logo.\n\nBODY:\n- The blue logo was chosen.\n\nPARKED:\nNone\n",
		usage: { input: 1, output: 1, totalTokens: 2, cost: 0 },
	}));
	const approve = () => {
		const parsed = parseCheckpointApprovalRequest({
			conversationId: threadId,
			model,
			density: proposal.density,
			proposal,
			approvedRecentContext: "### RC-DRAFT | CLOSED | 2026-10-08 | The logo\n\n**Session arc:** We picked a logo.\n\n**Body:**\n- The blue logo was chosen.\n\n**Parked:**\nNone\n",
		}, agentId);
		return writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date(), { runtimeCwd: tempCwd });
	};
	return { agentId, instance, threadId, runtime, approve };
}

function memoryOf(instance: ReturnType<typeof createPersistentAgentInstance>): string {
	return fs.readFileSync(instance.l1bCurrentPath(instance.readAgentJson()), "utf-8");
}

function pageCount(instance: ReturnType<typeof createPersistentAgentInstance>): number {
	return (memoryOf(instance).match(/^### RC-\d{4}\b/gm) ?? []).length;
}

function eventRecordsFor(instance: ReturnType<typeof createPersistentAgentInstance>, conversationId: string): number {
	const dir = path.join(instance.rootDir, "events", "checkpoint");
	if (!fs.existsSync(dir)) return 0;
	return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).filter((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")).conversationId === conversationId).length;
}

const failures: string[] = [];
/** Each case runs on its own, so one run shows every failure. */
async function section(label: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
		pass(label);
	} catch (error) {
		failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		console.log(`  FAIL ${label}`);
	}
}

/** What the next request does first: here, the room's status. */
function nextRequest(agentId: string): void {
	getPersistentAgentStatus(agentId);
}

let exitCode = 0;
try {
	// --- 1. A crash after each write -----------------------------------------
	// Before the memory file is written: nothing is saved, Save works again,
	// one page. After it: the room finishes the save on the next request, and
	// Save again answers with the save that landed instead of "stale".
	const steps: Array<{ name: string; pattern: RegExp; landed: boolean; torn?: boolean }> = [
		{ name: "the intent", pattern: /[\\/]runtime[\\/]commit[\\/]/, landed: false },
		{ name: "the archive copy", pattern: /-before-cp_/, landed: false },
		{ name: "the memory file", pattern: /[\\/]L1b[\\/]current\.md/, landed: false },
		{ name: "the fresh conversation", pattern: /postcp_/, landed: true },
		{ name: "the old conversation's close", pattern: /[\\/]threads[\\/]pi_commit_\d+\.json/, landed: true },
		{ name: "the old conversation's close, torn mid-write", pattern: /[\\/]threads[\\/]pi_commit_\d+\.json/, landed: true, torn: true },
		{ name: "agent.json", pattern: /[\\/]agent\.json/, landed: true },
		{ name: "the event record", pattern: /[\\/]events[\\/]checkpoint[\\/]/, landed: true },
	];
	for (const step of steps) await section(`a crash at ${step.name}`, async () => {
		const room = await roomWithProposal(step.name);
		const crash = crashOnWrite(step.pattern, { torn: step.torn });
		let crashed = false;
		try {
			room.approve();
		} catch {
			crashed = true;
		} finally {
			crash.restore();
		}
		assert(crash.hit() && crashed, `the save writes ${step.name} (the crash should have struck there)`);
		nextRequest(room.agentId);
		const thread = getPersistentAgentThread(room.agentId, room.threadId);
		if (!step.landed) {
			assert(pageCount(room.instance) === 0, `a crash at ${step.name} saves nothing, got ${pageCount(room.instance)} pages`);
			assert(thread?.state !== "closed" && getPersistentAgentRuntimeState(room.agentId).activeThreadId === room.threadId, `a crash at ${step.name} leaves the conversation open`);
			const again = room.approve();
			assert(again.writesMemory && pageCount(room.instance) === 1 && eventRecordsFor(room.instance, room.threadId) === 1, `after a crash at ${step.name}, Save works again: one page, one event record`);
		} else {
			assert(pageCount(room.instance) === 1, `a crash after the memory file (at ${step.name}) keeps exactly one page, got ${pageCount(room.instance)}`);
			assert(thread?.state === "closed" && thread.closedReason === "checkpoint", `a crash at ${step.name} is finished by the next request: the conversation is closed, got ${thread?.state}`);
			const active = getPersistentAgentRuntimeState(room.agentId).activeThreadId;
			assert(active && active !== room.threadId && getPersistentAgentThread(room.agentId, active)?.state === "standby", `a crash at ${step.name} is finished: a fresh conversation is open`);
			assert(eventRecordsFor(room.instance, room.threadId) === 1, `a crash at ${step.name} is finished: one event record names the conversation, got ${eventRecordsFor(room.instance, room.threadId)}`);
			assert(room.instance.readAgentJson()?.lastCheckpointId === thread.closedByCheckpointId, `a crash at ${step.name} is finished: agent.json names the save`);
			const again = room.approve();
			assert(again.checkpointId === thread.closedByCheckpointId && pageCount(room.instance) === 1, `Save again after a crash at ${step.name} answers with the save that landed, never a second page`);
			assert((again as any).alreadySaved === true, `Save again after a crash at ${step.name} says the save had already landed, so no window switches over again`);
		}
		assert(!fs.existsSync(path.join(room.instance.rootDir, "runtime", "commit", "remember.json")), `no save is left pending after a crash at ${step.name}`);
	});

	// --- 2. No turn reaches a half-saved conversation -------------------------
	await section("the turn gate finishes a half-done save before any turn, so no turn lands on a remembered conversation", async () => {
		const room = await roomWithProposal("turn gate");
		const crash = crashOnWrite(/postcp_/);
		try { room.approve(); } catch {} finally { crash.restore(); }
		let refused = false;
		try {
			beginPersistentAgentTurn(room.agentId, room.threadId, { turnId: "late-turn" });
			finishPersistentAgentTurn(room.agentId, room.threadId, { turnId: "late-turn" } as any);
		} catch {
			refused = true;
		}
		assert(refused, "a turn on a conversation whose save is half done is refused: the gate finishes the save first");
		assert(getPersistentAgentThread(room.agentId, room.threadId)?.state === "closed" && eventRecordsFor(room.instance, room.threadId) === 1, "the turn gate finished the save");
	});

	// --- 3. A conversation written to anyway keeps its page and stays open ----
	await section("a conversation written to after the memory file keeps its page, gets its record and stays open", async () => {
		const room = await roomWithProposal("moved leaf");
		const crash = crashOnWrite(/postcp_/);
		try { room.approve(); } catch {} finally { crash.restore(); }
		openPersistentAgentPiSessionManager(room.agentId, room.runtime, tempCwd).appendMessage({ role: "user", content: "One more thing after the save.", timestamp: Date.now() });
		nextRequest(room.agentId);
		const thread = getPersistentAgentThread(room.agentId, room.threadId);
		assert(pageCount(room.instance) === 1, "a conversation that moved on keeps the page it saved");
		assert(thread?.state !== "closed" && getPersistentAgentRuntimeState(room.agentId).activeThreadId === room.threadId, "a conversation that moved on stays open, so its later turns are remembered next time");
		assert(eventRecordsFor(room.instance, room.threadId) === 1, "a conversation that moved on still gets its event record");
	});

	// --- 4. A memory save between propose and Save leaves the proposal valid ---
	await section("a memory save between propose and Save leaves the proposal valid, and both saves land", async () => {
		const room = await roomWithProposal("memorize between");
		const loaded = loadMemoryDocument(room.agentId);
		const doc = loaded.doc;
		const topic = doc.topics[0];
		assert(topic, "the scaffold memory has a topic to edit");
		topic.entries.push({ ...(topic.entries[0] ?? {}), id: "E-COMMIT-1", text: "A note saved while the proposal waited." } as any);
		writeMemoryDocument(room.agentId, doc, { why: "edit", snapshotLabel: "edit" } as any);
		const saved = room.approve();
		assert(saved.writesMemory && pageCount(room.instance) === 1 && memoryOf(room.instance).includes("A note saved while the proposal waited."), "a Remember saved after another memory save keeps both: the page and the note");
	});

	// --- 5. Saves on one room take turns ------------------------------------
	await section("saves on one room take turns; other rooms and a failed save do not block", async () => {
		const { withRoomSaveLock } = await import("../src/memory-commit.js");
		const order: string[] = [];
		const slow = (name: string, ms: number) => async () => { order.push(`${name}:start`); await new Promise((resolve) => setTimeout(resolve, ms)); order.push(`${name}:end`); return name; };
		const results = await Promise.all([
			withRoomSaveLock("room-a", slow("first", 40)),
			withRoomSaveLock("room-a", slow("second", 1)),
			withRoomSaveLock("room-b", slow("other", 1)),
		]);
		assert(results.join(",") === "first,second,other", `each save gets its own answer, got ${results.join(",")}`);
		assert(order.indexOf("second:start") > order.indexOf("first:end"), `two saves on one room take turns, got ${order.join(" ")}`);
		assert(order.indexOf("other:end") < order.indexOf("first:end"), `another room does not wait, got ${order.join(" ")}`);
		const failed = await withRoomSaveLock("room-a", async () => { throw new Error("a save failed"); }).catch((error: Error) => error.message);
		const after = await withRoomSaveLock("room-a", async () => "next");
		assert(failed === "a save failed" && after === "next", "a failed save hands its failure back and does not block the next");
	});

	// --- 6. A memory write: the core file is the commit point ----------------
	// The raised limit and the event record land with it or not at all.
	const { readPersistentRoomMaintenanceSettings, writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
	const memoryEditRecords = (instance: ReturnType<typeof createPersistentAgentInstance>) => {
		const dir = path.join(instance.rootDir, "events", "memory-edit");
		return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length : 0;
	};
	for (const step of [
		{ name: "the snapshot", pattern: /-before-edit_/, landed: false },
		{ name: "the core file", pattern: /[\\/]L1b[\\/]current\.md/, landed: false },
		{ name: "the raised limit", pattern: /maintenance-settings\.json/, landed: true },
		{ name: "the edit's event record", pattern: /[\\/]events[\\/]memory-edit[\\/]/, landed: true },
	]) await section(`a memory write crashed at ${step.name}`, async () => {
		const room = await roomWithProposal(`memory ${step.name}`);
		writePersistentRoomMaintenanceSettings(room.agentId, { memoryBudgetTokens: 20000 });
		// Loading migrates the scaffold file once: that is a write of its own, before this one.
		const doc = loadMemoryDocument(room.agentId).doc;
		const before = memoryOf(room.instance);
		const recordsBefore = memoryEditRecords(room.instance);
		doc.topics[0]!.entries.push({ ...(doc.topics[0]!.entries[0] ?? {}), id: "E-COMMIT-2", text: "A note whose save crashed." } as any);
		const crash = crashOnWrite(step.pattern);
		let crashed = false;
		try {
			writeMemoryDocument(room.agentId, doc, { why: "edit", snapshotLabel: "edit", limitTo: 30000 } as any);
		} catch {
			crashed = true;
		} finally {
			crash.restore();
		}
		// After the core the save has landed: the write says so, and the rest is left to the next request.
		assert(crash.hit() && (crashed || step.landed), `the memory write writes ${step.name} (the crash should have struck there)`);
		nextRequest(room.agentId);
		const limit = readPersistentRoomMaintenanceSettings(room.agentId).memoryBudgetTokens;
		if (!step.landed) {
			assert(memoryOf(room.instance) === before && limit === 20000 && memoryEditRecords(room.instance) === recordsBefore, `a memory write crashed at ${step.name} changed nothing: memory, limit ${limit}, records`);
		} else {
			assert(memoryOf(room.instance).includes("A note whose save crashed."), `a memory write crashed at ${step.name} kept its core`);
			assert(limit === 30000, `a memory write crashed at ${step.name} is finished: the raised limit lands, got ${limit}`);
			assert(memoryEditRecords(room.instance) === recordsBefore + 1, `a memory write crashed at ${step.name} is finished: one event record`);
		}
		assert(!fs.existsSync(path.join(room.instance.rootDir, "runtime", "commit", "memory.json")), `no memory write is left pending after a crash at ${step.name}`);
	});

	// --- 6a. A second write never writes over a finish still pending --------
	// The settings file cannot be written for a while: the first save's raised
	// limit waits, and a second save in that while keeps it pending with its own.
	await section("a second memory write while the first one's rest still cannot finish keeps both", async () => {
		const room = await roomWithProposal("memory second write");
		writePersistentRoomMaintenanceSettings(room.agentId, { memoryBudgetTokens: 20000 });
		const doc = loadMemoryDocument(room.agentId).doc;
		const recordsBefore = memoryEditRecords(room.instance);
		doc.topics[0]!.entries.push({ ...(doc.topics[0]!.entries[0] ?? {}), id: "E-FIRST", text: "The first save's note." } as any);
		const settingsLocked = (target: unknown) => {
			if (/maintenance-settings\.json/.test(String(target))) throw new Error("injected: the settings file cannot be written");
		};
		(fs as any).writeFileSync = (file: any, ...rest: any[]) => { settingsLocked(file); return (realWriteFileSync as any)(file, ...rest); };
		(fs as any).renameSync = (from: any, to: any) => { settingsLocked(to); return realRenameSync(from, to); };
		try {
			writeMemoryDocument(room.agentId, doc, { why: "edit", snapshotLabel: "edit", limitTo: 30000 } as any);
			assert(fs.existsSync(path.join(room.instance.rootDir, "runtime", "commit", "memory.json")), "the first save's rest is pending");
			const second = loadMemoryDocument(room.agentId).doc;
			second.topics[0]!.entries.push({ ...(second.topics[0]!.entries[0] ?? {}), id: "E-SECOND", text: "The second save's note." } as any);
			writeMemoryDocument(room.agentId, second, { why: "edit", snapshotLabel: "edit" } as any);
		} finally {
			(fs as any).writeFileSync = realWriteFileSync;
			(fs as any).renameSync = realRenameSync;
		}
		nextRequest(room.agentId);
		const limit = readPersistentRoomMaintenanceSettings(room.agentId).memoryBudgetTokens;
		assert(limit === 30000, `the first save's raised limit lands, got ${limit}`);
		assert(memoryEditRecords(room.instance) === recordsBefore + 2, `both saves have their record, got ${memoryEditRecords(room.instance) - recordsBefore}`);
		assert(memoryOf(room.instance).includes("The second save's note.") && !fs.existsSync(path.join(room.instance.rootDir, "runtime", "commit", "memory.json")), "the second save lands, and nothing is left pending");
	});

	// --- 6a2. A next save never finishes an earlier save whose core never landed --
	// The first save crashes at its core file: nothing of it was saved. The
	// room's own settle before the next save fails once (its snapshot cannot be
	// removed yet), so the intent is still there when the next save starts: that
	// save neither raises the crashed save's limit nor writes its record, and its
	// snapshot goes.
	await section("a next save leaves out an earlier save whose core never landed", async () => {
		const room = await roomWithProposal("memory earlier not landed");
		writePersistentRoomMaintenanceSettings(room.agentId, { memoryBudgetTokens: 20000 });
		const first = loadMemoryDocument(room.agentId).doc;
		const second = structuredClone(first);
		const recordsBefore = memoryEditRecords(room.instance);
		const archiveDir = path.join(room.instance.rootDir, "L1b", "archive");
		const snapshotsBefore = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((name) => name.endsWith(".md")).length : 0;
		first.topics[0]!.entries.push({ ...(first.topics[0]!.entries[0] ?? {}), id: "E-LOST", text: "The crashed save's note." } as any);
		const crash = crashOnWrite(/[\\/]L1b[\\/]current\.md/);
		try {
			writeMemoryDocument(room.agentId, first, { why: "edit", snapshotLabel: "edit", limitTo: 30000 } as any);
		} catch {
			// the injected crash
		} finally {
			crash.restore();
		}
		assert(crash.hit() && fs.existsSync(path.join(room.instance.rootDir, "runtime", "commit", "memory.json")), "the crashed save left its intent");
		second.topics[0]!.entries.push({ ...(second.topics[0]!.entries[0] ?? {}), id: "E-NEXT", text: "The next save's note." } as any);
		const realRmSync = fs.rmSync;
		let settleBlocked = false;
		(fs as any).rmSync = (target: any, ...rest: any[]) => {
			if (!settleBlocked && /-before-edit_/.test(String(target))) {
				settleBlocked = true;
				throw new Error("injected: the snapshot cannot be removed yet");
			}
			return (realRmSync as any)(target, ...rest);
		};
		try {
			writeMemoryDocument(room.agentId, second, { why: "edit", snapshotLabel: "edit" } as any);
		} finally {
			(fs as any).rmSync = realRmSync;
		}
		assert(settleBlocked, "the room's settle met the crashed save");
		const limit = readPersistentRoomMaintenanceSettings(room.agentId).memoryBudgetTokens;
		assert(limit === 20000, `the crashed save's limit is not applied, got ${limit}`);
		assert(memoryEditRecords(room.instance) === recordsBefore + 1, `only the next save has a record, got ${memoryEditRecords(room.instance) - recordsBefore}`);
		const snapshotsAfter = fs.readdirSync(archiveDir).filter((name) => name.endsWith(".md")).length;
		assert(snapshotsAfter === snapshotsBefore + 1, `only the next save keeps a snapshot, got ${snapshotsAfter - snapshotsBefore}`);
		assert(!memoryOf(room.instance).includes("The crashed save's note.") && memoryOf(room.instance).includes("The next save's note.") && !fs.existsSync(path.join(room.instance.rootDir, "runtime", "commit", "memory.json")), "the next save lands alone, and nothing is left pending");
	});

	// --- 6b. A row taken out of the archive leaves it only once the core landed --
	// Restoring an archived row (a write that brings it back) and an undo (a
	// restore that takes its own rows back out) remove archive rows. A crash
	// before the core keeps the row in the archive; after it, the row goes.
	for (const write of ["a restore from the archive", "an undo"] as const) for (const step of [
		{ name: "the core file", pattern: /[\\/]L1b[\\/]current\.md/, landed: false },
		{ name: "the event record", pattern: /[\\/]events[\\/]memory-edit[\\/]/, landed: true },
	]) await section(`${write} crashed at ${step.name}`, async () => {
		const room = await roomWithProposal(`archive ${write} ${step.name}`);
		const doc = loadMemoryDocument(room.agentId).doc;
		const topic = doc.topics[0]!;
		const row = { ...(topic.entries[0] ?? {}), id: "E-ARCHIVED-1", text: "A note that waits in the archive." } as any;
		appendArchive(room.agentId, [{ entry: row, why: "user", topic: topic.title, section: topic.section }]);
		assert(readArchive(room.agentId).some((entry) => entry.id === row.id), "the row is in the archive before the write");
		const before = memoryOf(room.instance);
		const crash = crashOnWrite(step.pattern);
		let crashed = false;
		try {
			if (write === "a restore from the archive") {
				topic.entries.push(row);
				writeMemoryDocument(room.agentId, doc, { why: "edit", snapshotLabel: "edit", archiveRemoveIds: [row.id] } as any);
			} else {
				restoreMemoryFile(room.agentId, {
					restoredL1b: `${before}\n`, // other bytes than the core, so the settle can tell landed from not
					snapshotLabel: "undo",
					archiveRemoveIds: [row.id],
					eventRecord: ({ writeId }) => ({ eventRecordPath: room.instance.memoryEditEventRecordPath(writeId), record: { schemaVersion: 1, operation: "memory_edit", writeId } }),
				});
			}
		} catch {
			crashed = true;
		} finally {
			crash.restore();
		}
		assert(crash.hit() && (crashed || step.landed), `${write} writes ${step.name} (the crash should have struck there)`);
		nextRequest(room.agentId);
		const inArchive = readArchive(room.agentId).filter((entry) => entry.id === row.id).length;
		if (!step.landed) {
			assert(memoryOf(room.instance) === before, `${write} crashed at ${step.name} left the memory as it was`);
			assert(inArchive === 1, `${write} crashed at ${step.name} keeps the row in the archive, found ${inArchive}`);
		} else {
			assert(inArchive === 0, `${write} crashed at ${step.name} is finished: the row left the archive, found ${inArchive}`);
		}
		assert(!fs.existsSync(path.join(room.instance.rootDir, "runtime", "commit", "memory.json")), `no memory write is left pending after ${write} crashed at ${step.name}`);
	});

	// --- 6c. A row moved into the archive is there before it leaves the core --
	// A write that archives a row writes the archive first, then the core. A
	// crash between the two costs a duplicate, never the row.
	for (const step of [
		{ name: "the archive", pattern: /[\\/]archive[\\/]entries\.md/ },
		{ name: "the core file", pattern: /[\\/]L1b[\\/]current\.md/ },
	]) await section(`a write that archives a row crashed at ${step.name}`, async () => {
		const room = await roomWithProposal(`archive move ${step.name}`);
		const doc = loadMemoryDocument(room.agentId).doc;
		const topic = doc.topics[0]!;
		const row = { ...(topic.entries[0] ?? {}), id: "E-MOVING-1", text: "A note on its way to the archive." } as any;
		topic.entries.push(row);
		writeMemoryDocument(room.agentId, doc, { why: "edit", snapshotLabel: "edit" } as any);
		assert(memoryOf(room.instance).includes(row.text), "the row is in the core before the move");
		const moved = loadMemoryDocument(room.agentId).doc;
		const movedTopic = moved.topics[0]!;
		const leaving = movedTopic.entries.find((entry) => entry.id === row.id)!;
		movedTopic.entries = movedTopic.entries.filter((entry) => entry.id !== row.id);
		const crash = crashOnWrite(step.pattern);
		try {
			writeMemoryDocument(room.agentId, moved, { why: "edit", snapshotLabel: "edit", archiveAppend: [{ entry: leaving, why: "user", topic: movedTopic.title, section: movedTopic.section }] } as any);
		} catch {
			// the injected crash
		} finally {
			crash.restore();
		}
		assert(crash.hit(), `the write writes ${step.name} (the crash should have struck there)`);
		nextRequest(room.agentId);
		const inCore = memoryOf(room.instance).includes(row.text);
		const inArchive = readArchive(room.agentId).some((entry) => entry.id === row.id);
		assert(inCore || inArchive, `a write that archives a row crashed at ${step.name} lost the row: it is in neither the core nor the archive`);
		assert(!fs.existsSync(path.join(room.instance.rootDir, "runtime", "commit", "memory.json")), `no memory write is left pending after a crash at ${step.name}`);
	});

	// --- 7. Forget: closing the conversation is the commit point -------------
	const { writePersistentAgentMementoBoundary } = await import("../src/persistent-agents.js");
	const mementoRecords = (instance: ReturnType<typeof createPersistentAgentInstance>) => {
		const dir = path.join(instance.rootDir, "events", "memento");
		return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length : 0;
	};
	for (const step of [
		{ name: "the intent", pattern: /[\\/]runtime[\\/]commit[\\/]/, landed: false },
		{ name: "the close", pattern: /[\\/]threads[\\/]pi_commit_\d+\.json/, landed: false },
		{ name: "the close, torn mid-write", pattern: /[\\/]threads[\\/]pi_commit_\d+\.json/, landed: false, torn: true },
		{ name: "the fresh conversation", pattern: /postmem_/, landed: true },
		{ name: "the memento record", pattern: /[\\/]events[\\/]memento[\\/]/, landed: true },
	] as Array<{ name: string; pattern: RegExp; landed: boolean; torn?: boolean }>) await section(`a Forget crashed at ${step.name}`, async () => {
		const room = await roomWithProposal(`forget ${step.name}`);
		const crash = crashOnWrite(step.pattern, { torn: step.torn });
		let crashed = false;
		try {
			writePersistentAgentMementoBoundary(room.agentId, room.threadId, new Date(), { runtimeCwd: tempCwd });
		} catch {
			crashed = true;
		} finally {
			crash.restore();
		}
		assert(crash.hit() && crashed, `Forget writes ${step.name} (the crash should have struck there)`);
		nextRequest(room.agentId);
		const thread = getPersistentAgentThread(room.agentId, room.threadId);
		const active = getPersistentAgentRuntimeState(room.agentId).activeThreadId;
		if (!step.landed) {
			assert(thread?.state !== "closed" && active === room.threadId && mementoRecords(room.instance) === 0, `a Forget crashed at ${step.name} left the conversation open and untouched`);
			const again = writePersistentAgentMementoBoundary(room.agentId, room.threadId, new Date(), { runtimeCwd: tempCwd });
			assert(again.runtimeBoundary.closedThreadId === room.threadId && mementoRecords(room.instance) === 1, `after a Forget crashed at ${step.name}, Forget works again`);
		} else {
			assert(thread?.state === "closed" && thread.closedReason === "memento", `a Forget crashed at ${step.name} is finished: the conversation is closed as forgotten, got ${thread?.state}`);
			assert(active && active !== room.threadId && getPersistentAgentThread(room.agentId, active)?.state === "standby", `a Forget crashed at ${step.name} is finished: a fresh conversation is open`);
			assert(mementoRecords(room.instance) === 1, `a Forget crashed at ${step.name} is finished: one memento record, got ${mementoRecords(room.instance)}`);
		}
		assert(!fs.existsSync(path.join(room.instance.rootDir, "runtime", "commit", "forget.json")), `no Forget is left pending after a crash at ${step.name}`);
	});

	assert(failures.length === 0, `remember save commit smoke failed:\n${failures.join("\n")}`);
	console.log("remember save commit smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	exitCode = 1;
} finally {
	if (exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempCwd, { recursive: true, force: true });
	}
	process.exitCode = exitCode;
}
