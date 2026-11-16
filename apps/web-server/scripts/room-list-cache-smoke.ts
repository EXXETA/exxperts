// A room list's row cache (persistent-agent-row-cache.ts): a listed row is
// always the row a cold describe gives, on a miss and on a hit.
//
//   S. every room shape: never stamped, stamped, archived, without L1b, with an
//      active conversation, with an empty one, with a scheduled run's answer
//      unseen: the first list (a miss) and a later one (a hit, the row kept)
//      each give the cold row;
//   W. every writer that changes what a list shows, through its real path:
//      the row is kept, the writer runs, and the next list gives the cold row.
//      A hand edit stands for Memorize, Review and their undo, which change the
//      same files (L1b, the archive) through the same commit and need a model
//      run or a Memorize save first. The room lock, a detached answer and the room's model rows are not in a
//      list row: the room list's route adds them to each row on every request;
//   K. what no file holds, read again on every hit or compared with what the
//      row was built with: a file that appears where none was, the running
//      state behind activeThread, the unseen-answer marker's self-heal, the
//      schedule summary as the clock moves, and the last-used time; and a
//      fingerprinted file that could not be read, whose row is not served once
//      it can be;
//   G. the one-room status, its route and both entry gates never read a kept
//      row: a kept row that no longer matches its files reaches the list (the
//      control) and none of them;
//   P. a miss in every shape touches no file outside the row's fingerprint,
//      apart from the settle before it and the last-used read: Node's fs calls
//      recorded (reads, stats, exists, folder reads, a rename by its target, a
//      link);
//   B. at most LIST_ROW_CACHE_LIMIT rows are kept, the oldest dropped first.
//
// Offline: no model is called, no port is opened (the routes are injected).

import { deepStrictEqual } from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { SMOKE_SERVER_AUTH_ENV } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "room-list-cache-home-"));
const appDir = path.join(tempHome, ".exxperts", "app");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const roomsRoot = path.join(appDir, "personalized-agents");
const tempCwd = path.join(tempHome, "cwd");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = roomsRoot;
// The app's state follows these before HOME: left set, the smoke would write into the profile they name.
delete process.env.EXXPERTS_DATA_DIR;
delete process.env.EXXPERTS_STATE_HOME;
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV);
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(tempCwd, { recursive: true });

const MODEL = { provider: "anthropic", model: "claude-opus-5-5", label: "Claude Opus 5.5" };
const APPROVED_PAGE = "### RC-DRAFT | CLOSED | 2026-10-08 | The logo\n\n**Session arc:** We picked a logo.\n\n**Body:**\n- The blue logo was chosen.\n\n**Parked:**\nNone\n";

