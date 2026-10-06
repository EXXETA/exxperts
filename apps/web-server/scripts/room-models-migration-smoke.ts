// The move to a model per room, on a state folder shaped like 0.13.2 left it.
//
// The folder is built in a temp home the way 0.13.2 wrote it: the ChatGPT
// profile saved as the active one, with Memorize moved to GPT-6 Astra and
// Review left on GPT-6 Sol; the app's last pick for new rooms (GPT-6 Luna);
// six rooms (a ChatGPT preference, a Claude preference, a preference on a
// gateway that is gone, no preference, an unreadable preference file, and one
// a half-finished earlier run already moved), and an open conversation with
// its own lock. The migration runs twice. The first run must keep every choice
// (defaults from the last pick and the Memorize model, each room's preference
// as its conversation pick, the Review pick reported as collapsed, the gone
// gateway reported as unavailable), remove no file before its replacement reads
// back (the old last pick goes once the defaults hold it), and touch no
// conversation; the second run must change nothing. The
// before and after listings are printed for the report. Last, a saved gateway
// profile whose sign-in lapsed while ChatGPT is signed in: the defaults are the
// gateway's, never ChatGPT's, and the rooms on them wait.
//
// Offline: no server, no provider, no network.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "room-models-migration-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(appDir, { recursive: true });
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
const root = path.join(appDir, "personalized-agents");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
	"openai-codex": { type: "api_key", key: "synthetic-codex" },
	anthropic: { type: "api_key", key: "synthetic-anthropic" },
}, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "chatgpt-codex" }, null, 2));
fs.writeFileSync(path.join(appDir, "built-in-ai-profile-preferences.json"), JSON.stringify({ version: 1, profiles: { "chatgpt-codex": { learnModel: "gpt-6-astra", reviewMemoryModel: "gpt-6-sol" } } }, null, 2));
fs.writeFileSync(path.join(appDir, "web-chat-model.json"), JSON.stringify({ provider: "openai-codex", model: "gpt-6-luna" }, null, 2));

const { createPersistentAgentFromScaffoldInput, createPersistentAgentPiSessionJsonlThreadRuntime, writePersistentAgentThread } = await import("../src/persistent-agents.js");
const { migrateRoomModels, ROOM_MODELS_MIGRATION_REPORT_FILE } = await import("../src/room-models-migration.js");
const { readRoomModels, readStoredAiDefaults, resolveRoomModel } = await import("../src/room-models.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const key = (lock: { provider: string; model: string } | null | undefined) => (lock ? `${lock.provider}/${lock.model}` : "none");

/** Every file under the state folder with its size and sha256, for the before/after listing. */
function listing(): Map<string, string> {
	const files = new Map<string, string>();
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else files.set(path.relative(appDir, full), crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex").slice(0, 12));
		}
	};
	walk(appDir);
	return files;
}

function preferredFile(agentId: string): string {
	return path.join(root, agentId, "runtime", "preferred-model.json");
}

function writePreferred(agentId: string, content: string): void {
	fs.mkdirSync(path.dirname(preferredFile(agentId)), { recursive: true });
	fs.writeFileSync(preferredFile(agentId), content);
}

const room = (name: string) => createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;

