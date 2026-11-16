// A room list's rows: what a list leaves out of each row, and which rooms it
// describes at all.
//
//   1. the prompt budget preview: the one-room status carries it, in process
//      and through its route; a list row does not, in process or through the
//      room list's route, and a list read neither builds it nor takes the
//      memory files' sizes;
//   2. the left-out fields, pinned as a literal list: on a room that carries
//      every optional field, a list row is the one-room status row minus
//      exactly those fields, in process and through the two routes;
//   3. an archived room is settled but not described: a list read finishes a
//      Forget a crash left pending there, and leaves its stale unseen-answer
//      marker, which a describe would drop; the archived list still names it.
//
// Offline: no model is called, no port is opened (the routes are injected).

import { deepStrictEqual } from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { SMOKE_SERVER_AUTH_ENV } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "room-list-rows-home-"));
const appDir = path.join(tempHome, ".exxperts", "app");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const tempCwd = path.join(tempHome, "cwd");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(appDir, "personalized-agents");
// The app's state follows these before HOME: left set, the smoke would write into the profile they name.
delete process.env.EXXPERTS_DATA_DIR;
delete process.env.EXXPERTS_STATE_HOME;
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV);
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(tempCwd, { recursive: true });

/** What a room list leaves out of a row, as paths into the one-room status row. */
const LEFT_OUT = ["root", "l1a", "l1b.path", "l1b.exists", "l1b.bytes", "l1b.missingSections", "sectionRegistry", "promptBudget", "memoryBudgetTokens", "role", "model", "lastUsedIsEstimate"];
/** The status row's optional fields a live room can carry: the room in row 2 carries each. */
const OPTIONAL = ["unseenLandedAnswer", "displayName", "description", "role", "model", "promptBudget", "memoryBudgetTokens", "memoryBudget", "fastPathSecondApproval", "l1a.bytes", "l1b.bytes"];
/** What the room list's route adds to each row beyond the status route. */
const LIST_ROUTE_ADDS = ["activeLock", "answeringDetached"];
const MODEL = { provider: "anthropic", model: "claude-opus-5-5", label: "Claude Opus 5.5" };