const agents = await import("../src/persistent-agents.js");
const statusModule = await import("../src/persistent-agent-status.js");
const { cachedListRow, cachedListRowPaths, cachedListRowCount, LIST_ROW_CACHE_LIMIT } = await import("../src/persistent-agent-row-cache.js");
const { recordPersistentRoomLastUsed, persistentRoomLastUsedPath } = await import("../src/persistent-room-last-used.js");
const { getUsablePersistentAgentStatusForNormalUse } = await import("../src/room-status.js");
const { persistentRoomMaintenanceSettingsPath, readPersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
const { settleRoom } = await import("../src/room-settle.js");
const { resetForgetSweepForTests } = await import("../src/forget-erase.js");
const { addPersistentRoomScheduleJob, persistentRoomScheduleStorePath } = await import("../../../pi-package/extensions/schedule-prompt/index.js");
await Promise.all(["room-routes", "room-schedule-routes", "room-settings-routes"].map((name) => import(`../src/${name}.js`)));
const { app, AUTH_HEADER_NAME, AUTH_TOKEN } = await import("../src/server-app.js");
app.log.level = "silent";
const { listPersistentAgents, describePersistentAgent, listRowOf, getPersistentAgentStatus, assertPersistentAgentAcceptsSession } = statusModule;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const failures: string[] = [];
// chmod has no teeth on Windows or as root (the Linux release gate runs as root): the rows that stage a refused
// read or write run on the other legs.
const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
async function row(id: string, label: string, run: () => Promise<void> | void): Promise<void> {
	try {
		await run();
		console.log(`  ok  ${id} ${label}`);
	} catch (error) {
		failures.push(`${id} ${label}: ${error instanceof Error ? error.message : String(error)}`);
		console.log(`  FAIL ${id} ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function request(method: "GET" | "POST" | "PUT", url: string, payload?: object): Promise<{ status: number; json: any }> {
	const answer = await app.inject({ method, url, headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN }, ...(payload ? { payload } : {}) });
	return { status: answer.statusCode, json: JSON.parse(answer.body) };
}

// --- Rooms -------------------------------------------------------------------------

let made = 0;
const instanceOf = (agentId: string) => agents.createPersistentAgentInstance(agentId);

function bareRoom(label: string): string {
	made += 1;
	return agents.createPersistentAgentFromScaffoldInput({ displayName: `Cache ${label} ${made}`, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
}

/** A conversation as the page saves it: `keepPointer` writes one that is not the room's open one. */
function conversation(agentId: string, threadId: string, items: unknown[], keepPointer = false): void {
	const write = agents.writePersistentAgentThread(agentId, threadId, { state: "active", origin: "home", model: MODEL, items }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
		...(keepPointer ? { keepRuntimeIfMoved: true } : {}),
	});
	if (!items.length) return;
	const session = agents.openPersistentAgentPiSessionManager(agentId, write.thread.runtime as any, tempCwd);
	session.appendMessage({ role: "user", content: "Pick a logo.", timestamp: Date.now() } as any);
	session.appendMessage({ role: "assistant", content: [{ type: "text", text: "The blue one." }], api: "responses", provider: MODEL.provider, model: MODEL.model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as any);
}

const TURN = [{ kind: "user", id: "u1", text: "Pick a logo." }, { kind: "assistant", id: "a1", text: "The blue one." }];

/** A room with one open conversation that has a visible turn. */
function roomWithConversation(label: string): { agentId: string; threadId: string } {
	const agentId = bareRoom(label);
	const threadId = `c_cache_${made}`;
	conversation(agentId, threadId, TURN);
	return { agentId, threadId };
}

/** The body a Save sends for the room's open conversation. */
async function approvalBody(agentId: string, threadId: string): Promise<object> {
	const proposal = await agents.buildCheckpointProposal({ agentId, conversationId: threadId, model: MODEL, density: "standard", items: [{ kind: "user", text: "Pick a logo." }], runtimeCwd: tempCwd },
		async () => ({ text: "TITLE:\nThe logo\n\nSESSION_ARC:\nWe picked a logo.\n\nBODY:\n- The blue logo was chosen.\n\nPARKED:\nNone\n", usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } }));
	return { conversationId: threadId, model: MODEL, density: proposal.density, proposal, approvedRecentContext: APPROVED_PAGE };
}

/** Runs a Forget and cuts it off where a kill would, after its intent is written: the save stays pending. */
function crashedForget(agentId: string, threadId: string): void {
	const names = ["writeFileSync", "renameSync", "rmSync", "unlinkSync", "mkdirSync", "copyFileSync", "openSync"] as const;
	const real = new Map<string, any>(names.map((name) => [name, (fs as any)[name]]));
	let dead = false;
	for (const name of names) {
		(fs as any)[name] = (...args: any[]) => {
			const target = String(args[name === "renameSync" ? 1 : 0]);
			const writes = name !== "openSync" || (args[1] !== undefined && args[1] !== "r");
			dead ||= writes && /[\\/]postmem_[^\\/]*\.boot-prompt\.txt$/.test(target);
			if (dead) throw new Error("killed");
			return real.get(name)(...args);
		};
	}
	syncBuiltinESMExports();
	try {
		agents.writePersistentAgentMementoBoundary(agentId, threadId, new Date(), { runtimeCwd: tempCwd });
		throw new Error("the Forget was not cut off");
	} catch (error) {
		if (!/\bkilled$/.test((error as Error).message)) throw error;
	} finally {
		for (const name of names) (fs as any)[name] = real.get(name);
		syncBuiltinESMExports();
	}
}

// --- Lists ---------------------------------------------------------------------------

const listed = (agentId: string) => listPersistentAgents(new Set([agentId])).find((room) => room.id === agentId);
const cold = (agentId: string) => listRowOf(describePersistentAgent(agentId, { forList: true }));
const kept = (agentId: string): boolean => cachedListRowPaths(agentId) !== null;

/** Lists the room until its row is kept: a describe that repairs (the budget's first settle, the last-used estimate) keeps nothing, the next one does. */
function keep(agentId: string): void {
	for (let tries = 0; tries < 3 && !kept(agentId); tries += 1) listed(agentId);
	assert(kept(agentId), `the row of ${agentId} is never kept`);
}

/** The list's row for the room is the cold describe's. */
function listsAsCold(agentId: string, what: string): void {
	const row = listed(agentId);
	assert(row, `${what}: the room is not listed`);
	deepStrictEqual(row, cold(agentId), `${what}: the listed row is not the cold describe's`);
}

/** A kept row, then `write`, then the next list gives the cold row. */
async function afterWrite(agentId: string, write: () => unknown): Promise<void> {
	keep(agentId);
	listsAsCold(agentId, "before the write (a hit)");
	await write();
	listsAsCold(agentId, "after the write");
}

/** Read and write access off a folder for `run`, so a write in it fails once, as a full disk or a lost permission would. */
function withFolderReadOnly(folder: string, run: () => void): void {
	if (!canForceFsRefusal) throw new Error("withFolderReadOnly runs only where chmod can refuse a write: not on Windows, not as root");
	fs.chmodSync(folder, 0o555);
	try {
		run();
	} finally {
		fs.chmodSync(folder, 0o755);
	}
}

/** The fs calls made while `run` runs, as [kind, path, the call's stack]. */
function fileCallsDuring(run: () => unknown): Array<[string, string, string]> {
	const kinds: Record<string, (args: any[]) => string> = {
		readFileSync: (args) => String(args[0]),
		statSync: (args) => String(args[0]),
		lstatSync: (args) => String(args[0]),
		existsSync: (args) => String(args[0]),
		readdirSync: (args) => String(args[0]),
		accessSync: (args) => String(args[0]),
		renameSync: (args) => String(args[1]),
		linkSync: (args) => String(args[1]),
	};
	const real = new Map<string, any>(Object.keys(kinds).map((name) => [name, (fs as any)[name]]));
	const calls: Array<[string, string, string]> = [];
	for (const [name, target] of Object.entries(kinds)) {
		(fs as any)[name] = (...args: any[]) => {
			calls.push([name, target(args), String(new Error().stack)]);
			return real.get(name)(...args);
		};
	}
	syncBuiltinESMExports();
	const stackLimit = Error.stackTraceLimit;
	Error.stackTraceLimit = 100;
	try {
		run();
	} finally {
		Error.stackTraceLimit = stackLimit;
		for (const name of Object.keys(kinds)) (fs as any)[name] = real.get(name);
		syncBuiltinESMExports();
	}
	return calls;
}

try {
	// --- The shapes --------------------------------------------------------------------
	const neverStamped = bareRoom("Never stamped");
	const stamped = roomWithConversation("Stamped");
	recordPersistentRoomLastUsed(stamped.agentId, "server");
	const archived = roomWithConversation("Archived");
	agents.archivePersistentAgent(archived.agentId, { confirmation: `DELETE ${archived.agentId}` });
	const withoutL1b = bareRoom("Without L1b");
	fs.rmSync(instanceOf(withoutL1b).l1bCurrentPath(instanceOf(withoutL1b).readAgentJson()));
	const active = roomWithConversation("Active");
	const empty = bareRoom("Empty");
	conversation(empty, `c_cache_empty_${made}`, []);
	const scheduled = roomWithConversation("Scheduled");
	const scheduledRun = `c_cache_run_${made}`;
	conversation(scheduled.agentId, scheduledRun, TURN, true);
	agents.recordPersistentAgentUnseenLandedAnswer(scheduled.agentId, { threadId: scheduledRun, turnId: "t1", terminalReason: "completed", origin: "scheduled-run" });
	const shapes: Array<[string, string]> = [["never stamped", neverStamped], ["stamped", stamped.agentId], ["without L1b", withoutL1b], ["with an active conversation", active.agentId], ["with an empty conversation", empty], ["with a scheduled run's answer unseen", scheduled.agentId]];

	// The path guard runs first: every shape's first list is a miss.
	for (const [shape, agentId] of shapes) {
		await row("P1", `a miss in a room ${shape} touches no file outside its row's fingerprint, the settle before it and the last-used read`, () => {
			const instance = instanceOf(agentId);
			const lastUsed = persistentRoomLastUsedPath(agentId);
			// The last-used time is read on every list, never fingerprinted: the stamp, else the conversations the estimate
			// reads and the stamp it writes (its folder made sure of, a temporary file linked in). Allowed only from inside
			// that read, by the call's stack: the same paths read anywhere else in the describe are held to the fingerprint.
			const lastUsedPath = (file: string) => file === lastUsed || file === instance.runtimeThreadsDir() || path.dirname(file) === instance.runtimeThreadsDir() || file === instance.runtimeDir() || file.startsWith(`${lastUsed}.tmp-`);
			const lastUsedRead = (file: string, stack: string) => lastUsedPath(file) && /persistent-room-last-used\.ts|estimatePersistentRoomLastUsed/.test(stack);
			const settle = new Set(fileCallsDuring(() => settleRoom(agentId)).map(([, file]) => file));
			assert(!kept(agentId), "the row is kept before its first list");
			const calls = fileCallsDuring(() => listed(agentId));
			const fingerprint = new Set(cachedListRowPaths(agentId) ?? []);
			// A first describe that repairs keeps no row: the next list's fingerprint is the one its reads are held to.
			if (!fingerprint.size) {
				listed(agentId);
				for (const file of cachedListRowPaths(agentId) ?? []) fingerprint.add(file);
			}
			assert(fingerprint.size, "no row is kept after two lists");
			const outside = calls.filter(([, file, stack]) => file !== roomsRoot && !settle.has(file) && !fingerprint.has(file) && !lastUsedRead(file, stack));
			assert(outside.length === 0, `outside the fingerprint: ${JSON.stringify(outside.map(([kind, file]) => [kind, file]))}`);
		});
	}

	for (const [shape, agentId] of shapes) {
		await row("S1", `a room ${shape}: the list gives the cold row on a miss and, once kept, on a hit`, () => {
			listsAsCold(agentId, "a miss");
			keep(agentId);
			listsAsCold(agentId, "a hit");
		});
	}
	await row("S2", "an archived room is never listed nor kept", () => {
		assert(!listed(archived.agentId) && !kept(archived.agentId), "the archived room is listed or kept");
	});

	// --- The writers -------------------------------------------------------------------
	await row("W1", "create: a new room is listed with the cold row", () => {
		const created = roomWithConversation("Created");
		listsAsCold(created.agentId, "a new room");
	});
	await row("W2", "rename (agent.json, L1a, L1b)", async () => {
		const room = roomWithConversation("Rename");
		await afterWrite(room.agentId, () => agents.renamePersistentAgent(room.agentId, "Cache renamed room"));
	});
	await row("W3", "archive (agent.json, state.json): the room leaves the list; restore (agent.json): it comes back with the cold row", async () => {
		const room = roomWithConversation("Archive");
		keep(room.agentId);
		agents.archivePersistentAgent(room.agentId, { confirmation: `DELETE ${room.agentId}` });
		assert(!listed(room.agentId), "the archived room is listed");
		agents.restorePersistentAgent(room.agentId);
		listsAsCold(room.agentId, "after the restore");
	});
	await row("W4", "delete for good: the room leaves the list", () => {
		const room = roomWithConversation("Purge");
		keep(room.agentId);
		agents.archivePersistentAgent(room.agentId, { confirmation: `DELETE ${room.agentId}` });
		agents.purgePersistentAgent(room.agentId, { confirmation: `DELETE ${room.agentId} FOREVER` });
		assert(!listPersistentAgents("every room").some((listedRoom) => listedRoom.id === room.agentId), "the deleted room is listed");
	});
	await row("W5", "Forget (state.json, the new conversation's record, L1b)", async () => {
		const room = roomWithConversation("Forget");
		await afterWrite(room.agentId, () => agents.writePersistentAgentMementoBoundary(room.agentId, room.threadId, new Date(), { runtimeCwd: tempCwd }));
	});
	await row("W6", "Remember (L1b, agent.json, state.json, the records)", async () => {
		const room = roomWithConversation("Remember");
		const body = await approvalBody(room.agentId, room.threadId);
		await afterWrite(room.agentId, () => {
			const parsed = agents.parseCheckpointApprovalRequest(body, room.agentId);
			agents.writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date(), { runtimeCwd: tempCwd });
		});
	});
	await row("W7", "a hand edit of the memory, through its route (L1b)", async () => {
		const room = roomWithConversation("Hand edit");
		await afterWrite(room.agentId, async () => {
			const added = await request("POST", `/api/persistent-agents/${room.agentId}/memory/entries`, { topic: "Commercial terms", kind: "fact", text: "- Payment terms are 30 days net." });
			assert(added.status === 200, `the hand edit: ${added.status} ${JSON.stringify(added.json)}`);
		});
	});
	await row("W8", "the memory limit, through its route (maintenance settings)", async () => {
		const room = roomWithConversation("Limit");
		await afterWrite(room.agentId, async () => {
			const saved = await request("PUT", `/api/persistent-agents/${room.agentId}/maintenance-settings`, { memoryBudgetTokens: 15_000 });
			assert(saved.status === 200, `the limit: ${saved.status} ${JSON.stringify(saved.json)}`);
		});
	});
	await row("W9", "a turn starts (the running state, last-used.json), stops and ends (the running state)", async () => {
		const room = roomWithConversation("Turn");
		let turnId: string | undefined;
		await afterWrite(room.agentId, () => {
			turnId = agents.beginPersistentAgentTurn(room.agentId, room.threadId).turnId;
		});
		await afterWrite(room.agentId, () => agents.markPersistentAgentTurnCancelling(room.agentId, room.threadId));
		await afterWrite(room.agentId, () => agents.finishPersistentAgentTurn(room.agentId, room.threadId, { turnId, terminalReason: "cancelled" }));
	});
	await row("W10", "an answer lands unseen (the marker), and a bind clears it (the marker)", async () => {
		const room = roomWithConversation("Unseen");
		await afterWrite(room.agentId, () => agents.recordPersistentAgentUnseenLandedAnswer(room.agentId, { threadId: room.threadId, turnId: "t1", terminalReason: "completed" }));
		assert(listed(room.agentId)?.unseenLandedAnswer, "no badge after the landing");
		await afterWrite(room.agentId, () => agents.clearPersistentAgentUnseenLandedAnswerForBind(room.agentId, room.threadId));
	});
	await row("W11", "a conversation saved (its record), and switched to another (state.json, the new record)", async () => {
		const room = roomWithConversation("Switch");
		await afterWrite(room.agentId, () => agents.writePersistentAgentThread(room.agentId, room.threadId, { state: "active", origin: "unknown", items: [...TURN, { kind: "user", id: "u2", text: "And the font?" }] }));
		await afterWrite(room.agentId, () => conversation(room.agentId, `c_cache_next_${made}`, []));
	});
	await row("W12", "a scheduled task added (schedules.json), and a scheduled run's answer landing unseen in its own conversation (the marker)", async () => {
		const room = roomWithConversation("Schedule");
		await afterWrite(room.agentId, () => addPersistentRoomScheduleJob(room.agentId, { name: "Morning summary", type: "once", schedule: "+30m", prompt: "Summarise the morning." }));
		const run = `c_cache_run_${made}`;
		conversation(room.agentId, run, TURN, true);
		await afterWrite(room.agentId, () => agents.recordPersistentAgentUnseenLandedAnswer(room.agentId, { threadId: run, turnId: "t2", terminalReason: "completed", origin: "scheduled-run" }));
	});
	await row("W13", "an unreadable schedule store, then repaired (schedules.json): the warning goes with it", async () => {
		const room = roomWithConversation("Schedule store");
		const store = persistentRoomScheduleStorePath(room.agentId);
		await afterWrite(room.agentId, () => {
			fs.mkdirSync(path.dirname(store), { recursive: true });
			fs.writeFileSync(store, "{ not json");
		});
		assert(listed(room.agentId)?.warnings.some((warning) => warning.startsWith("schedule summary unavailable")), "no warning for the unreadable store");
		await afterWrite(room.agentId, () => fs.rmSync(store));
	});
	await row("W14", "a crash finish: a Forget a crash left pending is finished by the list's settle", async () => {
		const room = roomWithConversation("Crash");
		await afterWrite(room.agentId, () => crashedForget(room.agentId, room.threadId));
	});
	await row("W15", "the Forget sweep at a process's first settle of a room", async () => {
		const room = roomWithConversation("Sweep");
		agents.writePersistentAgentMementoBoundary(room.agentId, room.threadId, new Date(), { runtimeCwd: tempCwd });
		await afterWrite(room.agentId, () => resetForgetSweepForTests());
	});
	await row("W16", "a scheduled run's conversation deleted while another is open, in a stamped room (that conversation's record): the badge goes", async () => {
		const room = roomWithConversation("Deleted run");
		recordPersistentRoomLastUsed(room.agentId, "server");
		const run = `c_cache_run_${made}`;
		conversation(room.agentId, run, TURN, true);
		agents.recordPersistentAgentUnseenLandedAnswer(room.agentId, { threadId: run, turnId: "t3", terminalReason: "completed", origin: "scheduled-run" });
		keep(room.agentId);
		assert(listed(room.agentId)?.unseenLandedAnswer, "no badge before the delete");
		await afterWrite(room.agentId, () => agents.deletePersistentAgentThread(room.agentId, run));
		assert(!listed(room.agentId)?.unseenLandedAnswer, "the badge is still there");
	});
	if (!canForceFsRefusal) console.log("  skip W17, K5, K9: chmod cannot refuse a read or a write here");
	if (canForceFsRefusal) await row("W17", "a budget settle that fails once, then recovers with no fingerprinted file changed (maintenance settings)", () => {
		const room = roomWithConversation("Settle fails");
		recordPersistentRoomLastUsed(room.agentId, "server");
		// A room from before the settle: no settings file, so its budget has not met its memory yet.
		fs.rmSync(persistentRoomMaintenanceSettingsPath(room.agentId));
		const runtime = instanceOf(room.agentId).runtimeDir();
		withFolderReadOnly(runtime, () => {
			listed(room.agentId);
			listed(room.agentId);
		});
		assert(!readPersistentRoomMaintenanceSettings(room.agentId).memoryBudgetSettled, "the budget was settled in a folder that cannot be written");
		listed(room.agentId);
		assert(readPersistentRoomMaintenanceSettings(room.agentId).memoryBudgetSettled, "the list after the settings can be written again did not settle the budget");
		listsAsCold(room.agentId, "after the settings can be written again");
	});

	// --- What no file holds --------------------------------------------------------------
	await row("K1", "the room folder appears where none was", () => {
		const room = roomWithConversation("Late folder");
		const root = instanceOf(room.agentId).rootDir;
		const away = path.join(tempHome, "away");
		fs.renameSync(root, away);
		const build = { describe: () => cold(room.agentId), readTime: () => ({ scheduleSummary: cold(room.agentId).scheduleSummary, lastUsedAt: null }) };
		assert(cachedListRow(room.agentId, build).exists === false, "the room is there");
		assert(kept(room.agentId), "the missing room's row is not kept");
		fs.renameSync(away, root);
		deepStrictEqual(cachedListRow(room.agentId, build), cold(room.agentId));
	});
	for (const [file, pathOf] of [
		["L1a", (agentId: string) => instanceOf(agentId).l1aPath(instanceOf(agentId).readAgentJson())],
		["L1b", (agentId: string) => instanceOf(agentId).l1bCurrentPath(instanceOf(agentId).readAgentJson())],
		["the section registry", (agentId: string) => instanceOf(agentId).sectionRegistryPath(instanceOf(agentId).readAgentJson())],
	] as const) {
		await row("K2", `${file} appears where none was`, async () => {
			const room = roomWithConversation(`Late ${file}`);
			const target = pathOf(room.agentId);
			const text = fs.readFileSync(target);
			fs.rmSync(target);
			await afterWrite(room.agentId, () => fs.writeFileSync(target, text));
		});
	}
	await row("K3", "the unseen-answer marker appears where none was", async () => {
		const room = roomWithConversation("Late marker");
		await afterWrite(room.agentId, () => agents.recordPersistentAgentUnseenLandedAnswer(room.agentId, { threadId: room.threadId, turnId: "t4", terminalReason: "completed" }));
	});
	await row("K4", "the running state behind activeThread: running, cancelling and idle, with no file changed", async () => {
		const room = roomWithConversation("Running");
		const turn = agents.beginPersistentAgentTurn(room.agentId, room.threadId);
		await afterWrite(room.agentId, () => agents.markPersistentAgentTurnCancelling(room.agentId, room.threadId));
		assert(listed(room.agentId)?.activeThread?.cancelling, "the row does not say cancelling");
		await afterWrite(room.agentId, () => agents.finishPersistentAgentTurn(room.agentId, room.threadId, { turnId: turn.turnId, terminalReason: "cancelled" }));
	});
	if (canForceFsRefusal) await row("K5", "the marker's self-heal: a stale marker the describe fails to drop keeps no row, and the next list drops it", () => {
		const room = roomWithConversation("Self-heal");
		recordPersistentRoomLastUsed(room.agentId, "server");
		keep(room.agentId);
		agents.recordPersistentAgentUnseenLandedAnswer(room.agentId, { threadId: "c_cache_gone", turnId: "t5", terminalReason: "completed" });
		const marker = instanceOf(room.agentId).runtimeUnseenLandedAnswerPath();
		withFolderReadOnly(instanceOf(room.agentId).runtimeDir(), () => {
			assert(!listed(room.agentId)?.unseenLandedAnswer, "a stale marker badges the room");
			assert(fs.existsSync(marker), "the marker was dropped in a folder that cannot be written");
		});
		listed(room.agentId);
		assert(!fs.existsSync(marker), "the stale marker is still on disk after a list that could drop it");
		listsAsCold(room.agentId, "after the self-heal");
	});
	await row("K6", "the schedule summary after the clock passes an interval job's next time, with no file changed", async () => {
		const room = roomWithConversation("Clock");
		const job = addPersistentRoomScheduleJob(room.agentId, { name: "Every minute", type: "interval", schedule: "1m", prompt: "Check in.", now: new Date(Date.now() - 58_500) });
		const due = Date.parse(String(job.nextRunAt));
		keep(room.agentId);
		const before = listed(room.agentId)?.scheduleSummary.nextRunAt;
		assert(Date.now() < due && before === job.nextRunAt, `the job is already due, or the list says ${before}`);
		// Wait for the clock, not a fixed pause: until the job's next time has passed.
		while (Date.now() <= due) await new Promise((resolve) => setTimeout(resolve, 50));
		listsAsCold(room.agentId, "after the next time passed");
		assert(listed(room.agentId)?.scheduleSummary.nextRunAt !== before, "the next time did not move");
	});
	await row("K7", "the last-used time: a turn's stamp, with no fingerprinted file changed", async () => {
		const room = roomWithConversation("Stamp");
		recordPersistentRoomLastUsed(room.agentId, "server", {}, new Date(Date.now() - 3_600_000));
		await afterWrite(room.agentId, () => recordPersistentRoomLastUsed(room.agentId, "server"));
	});
	await row("K8", "the last-used estimate: a conversation with a turn added to a never-stamped room, its open one untouched", async () => {
		const agentId = bareRoom("Estimate");
		conversation(agentId, `c_cache_open_${made}`, []);
		await afterWrite(agentId, () => conversation(agentId, `c_cache_used_${made}`, TURN, true));
		assert(listed(agentId)?.lastUsedAt, "no last use after a conversation with a turn");
	});

	if (canForceFsRefusal) await row("K9", "a fingerprinted file that cannot be read: state.json unreadable, then readable again with its content unchanged", () => {
		const room = roomWithConversation("Unreadable");
		recordPersistentRoomLastUsed(room.agentId, "server");
		keep(room.agentId);
		const state = instanceOf(room.agentId).runtimeStatePath();
		// A write first, so the next list is a miss and reads the file while it cannot be read.
		agents.writePersistentAgentThread(room.agentId, room.threadId, { state: "active", origin: "unknown", items: [...TURN, { kind: "user", id: "u2", text: "And the font?" }] });
		fs.chmodSync(state, 0o000);
		try {
			assert(listed(room.agentId)?.runtime.state === "idle", "an unreadable state.json does not read as idle");
			listsAsCold(room.agentId, "while state.json cannot be read");
		} finally {
			fs.chmodSync(state, 0o644);
		}
		listsAsCold(room.agentId, "once state.json can be read again");
		assert(listed(room.agentId)?.runtime.state === "active", "the room still reads as idle");
	});

	await row("K10", "an empty conversation's transcript gains a message while its record stays empty (the transcript)", async () => {
		const agentId = bareRoom("Transcript");
		const threadId = `c_cache_blank_${made}`;
		conversation(agentId, threadId, []);
		assert(listed(agentId)?.activeThread?.followsConversationPick, "an empty conversation does not follow the conversation pick");
		await afterWrite(agentId, () => {
			const thread = agents.getPersistentAgentThread(agentId, threadId);
			agents.openPersistentAgentPiSessionManager(agentId, thread!.runtime as any, tempCwd).appendMessage({ role: "user", content: "Pick a logo.", timestamp: Date.now() } as any);
		});
		assert(!listed(agentId)?.activeThread?.followsConversationPick, "a conversation with a message still follows the conversation pick");
	});

	// --- The one-room status and the gates --------------------------------------------------
	await row("G1", "a planted wrong row reaches the list, and never the one-room status, its route, normal use or either entry gate", async () => {
		const room = roomWithConversation("Gates");
		recordPersistentRoomLastUsed(room.agentId, "server");
		keep(room.agentId);
		const l1b = instanceOf(room.agentId).l1bCurrentPath(instanceOf(room.agentId).readAgentJson());
		const text = fs.readFileSync(l1b, "utf-8");
		assert(text.includes("## Deep Memory"), "L1b has no Deep Memory heading");
		fs.writeFileSync(l1b, text.replace("## Deep Memory", "## Xeep Memory"));
		// Planted through the cache's own call: a ready row kept under the files as they now stand.
		const wrong = { ...cold(room.agentId), status: "ready" as const, errors: [] };
		assert(cold(room.agentId).status === "error", "the edit did not break the room");
		cachedListRow(room.agentId, { describe: () => wrong, readTime: () => ({ scheduleSummary: wrong.scheduleSummary, lastUsedAt: wrong.lastUsedAt }) });
		assert(listed(room.agentId)?.status === "ready", "control: the planted row did not reach the list");
		assert(getPersistentAgentStatus(room.agentId).status === "error", "getPersistentAgentStatus read the kept row");
		const route = await request("GET", `/api/persistent-agents/${room.agentId}/status`);
		assert(route.json.status === "error", `the status route: ${route.json.status}`);
		let normalUse = "";
		try {
			getUsablePersistentAgentStatusForNormalUse(room.agentId);
		} catch (error) {
			normalUse = (error as Error).message;
		}
		assert(normalUse.includes("Deep Memory"), `normal use: ${normalUse || "allowed"}`);
		let session = "";
		try {
			assertPersistentAgentAcceptsSession(getPersistentAgentStatus(room.agentId));
		} catch (error) {
			session = (error as Error).message;
		}
		assert(session.includes("not ready: error"), `the session gate: ${session || "allowed"}`);
		let checkpoint = "";
		try {
			agents.parseCheckpointApprovalRequest({}, room.agentId);
		} catch (error) {
			checkpoint = (error as Error).message;
		}
		assert(checkpoint.includes("not ready: error"), `the Remember gate: ${checkpoint || "allowed"}`);
	});

	// --- The bound ------------------------------------------------------------------------
	await row("B1", `at most ${LIST_ROW_CACHE_LIMIT} rows are kept: at the bound none is dropped, past it the oldest goes`, () => {
		assert(LIST_ROW_CACHE_LIMIT === 10_000, `the limit is ${LIST_ROW_CACHE_LIMIT}`);
		const earlier = stamped.agentId;
		assert(kept(earlier), "an earlier room's row is not kept");
		const ids = Array.from({ length: LIST_ROW_CACHE_LIMIT + 1 }, (_, index) => `cache-bound-${String(index).padStart(5, "0")}`);
		for (const id of ids) fs.mkdirSync(path.join(roomsRoot, id, "runtime"), { recursive: true });
		listPersistentAgents(new Set(ids.slice(0, LIST_ROW_CACHE_LIMIT)));
		assert(cachedListRowCount() === LIST_ROW_CACHE_LIMIT, `at the bound: ${cachedListRowCount()} rows`);
		assert(ids.slice(0, LIST_ROW_CACHE_LIMIT).every(kept) && !kept(earlier), "at the bound: a row of the list is gone, or an older one stayed");
		listPersistentAgents(new Set([ids.at(-1)!]));
		assert(cachedListRowCount() === LIST_ROW_CACHE_LIMIT, `past the bound: ${cachedListRowCount()} rows`);
		assert(!kept(ids[0]!) && kept(ids[1]!) && kept(ids.at(-1)!), "past the bound: the oldest row stayed, or a newer one went");
	});
} finally {
	await app.close();
	fs.rmSync(tempHome, { recursive: true, force: true });
}

if (failures.length) {
	console.error(`room list cache smoke FAILED (${failures.length}):\n${failures.join("\n")}`);
	process.exit(1);
}
console.log("room list cache smoke passed");
