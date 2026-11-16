// A room list says who is looking. Given a set, a list touches only the rooms
// in the set that are on disk; given "every room", all of them; given anything
// else, it throws before it reads. A room outside the set is checked twice: a
// recorder on every file call, and the room's bytes and times, each against the
// same room in the set, since a status read also writes. The AI defaults are the
// one reader that looks past the set: a default must hold every room's memory,
// so a room outside the set is read from its own small files, never its status,
// and is never named.
//
// Run with: npm run smokes room-viewer-list

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import type { RoomViewer } from "../src/persistent-agents.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-list-who-looks-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempRoot, "rooms");
fs.mkdirSync(tempHome, { recursive: true });
fs.mkdirSync(agentsRoot, { recursive: true });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

// A gateway rooms can use. Small Model holds a 10k memory and not a 20k one, so
// the AI defaults name a room only when that room is among those looked at.
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }, { id: "small-model", name: "Small Model", contextWindow: 40000, maxTokens: 8000 }] } } }));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-viewer-key" } }));
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }, { modelId: "small-model", label: "Small Model" }], maintenanceModel: "room-model" }));
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }));

const { archivePersistentAgent, createPersistentAgentFromScaffoldInput, createPersistentAgentInstance, listArchivedPersistentAgents, listPersistentAgents, writePersistentAgentThread } = await import("../src/persistent-agents.js");
const { buildMemoryAskContext, buildMemoryDigest, buildMemoryOverview, searchMemory } = await import("../src/memory-api.js");
const { aiDefaultsPayload } = await import("../src/ai-models.js");
const { writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");

// Every file call that names a path, wherever it points: a room's schedule
// store and lock live outside its folder and carry its id in their name.
const recording = { on: false, calls: [] as string[] };
const fsFunctions = fs as unknown as Record<string, unknown>;
for (const name of Object.keys(fs)) {
	const original = fsFunctions[name];
	if (typeof original !== "function" || /^[A-Z]/.test(name)) continue;
	const recorded = function (this: unknown, ...args: unknown[]): unknown {
		if (recording.on) for (const arg of args) if (typeof arg === "string" || arg instanceof URL || Buffer.isBuffer(arg)) recording.calls.push(`${name} ${String(arg)}`);
		return Reflect.apply(original, this, args);
	};
	fsFunctions[name] = Object.assign(recorded, original);
}
syncBuiltinESMExports();

function record<T>(action: () => T): { answer: T; calls: string[] } {
	recording.on = true;
	recording.calls = [];
	try {
		return { answer: action(), calls: recording.calls };
	} finally {
		recording.on = false;
	}
}

function callsNaming(calls: string[], id: string): string[] {
	return calls.filter((call) => call.includes(id));
}

// A room's bytes and times. The times start in the past, so a rewrite of the
// same bytes shows too.
function backdate(dir: string): void {
	const past = new Date("2020-01-02T03:04:05.000Z");
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) backdate(path.join(dir, entry.name));
		fs.utimesSync(path.join(dir, entry.name), past, past);
	}
	fs.utimesSync(dir, past, past);
}

function snapshot(dir: string): Record<string, string> {
	const seen: Record<string, string> = {};
	const walk = (at: string): void => {
		const stat = fs.statSync(at);
		const bytes = stat.isFile() ? crypto.createHash("sha256").update(fs.readFileSync(at)).digest("hex") : "folder";
		seen[path.relative(dir, at) || "."] = `${bytes} ${stat.mtimeMs} ${stat.ctimeMs}`;
		if (stat.isDirectory()) for (const name of fs.readdirSync(at).sort()) walk(path.join(at, name));
	};
	walk(dir);
	return seen;
}

function createRoom(displayName: string): string {
	const created = createPersistentAgentFromScaffoldInput({ displayName, userName: "Smoke User", preferredUserAddress: "Smoke User" });
	return created.agent.agentId;
}

const roomFolder = (id: string): string => path.join(agentsRoot, id);
const ids = (rows: Array<{ id: string }>): string[] => rows.map((row) => row.id);
const rootEntries = (): string[] => fs.readdirSync(agentsRoot).sort();

function check(name: string, run: () => void): void {
	run();
	console.log(`ok - ${name}`);
}

