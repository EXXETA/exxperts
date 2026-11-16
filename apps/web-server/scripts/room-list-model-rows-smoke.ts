// A room list's model rows: the list resolves each task's AI default once and
// gives it to every room, and each room's rows are still the rows that room
// gets alone.
//
//   1. rows: through the room list's route, over a room on the defaults, a
//      room with its own picks and a room whose memory budget is too big for
//      one model, with derived and with stored defaults, each room's `models`
//      equal what `roomModelsPayload` gives that room alone, fresh catalog;
//   2. reads: with stored defaults, one list reads the AI defaults' file at
//      most twice in all;
//   3. a default saved between two lists shows in the second list's default
//      rows and in a room on the default; a room's own pick stays;
//   4. the two saves that answer with the catalog they made before saving
//      (the AI defaults, a room's own picks) answer with what they saved.
//
// Offline: no model is called, no port is opened (the routes are injected).
//
// Run with: npm run smokes room-list-model-rows

import { deepStrictEqual } from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { SMOKE_SERVER_AUTH_ENV } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "room-list-model-rows-home-"));
const appDir = path.join(tempHome, ".exxperts", "app");
const agentDir = path.join(tempHome, ".exxperts", "agent");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(appDir, "personalized-agents");
// The app's state follows these before HOME: left set, the smoke would write into the profile they name.
delete process.env.EXXPERTS_DATA_DIR;
delete process.env.EXXPERTS_STATE_HOME;
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV);
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });

// A gateway with two models. Small Model holds a 10k memory and not a 20k one.
const ROOM_MODEL = { provider: "openai-compatible", model: "room-model" };
const SMALL_MODEL = { provider: "openai-compatible", model: "small-model" };
const PROFILE_FILE = path.join(appDir, "persistent-agent-ai-profile.json");
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }, { id: "small-model", name: "Small Model", contextWindow: 40000, maxTokens: 8000 }] } } }));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-list-key" } }));
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }, { modelId: "small-model", label: "Small Model" }], maintenanceModel: "room-model" }));
// A saved profile and no stored defaults: the defaults are derived from the profile.
fs.writeFileSync(PROFILE_FILE, JSON.stringify({ profileId: "openai-compatible" }));

// Every read of the AI defaults' file, by any fs function, while recording.
const recording = { on: false, reads: 0 };
const fsFunctions = fs as unknown as Record<string, unknown>;
for (const name of ["readFileSync", "readFile", "openSync", "open"]) {
	const original = fsFunctions[name] as (...args: unknown[]) => unknown;
	const recorded = function (this: unknown, ...args: unknown[]): unknown {
		if (recording.on && String(args[0]) === PROFILE_FILE) recording.reads += 1;
		return Reflect.apply(original, this, args);
	};
	fsFunctions[name] = Object.assign(recorded, original);
}
syncBuiltinESMExports();

const agents = await import("../src/persistent-agents.js");
const { roomModelsPayload } = await import("../src/ai-models.js");
const { createRoomModelCatalog, readStoredAiDefaults, writeAiDefaults, writeRoomModels } = await import("../src/room-models.js");
const { writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
await Promise.all(["room-routes", "model-routes", "room-settings-routes"].map((name) => import(`../src/${name}.js`)));
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

async function send(method: "GET" | "PUT", url: string, payload?: unknown): Promise<any> {
	const answer = await app.inject({ method, url, headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN }, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });
	assert(answer.statusCode === 200, `${method} ${url}: ${answer.statusCode} ${answer.body}`);
	return JSON.parse(answer.body);
}

/** The room list's model rows, by room id. */
async function listModels(): Promise<Map<string, any>> {
	const rows = await send("GET", "/api/persistent-agents");
	return new Map(rows.map((room: any) => [room.id, room.models]));
}

const lockOf = (payload: any): string => (payload ? `${payload.provider}/${payload.model}` : "none");
const createRoom = (displayName: string): string => agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Smoke User", preferredUserAddress: "Smoke User" }).agent.agentId;

const onDefault = createRoom("On Default Room");
const ownPicks = createRoom("Own Picks Room");
const bigMemory = createRoom("Big Memory Room");
writePersistentRoomMaintenanceSettings(onDefault, { memoryBudgetTokens: 10_000 });
writePersistentRoomMaintenanceSettings(ownPicks, { memoryBudgetTokens: 10_000 });
writePersistentRoomMaintenanceSettings(bigMemory, { memoryBudgetTokens: 20_000 });
writeRoomModels(ownPicks, { conversation: SMALL_MODEL, memory: ROOM_MODEL });
const rooms = [onDefault, ownPicks, bigMemory];