try {
	const chatgptRoom = room("ChatGPT Room");
	const claudeRoom = room("Claude Room");
	const goneGatewayRoom = room("Gone Gateway Room");
	const plainRoom = room("Plain Room");
	const unreadableRoom = room("Unreadable Room");
	const halfDoneRoom = room("Half Done Room");
	writePreferred(chatgptRoom, JSON.stringify({ schemaVersion: 1, provider: "openai-codex", model: "gpt-5.6-terra", updatedAt: "2026-09-20T10:00:00.000Z" }));
	writePreferred(claudeRoom, JSON.stringify({ schemaVersion: 1, provider: "anthropic", model: "claude-sonnet-5", updatedAt: "2026-09-20T10:00:00.000Z" }));
	writePreferred(goneGatewayRoom, JSON.stringify({ schemaVersion: 1, provider: "gw-deleted-gateway", model: "phantom-model", updatedAt: "2026-09-20T10:00:00.000Z" }));
	writePreferred(unreadableRoom, "not json");
	writePreferred(halfDoneRoom, JSON.stringify({ schemaVersion: 1, provider: "openai-codex", model: "gpt-6-luna", updatedAt: "2026-09-20T10:00:00.000Z" }));
	fs.writeFileSync(path.join(root, halfDoneRoom, "runtime", "models.json"), JSON.stringify({ schemaVersion: 1, conversation: { provider: "openai-codex", model: "gpt-6-astra" }, updatedAt: "2026-09-21T10:00:00.000Z" }, null, 2));
	// An open conversation with its own lock, in the ChatGPT room.
	const thread = writePersistentAgentThread(chatgptRoom, "c_open_0001", { state: "active", origin: "home", model: { provider: "openai-codex", model: "gpt-6-sol" }, items: [] }, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: chatgptRoom, threadId: "c_open_0001", model, cwd: tempHome }),
	});
	const threadFile = path.join(root, chatgptRoom, "runtime", "threads", "c_open_0001.json");
	assert(fs.existsSync(threadFile) && thread.thread.model.model === "gpt-6-sol", "the open conversation's thread file exists with its lock");
	const threadBefore = fs.readFileSync(threadFile, "utf-8");

	const before = listing();
	const first = migrateRoomModels({ now: new Date("2026-09-25T09:00:00.000Z") });
	const after = listing();
	// The listing shows the files a model choice lives in; the rest of each
	// room is the scaffold, and the whole-folder comparison below covers it.
	const shown = (file: string) => /(preferred-model|models|persistent-agent-ai-profile|web-chat-model|built-in-ai-profile-preferences|room-models-migration)\.json$|threads\//.test(file);
	console.log("  before:");
	for (const [file, hash] of before) if (shown(file)) console.log(`    ${file}  ${hash}${after.get(file) === hash ? "" : after.has(file) ? "  (changed)" : "  (removed)"}`);
	console.log("  after, new or changed:");
	for (const [file, hash] of after) if (before.get(file) !== hash) console.log(`    ${file}  ${hash}`);
	const changedOutsideModels = [...after].filter(([file, hash]) => before.get(file) !== hash && !shown(file)).concat([...before].filter(([file]) => !after.has(file) && !shown(file)));
	assert(changedOutsideModels.length === 0, `the migration touches only model files, got ${JSON.stringify(changedOutsideModels)}`);

	// The defaults.
	const defaults = readStoredAiDefaults();
	assert(key(defaults.conversation) === "openai-codex/gpt-6-luna", `the conversation default is the app's last pick for new rooms, got ${key(defaults.conversation)}`);
	assert(key(defaults.memory) === "openai-codex/gpt-6-astra", `the memory default is the profile's Memorize model, got ${key(defaults.memory)}`);
	const stateFile = JSON.parse(fs.readFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), "utf-8"));
	assert(stateFile.profileId === "chatgpt-codex", "the saved profile pointer stays");
	assert(first.defaults.written && first.defaults.conversationFrom === "last-pick", `the report says the defaults were written from the last pick, got ${JSON.stringify(first.defaults)}`);
	assert(first.defaults.lastPickRemoved && !fs.existsSync(path.join(appDir, "web-chat-model.json")), "the old last pick goes once the defaults hold it");
	assert(first.collapsed.length === 1 && key(first.collapsed[0]!.review) === "openai-codex/gpt-6-sol" && key(first.collapsed[0]!.memorize) === "openai-codex/gpt-6-astra", `the Review pick that differed is reported as collapsed into Memorize's, got ${JSON.stringify(first.collapsed)}`);
	pass("the defaults keep the last pick for new rooms and the Memorize model, and the differing Review pick is reported as collapsed");

	// The rooms.
	assert(key(readRoomModels(chatgptRoom)?.conversation) === "openai-codex/gpt-5.6-terra", "the ChatGPT room keeps its pick");
	assert(key(readRoomModels(claudeRoom)?.conversation) === "anthropic/claude-sonnet-5", "the Claude room keeps its pick, on another provider than the profile's");
	assert(key(readRoomModels(goneGatewayRoom)?.conversation) === "gw-deleted-gateway/phantom-model", "a pick on a gateway that is gone is kept as it was");
	assert(readRoomModels(plainRoom) === null, "a room with no preference gets no file and inherits the default");
	assert(readRoomModels(unreadableRoom) === null, "an unreadable preference moves nothing");
	assert(key(readRoomModels(halfDoneRoom)?.conversation) === "openai-codex/gpt-6-astra", "a room an earlier run already moved keeps what that run wrote");
	for (const agentId of [chatgptRoom, claudeRoom, goneGatewayRoom, unreadableRoom, halfDoneRoom]) assert(!fs.existsSync(preferredFile(agentId)), `the old preference file of ${agentId} is gone once its pick is safe`);
	assert(JSON.stringify(first.rooms.map((row) => row.agentId).sort()) === JSON.stringify([chatgptRoom, claudeRoom, goneGatewayRoom].sort()), `the report lists the three rooms that moved, got ${JSON.stringify(first.rooms)}`);
	assert(first.unavailable.length === 1 && first.unavailable[0]!.agentId === goneGatewayRoom && first.unavailable[0]!.reason === "not-offered", `the report lists the gone gateway's pick as unavailable, got ${JSON.stringify(first.unavailable)}`);
	const goneRow = resolveRoomModel(goneGatewayRoom, "conversation");
	assert(goneRow.effective === null && goneRow.reason === "not-offered" && key(goneRow.chosen) === "gw-deleted-gateway/phantom-model", `that room waits for its pick: nothing runs in its place, got ${JSON.stringify(goneRow)}`);
	assert(first.errors.length === 0, `no errors, got ${JSON.stringify(first.errors)}`);
	pass("each room's preference becomes its conversation pick, the unavailable one is reported and waits, and no old file is left");

	assert(fs.readFileSync(threadFile, "utf-8") === threadBefore, "the open conversation's thread file is byte-identical");
	pass("the open conversation keeps its own lock, untouched");
	const report = JSON.parse(fs.readFileSync(ROOM_MODELS_MIGRATION_REPORT_FILE, "utf-8"));
	assert(report.rooms.length === 3 && report.collapsed.length === 1 && report.unavailable.length === 1, "the report file holds what the run did");
	pass("the report file lists the moved rooms, the collapsed pick and the unavailable pick");

	// The second run.
	const reportBefore = fs.readFileSync(ROOM_MODELS_MIGRATION_REPORT_FILE, "utf-8");
	const settled = listing();
	const second = migrateRoomModels({ now: new Date("2026-09-25T10:00:00.000Z") });
	const again = listing();
	assert(JSON.stringify([...again]) === JSON.stringify([...settled]), "the second run changes no file");
	assert(!second.defaults.written && second.rooms.length === 0 && second.errors.length === 0, `the second run moves nothing, got ${JSON.stringify(second)}`);
	assert(fs.readFileSync(ROOM_MODELS_MIGRATION_REPORT_FILE, "utf-8") === reportBefore, "the second run leaves the first run's report as it was");
	pass("the second run changes nothing and keeps the first run's report");

	// A saved gateway whose sign-in lapsed, ChatGPT signed in, no defaults yet.
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Company Gateway", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }, { id: "maint-model", name: "Maintenance Model", contextWindow: 200000, maxTokens: 32000 }] } } }, null, 2));
	fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Company Gateway", roomModels: [{ modelId: "room-model" }], maintenanceModel: "maint-model" }, null, 2));
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: "synthetic-codex" } }, null, 2), { mode: 0o600 });
	const lapsed = migrateRoomModels({ now: new Date("2026-09-25T11:00:00.000Z") });
	const gatewayDefaults = readStoredAiDefaults();
	assert(lapsed.defaults.written && key(gatewayDefaults.conversation) === "openai-compatible/room-model" && key(gatewayDefaults.memory) === "openai-compatible/maint-model", `a saved gateway whose sign-in lapsed gives the gateway's defaults, got ${JSON.stringify(gatewayDefaults)}`);
	const waiting = resolveRoomModel(plainRoom, "conversation");
	assert(waiting.effective === null && waiting.reason === "signed-out" && key(waiting.chosen) === "openai-compatible/room-model", `a room on those defaults waits for the gateway and never runs on ChatGPT, got ${JSON.stringify(waiting)}`);
	pass("a saved gateway whose sign-in lapsed keeps its defaults: rooms wait for it instead of moving to ChatGPT");

	console.log("room models migration smoke passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
