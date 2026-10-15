// Forget deletes the conversation for real. A room's conversation is planted
// in every store that can hold its words (the transcript, the thread record and
// its queued handoffs, a crash leftover, the Remember work, the workspace
// setting, a task row and its task folder, a scheduled run's prompt and
// answer, a stream trace), then forgotten; afterwards no file under the home
// holds its word, while the shelf file, the memento event and the run's status
// line stay. Then the one-time sweep: a conversation forgotten before this
// release is erased, a remembered transcript and the active conversation are
// left alone, an old unclaimed transcript goes, the sweep stamps once, and a
// transcript a late write recreated is erased on the next start.
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "forget-erase-home-"));
const appDir = path.join(tempHome, ".exxperts", "app");
const root = path.join(appDir, "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2));
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const agents = await import("../src/persistent-agents.js");
const { conversationForgotten, eraseConversationWords, eraseForgottenTask, resetForgetSweepForTests } = await import("../src/forget-erase.js");
const registry = await import("../src/persistent-room-specialist-registry.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const cwd = path.join(tempHome, "cwd");
fs.mkdirSync(cwd, { recursive: true });

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** Every file under the home that holds the word, with forward slashes on every system. */
function filesHolding(word: string): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (fs.readFileSync(file, "utf-8").includes(word)) found.push(path.relative(tempHome, file).split(path.sep).join("/"));
		}
	};
	walk(tempHome);
	return found;
}

/** A conversation with a session file, turns that carry the word, and the word in its saved items and handoffs. */
function converse(agentId: string, threadId: string, word: string, state: "active" | "standby" = "active"): void {
	const write = agents.writePersistentAgentThread(agentId, threadId, {
		state,
		origin: "home",
		model: MODEL,
		items: [{ kind: "user", id: "u1", text: `The code word is ${word}.` }],
	}, { createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd }) });
	assert(write.thread.runtime.kind === "pi-session-jsonl", `${threadId} is backed by a session file`);
	const session = agents.openPersistentAgentPiSessionManager(agentId, write.thread.runtime, cwd);
	session.appendMessage({ role: "user", content: `The code word is ${word}.`, timestamp: Date.now() } as any);
	session.appendMessage({ role: "assistant", content: [{ type: "text", text: `Noted: ${word}.` }], api: "responses", provider: MODEL.provider, model: MODEL.model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as any);
}

