// Forget means gone: every stored copy of a forgotten conversation's words is
// erased, and what stays is content free.
//
// The erase runs after Forget's commit point (the conversation closed as
// forgotten) and is the same for a new Forget, a Forget a crash left half done
// and a conversation forgotten before this release; the sweep finds those.
// Every step tolerates a missing file, so an erase stopped half way finishes
// the next time. What stays: the closed thread record with its items emptied
// (ids, model and times; a late save from a client cannot recreate a closed
// record), the memento event, a scheduled run's run.json (its status line),
// and files a task wrote into the room's shelf or the person's own folders.
//
// It works from the room folder alone, so the room's model code can call it
// without this module calling back.

import fs from "node:fs";
import path from "node:path";

import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

function readJson(file: string): any {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

function list(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

/**
 * Removes a file or folder; true when something was there. One that cannot go
 * now (on Windows, a file held open) never fails the Forget, which has landed:
 * the room is marked, and its sweep at the next start erases what was left.
 */
function remove(target: string): boolean {
	if (!fs.existsSync(target)) return false;
	try {
		fs.rmSync(target, { recursive: true, force: true });
	} catch (error) {
		heldBack += 1;
		console.error(`[forget] a forgotten file could not be deleted yet: ${(error as NodeJS.ErrnoException)?.code ?? "Error"}`);
	}
	return true;
}

/** Files a Forget could not delete yet, in this process; a room that held any back is swept again at the next start. */
let heldBack = 0;

function heldBackMark(roomDir: string): string {
	return path.join(roomDir, "runtime", "forget-held-back");
}

/** A path a record names, kept inside the room. */
function inRoom(roomDir: string, relPath: unknown): string | null {
	if (typeof relPath !== "string" || !relPath) return null;
	const resolved = path.resolve(roomDir, relPath);
	return resolved.startsWith(path.resolve(roomDir) + path.sep) ? resolved : null;
}

/** Which task notes and scheduled runs belong to which conversation, read once however many conversations are erased. */
interface ConversationStores {
	tasks: Map<string, Array<{ file: string; taskId: unknown }>>;
	runs: Map<string, string[]>;
}

function indexConversationStores(agentId: string, roomDir: string): ConversationStores {
	const stores: ConversationStores = { tasks: new Map(), runs: new Map() };
	const ledger = path.join(roomDir, "runtime", "task-ledger");
	for (const name of list(ledger)) {
		const row = name.endsWith(".json") ? readJson(path.join(ledger, name)) : null;
		if (typeof row?.conversationId === "string") stores.tasks.set(row.conversationId, [...(stores.tasks.get(row.conversationId) ?? []), { file: path.join(ledger, name), taskId: row.taskId }]);
	}
	const runs = productAppStatePath("background-runs", "runs");
	for (const runId of list(runs)) {
		const run = readJson(path.join(runs, runId, "run.json"));
		const threadId = run?.target?.threadId;
		if (typeof threadId === "string" && (!run?.scope?.roomId || run.scope.roomId === agentId)) stores.runs.set(threadId, [...(stores.runs.get(threadId) ?? []), path.join(runs, runId)]);
	}
	return stores;
}

/** Conversations this process erased: a turn or a job still running on one erases again when it ends. */
const ERASED = new Set<string>();

/**
 * Called when a turn or a job ends: what it wrote after its conversation was
 * forgotten goes too. Only while the record is gone or still the tombstone: a
 * deleted id a stale tab saved again is a live conversation.
 */
export function eraseAgainIfForgotten(agentId: string, roomDir: string, threadId: string): void {
	if (!ERASED.has(`${roomDir}\0${threadId}`)) return;
	if (fs.existsSync(path.join(roomDir, "runtime", "threads", `${threadId}.json`)) && !conversationForgotten(roomDir, threadId)) return;
	eraseConversationWords(agentId, roomDir, threadId);
}

/**
 * Erases one forgotten conversation's words. True when anything was erased,
 * so the sweep can count what it did.
 */
export function eraseConversationWords(agentId: string, roomDir: string, threadId: string, legacySessionFile?: string, stores = indexConversationStores(agentId, roomDir), kept: ReadonlySet<string> = new Set()): boolean {
	ERASED.add(`${roomDir}\0${threadId}`);
	const held = heldBack;
	try {
		return eraseWords(agentId, roomDir, threadId, legacySessionFile, stores, kept);
	} finally {
		if (heldBack > held) try { fs.writeFileSync(heldBackMark(roomDir), ""); } catch { /* the transcript check still finds a held transcript */ }
	}
}

function eraseWords(agentId: string, roomDir: string, threadId: string, legacySessionFile: string | undefined, stores: ConversationStores, kept: ReadonlySet<string>): boolean {
	const runtime = path.join(roomDir, "runtime");
	const threadFile = path.join(runtime, "threads", `${threadId}.json`);
	const thread = readJson(threadFile);
	let erased = false;
	const sessions = path.join(runtime, "pi-sessions");
	for (const file of [path.join(sessions, `${threadId}.jsonl`), path.join(sessions, `${threadId}.boot-prompt.txt`), inRoom(roomDir, thread?.runtime?.sessionFileRelPath), inRoom(roomDir, thread?.runtime?.bootPromptSnapshotRelPath), legacySessionFile ? inRoom(roomDir, legacySessionFile) : null]) {
		// A file a conversation that is not forgotten names as its own stays.
		if (file && !kept.has(file)) erased = remove(file) || erased;
	}
	// Leftovers of a write a crash cut short hold the same words.
	for (const name of list(sessions)) if (name.startsWith(`${threadId}.boot-prompt.txt.`)) erased = remove(path.join(sessions, name)) || erased;
	for (const name of list(path.dirname(threadFile))) if (name.startsWith(`${threadId}.json.tmp-`)) erased = remove(path.join(path.dirname(threadFile), name)) || erased;
	erased = remove(path.join(runtime, "remember", threadId)) || erased;
	erased = remove(path.join(runtime, "workspace-policies", `${threadId}.json`)) || erased;
	// The conversation's task notes and task folders.
	for (const task of stores.tasks.get(threadId) ?? []) {
		erased = remove(task.file) || erased;
		if (typeof task.taskId === "string") eraseForgottenTask(roomDir, task.taskId);
	}
	// A scheduled run keeps its status line, not its prompt and answer.
	for (const runDir of stores.runs.get(threadId) ?? []) {
		for (const name of list(runDir)) if (name === "input.md" || name === "output.md" || name.startsWith(".artifact.")) erased = remove(path.join(runDir, name)) || erased;
	}
	erased = remove(productAppStatePath("stream-traces", agentId, `${threadId.replace(/[^\w.-]/g, "_")}.jsonl`)) || erased;
	if (thread && (thread.items?.length || thread.pendingHandoffs)) {
		const { pendingHandoffs: _handoffs, ...kept } = thread;
		const tmp = `${threadFile}.tmp-${process.pid}-${Date.now()}`;
		try {
			fs.writeFileSync(tmp, `${JSON.stringify({ ...kept, items: [] }, null, 2)}\n`, { mode: 0o600 });
			fs.renameSync(tmp, threadFile);
		} catch (error) {
			heldBack += 1;
			console.error(`[forget] a forgotten conversation's record could not be emptied yet: ${(error as NodeJS.ErrnoException)?.code ?? "Error"}`);
		}
		erased = true;
	}
	return erased;
}

/** A forgotten conversation's task: its note and its folder. A task that ends after the Forget calls it again for what it wrote late. */
export function eraseForgottenTask(roomDir: string, taskId: string): void {
	if (!/^[\w-]{1,80}$/.test(taskId)) return;
	remove(productAppStatePath("artifacts", "tasks", taskId));
	remove(path.join(roomDir, "runtime", "task-ledger", `${taskId}.json`));
}

/** True when the conversation was forgotten: what a task started from it hands back is thrown away. */
export function conversationForgotten(roomDir: string, threadId: string): boolean {
	const thread = readJson(path.join(roomDir, "runtime", "threads", `${threadId}.json`));
	return thread?.state === "closed" && thread.closedReason === "memento";
}

const SWEPT = new Set<string>();

/**
 * Erases every conversation this room forgot, once per room per process: the
 * ones forgotten before this release, and any a late write brought back. It
 * never touches the active conversation or a transcript another conversation owns. A
 * room swept before, with no Forget since and nothing back, is skipped.
 */
export function sweepForgotten(agentId: string, roomDir: string): void {
	if (SWEPT.has(roomDir)) return;
	SWEPT.add(roomDir);
	const runtime = path.join(roomDir, "runtime");
	const stamp = path.join(runtime, "forget-sweep.json");
	try {
		const active = readJson(path.join(runtime, "state.json"))?.activeThreadId;
		// A transcript a Remember names, and the conversation it belongs to: Forget
		// deletes a forgotten conversation's own transcript, as the direct erase
		// does, never one that belongs to another conversation.
		const remembered = new Map<string, string>();
		for (const name of list(path.join(roomDir, "events", "checkpoint"))) {
			const boundary = readJson(path.join(roomDir, "events", "checkpoint", name))?.runtimeBoundary;
			if (typeof boundary?.oldSessionFileRelPath === "string") remembered.set(boundary.oldSessionFileRelPath, typeof boundary.closedThreadId === "string" ? boundary.closedThreadId : "");
		}
		const anothers = (threadId: unknown, transcript: unknown) => typeof transcript === "string" && remembered.has(transcript) && remembered.get(transcript) !== threadId;
		// Swept before, with no Forget since, no forgotten transcript back on
		// disk and nothing held back: nothing to do, and the conversations (the
		// heavy files) are not read again. Only the small event files are. Only a
		// record from before 0.14.3 names its transcript: a newer one names no
		// path, and a file a Forget could not delete marks the room instead.
		const stampedAt = fs.existsSync(stamp) ? fs.statSync(stamp).mtimeMs : null;
		if (stampedAt !== null) {
			const events = list(path.join(roomDir, "events", "memento")).map((name) => path.join(roomDir, "events", "memento", name));
			const since = events.some((file) => fs.statSync(file).mtimeMs > stampedAt);
			const back = events.some((file) => {
				const boundary = readJson(file)?.runtimeBoundary;
				const transcript = boundary?.oldSessionFileRelPath;
				return typeof transcript === "string" && !anothers(boundary?.closedThreadId, transcript) && boundary?.closedThreadId !== active && fs.existsSync(path.join(roomDir, transcript));
			});
			if (!since && !back && !fs.existsSync(heldBackMark(roomDir))) return;
		}
		const held = heldBack;
		const forgotten = new Map<string, string | undefined>();
		const kept = new Set<string>();
		for (const name of list(path.join(runtime, "threads"))) {
			const thread = name.endsWith(".json") ? readJson(path.join(runtime, "threads", name)) : null;
			if (typeof thread?.threadId !== "string") continue;
			if (thread.state === "closed" && thread.closedReason === "memento") forgotten.set(thread.threadId, undefined);
			else for (const own of [thread.runtime?.sessionFileRelPath, thread.runtime?.bootPromptSnapshotRelPath].map((rel) => inRoom(roomDir, rel))) if (own) kept.add(own);
		}
		for (const name of list(path.join(roomDir, "events", "memento"))) {
			const boundary = readJson(path.join(roomDir, "events", "memento", name))?.runtimeBoundary;
			if (typeof boundary?.closedThreadId === "string") forgotten.set(boundary.closedThreadId, boundary.oldSessionFileRelPath);
		}
		let count = 0;
		let stores: ConversationStores | undefined;
		for (const [threadId, legacy] of forgotten) {
			if (threadId === active || anothers(threadId, legacy)) continue;
			stores ??= indexConversationStores(agentId, roomDir);
			if (eraseConversationWords(agentId, roomDir, threadId, legacy, stores, kept)) count += 1;
		}
		if (heldBack === held) fs.rmSync(heldBackMark(roomDir), { force: true });
		if (!fs.existsSync(stamp)) {
			fs.writeFileSync(stamp, `${JSON.stringify({ version: 1, at: new Date().toISOString(), erased: count })}\n`, { mode: 0o600 });
			if (count > 0) console.log(`[forget] Deleted ${count === 1 ? "1 conversation" : `${count} conversations`} forgotten before this update.`);
		} else {
			// The stamp keeps what the first sweep found; its time says when the room was last swept.
			const now = new Date();
			fs.utimesSync(stamp, now, now);
		}
	} catch (error) {
		// A sweep that fails tries again on the next start; the room stays usable.
		SWEPT.delete(roomDir);
		console.error(`[forget] the sweep of a room could not finish: ${(error as Error)?.name ?? "Error"}`);
	}
}

/** Test seam: a smoke restarts the server by forgetting which rooms were swept. */
export function resetForgetSweepForTests(): void {
	SWEPT.clear();
}