// Twins: the same scaffold, neither ever read, so what a read does to one it
// would have done to the other. A conversation somebody spoke in, with no
// last-used stamp, is what makes the first status read write one.
const shown = createRoom("Shown Twin Room");
const hidden = createRoom("Hidden Twin Room");
for (const id of [shown, hidden]) writePersistentAgentThread(id, "viewer_smoke_thread", { state: "active", origin: "home", model: { provider: "openai-compatible", model: "room-model" }, items: [{ kind: "user", id: "u1", text: "Synthetic user message." }] });
const archivedShown = createRoom("Stored Twin Room");
const archivedHidden = createRoom("Packed Twin Room");
for (const id of [archivedShown, archivedHidden]) archivePersistentAgent(id, { confirmation: `DELETE ${id}` });

type AnyList = (viewer: unknown) => Array<{ id: string }>;
const LISTS: Array<{ name: string; list: AnyList; inSet: string; outside: string; otherKind: string[]; readWrites: boolean }> = [
	{ name: "listPersistentAgents", list: listPersistentAgents as AnyList, inSet: shown, outside: hidden, otherKind: [archivedShown, archivedHidden], readWrites: true },
	{ name: "listArchivedPersistentAgents", list: listArchivedPersistentAgents as AnyList, inSet: archivedShown, outside: archivedHidden, otherKind: [shown, hidden], readWrites: false },
];

