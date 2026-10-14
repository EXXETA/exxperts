// An update moves a default that nobody chose: ChatGPT's went from GPT-6 Sol
// to GPT-6.1 Sol in 0.14.3, the Memory model and the conversation model both.
//
// The 0.14 migration wrote each install's defaults once, the memory one from
// the profile, so an install signed in to ChatGPT stores GPT-6 Sol as its
// memory default. On the update:
//   - a stored GPT-6 Sol default moves to GPT-6.1 Sol, once, and the move is
//     recorded, unless something on disk shows the person chose it; with no
//     migration record, or one that wrote nothing, nothing does;
//   - a default the person changed after the migration wrote it, and a room's
//     own Memory model, are left alone;
//   - a Remember page written on GPT-6 Sol before the update still saves for a
//     room on the default, and a page from any other model is still refused;
//   - a Memorize or Review that goes on after the update runs on the room's
//     Memory model as it now resolves, GPT-6.1 Sol.
//
// The conversation default moves the same way, once, except when the
// migration took it from the person's last pick. A room's own pick stays, and
// a conversation already under way keeps its lock. A fresh install starts on
// GPT-6.1 Sol.
//
// Offline: no server, no provider, no network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "default-move-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
const cwd = path.join(tempHome, "cwd");
for (const dir of [agentDir, appDir, cwd]) fs.mkdirSync(dir, { recursive: true });
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(appDir, "personalized-agents");
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: "synthetic-codex" }, anthropic: { type: "api_key", key: "synthetic-anthropic" } }, null, 2), { mode: 0o600 });

const agents = await import("../src/persistent-agents.js");
const { migrateRoomModels, ROOM_MODELS_MIGRATION_REPORT_FILE } = await import("../src/room-models-migration.js");
const roomModels = await import("../src/room-models.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const key = (lock: { provider: string; model: string } | null | undefined) => (lock ? `${lock.provider}/${lock.model}` : "none");
const SOL = { provider: "openai-codex", model: "gpt-6-sol" };
const SOL_61 = { provider: "openai-codex", model: "gpt-6.1-sol" };
const ASTRA = { provider: "openai-codex", model: "gpt-6-astra" };
const OPUS = { provider: "anthropic", model: "claude-opus-5-5" };
const profileFile = path.join(appDir, "persistent-agent-ai-profile.json");

/** An install as 0.14.2 left it: ChatGPT saved, its defaults written by the migration, the report naming what it wrote. */
function install(stored: { conversation?: unknown; memory?: unknown }, reportMemory: unknown | null, reportConversation: { conversation: unknown; conversationFrom?: string } = { conversation: SOL }): void {
	fs.writeFileSync(profileFile, JSON.stringify({ profileId: "chatgpt-codex", defaults: stored }, null, 2));
	fs.rmSync(ROOM_MODELS_MIGRATION_REPORT_FILE, { force: true });
	for (const task of ["conversation", "memory"] as const) fs.rmSync(roomModels.defaultMoveFile(task), { force: true });
	if (reportMemory) fs.writeFileSync(ROOM_MODELS_MIGRATION_REPORT_FILE, JSON.stringify({ schemaVersion: 1, migratedAt: "2026-09-28T09:00:00.000Z", defaults: { written: true, ...reportConversation, memory: reportMemory }, collapsed: [], rooms: [], unavailable: [], errors: [] }, null, 2));
}

/** A Remember page for the room's open conversation, written on the given model. */
function rememberPage(agentId: string, threadId: string, model: { provider: string; model: string }) {
	const write = agents.writePersistentAgentThread(agentId, threadId, { state: "active", origin: "home", model: SOL, items: [{ kind: "user", id: "u1", text: "The kickoff is on Monday." }] }, {
		createRuntime: ({ model: lock }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model: lock, cwd }),
	});
	assert(write.thread.runtime.kind === "pi-session-jsonl", "the conversation is backed by a session file");
	const session = agents.openPersistentAgentPiSessionManager(agentId, write.thread.runtime, cwd);
	session.appendMessage({ role: "user", content: "The kickoff is on Monday.", timestamp: Date.now() } as any);
	const l1b = fs.readFileSync(path.join(process.env.EXXETA_PERSISTENT_AGENTS_ROOT!, agentId, "L1b", "current.md"), "utf-8");
	const source = agents.buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId: threadId, l1b, runtimeCwd: cwd }).source;
	return {
		conversationId: threadId,
		density: "compact",
		proposal: { agentId, conversationId: threadId, sessionId: null, writesMemory: false, source, process: { model } },
		approvedRecentContext: ["### RC-DRAFT | CLOSED | 2026-10-08 | Kickoff", "", "**Session arc:** The kickoff date was set.", "", "**Body:**", "- The kickoff is on Monday.", "", "**Parked:**", "None", ""].join("\n"),
	};
}