const agents = await import("../src/persistent-agents.js");
const { recordPersistentAgentUnseenLandedAnswer } = await import("../src/persistent-agent-turns.js");
const { commitIntentPath } = await import("../src/memory-commit.js");
await Promise.all(["room-routes", "room-schedule-routes"].map((name) => import(`../src/${name}.js`)));
const { app, AUTH_HEADER_NAME, AUTH_TOKEN } = await import("../src/server-app.js");
app.log.level = "silent";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const failures: string[] = [];
async function row(id: string, label: string, run: () => Promise<void> | void): Promise<void> {
	try {
		await run();
		console.log(`  ok  ${id} ${label}`);
	} catch (error) {
		failures.push(`${id} ${label}: ${error instanceof Error ? error.message : String(error)}`);
		console.log(`  FAIL ${id} ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function getJson(url: string): Promise<any> {
	const answer = await app.inject({ method: "GET", url, headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN } });
	assert(answer.statusCode === 200, `${url}: ${answer.statusCode} ${answer.body}`);
	return JSON.parse(answer.body);
}

const has = (value: any, dotted: string): boolean => {
	const parts = dotted.split(".");
	const parent = parts.slice(0, -1).reduce((at, key) => at?.[key], value);
	return parent !== null && typeof parent === "object" && parts.at(-1)! in parent && parent[parts.at(-1)!] !== undefined;
};

/** A deep copy of the row without the given paths. */
function without(value: object, paths: string[]): any {
	const copy = JSON.parse(JSON.stringify(value));
	for (const dotted of paths) {
		const parts = dotted.split(".");
		const parent = parts.slice(0, -1).reduce((at, key) => at?.[key], copy);
		if (parent && typeof parent === "object") delete parent[parts.at(-1)!];
	}
	return copy;
}

/** A room with one conversation that has a visible turn, as a person leaves it. */
function roomWithConversation(label: string, input: Record<string, string> = {}): { agentId: string; threadId: string } {
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: `List ${label}`, userName: "Synthetic User", preferredUserAddress: "Synthetic User", ...input }).agent.agentId;
	const threadId = `c_list_${label.toLowerCase()}`;
	const write = agents.writePersistentAgentThread(agentId, threadId, {
		state: "active",
		origin: "home",
		model: MODEL,
		items: [{ kind: "user", id: "u1", text: "Pick a logo." }, { kind: "assistant", id: "a1", text: "The blue one." }],
	}, { createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }) });
	const session = agents.openPersistentAgentPiSessionManager(agentId, write.thread.runtime as any, tempCwd);
	session.appendMessage({ role: "user", content: "Pick a logo.", timestamp: Date.now() } as any);
	session.appendMessage({ role: "assistant", content: [{ type: "text", text: "The blue one." }], api: "responses", provider: MODEL.provider, model: MODEL.model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as any);
	return { agentId, threadId };
}

/** The file reads and stats made while `run` runs, as "read <path>" and "stat <path>". */
function fileCallsDuring(run: () => unknown): string[] {
	const kinds = { readFileSync: "read", statSync: "stat" } as const;
	const real = new Map<string, any>(Object.keys(kinds).map((name) => [name, (fs as any)[name]]));
	const calls: string[] = [];
	for (const [name, kind] of Object.entries(kinds)) {
		(fs as any)[name] = (...args: any[]) => {
			calls.push(`${kind} ${String(args[0])}`);
			return real.get(name)(...args);
		};
	}
	syncBuiltinESMExports();
	try {
		run();
	} finally {
		for (const name of Object.keys(kinds)) (fs as any)[name] = real.get(name);
		syncBuiltinESMExports();
	}
	return calls;
}

/** Runs a Forget and cuts it off where a kill would, after its intent is written: the save stays pending. */
async function crashedForget(agentId: string, threadId: string): Promise<void> {
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
		await agents.writePersistentAgentMementoBoundary(agentId, threadId, new Date(), { runtimeCwd: tempCwd });
		throw new Error("the Forget was not cut off");
	} catch (error) {
		// The cut may surface wrapped by the step it stopped.
		if (!/\bkilled$/.test((error as Error).message)) throw error;
	} finally {
		for (const name of names) (fs as any)[name] = real.get(name);
		syncBuiltinESMExports();
	}
}

try {
	// --- The full room: every optional field a live room can carry ------------------
	const full = roomWithConversation("Full", { description: "Keeps the brand work.", role: "brand-desk" });
	recordPersistentAgentUnseenLandedAnswer(full.agentId, { threadId: full.threadId, turnId: "t1", terminalReason: "completed", origin: "detached-turn" });
	// An older room's agent.json carries a model of its own.
	const fullAgentJson = agents.createPersistentAgentInstance(full.agentId).agentJsonPath();
	fs.writeFileSync(fullAgentJson, JSON.stringify({ ...JSON.parse(fs.readFileSync(fullAgentJson, "utf-8")), model: { provider: MODEL.provider, model: MODEL.model } }, null, 2) + "\n");
	// The first read gives a never-stamped room its estimate; the rows below compare later reads.
	agents.getPersistentAgentStatus(full.agentId);

	const status = agents.getPersistentAgentStatus(full.agentId);
	const listed = agents.listPersistentAgents("every room").find((room) => room.id === full.agentId);
	const statusRoute = await getJson(`/api/persistent-agents/${full.agentId}/status`);
	const listRoute = (await getJson("/api/persistent-agents")).find((room: { id: string }) => room.id === full.agentId);

	await row("R1a", "the one-room status carries the prompt budget preview, in process and through its route", () => {
		assert((status.promptBudget?.bootEstimatedTokens ?? 0) > 0, `getPersistentAgentStatus: ${JSON.stringify(status.promptBudget)}`);
		assert((statusRoute.promptBudget?.bootEstimatedTokens ?? 0) > 0, `the status route: ${JSON.stringify(statusRoute.promptBudget)}`);
	});
	await row("R1b", "a list row carries no prompt budget, in process and through the room list's route", () => {
		assert(listed && listRoute, "the full room is listed");
		assert(!("promptBudget" in listed), `listPersistentAgents: ${JSON.stringify((listed as any).promptBudget)}`);
		assert(!("promptBudget" in listRoute), `the room list's route: ${JSON.stringify(listRoute.promptBudget)}`);
	});

	// A list stats L1a and L1b for its row cache's fingerprint, so only the read is pinned on its side; R2b holds that no size reaches its row.
	await row("R1c", "a list read builds no preview: it never reads L1a's text; the one-room status reads it and stats L1a and L1b for their sizes", () => {
		const l1a = status.l1a.path;
		const l1b = status.l1b.path;
		const listing = fileCallsDuring(() => agents.listPersistentAgents("every room"));
		const touched = listing.filter((call) => call === `read ${l1a}`);
		assert(touched.length === 0, `the list: ${JSON.stringify(touched)}`);
		const one = fileCallsDuring(() => agents.getPersistentAgentStatus(full.agentId));
		const missing = [`read ${l1a}`, `stat ${l1a}`, `stat ${l1b}`].filter((call) => !one.includes(call));
		assert(missing.length === 0, `the one-room status did not make ${JSON.stringify(missing)}`);
	});

	await row("R2a", "the full room carries every optional field in its one-room status, and every left-out field", () => {
		const missing = [...OPTIONAL, ...LEFT_OUT].filter((field) => !has(status, field) || !has(statusRoute, field));
		assert(missing.length === 0, `missing: ${JSON.stringify(missing)}`);
		assert(status.activeThread?.hasUserVisibleTurns && status.lastUsedAt, "the room has an open conversation and a last use");
	});
	await row("R2b", "a list row is the one-room status minus exactly the left-out fields, in process", () => {
		assert(listed, "the full room is listed");
		deepStrictEqual(without(listed, []), without(status, LEFT_OUT));
	});
	await row("R2c", "through the routes too: the room list's row, less what that route adds, is the status route's row minus exactly the left-out fields", () => {
		assert(listRoute, "the full room is listed");
		assert(LIST_ROUTE_ADDS.every((field) => field in listRoute), `the room list's route adds ${JSON.stringify(LIST_ROUTE_ADDS)}`);
		deepStrictEqual(without(listRoute, LIST_ROUTE_ADDS), without(statusRoute, LEFT_OUT));
	});

	// --- An archived room with a pending Forget and a stale unseen-answer marker -------
	const shelved = roomWithConversation("Shelved");
	const shelvedRoot = agents.createPersistentAgentInstance(shelved.agentId).rootDir;
	await crashedForget(shelved.agentId, shelved.threadId);
	agents.archivePersistentAgent(shelved.agentId, { confirmation: `DELETE ${shelved.agentId}` });
	// A marker for a turn in a conversation that is not the room's open one: a describe drops it.
	recordPersistentAgentUnseenLandedAnswer(shelved.agentId, { threadId: "c_list_gone", turnId: "t9", terminalReason: "completed", origin: "detached-turn" });
	const markerFile = agents.createPersistentAgentInstance(shelved.agentId).runtimeUnseenLandedAnswerPath();
	const forgetPending = () => fs.existsSync(commitIntentPath(shelvedRoot, "forget"));

	await row("R3a", "before the list: the archived room has a Forget pending and a marker on disk", () => {
		assert(forgetPending(), "the Forget is pending");
		assert(fs.existsSync(markerFile), "the marker is on disk");
	});
	const rooms = await getJson("/api/persistent-agents");
	await row("R3b", "a list read finishes the pending Forget in the archived room, and does not list it", () => {
		assert(!forgetPending(), "the Forget is still pending after the list read");
		assert(!rooms.some((room: { id: string }) => room.id === shelved.agentId), "the archived room is listed");
		assert(rooms.some((room: { id: string }) => room.id === full.agentId), "the live room is listed");
	});
	await row("R3c", "a list read does not describe the archived room: its stale marker is still on disk", () => {
		assert(fs.existsSync(markerFile), "the marker was dropped, so the list described the archived room");
	});
	await row("R3d", "the archived list still names the archived room", async () => {
		const archived = await getJson("/api/persistent-agents/archived");
		const entry = archived.find((room: { id: string }) => room.id === shelved.agentId);
		assert(entry && entry.displayName === "List Shelved" && entry.archivedAt > 0, `the archived list: ${JSON.stringify(archived)}`);
		assert(!archived.some((room: { id: string }) => room.id === full.agentId), "the live room is in the archived list");
	});
	await row("R3e", "control: a describe of the same archived room drops the stale marker", () => {
		agents.getPersistentAgentStatus(shelved.agentId);
		assert(!fs.existsSync(markerFile), "the marker is still on disk after a describe");
	});
} finally {
	await app.close();
	fs.rmSync(tempHome, { recursive: true, force: true });
}

if (failures.length) {
	console.error(`room list rows smoke FAILED (${failures.length}):\n${failures.join("\n")}`);
	process.exit(1);
}
console.log("room list rows smoke passed");