function plant(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

try {
	// --- A Forget erases every store ----------------------------------------------
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Forget Erase Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const room = path.join(root, agentId);
	const WORD = "QUILLARANTH";
	const threadId = "c_forget_0001";
	converse(agentId, threadId, WORD);
	agents.writePersistentAgentThread(agentId, threadId, { state: "active", pendingHandoffs: [`A handoff about ${WORD}.`] });
	plant(path.join(room, "runtime", "threads", `${threadId}.json.tmp-1-2`), `{"items":["${WORD}"]}`);
	plant(path.join(room, "runtime", "remember", threadId, "parts.json"), `{"notes":["${WORD}"]}`);
	plant(path.join(room, "runtime", "workspace-policies", `${threadId}.json`), JSON.stringify({ conversationId: threadId, folders: [] }));
	plant(path.join(room, "runtime", "task-ledger", "t_forget1.json"), JSON.stringify({ taskId: "t_forget1", conversationId: threadId, title: `Write up ${WORD}` }));
	plant(path.join(room, "runtime", "task-ledger", "t_other1.json"), JSON.stringify({ taskId: "t_other1", conversationId: "c_other", title: "Another conversation's task" }));
	plant(path.join(appDir, "artifacts", "tasks", "t_forget1", "inputs", "brief.md"), `Brief: ${WORD}`);
	plant(path.join(appDir, "artifacts", "tasks", "t_other1", "inputs", "brief.md"), "Another brief");
	const runDir = path.join(appDir, "background-runs", "runs", `bg_${"a".repeat(32)}`);
	plant(path.join(runDir, "run.json"), JSON.stringify({ runId: `bg_${"a".repeat(32)}`, status: "succeeded", target: { threadId }, scope: { roomId: agentId } }));
	plant(path.join(runDir, "input.md"), `Ask about ${WORD}`);
	plant(path.join(runDir, "output.md"), `The answer names ${WORD}`);
	plant(path.join(appDir, "stream-traces", agentId, `${threadId}.jsonl`), `{"text":"${WORD}"}\n`);
	plant(path.join(room, "files", "report.md"), "A report the task wrote onto the shelf: it stays.");
	assert(filesHolding(WORD).length >= 9, `the word is planted in every store, got ${JSON.stringify(filesHolding(WORD))}`);

	// A specialist task still running from the conversation, and one from another.
	const runningTask = (taskId: string, conversationId: string) => registry.registerSpecialistTask(agentId, { taskId, conversationId, templateId: "deck", templateVersion: 1, templateLabel: "Slide deck", title: "A deck", model: MODEL, abortController: new AbortController() });
	const forgottenTask = runningTask("t_forget1", threadId);
	const otherTask = runningTask("t_other1", "c_other");

	const result = agents.writePersistentAgentMementoBoundary(agentId, threadId, new Date("2026-10-08T10:00:00.000Z"), { runtimeCwd: cwd });
	// Forget is the trash icon: the conversation's running task stops and its result is thrown away.
	assert(forgottenTask.abortController.signal.aborted && forgottenTask.discarded === true && !forgottenTask.stoppedByUser, "Forget stops the conversation's running task and marks its result discarded");
	assert(!otherTask.abortController.signal.aborted && !otherTask.discarded, "another conversation's task keeps running");
	assert(conversationForgotten(room, threadId) && !conversationForgotten(room, "c_other"), "a task's handoff can tell its conversation was forgotten, even one that ended before the stop reached it");
	assert(filesHolding(WORD).length === 0, `after Forget no file holds the conversation's words, got ${JSON.stringify(filesHolding(WORD))}`);
	const tombstone = JSON.parse(fs.readFileSync(path.join(room, "runtime", "threads", `${threadId}.json`), "utf-8"));
	assert(tombstone.state === "closed" && tombstone.closedReason === "memento" && tombstone.items.length === 0 && !tombstone.pendingHandoffs, `the closed record stays with no words, got ${JSON.stringify(tombstone)}`);
	const event = JSON.parse(fs.readFileSync(path.join(room, "events", "memento", `${result.mementoId}.json`), "utf-8"));
	assert(event.runtimeBoundary.closedThreadId === threadId && !("oldSessionFileRelPath" in event.runtimeBoundary), `the memento event stays, naming no transcript path, got ${JSON.stringify(event.runtimeBoundary)}`);
	assert(fs.existsSync(path.join(runDir, "run.json")) && fs.existsSync(path.join(room, "files", "report.md")), "the run's status line and the shelf file stay");
	assert(fs.existsSync(path.join(room, "runtime", "task-ledger", "t_other1.json")) && fs.existsSync(path.join(appDir, "artifacts", "tasks", "t_other1")), "another conversation's task stays");
	// A turn that outlived the 5 s quiesce streamed into the deleted transcript: its end erases it again.
	plant(path.join(room, "runtime", "pi-sessions", `${threadId}.jsonl`), `{"text":"Late words about ${WORD}"}\n`);
	agents.finishPersistentAgentTurn(agentId, threadId, { terminalReason: "completed" });
	assert(filesHolding(WORD).length === 0, `the end of a turn on a forgotten conversation erases what it wrote late, got ${JSON.stringify(filesHolding(WORD))}`);
	// A task that writes after the erase leaves nothing once it ends.
	plant(path.join(appDir, "artifacts", "tasks", "t_forget1", "deck.md"), `Late slide about ${WORD}`);
	plant(path.join(room, "runtime", "task-ledger", "t_forget1.json"), JSON.stringify({ taskId: "t_forget1", conversationId: threadId, summary: WORD }));
	eraseForgottenTask(room, "t_forget1");
	assert(filesHolding(WORD).length === 0 && !fs.existsSync(path.join(appDir, "artifacts", "tasks", "t_forget1")), `a discarded task's late files and row are erased when it ends, got ${JSON.stringify(filesHolding(WORD))}`);
	registry.removeSpecialistTask(agentId, "t_forget1");
	registry.removeSpecialistTask(agentId, "t_other1");
	let refused = false;
	try { agents.writePersistentAgentThread(agentId, threadId, { state: "active", items: [{ kind: "user", id: "late", text: WORD }] }); } catch { refused = true; }
	assert(refused && filesHolding(WORD).length === 0, "a late save from a client cannot bring the conversation back");
	// Deleted, then a stale tab saves it again: the id is open and live, and a turn ending on it erases nothing.
	const REBORN = "CINDERWHARF";
	agents.deletePersistentAgentThread(agentId, threadId);
	converse(agentId, threadId, REBORN);
	agents.finishPersistentAgentTurn(agentId, threadId, { terminalReason: "completed" });
	const reborn = filesHolding(REBORN);
	assert(reborn.some((file) => file.endsWith(`pi-sessions/${threadId}.jsonl`)) && reborn.some((file) => file.endsWith(`threads/${threadId}.json`)), `an open conversation that reuses a forgotten id keeps its transcript and items, got ${JSON.stringify(reborn)}`);
	console.log("ok forget erases every store");

	// --- The sweep: conversations forgotten before this release -------------------
	const oldId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Forget Sweep Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const oldRoom = path.join(root, oldId);
	const OLD = "VELLUMORACLE";
	const KEPT = "HAWTHORNLEDGER";
	const LIVE = "MARIGOLDSPINDLE";
	// Remembered: closed for a Remember, named by its checkpoint event.
	converse(oldId, "c_remembered", KEPT);
	const rememberedFile = path.join(oldRoom, "runtime", "threads", "c_remembered.json");
	fs.writeFileSync(rememberedFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(rememberedFile, "utf-8")), state: "closed", closedReason: "checkpoint" }));
	plant(path.join(oldRoom, "events", "checkpoint", "cp_old.json"), JSON.stringify({ checkpointId: "cp_old", runtimeBoundary: { closedThreadId: "c_remembered", oldSessionFileRelPath: "runtime/pi-sessions/c_remembered.jsonl" } }));
	// Forgotten by 0.14.2: the thread closed as forgotten with its words, its transcript left, the event naming its path.
	converse(oldId, "c_forgotten", OLD, "standby");
	agents.closePersistentAgentThreadForMemento(oldId, "c_forgotten", "mm_old");
	plant(path.join(oldRoom, "events", "memento", "mm_old.json"), JSON.stringify({ mementoId: "mm_old", runtimeBoundary: { closedThreadId: "c_forgotten", oldSessionFileRelPath: "runtime/pi-sessions/c_forgotten.jsonl" } }));
	// Remembered, then it went on, then forgotten: Forget deletes its whole transcript, as the direct erase does.
	const MOVED = "QUARTZLANTERN";
	converse(oldId, "c_moved_0001", MOVED, "standby");
	plant(path.join(oldRoom, "events", "checkpoint", "cp_moved.json"), JSON.stringify({ checkpointId: "cp_moved", runtimeBoundary: { closedThreadId: "c_moved_0001", oldSessionFileRelPath: "runtime/pi-sessions/c_moved_0001.jsonl" } }));
	agents.closePersistentAgentThreadForMemento(oldId, "c_moved_0001", "mm_moved");
	plant(path.join(oldRoom, "events", "memento", "mm_moved.json"), JSON.stringify({ mementoId: "mm_moved", runtimeBoundary: { closedThreadId: "c_moved_0001", oldSessionFileRelPath: "runtime/pi-sessions/c_moved_0001.jsonl" } }));
	// The conversation open now.
	converse(oldId, "c_live_0001", LIVE);
	// Unnamed is not forgotten: an old CLI /new or /branch transcript, and one whose record does not read, both stay.
	const UNNAMED = "PEWTERCOMPASS";
	const cliFile = path.join(oldRoom, "runtime", "pi-sessions", "2026-01-01T10-00-00-000Z_0b1c2d3e.jsonl");
	const brokenFile = path.join(oldRoom, "runtime", "pi-sessions", "c_broken.jsonl");
	plant(cliFile, `{"text":"${UNNAMED} on a branch"}\n`);
	plant(brokenFile, `{"text":"${UNNAMED} with a broken record"}\n`);
	plant(path.join(oldRoom, "runtime", "threads", "c_broken.json"), "{ not json");
	for (const file of [cliFile, brokenFile]) fs.utimesSync(file, new Date("2026-01-01"), new Date("2026-01-01"));
	plant(path.join(oldRoom, "runtime", "pi-sessions", "c_orphan_new.jsonl"), "{}\n");
	assert(filesHolding(OLD).length >= 2, `the old conversation's words are on disk before the update, got ${JSON.stringify(filesHolding(OLD))}`);

	// A room saved by 0.14.2 has no stamp; the setup above already read this room's status once.
	fs.rmSync(path.join(oldRoom, "runtime", "forget-sweep.json"), { force: true });
	resetForgetSweepForTests();
	agents.getPersistentAgentStatus(oldId);
	assert(filesHolding(OLD).length === 0, `the first start erases the conversation forgotten before the update, got ${JSON.stringify(filesHolding(OLD))}`);
	assert(filesHolding(KEPT).length > 0 && filesHolding(LIVE).length > 0, "the remembered transcript and the open conversation are untouched");
	assert(filesHolding(MOVED).length === 0, `a conversation remembered and then forgotten loses its whole transcript, got ${JSON.stringify(filesHolding(MOVED))}`);
	assert(fs.existsSync(path.join(oldRoom, "runtime", "pi-sessions", "c_orphan_new.jsonl")), "a transcript being written now is left alone");
	assert(fs.existsSync(cliFile) && fs.existsSync(brokenFile) && filesHolding(UNNAMED).length === 2, `a transcript nothing names is never deleted, however old, got ${JSON.stringify(filesHolding(UNNAMED))}`);
	const stamp = fs.readFileSync(path.join(oldRoom, "runtime", "forget-sweep.json"), "utf-8");
	assert(JSON.parse(stamp).erased === 2, `the sweep stamps what it erased, got ${stamp}`);
	// A late write recreates the forgotten transcript; the next start erases it and stamps nothing new.
	plant(path.join(oldRoom, "runtime", "pi-sessions", "c_forgotten.jsonl"), `{"text":"${OLD}"}\n`);
	resetForgetSweepForTests();
	agents.getPersistentAgentStatus(oldId);
	assert(filesHolding(OLD).length === 0 && fs.readFileSync(path.join(oldRoom, "runtime", "forget-sweep.json"), "utf-8") === stamp, "a recreated transcript is erased on the next start, and the stamp stays as it was");
	// With the stamp and no Forget since, a start does not read the conversations again.
	const QUIET = "LANTERNQUIET";
	converse(oldId, "c_unswept", QUIET, "standby");
	agents.closePersistentAgentThreadForMemento(oldId, "c_unswept", "mm_unswept");
	converse(oldId, "c_live_0002", "OTHERLIVE");
	const old = new Date(Date.now() - 60_000);
	fs.utimesSync(path.join(oldRoom, "runtime", "forget-sweep.json"), new Date(), new Date());
	for (const name of fs.readdirSync(path.join(oldRoom, "events", "memento"))) fs.utimesSync(path.join(oldRoom, "events", "memento", name), old, old);
	resetForgetSweepForTests();
	agents.getPersistentAgentStatus(oldId);
	assert(filesHolding(QUIET).length > 0, "no Forget since the stamp: the start skips the sweep");
	// A Forget after the stamp: the next start sweeps again.
	plant(path.join(oldRoom, "events", "memento", "mm_unswept.json"), JSON.stringify({ mementoId: "mm_unswept", runtimeBoundary: { closedThreadId: "c_unswept", oldSessionFileRelPath: "runtime/pi-sessions/c_unswept.jsonl" } }));
	fs.utimesSync(path.join(oldRoom, "events", "memento", "mm_unswept.json"), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
	resetForgetSweepForTests();
	agents.getPersistentAgentStatus(oldId);
	assert(filesHolding(QUIET).length === 0, `a Forget newer than the stamp sweeps on the next start, got ${JSON.stringify(filesHolding(QUIET))}`);
	console.log("ok the sweep erases what was forgotten before, and only that");

	// --- A file that cannot go yet does not fail the Forget ---------------------------
	// (Windows: a file held open.) The conversation is forgotten; the rest is erased.
	// chmod has no teeth on Windows or as root (the Linux gate runs as root), so
	// the refusal is only forced where the file system will honour it.
	const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
	if (canForceFsRefusal) {
		const heldRoomId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Forget Held Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		const heldRoom = path.join(root, heldRoomId);
		const HELD = "VELLORANTHIS";
		converse(heldRoomId, "c_held_0001", HELD);
		plant(path.join(heldRoom, "runtime", "remember", "c_held_0001", "parts.json"), `{"notes":["${HELD}"]}`);
		const locked = path.join(heldRoom, "runtime", "remember", "c_held_0001");
		fs.chmodSync(locked, 0o500);
		let failed: unknown = null;
		try {
			agents.writePersistentAgentMementoBoundary(heldRoomId, "c_held_0001", new Date("2026-10-08T12:00:00.000Z"), { runtimeCwd: cwd });
			// A start while the file is still held sweeps and fails again.
			resetForgetSweepForTests();
			agents.getPersistentAgentStatus(heldRoomId);
		} catch (error) { failed = error; } finally { fs.chmodSync(locked, 0o700); }
		assert(failed === null, `a Forget that landed reads as done, got ${failed instanceof Error ? failed.message : failed}`);
		assert(conversationForgotten(heldRoom, "c_held_0001"), "the conversation is forgotten");
		assert(!filesHolding(HELD).some((file) => file.includes("pi-sessions")), `the transcript is erased though another file was held, got ${JSON.stringify(filesHolding(HELD))}`);
		// The next start, the file free, erases what was held back.
		resetForgetSweepForTests();
		agents.getPersistentAgentStatus(heldRoomId);
		assert(filesHolding(HELD).length === 0, `the next start erases what was held back, got ${JSON.stringify(filesHolding(HELD))}`);
		console.log("ok a file that cannot be deleted yet does not fail the Forget");

		// The conversation's record that cannot be emptied yet (Windows: a rename
		// refused while another reader holds it) is held back too, so the next start sweeps.
		const RECORD = "QUANDERMILT";
		converse(heldRoomId, "c_record_0001", RECORD);
		const threads = path.join(heldRoom, "runtime", "threads");
		fs.rmSync(path.join(heldRoom, "runtime", "forget-held-back"), { force: true });
		fs.chmodSync(threads, 0o500);
		try {
			eraseConversationWords(heldRoomId, heldRoom, "c_record_0001");
		} finally { fs.chmodSync(threads, 0o700); }
		assert(fs.readFileSync(path.join(threads, "c_record_0001.json"), "utf-8").includes(RECORD), "the record still holds the words, as on Windows");
		assert(fs.existsSync(path.join(heldRoom, "runtime", "forget-held-back")), "a record that could not be emptied is marked held back, so the next start sweeps");
		console.log("ok a record that cannot be emptied yet is held back");
	} else console.log("forget erase smoke: the held-file checks skipped (folder modes have no effect on Windows or as root)");
	{
		// A forgotten record that names a transcript a kept conversation names as its own: the sweep never deletes it.
		const sharedId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Forget Shared Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		const sharedRoom = path.join(root, sharedId);
		const SHARED = "COBALTWEATHERVANE";
		converse(sharedId, "c_kept_0001", SHARED, "standby");
		const keptRecord = JSON.parse(fs.readFileSync(path.join(sharedRoom, "runtime", "threads", "c_kept_0001.json"), "utf-8"));
		const keptTranscript = keptRecord.runtime.sessionFileRelPath as string;
		converse(sharedId, "c_live_0003", "OTHERLIVE");
		plant(path.join(sharedRoom, "events", "memento", "mm_shared.json"), JSON.stringify({ mementoId: "mm_shared", runtimeBoundary: { closedThreadId: "c_gone_0001", oldSessionFileRelPath: keptTranscript } }));
		fs.rmSync(path.join(sharedRoom, "runtime", "forget-sweep.json"), { force: true });
		resetForgetSweepForTests();
		agents.getPersistentAgentStatus(sharedId);
		assert(fs.existsSync(path.join(sharedRoom, keptTranscript)) && filesHolding(SHARED).length > 0, `a transcript a kept conversation names stays, got ${JSON.stringify(filesHolding(SHARED))}`);
		console.log("ok a transcript a kept conversation names is never swept");
	}
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
console.log("forget-erase smoke passed");