/** What the Save route does with a page: the room's Memory models, then the parse. */
function save(agentId: string, page: unknown): "saved" | string {
	try {
		agents.parseCheckpointApprovalRequest(page, agentId, roomModels.rememberSaveMemoryModels(agentId));
		return "saved";
	} catch (error) {
		return (error as Error).message;
	}
}

try {
	const onDefault = agents.createPersistentAgentFromScaffoldInput({ displayName: "On The Default", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const ownPick = agents.createPersistentAgentFromScaffoldInput({ displayName: "Own Pick", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(ownPick, { memory: SOL });
	const pageBefore = rememberPage(onDefault, "c_waiting_0001", SOL);

	// --- The move ------------------------------------------------------------------
	install({ conversation: SOL, memory: SOL }, SOL);
	migrateRoomModels({ now: new Date("2026-10-09T08:00:00.000Z") });
	assert(key(roomModels.readStoredAiDefaults().memory) === key(SOL_61), `a memory default the migration wrote moves to GPT-6.1 Sol, got ${key(roomModels.readStoredAiDefaults().memory)}`);
	assert(key(roomModels.readStoredAiDefaults().conversation) === key(SOL_61), "a conversation default the report does not say came from the person's last pick moves too");
	const move = roomModels.readDefaultMove("memory");
	assert(key(move?.from) === key(SOL) && key(move?.to) === key(SOL_61) && move?.at === "2026-10-09T08:00:00.000Z", `the move is recorded, got ${JSON.stringify(move)}`);
	assert(key(roomModels.resolveRoomModel(onDefault, "memory").effective) === key(SOL_61), "a room on the default now runs its memory work on GPT-6.1 Sol");
	assert(key(roomModels.resolveRoomModel(ownPick, "memory").effective) === key(SOL), "a room that chose GPT-6 Sol keeps it");
	const recorded = fs.readFileSync(roomModels.defaultMoveFile("memory"), "utf-8");
	migrateRoomModels({ now: new Date("2026-10-09T09:00:00.000Z") });
	assert(key(roomModels.readStoredAiDefaults().memory) === key(SOL_61) && fs.readFileSync(roomModels.defaultMoveFile("memory"), "utf-8") === recorded, "a second start changes nothing");
	pass("a memory default the migration wrote moves to GPT-6.1 Sol once, recorded; a room's own pick stays");

	// --- A page that was waiting -----------------------------------------------------
	assert(save(onDefault, pageBefore) === "saved", `a GPT-6 Sol page written before the update still saves for a room on the default, got ${save(onDefault, pageBefore)}`);
	assert(save(onDefault, rememberPage(onDefault, "c_waiting_0002", SOL_61)) === "saved", "a page on the new default saves");
	const foreign = save(onDefault, rememberPage(onDefault, "c_waiting_0003", OPUS));
	assert(foreign === agents.REMEMBER_MEMORY_MODEL_CHANGED_MESSAGE, `a page from another model is still refused, got ${foreign}`);
	assert(save(ownPick, rememberPage(ownPick, "c_waiting_0004", SOL)) === "saved", "a room that chose GPT-6 Sol saves its GPT-6 Sol page");
	assert(save(ownPick, rememberPage(ownPick, "c_waiting_0005", SOL_61)) === agents.REMEMBER_MEMORY_MODEL_CHANGED_MESSAGE, "a room that chose GPT-6 Sol does not take a GPT-6.1 Sol page: the move was not its");
	pass("a GPT-6 Sol page waiting across the update saves for a room on the default; any other change is still refused");

	// --- Picked again after the move ---------------------------------------------------
	roomModels.writeAiDefaults({ memory: { ...SOL } });
	migrateRoomModels({ now: new Date("2026-10-09T09:30:00.000Z") });
	assert(key(roomModels.readStoredAiDefaults().memory) === key(SOL), `GPT-6 Sol picked again after the move stays, got ${key(roomModels.readStoredAiDefaults().memory)}`);
	pass("a memory default picked again after the move is not moved a second time");

	// --- Left alone --------------------------------------------------------------------
	install({ conversation: SOL, memory: SOL }, ASTRA);
	migrateRoomModels({ now: new Date("2026-10-09T10:00:00.000Z") });
	assert(key(roomModels.readStoredAiDefaults().memory) === key(SOL) && !roomModels.readDefaultMove("memory"), "a memory default the person changed after the migration stays");
	assert(save(onDefault, rememberPage(onDefault, "c_waiting_0006", SOL_61)) === agents.REMEMBER_MEMORY_MODEL_CHANGED_MESSAGE, "with no move, a page from another model is refused as before");
	// A report a later start rewrote, saying it wrote nothing, vouches for nothing: the default stays.
	install({ conversation: SOL, memory: SOL }, SOL);
	fs.writeFileSync(ROOM_MODELS_MIGRATION_REPORT_FILE, JSON.stringify({ schemaVersion: 1, migratedAt: "2026-10-09T10:20:00.000Z", defaults: { written: false }, collapsed: [], rooms: [], unavailable: [], errors: [] }, null, 2));
	migrateRoomModels({ now: new Date("2026-10-09T10:25:00.000Z") });
	assert(key(roomModels.readStoredAiDefaults().memory) === key(SOL_61) && key(roomModels.readStoredAiDefaults().conversation) === key(SOL_61), "a rewritten report with nothing written shows no choice: both defaults move");
	// A start cut short after the record and before the move moves it at the next start.
	install({ conversation: SOL, memory: SOL }, SOL);
	roomModels.writeDefaultMove("memory", { from: { ...SOL }, to: { ...SOL_61 }, at: "2026-10-09T10:30:00.000Z" });
	migrateRoomModels({ now: new Date("2026-10-09T10:40:00.000Z") });
	assert(key(roomModels.readStoredAiDefaults().memory) === key(SOL_61), `a move cut short is made at the next start, got ${key(roomModels.readStoredAiDefaults().memory)}`);
	pass("a default the person changed after the migration stays; one a rewritten report does not vouch for moves");

	// --- No migration record -------------------------------------------------------------
	install({ conversation: SOL, memory: SOL }, null);
	migrateRoomModels({ now: new Date("2026-10-09T11:00:00.000Z") });
	assert(key(roomModels.readStoredAiDefaults().memory) === key(SOL_61) && key(roomModels.readStoredAiDefaults().conversation) === key(SOL_61), `with no record of the migration nothing shows a choice: both defaults move, got ${JSON.stringify(roomModels.readStoredAiDefaults())}`);
	assert(roomModels.readDefaultMove("memory")?.done === true && roomModels.readDefaultMove("conversation")?.done === true, "both moves are recorded");
	const noRecord = ["conversation", "memory"].map((task) => fs.readFileSync(roomModels.defaultMoveFile(task as "conversation" | "memory"), "utf-8")).join("");
	migrateRoomModels({ now: new Date("2026-10-09T11:10:00.000Z") });
	assert(key(roomModels.readStoredAiDefaults().memory) === key(SOL_61) && ["conversation", "memory"].map((task) => fs.readFileSync(roomModels.defaultMoveFile(task as "conversation" | "memory"), "utf-8")).join("") === noRecord, "a second start changes nothing");
	roomModels.writeAiDefaults({ conversation: { ...SOL }, memory: { ...SOL } });
	migrateRoomModels({ now: new Date("2026-10-09T11:20:00.000Z") });
	assert(key(roomModels.readStoredAiDefaults().memory) === key(SOL) && key(roomModels.readStoredAiDefaults().conversation) === key(SOL), "GPT-6 Sol picked again after the move stays on both rows");
	pass("with no record of the migration both defaults move once; a pick made again after it stays");

	// --- A Memorize model saved before 0.14 --------------------------------------------
	// 0.13 saved the Memorize model even when the person kept the default, so it proves no choice: the memory default moves.
	const preferencesFile = path.join(appDir, "built-in-ai-profile-preferences.json");
	install({ conversation: SOL, memory: SOL }, null);
	fs.writeFileSync(preferencesFile, JSON.stringify({ version: 1, profiles: { "chatgpt-codex": { learnModel: "gpt-6-sol", reviewMemoryModel: "gpt-6-astra" } } }, null, 2));
	migrateRoomModels({ now: new Date("2026-10-09T11:30:00.000Z") });
	assert(key(roomModels.readStoredAiDefaults().memory) === key(SOL_61) && roomModels.readDefaultMove("memory")?.done === true, `a memory default saved as the Memorize model before 0.14 moves, got ${key(roomModels.readStoredAiDefaults().memory)}`);
	assert(key(roomModels.readStoredAiDefaults().conversation) === key(SOL_61), "the conversation default, with nothing showing a choice, moves too");
	fs.rmSync(preferencesFile, { force: true });
	pass("a GPT-6 Sol saved as the Memorize model before 0.14 proves no choice: both defaults move");

	// --- The conversation default ------------------------------------------------------
	const conversationMove = () => roomModels.readDefaultMove("conversation");
	const storedConversation = () => key(roomModels.readStoredAiDefaults().conversation);
	install({ conversation: SOL, memory: SOL_61 }, SOL_61, { conversation: SOL, conversationFrom: "recommended" });
	roomModels.writeRoomModels(ownPick, { conversation: SOL });
	const underWay = "c_under_way_0001";
	rememberPage(onDefault, underWay, SOL);
	const prepared = "c_prepared_0001";
	agents.writePersistentAgentThread(onDefault, prepared, { state: "active", origin: "home", model: SOL, items: [] }, {
		createRuntime: ({ model: lock }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: onDefault, threadId: prepared, model: lock, cwd }),
	});
	migrateRoomModels({ now: new Date("2026-10-12T08:00:00.000Z") });
	assert(storedConversation() === key(SOL_61), `a conversation default the migration took from the recommendation moves to GPT-6.1 Sol, got ${storedConversation()}`);
	assert(key(conversationMove()?.from) === key(SOL) && key(conversationMove()?.to) === key(SOL_61) && conversationMove()?.at === "2026-10-12T08:00:00.000Z" && conversationMove()?.done === true, `the conversation move is recorded, got ${JSON.stringify(conversationMove())}`);
	assert(key(roomModels.resolveRoomModel(onDefault, "conversation").effective) === key(SOL_61), "a room on the default starts its next conversation on GPT-6.1 Sol");
	assert(key(roomModels.resolveRoomModel(ownPick, "conversation").effective) === key(SOL), "a room that chose GPT-6 Sol for its conversations keeps it");
	assert(key(agents.getPersistentAgentThread(onDefault, underWay)?.model) === key(SOL), "a conversation under way keeps its GPT-6 Sol lock");
	assert(agents.emptyPersistentAgentThreadModelTarget(onDefault, underWay, () => roomModels.resolveRoomModel(onDefault, "conversation").effective) === null, "a conversation under way is not moved to the new default");
	// An empty conversation follows the room's pick until its first message, as it does after any pick.
	assert(key(agents.emptyPersistentAgentThreadModelTarget(onDefault, prepared, () => roomModels.resolveRoomModel(onDefault, "conversation").effective)) === key(SOL_61), "an empty conversation boots on the new default");
	const conversationRecorded = fs.readFileSync(roomModels.defaultMoveFile("conversation"), "utf-8");
	migrateRoomModels({ now: new Date("2026-10-12T09:00:00.000Z") });
	assert(storedConversation() === key(SOL_61) && fs.readFileSync(roomModels.defaultMoveFile("conversation"), "utf-8") === conversationRecorded, "a second start changes nothing");
	roomModels.writeAiDefaults({ conversation: { ...SOL } });
	migrateRoomModels({ now: new Date("2026-10-12T09:30:00.000Z") });
	assert(storedConversation() === key(SOL), `GPT-6 Sol picked again after the move stays, got ${storedConversation()}`);
	pass("a conversation default taken from the recommendation moves to GPT-6.1 Sol once, recorded; a room's own pick and a conversation under way stay");

	install({ conversation: SOL, memory: SOL_61 }, SOL_61, { conversation: SOL, conversationFrom: "last-pick" });
	migrateRoomModels({ now: new Date("2026-10-12T10:00:00.000Z") });
	assert(storedConversation() === key(SOL) && !conversationMove(), "a conversation default the migration took from the person's last pick stays");
	install({ conversation: ASTRA, memory: SOL_61 }, SOL_61, { conversation: SOL, conversationFrom: "recommended" });
	migrateRoomModels({ now: new Date("2026-10-12T10:10:00.000Z") });
	assert(storedConversation() === key(ASTRA) && !conversationMove(), "a conversation default the person changed after the migration stays");
	install({ conversation: SOL, memory: SOL_61 }, SOL_61, { conversation: SOL });
	migrateRoomModels({ now: new Date("2026-10-12T10:20:00.000Z") });
	assert(storedConversation() === key(SOL_61) && conversationMove()?.done === true, "a report that does not say where the conversation default came from shows no choice: it moves");
	install({ conversation: SOL, memory: SOL_61 }, null);
	migrateRoomModels({ now: new Date("2026-10-12T10:30:00.000Z") });
	assert(storedConversation() === key(SOL_61) && conversationMove()?.done === true, "with no record of the migration, the conversation default moves");
	// An update from before 0.14: this start writes the defaults from the person's last pick, and that stays.
	install({}, null);
	fs.writeFileSync(roomModels.LEGACY_ROOM_MODEL_SELECTION_FILE, JSON.stringify(SOL));
	const lastPickNow = migrateRoomModels({ now: new Date("2026-10-12T10:40:00.000Z") });
	assert(lastPickNow.defaults.conversationFrom === "last-pick" && storedConversation() === key(SOL) && !conversationMove(), `a conversation default this start took from the person's last pick stays, got ${storedConversation()}`);
	pass("a conversation default from the person's last pick, or one changed since, stays; one with no proof of a choice moves");

	// --- A move that fails --------------------------------------------------------------
	// A row's move record cannot be saved (a folder stands where the file goes): that row's move fails and is made at the next start; the other row moves, or keeps the proof of the person's choice, either way.
	const blockRecord = (task: "conversation" | "memory") => fs.mkdirSync(roomModels.defaultMoveFile(task), { recursive: true });
	const unblockRecord = (task: "conversation" | "memory") => fs.rmSync(roomModels.defaultMoveFile(task), { recursive: true, force: true });
	const savedReport = () => JSON.parse(fs.readFileSync(ROOM_MODELS_MIGRATION_REPORT_FILE, "utf-8"));
	install({ conversation: SOL, memory: SOL }, SOL, { conversation: SOL, conversationFrom: "last-pick" });
	blockRecord("memory");
	const failed = migrateRoomModels({ now: new Date("2026-10-12T12:00:00.000Z") });
	assert(failed.errors.some((error) => error.startsWith("memory default:")) && key(roomModels.readStoredAiDefaults().memory) === key(SOL), `the memory move fails and says so, got ${JSON.stringify(failed.errors)}`);
	assert(savedReport().defaults.written === true && savedReport().defaults.conversationFrom === "last-pick" && savedReport().errors.length > 0, `the report keeps the record of what the migration wrote beside the error, got ${JSON.stringify(savedReport().defaults)}`);
	unblockRecord("memory");
	migrateRoomModels({ now: new Date("2026-10-12T12:10:00.000Z") });
	assert(key(roomModels.readStoredAiDefaults().memory) === key(SOL_61) && roomModels.readDefaultMove("memory")?.done === true, `the failed memory move is made at the next start, got ${key(roomModels.readStoredAiDefaults().memory)}`);
	assert(storedConversation() === key(SOL) && !conversationMove(), "the conversation default from the person's last pick stays across both starts");
	install({ conversation: SOL, memory: SOL }, ASTRA, { conversation: SOL, conversationFrom: "recommended" });
	blockRecord("conversation");
	migrateRoomModels({ now: new Date("2026-10-12T12:20:00.000Z") });
	assert(storedConversation() === key(SOL) && key(roomModels.readStoredAiDefaults().memory) === key(SOL), "the conversation move fails; the memory default the person changed stays");
	unblockRecord("conversation");
	migrateRoomModels({ now: new Date("2026-10-12T12:30:00.000Z") });
	assert(storedConversation() === key(SOL_61) && conversationMove()?.done === true, `the failed conversation move is made at the next start, got ${storedConversation()}`);
	assert(key(roomModels.readStoredAiDefaults().memory) === key(SOL) && !roomModels.readDefaultMove("memory"), "the memory default the person changed still stays at the next start");
	// The default moved but its last record did not save: the move counts as made, and a pick made again after it stays.
	install({ conversation: SOL_61, memory: SOL_61 }, SOL, { conversation: SOL, conversationFrom: "recommended" });
	roomModels.writeDefaultMove("conversation", { from: { ...SOL }, to: { ...SOL_61 }, at: "2026-10-12T12:40:00.000Z" });
	migrateRoomModels({ now: new Date("2026-10-12T12:45:00.000Z") });
	assert(conversationMove()?.done === true, "a move whose default moved but whose record did not save is recorded as made");
	roomModels.writeAiDefaults({ conversation: { ...SOL } });
	migrateRoomModels({ now: new Date("2026-10-12T12:50:00.000Z") });
	assert(storedConversation() === key(SOL), `GPT-6 Sol picked again after such a move stays, got ${storedConversation()}`);
	pass("a move that fails on one row leaves the other row's move and proof; it is made at the next start, once");

	// --- A fresh install -----------------------------------------------------------------
	install({}, null);
	const fresh = migrateRoomModels({ now: new Date("2026-10-12T11:00:00.000Z") });
	assert(storedConversation() === key(SOL_61) && fresh.defaults.conversationFrom === "recommended", `a fresh install signed in to ChatGPT starts its conversations on GPT-6.1 Sol, got ${storedConversation()}`);
	assert(!conversationMove(), "a fresh install records no move");
	pass("a fresh install signed in to ChatGPT starts on GPT-6.1 Sol");
	console.log("default move smoke passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