try {
	for (const { name, list, inSet, outside, otherKind, readWrites } of LISTS) {
		check(`${name}: a room outside the set has no file read or written, and the same room in the set does`, () => {
			for (const id of [inSet, outside]) backdate(roomFolder(id));
			const outsideBefore = snapshot(roomFolder(outside));
			const narrowed = record(() => list(new Set([inSet])));
			assert.deepEqual(ids(narrowed.answer), [inSet], "the set's room is the only row");
			assert.deepEqual(callsNaming(narrowed.calls, outside), [], "no file call names the room outside the set");
			for (const other of otherKind) assert.deepEqual(callsNaming(narrowed.calls, other), [], "nor a room of the other kind outside the set");
			assert.ok(callsNaming(narrowed.calls, inSet).length > 0, "the recorder sees the set's room being read");
			assert.deepEqual(snapshot(roomFolder(outside)), outsideBefore, "the room outside the set keeps its bytes and times");

			const control = record(() => list(new Set([outside])));
			assert.deepEqual(ids(control.answer), [outside], "the same room in the set is the row");
			assert.ok(callsNaming(control.calls, outside).length > 0, "and the recorder sees it read");
			if (readWrites) assert.notDeepEqual(snapshot(roomFolder(outside)), outsideBefore, "and the same read does change a room, so the unchanged bytes above mean something");
		});

		check(`${name}: an id with no folder, or not a valid room id, gives no row and creates nothing`, () => {
			const tombstone = `${inSet}.purging-1`;
			fs.mkdirSync(roomFolder(tombstone));
			const before = rootEntries();
			const strangers = ["no-such-room", "../escaped-room", "Not A Room", "", ".", "..", tombstone];
			const refused = record(() => list(new Set(strangers)));
			assert.deepEqual(refused.answer, [], "no row for any of them");
			for (const stranger of ["no-such-room", "escaped-room", "Not A Room", tombstone]) assert.deepEqual(callsNaming(refused.calls, stranger), [], `no file call names ${stranger}`);
			assert.deepEqual(rootEntries(), before, "no folder appears");
			assert.equal(fs.existsSync(path.join(tempRoot, "escaped-room")), false, "nothing appears beside the rooms");

			const control = record(() => list(new Set([...strangers, inSet])));
			assert.deepEqual(ids(control.answer), [inSet], "a real room among them is still the row");
			assert.deepEqual(rootEntries(), before, "and still no folder appears");
			fs.rmdirSync(roomFolder(tombstone));
		});

		check(`${name}: a padded folder name in the set does not open the real room of that name`, () => {
			// Windows strips a trailing space from a path, so that folder cannot exist there.
			const padded = process.platform === "win32" ? [` ${outside}`] : [` ${outside}`, `${outside} `, `${outside}\t`];
			for (const folder of padded) fs.mkdirSync(roomFolder(folder));
			backdate(roomFolder(outside));
			const outsideBefore = snapshot(roomFolder(outside));
			const refused = record(() => list(new Set(padded)));
			assert.deepEqual(refused.answer, [], "no row for a padded name, whose real room is outside the set");
			assert.deepEqual(callsNaming(refused.calls, outside), [], "and no file call names that room");
			assert.deepEqual(snapshot(roomFolder(outside)), outsideBefore, "which keeps its bytes and times");

			const control = record(() => list(new Set([outside])));
			assert.deepEqual(ids(control.answer), [outside], "the real id is still the one row, padded folders or not");
			assert.ok(callsNaming(control.calls, outside).length > 0, "and the recorder sees that room read");
			for (const folder of padded) fs.rmdirSync(roomFolder(folder));
		});

		check(`${name}: an empty set gives no rows and reads no room`, () => {
			const empty = record(() => list(new Set()));
			assert.deepEqual(empty.answer, [], "no rows");
			for (const id of [shown, hidden, archivedShown, archivedHidden]) assert.deepEqual(callsNaming(empty.calls, id), [], "no room is read");
		});

		check(`${name}: "every room" gives every room of its kind and no other`, () => {
			assert.deepEqual(ids(list("every room")).sort(), [inSet, outside].sort());
			assert.deepEqual(ids(list(new Set(otherKind))), [], "the other kind's rooms are never its rows, even in the set");
		});

		check(`${name}: anything else throws and reads nothing`, () => {
			const notViewers: unknown[] = [undefined, null, "", "every", "EVERY ROOM", "every room ", inSet, [inSet], { has: () => true }, new Map([[inSet, 1]]), 0, true];
			for (const viewer of notViewers) {
				const attempt = record(() => assert.throws(() => list(viewer), /needs a viewer/, `refuses ${String(viewer)}`));
				assert.deepEqual(attempt.calls, [], `reads nothing for ${String(viewer)}`);
			}
			assert.ok(record(() => list("every room")).calls.length > 0, "the recorder does see the list read");
		});
	}

	check("a viewer is a set or the literal, and the compiler refuses a forgotten one", () => {
		const viewers: RoomViewer[] = [new Set([shown]), "every room"];
		assert.equal(viewers.length, 2);
		// @ts-expect-error a forgotten viewer must fail the type check
		assert.throws(() => listPersistentAgents(), /needs a viewer/);
		// @ts-expect-error a forgotten viewer must fail the type check
		assert.throws(() => listArchivedPersistentAgents(), /needs a viewer/);
		// @ts-expect-error a room id is not a viewer
		assert.throws(() => listPersistentAgents(shown), /needs a viewer/);
	});

	// What the memory screens and the AI defaults read: each room holds a word of
	// its own and a shared one, and a save, so a row for the room shows in each.
	const WORDS = { [shown]: "shownroomword", [hidden]: "hiddenroomword" };
	for (const id of [shown, hidden]) {
		const instance = createPersistentAgentInstance(id);
		fs.appendFileSync(path.join(roomFolder(id), "L1b", "current.md"), `\n- ${WORDS[id]} and sharedroomword.\n`);
		fs.mkdirSync(instance.checkpointEventDir(), { recursive: true });
		fs.writeFileSync(path.join(instance.checkpointEventDir(), "viewer-smoke.json"), JSON.stringify({ approvedAt: "2026-09-01T09:00:00.000Z", result: { estimatedTokens: 10 }, checkpoint: { approvedEntry: { chars: 5, title: "A save" } } }));
	}
	writePersistentRoomMaintenanceSettings(shown, { memoryBudgetTokens: 10_000 });
	writePersistentRoomMaintenanceSettings(hidden, { memoryBudgetTokens: 20_000 });

	const READERS: Array<{ name: string; roomsSeen: (viewer: RoomViewer) => string[] }> = [
		{ name: "buildMemoryOverview", roomsSeen: (viewer) => ids(buildMemoryOverview(viewer).rooms) },
		{ name: "searchMemory", roomsSeen: (viewer) => [...new Set(searchMemory(viewer, "sharedroomword").map((hit) => hit.roomId))] },
		{ name: "buildMemoryAskContext", roomsSeen: (viewer) => { const { context } = buildMemoryAskContext(viewer, "What was said?"); return [shown, hidden].filter((id) => context.includes(WORDS[id])); } },
		{ name: "buildMemoryDigest", roomsSeen: (viewer) => ids(buildMemoryDigest(viewer, 0).rooms) },
	];
	for (const { name, roomsSeen } of READERS) {
		check(`${name}: passes the viewer to the list`, () => {
			const narrowed = record(() => roomsSeen(new Set([shown])));
			assert.deepEqual(narrowed.answer, [shown], "the set's room is what it answers from");
			assert.deepEqual(callsNaming(narrowed.calls, hidden), [], "and no file call names the room outside the set");
			const control = record(() => roomsSeen(new Set([hidden])));
			assert.deepEqual(control.answer, [hidden], "the other room in the set is what it answers from");
			assert.ok(callsNaming(control.calls, hidden).length > 0, "and the recorder sees it read");
		});
	}

	check("the memory readers answer from every room when told so", () => {
		for (const { name, roomsSeen } of READERS) assert.deepEqual(roomsSeen("every room").sort(), [shown, hidden].sort(), name);
		assert.deepEqual(aiDefaultsPayload("every room").memory.tooSmall, [{ provider: "openai-compatible", model: "small-model", room: "Hidden Twin Room" }]);
	});

	// Small Model cannot hold the 20k room, wherever it is.
	const SMALL_UNNAMED = [{ provider: "openai-compatible", model: "small-model" }];
	const READ_ONLY_CALLS = new Set(["existsSync", "readFileSync", "statSync", "lstatSync", "readdirSync", "realpathSync", "accessSync"]);
	check("aiDefaultsPayload: a room outside the set still blocks a default too small for it, unnamed, read from its own small files only", () => {
		backdate(roomFolder(hidden));
		const hiddenBefore = snapshot(roomFolder(hidden));
		const narrowed = record(() => aiDefaultsPayload(new Set([shown])).memory.tooSmall);
		assert.deepEqual(narrowed.answer, SMALL_UNNAMED, "Small Model is too small, and no room is named");
		const hiddenCalls = callsNaming(narrowed.calls, hidden);
		assert.ok(hiddenCalls.length > 0, "the recorder sees the room outside the set read");
		assert.deepEqual(hiddenCalls.filter((call) => !READ_ONLY_CALLS.has(call.split(" ")[0]!)), [], "every file call on it reads");
		assert.deepEqual(hiddenCalls.filter((call) => !/(agent\.json|models\.json|maintenance-settings\.json)$/.test(call)), [], "and reads only its agent.json, models file and settings, never what a status read reads");
		assert.deepEqual(snapshot(roomFolder(hidden)), hiddenBefore, "it keeps its bytes and times");

		const control = record(() => aiDefaultsPayload(new Set([hidden])).memory.tooSmall);
		assert.deepEqual(control.answer, [{ ...SMALL_UNNAMED[0], room: "Hidden Twin Room" }], "the same room in the set is named");
		assert.ok(callsNaming(control.calls, hidden).some((call) => call.includes("L1b")), "and is read as a status read reads it");

		writePersistentRoomMaintenanceSettings(hidden, { memoryBudgetTokens: 10_000 });
		assert.deepEqual(aiDefaultsPayload(new Set([shown])).memory.tooSmall, [], "the control: with that room at 10k, Small Model holds every room");
		writePersistentRoomMaintenanceSettings(hidden, { memoryBudgetTokens: 20_000 });
	});

	check("a room asked for by name outside the set answers like no room at all", () => {
		assert.deepEqual(searchMemory(new Set([shown]), "sharedroomword", hidden), []);
		assert.ok(searchMemory(new Set([hidden]), "sharedroomword", hidden).length > 0, "the same search with the room in the set finds it");
		assert.equal(buildMemoryAskContext(new Set([shown]), "What was said?", undefined, [hidden]).context, "");
		assert.ok(buildMemoryAskContext(new Set([hidden]), "What was said?", undefined, [hidden]).context.includes(WORDS[hidden]), "the same ask with the room in the set reads it");
	});

	check("the memory readers and the AI defaults refuse a forgotten viewer, at the compiler and at run time", () => {
		// @ts-expect-error a forgotten viewer must fail the type check
		assert.throws(() => buildMemoryOverview(), /needs a viewer/);
		// @ts-expect-error a call written before the viewer must fail the type check
		assert.throws(() => searchMemory("sharedroomword", shown), /needs a viewer/);
		// @ts-expect-error a call written before the viewer must fail the type check
		assert.throws(() => buildMemoryAskContext("What was said?"), /needs a viewer/);
		// @ts-expect-error a call written before the viewer must fail the type check
		assert.throws(() => buildMemoryDigest(0), /needs a viewer/);
		// @ts-expect-error a forgotten viewer must fail the type check
		assert.throws(() => aiDefaultsPayload(), /needs a viewer/);
	});

	console.log("room viewer list smoke passed");
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