async function rowsAsAlone(): Promise<Map<string, any>> {
	const listed = await listModels();
	for (const id of rooms) deepStrictEqual(listed.get(id), roomModelsPayload(id, createRoomModelCatalog()), `the list's rows for ${id} are its rows alone`);
	return listed;
}

try {
	await row("1a", "derived defaults: each room's rows in the list are its rows alone", async () => {
		const listed = await rowsAsAlone();
		deepStrictEqual(readStoredAiDefaults(), {}, "the defaults are still derived, none stored");
		assert(lockOf(listed.get(onDefault).conversation.default) === lockOf(ROOM_MODEL), `the derived conversation default is Room Model, got ${lockOf(listed.get(onDefault).conversation.default)}`);
		assert(listed.get(ownPicks).conversation.source === "room" && listed.get(onDefault).conversation.source === "default", "one room runs on its own pick, the other on the default");
		assert(listed.get(bigMemory).memory.tooSmall.some((lock: any) => lockOf(lock) === lockOf(SMALL_MODEL)) && !listed.get(onDefault).memory.tooSmall.length, "Small Model is too small for the 20k memory only");
	});

	writeAiDefaults({ conversation: SMALL_MODEL, memory: ROOM_MODEL });
	await row("1b", "stored defaults: each room's rows in the list are its rows alone", async () => {
		const listed = await rowsAsAlone();
		assert(lockOf(listed.get(onDefault).conversation.chosen) === lockOf(SMALL_MODEL), "the room on the default runs the stored Small Model");
	});

	await row("2", "with stored defaults, one list reads the AI defaults' file at most twice", async () => {
		recording.reads = 0;
		recording.on = true;
		try {
			await listModels();
		} finally {
			recording.on = false;
		}
		assert(recording.reads > 0 && recording.reads <= 2, `the list of ${rooms.length} rooms read ${PROFILE_FILE} ${recording.reads} times`);
	});

	await row("3", "a default saved between two lists shows in the second; a room's own pick stays", async () => {
		const first = await listModels();
		assert(lockOf(first.get(onDefault).conversation.default) === lockOf(SMALL_MODEL), "the first list's default is Small Model");
		writeAiDefaults({ conversation: ROOM_MODEL });
		const second = await listModels();
		for (const id of rooms) assert(lockOf(second.get(id).conversation.default) === lockOf(ROOM_MODEL), `the second list's default row for ${id} is Room Model, got ${lockOf(second.get(id).conversation.default)}`);
		assert(lockOf(second.get(onDefault).conversation.chosen) === lockOf(ROOM_MODEL) && lockOf(second.get(onDefault).conversation.effective) === lockOf(ROOM_MODEL), "the room on the default now runs Room Model");
		assert(second.get(ownPicks).conversation.source === "room" && lockOf(second.get(ownPicks).conversation.chosen) === lockOf(SMALL_MODEL), "the room with its own pick keeps Small Model");
	});

	await row("4a", "the AI defaults' save answers with the defaults it saved", async () => {
		const saved = await send("PUT", "/api/ai/defaults", { conversation: SMALL_MODEL });
		assert(lockOf(saved.defaults.conversation.chosen) === lockOf(SMALL_MODEL), `the save answers Small Model, got ${lockOf(saved.defaults.conversation.chosen)}`);
		const again = await send("PUT", "/api/ai/defaults", { conversation: ROOM_MODEL });
		assert(lockOf(again.defaults.conversation.chosen) === lockOf(ROOM_MODEL), `the next save answers Room Model, got ${lockOf(again.defaults.conversation.chosen)}`);
		const listed = await listModels();
		assert(lockOf(listed.get(onDefault).conversation.chosen) === lockOf(ROOM_MODEL), "the list after the save has the saved default");
	});

	await row("4b", "a room's own picks' save answers with the picks it saved", async () => {
		const picked = await send("PUT", `/api/persistent-agents/${onDefault}/models`, { conversation: SMALL_MODEL });
		assert(picked.models.conversation.source === "room" && lockOf(picked.models.conversation.chosen) === lockOf(SMALL_MODEL), `the save answers the room's pick, got ${picked.models.conversation.source} ${lockOf(picked.models.conversation.chosen)}`);
		const cleared = await send("PUT", `/api/persistent-agents/${onDefault}/models`, { conversation: null });
		assert(cleared.models.conversation.source === "default" && lockOf(cleared.models.conversation.chosen) === lockOf(ROOM_MODEL), `the cleared row answers the default, got ${cleared.models.conversation.source} ${lockOf(cleared.models.conversation.chosen)}`);
	});
} finally {
	await app.close();
	fs.rmSync(tempHome, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`room-list-model-rows smoke: ${failures.length} failed\n${failures.join("\n")}`);
	process.exit(1);
}
console.log("room-list-model-rows smoke: ok");
