import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated HOME and rooms root: nothing here touches the developer's rooms.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-room-last-used-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
delete process.env.EXXPERTS_STATE_HOME;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const { beginPersistentAgentTurn, createPersistentAgentFromScaffoldInput, finishPersistentAgentTurn, getPersistentAgentStatus, getPersistentAgentThread, writePersistentAgentThread } = await import("../src/persistent-agents.js");
const { persistentRoomLastUsedPath, readPersistentRoomLastUsed, recordPersistentRoomLastUsed, recordPersistentRoomLastUsedIfAbsent } = await import("../src/persistent-room-last-used.js");
const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
writePersistentAgentAiProfileState("openai-compatible");

const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** Run `fn` with console.warn caught: what it returns (or throws), and what was logged. */
function withWarnings<T>(fn: () => T): { value: T; warnings: string[] } {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
	try {
		return { value: fn(), warnings };
	} finally {
		console.warn = original;
	}
}

const leftovers = (dir: string): string[] => fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));

try {
	// --- A room nobody has used: no stamp, no estimate, and reading makes nothing ---
	const serverRoom = createPersistentAgentFromScaffoldInput({ displayName: "Last Used Server Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const stampFile = persistentRoomLastUsedPath(serverRoom);
	assert(stampFile === path.join(root, serverRoom, "runtime", "last-used.json"), "the stamp lives in the room's runtime folder");
	assert(readPersistentRoomLastUsed(serverRoom) === null, "a room never used has no stamp");
	let status = getPersistentAgentStatus(serverRoom);
	assert(status.lastUsedAt === null && status.lastUsedIsEstimate === false, "a room never used, with no conversation, has no last-used time and no estimate");
	assert(!fs.existsSync(stampFile), "reading the status writes no stamp");

	// --- The estimate: the newest change of any conversation somebody spoke in, given once ---
	const threadsDir = path.join(root, serverRoom, "runtime", "threads");
	const threadId = "last_used_smoke_0001";
	writePersistentAgentThread(serverRoom, threadId, { state: "active", origin: "home", model, items: [] });
	status = getPersistentAgentStatus(serverRoom);
	assert(status.activeThread?.threadId === threadId && status.activeThread.hasUserVisibleTurns === false, "fixture: an open conversation nobody spoke in");
	assert(status.lastUsedAt === null && status.lastUsedIsEstimate === false, "a conversation nobody spoke in is no estimate of use");
	assert(!fs.existsSync(stampFile), "and nothing is written for it");

	// Two closed conversations, spoken in, the older one written later; the open one still silent.
	const closedAt = (id: string, updatedAt: number, items: unknown[]): void => {
		writePersistentAgentThread(serverRoom, id, { state: "active", origin: "home", model, items: items as any });
		const file = path.join(threadsDir, `${id}.json`);
		const record = JSON.parse(fs.readFileSync(file, "utf-8"));
		fs.writeFileSync(file, JSON.stringify({ ...record, state: "closed", closedReason: "checkpoint", closedAt: updatedAt, updatedAt }, null, 2));
		// The open conversation stays the room's active one.
		writePersistentAgentThread(serverRoom, threadId, { state: "active", origin: "home", model, items: [] });
	};
	const newestSpoken = Date.parse("2026-08-31T09:00:00.000Z");
	closedAt("last_used_smoke_closed_newer", newestSpoken, [{ kind: "user", id: "u1", text: "Synthetic user message." }, { kind: "assistant", id: "a1", text: "Synthetic answer." }]);
	closedAt("last_used_smoke_closed_older", Date.parse("2026-07-01T09:00:00.000Z"), [{ kind: "user", id: "u2", text: "An older synthetic message." }]);
	closedAt("last_used_smoke_closed_silent", Date.parse("2026-09-15T09:00:00.000Z"), []);
	fs.writeFileSync(path.join(threadsDir, "last_used_smoke_junk.json"), "{ not a record");
	// A record whose time no Date can hold (finite, positive, out of range) is one record, not the whole room.
	const outOfRange = JSON.parse(fs.readFileSync(path.join(threadsDir, "last_used_smoke_closed_newer.json"), "utf-8"));
	fs.writeFileSync(path.join(threadsDir, "last_used_smoke_out_of_range.json"), JSON.stringify({ ...outOfRange, threadId: "last_used_smoke_out_of_range", updatedAt: 1e20 }));
	// A record the reader refuses outright (an id it will not accept) is one record, not the whole room.
	const refusedRecord = JSON.parse(fs.readFileSync(path.join(threadsDir, "last_used_smoke_closed_newer.json"), "utf-8"));
	fs.writeFileSync(path.join(threadsDir, "last_used_smoke_refused.json"), JSON.stringify({ ...refusedRecord, threadId: "last_used_smoke_refused", closedByCheckpointId: "../not an id", updatedAt: Date.parse("2026-09-20T09:00:00.000Z") }));
	// The reading of the conversation records is counted: it happens once per room per process while the room's conversations are the same files.
	const realReaddirSync = fs.readdirSync;
	const realReadFileSync = fs.readFileSync;
	let recordReads = 0;
	// (the open conversation's own record is read by every status regardless; it is not counted)
	(fs as any).readFileSync = (...args: any[]) => { if (String(args[0]).startsWith(threadsDir + path.sep) && !String(args[0]).endsWith(`${threadId}.json`)) recordReads += 1; return (realReadFileSync as any)(...args); };
	status = getPersistentAgentStatus(serverRoom);
	assert(status.lastUsedIsEstimate === true && status.lastUsedAt === new Date(newestSpoken).toISOString(), "with no stamp, the newest conversation somebody spoke in stands in, closed or not, flagged as an estimate; a newer one nobody spoke in, a record that cannot be read and a record whose time is out of range do not count");
	const written = readPersistentRoomLastUsed(serverRoom);
	assert(written?.door === "estimate" && written.lastUsedAt === status.lastUsedAt, "the estimate is written once as a stamp of its own door");
	const readsForTheWalk = recordReads;
	assert(readsForTheWalk >= 4, "fixture: the walk read the room's records");
	// Written once: a conversation changing afterwards does not move it while the stamp stands.
	closedAt("last_used_smoke_closed_newest", Date.parse("2026-09-16T09:00:00.000Z"), [{ kind: "user", id: "u3", text: "A newer synthetic message." }]);
	status = getPersistentAgentStatus(serverRoom);
	assert(status.lastUsedAt === new Date(newestSpoken).toISOString() && status.lastUsedIsEstimate === true, "the estimate is not recomputed while its stamp stands");
	// With the stamp gone: the conversation added since changed the listing, so the
	// records are read once more (not on every status), the estimate now includes
	// that conversation, and it is written again, the room having none.
	fs.rmSync(stampFile);
	recordReads = 0;
	status = getPersistentAgentStatus(serverRoom);
	status = getPersistentAgentStatus(serverRoom);
	const walkedAgain = recordReads;
	assert(walkedAgain > 0 && walkedAgain <= readsForTheWalk + 2, `the records are read once more for the changed listing, not on every status (${walkedAgain} reads for two statuses)`);
	assert(status.lastUsedIsEstimate === true && status.lastUsedAt === "2026-09-16T09:00:00.000Z" && readPersistentRoomLastUsed(serverRoom)?.door === "estimate", "the estimate includes the conversation added since and is written again, the room having no stamp");
	recordReads = 0;
	fs.rmSync(stampFile);
	getPersistentAgentStatus(serverRoom);
	assert(recordReads === 0 && !fs.existsSync(stampFile), `the same listing again: no record is read and nothing is written (reads=${recordReads}, stamp exists=${fs.existsSync(stampFile)})`);
	fs.readFileSync = realReadFileSync;

	// --- The estimate never replaces a stamp: a turn stamped by the other process while the status was being built wins ---
	{
		const racedRoom = createPersistentAgentFromScaffoldInput({ displayName: "Last Used Raced Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		const racedThreads = path.join(root, racedRoom, "runtime", "threads");
		writePersistentAgentThread(racedRoom, "last_used_smoke_raced", { state: "active", origin: "home", model, items: [{ kind: "user", id: "u1", text: "Synthetic user message." }] });
		const racedFile = path.join(racedThreads, "last_used_smoke_raced.json");
		fs.writeFileSync(racedFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(racedFile, "utf-8")), updatedAt: Date.parse("2026-07-01T09:00:00.000Z") }));
		const raceStamp = new Date("2026-09-21T09:00:00.000Z");
		// The terminal's turn lands between the status builder's read (no stamp) and its write: stood in for by a stamp written during the walk.
		(fs as any).readdirSync = (...args: any[]) => {
			if (String(args[0]) === racedThreads) recordPersistentRoomLastUsed(racedRoom, "cli", {}, raceStamp);
			return (realReaddirSync as any)(...args);
		};
		status = getPersistentAgentStatus(racedRoom);
		fs.readdirSync = realReaddirSync;
		const onDiskAfterRace = readPersistentRoomLastUsed(racedRoom);
		assert(onDiskAfterRace?.door === "cli" && onDiskAfterRace.lastUsedAt === raceStamp.toISOString(), "the turn's stamp is still on disk: the estimate did not replace it");
		assert(status.lastUsedAt === raceStamp.toISOString() && status.lastUsedIsEstimate === false, "and the status says the turn, not the estimate");
		// What this process remembers for the room is its estimate, not the stamp that won: with that stamp gone, the status says the estimate.
		fs.rmSync(persistentRoomLastUsedPath(racedRoom));
		status = getPersistentAgentStatus(racedRoom);
		assert(status.lastUsedIsEstimate === true && status.lastUsedAt === "2026-07-01T09:00:00.000Z", "with the turn's stamp gone, the room says the estimate this process made, flagged as one");
		assert(leftovers(path.dirname(persistentRoomLastUsedPath(racedRoom))).length === 0, "and the estimate's temporary file is gone");
		// The if-absent write on its own: absent, it writes; present, it yields what is there and touches nothing.
		fs.rmSync(persistentRoomLastUsedPath(racedRoom), { force: true });
		const fresh = recordPersistentRoomLastUsedIfAbsent(racedRoom, { schemaVersion: 1, lastUsedAt: "2026-01-01T00:00:00.000Z", door: "estimate" });
		assert(fresh?.door === "estimate" && readPersistentRoomLastUsed(racedRoom)?.lastUsedAt === "2026-01-01T00:00:00.000Z", "if absent, the estimate is written");
		const kept = recordPersistentRoomLastUsedIfAbsent(racedRoom, { schemaVersion: 1, lastUsedAt: "2026-02-02T00:00:00.000Z", door: "estimate" });
		assert(kept?.lastUsedAt === "2026-01-01T00:00:00.000Z" && readPersistentRoomLastUsed(racedRoom)?.lastUsedAt === "2026-01-01T00:00:00.000Z", "if present, what is there is returned and left as it was");
		assert(leftovers(path.dirname(persistentRoomLastUsedPath(racedRoom))).length === 0, "and no temporary file is left by the refused write");
		const ghostEstimate = withWarnings(() => recordPersistentRoomLastUsedIfAbsent("last-used-ghost-room", { schemaVersion: 1, lastUsedAt: "2026-01-01T00:00:00.000Z", door: "estimate" }));
		assert(ghostEstimate.value === null && !fs.existsSync(path.join(root, "last-used-ghost-room")) && ghostEstimate.warnings.length === 0, "a room that is gone gets no estimate and no folder");
	}
	// An archived room is left alone; restored, it is estimated like any other.
	const agentJsonPath = path.join(root, serverRoom, "agent.json");
	const agentJson = JSON.parse(fs.readFileSync(agentJsonPath, "utf-8"));
	fs.rmSync(stampFile, { force: true });
	fs.writeFileSync(agentJsonPath, JSON.stringify({ ...agentJson, archivedAt: Date.now(), archivedBy: "smoke", archivedReason: "smoke" }));
	status = getPersistentAgentStatus(serverRoom);
	assert(status.lastUsedAt === null && status.lastUsedIsEstimate === false && !fs.existsSync(stampFile), "an archived room without a stamp is neither estimated nor written to");
	fs.writeFileSync(agentJsonPath, JSON.stringify(agentJson));
	status = getPersistentAgentStatus(serverRoom);
	assert(status.lastUsedIsEstimate === true && status.lastUsedAt === "2026-09-16T09:00:00.000Z" && !fs.existsSync(stampFile), "restored, the room says the estimate this process already made, without writing it again");
	fs.rmSync(path.join(threadsDir, "last_used_smoke_closed_newest.json"));
	fs.rmSync(path.join(threadsDir, "last_used_smoke_junk.json"));
	fs.rmSync(path.join(threadsDir, "last_used_smoke_refused.json"));
	fs.rmSync(path.join(threadsDir, "last_used_smoke_out_of_range.json"));
	const spokenThread = { updatedAt: newestSpoken };

	// --- A turn that is refused never started: no stamp ---
	let refused = false;
	try { beginPersistentAgentTurn(serverRoom, "last_used_smoke_other"); } catch { refused = true; }
	assert(refused && !fs.existsSync(stampFile), "a refused turn leaves no stamp");

	// --- The server door: a turn starting stamps the room, and the stamp replaces the estimate ---
	const before = Date.now();
	const running = beginPersistentAgentTurn(serverRoom, threadId, { turnId: "turn_last_used_1" });
	const after = Date.now();
	assert(running.state === "running", "fixture: the turn started");
	const stamped = readPersistentRoomLastUsed(serverRoom);
	assert(stamped !== null && stamped.door === "server", "a turn starting on the server stamps the room, door server");
	const stampedTime = Date.parse(stamped.lastUsedAt);
	assert(stampedTime >= before && stampedTime <= after, "the stamp is the moment the turn started");
	const onDisk = JSON.parse(fs.readFileSync(stampFile, "utf-8"));
	assert(onDisk.schemaVersion === 1 && onDisk.lastUsedAt === stamped.lastUsedAt && onDisk.door === "server" && Object.keys(onDisk).length === 3, "the record is schemaVersion, lastUsedAt, door and nothing else");
	status = getPersistentAgentStatus(serverRoom);
	assert(status.lastUsedAt === stamped.lastUsedAt && status.lastUsedIsEstimate === false, "the status carries the turn's stamp, no longer an estimate");
	assert(Date.parse(stamped.lastUsedAt) > spokenThread.updatedAt, "fixture: the turn is newer than the estimate it replaced");
	assert(leftovers(path.dirname(stampFile)).length === 0, "the write leaves no temporary file behind");

	// A failed or cancelled turn still counts (the stamp was written at the
	// start and nothing takes it back), and the next turn moves it forward.
	finishPersistentAgentTurn(serverRoom, threadId, { turnId: "turn_last_used_1", terminalReason: "failed" });
	assert(readPersistentRoomLastUsed(serverRoom)?.lastUsedAt === stamped.lastUsedAt, "a turn that fails keeps its stamp");

	// --- A given moment is written as given; a second stamp replaces the first ---
	const later = new Date(stampedTime + 60_000);
	recordPersistentRoomLastUsed(serverRoom, "cli", {}, later);
	const restamped = readPersistentRoomLastUsed(serverRoom);
	assert(restamped?.lastUsedAt === later.toISOString() && restamped.door === "cli", "a later stamp replaces the earlier one, door included");
	assert(leftovers(path.dirname(stampFile)).length === 0, "and leaves no temporary file either");

	// --- The promise: a stamp that cannot be written never touches the turn ---
	fs.rmSync(stampFile);
	fs.mkdirSync(stampFile);
	const broken = withWarnings(() => beginPersistentAgentTurn(serverRoom, threadId, { turnId: "turn_last_used_2" }));
	assert(broken.value.state === "running" && broken.value.turnId === "turn_last_used_2", "with a folder where the stamp belongs, the turn starts all the same");
	assert(broken.warnings.length === 1 && broken.warnings[0].includes("[room-last-used]") && broken.warnings[0].includes(serverRoom) && broken.warnings[0].includes("door=server"), "the failure is logged once, naming the room and the door");
	assert(/EISDIR|ENOTEMPTY|EPERM|EEXIST|directory/i.test(broken.warnings[0]), "and with its cause");
	assert(fs.statSync(stampFile).isDirectory() && leftovers(path.dirname(stampFile)).length === 0, "the failed write cleans its temporary file up");
	assert(readPersistentRoomLastUsed(serverRoom) === null, "a folder where the stamp belongs reads as no stamp");
	status = getPersistentAgentStatus(serverRoom);
	assert(status.lastUsedIsEstimate === true && status.lastUsedAt !== null, "and the status falls back to the estimate instead of failing");
	finishPersistentAgentTurn(serverRoom, threadId, { turnId: "turn_last_used_2", terminalReason: "completed" });
	fs.rmdirSync(stampFile);

	// --- A room that is gone is not brought back by a stamp ---
	const ghost = withWarnings(() => recordPersistentRoomLastUsed("last-used-ghost-room", "server"));
	assert(!fs.existsSync(path.join(root, "last-used-ghost-room")), "stamping a room that does not exist creates no folder");
	assert(ghost.warnings.length === 0, "and is nothing to report");
	const invalid = withWarnings(() => recordPersistentRoomLastUsed("../escape", "server"));
	assert(invalid.warnings.length === 1 && invalid.warnings[0].includes("invalid persistent-room agent id"), "an id that is no room id is refused inside, logged, never thrown");
	assert(readPersistentRoomLastUsed("../escape") === null, "and reads as no stamp, never thrown");
	// A room whose runtime folder is missing gets it back (and only it).
	const bareRoom = path.join(root, "last-used-bare-room");
	fs.mkdirSync(bareRoom, { recursive: true });
	recordPersistentRoomLastUsed("last-used-bare-room", "server");
	assert(readPersistentRoomLastUsed("last-used-bare-room")?.door === "server", "a room without a runtime folder is stamped, the folder made for it");

	// --- The read is lenient: a record it cannot understand is no stamp ---
	const unreadable: Array<[string, string]> = [
		["not JSON", "{ nope"],
		["not an object", "\"2026-09-17T10:00:00.000Z\""],
		["another schema", JSON.stringify({ schemaVersion: 2, lastUsedAt: "2026-09-17T10:00:00.000Z", door: "server" })],
		["a time that is a number, even one that would parse as a year", JSON.stringify({ schemaVersion: 1, lastUsedAt: 2026, door: "server" })],
		["a time that does not parse", JSON.stringify({ schemaVersion: 1, lastUsedAt: "yesterday", door: "server" })],
		["no time", JSON.stringify({ schemaVersion: 1, door: "server" })],
	];
	for (const [label, content] of unreadable) {
		fs.writeFileSync(stampFile, content);
		assert(readPersistentRoomLastUsed(serverRoom) === null, `${label} reads as no stamp`);
		assert(getPersistentAgentStatus(serverRoom).lastUsedIsEstimate === true, `${label}: the status falls back to the estimate`);
	}
	fs.writeFileSync(stampFile, JSON.stringify({ schemaVersion: 1, lastUsedAt: "2026-09-17T10:00:00.000Z", door: "telepathy" }));
	const unknownDoor = readPersistentRoomLastUsed(serverRoom);
	assert(unknownDoor?.lastUsedAt === "2026-09-17T10:00:00.000Z" && unknownDoor.door === null, "a door this build does not know keeps the time and drops the door");
	assert(getPersistentAgentStatus(serverRoom).lastUsedIsEstimate === false, "and is not an estimate");
	fs.writeFileSync(stampFile, JSON.stringify({ schemaVersion: 1, lastUsedAt: "2026-09-17T10:00:00.000Z", door: "estimate" }));
	assert(getPersistentAgentStatus(serverRoom).lastUsedIsEstimate === true, "a stamp of door estimate reads as one");

	// --- A pipe where a record or the stamp belongs is not opened: it would block the whole server ---
	// (no pipes on Windows; the reads that refuse them are the same code there)
	if (process.platform !== "win32") {
		fs.rmSync(stampFile);
		const plain = getPersistentAgentStatus(serverRoom);
		assert(plain.lastUsedIsEstimate === true && plain.lastUsedAt !== null, "fixture: with the stamp gone the room says its estimate");
		// (the same listing again writes nothing: the stamp may or may not be there)
		fs.rmSync(stampFile, { force: true });
		const pipeRecord = path.join(threadsDir, "last_used_smoke_pipe.json");
		execFileSync("mkfifo", [pipeRecord]);
		status = getPersistentAgentStatus(serverRoom);
		assert(status.lastUsedIsEstimate === true && status.lastUsedAt === plain.lastUsedAt, "a pipe named like a conversation record is skipped by the walk: the status is built and the estimate is the same");
		fs.rmSync(pipeRecord);
		fs.rmSync(stampFile, { force: true });
		execFileSync("mkfifo", [stampFile]);
		assert(readPersistentRoomLastUsed(serverRoom) === null, "a pipe where the stamp belongs reads as no stamp");
		status = getPersistentAgentStatus(serverRoom);
		assert(status.lastUsedIsEstimate === true && status.lastUsedAt === plain.lastUsedAt, "and the status says the estimate, which the pipe keeps from being written");
		assert(fs.statSync(stampFile).isFIFO() && leftovers(path.dirname(stampFile)).length === 0, "the pipe is left where it is and no temporary file stays beside it");
		fs.rmSync(stampFile);
		fs.writeFileSync(stampFile, JSON.stringify({ schemaVersion: 1, lastUsedAt: "2026-09-17T10:00:00.000Z", door: "estimate" }));
	}

	// --- The terminal door: the REAL cli-rooms extension, its real message hook ---
	const cliRoom = createPersistentAgentFromScaffoldInput({ displayName: "Last Used Terminal Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const cliThreadId = "last_used_smoke_cli_0001";
	writePersistentAgentThread(cliRoom, cliThreadId, { state: "active", origin: "home", model, items: [] });
	process.env.EXXETA_PERSISTENT_ROOM_AGENT = cliRoom;
	process.env.EXXETA_PERSISTENT_ROOM_THREAD = cliThreadId;
	process.env.EXXETA_PERSISTENT_ROOM_MODEL_PROVIDER = model.provider;
	process.env.EXXETA_PERSISTENT_ROOM_MODEL_ID = model.model;
	const handlers = new Map<string, Array<(event: any) => unknown>>();
	const fakePi: any = new Proxy({}, {
		get: (_target, prop) => prop === "on"
			? (name: string, handler: (event: any) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }
			: () => undefined,
	});
	// Imported by a path the scripts typecheck does not follow: the extension is
	// not part of that project, and its own type errors are not this smoke's.
	const cliRoomsModule: string = "../../../pi-package/extensions/cli-rooms/index.js";
	const { default: cliRooms } = await import(cliRoomsModule) as { default: (pi: unknown) => void };
	cliRooms(fakePi);
	const messageEnd = handlers.get("message_end") ?? [];
	assert(messageEnd.length === 1, "fixture: the extension registers one message_end hook");
	const fire = async (message: unknown): Promise<void> => { for (const handler of messageEnd) await handler({ message }); };

	await fire({ role: "assistant", content: "Synthetic answer." });
	assert(readPersistentRoomLastUsed(cliRoom) === null, "an assistant message is not the user using the room");
	await fire({ role: "user", content: "   " });
	assert(readPersistentRoomLastUsed(cliRoom) === null, "an empty user message is not a turn");
	const cliBefore = Date.now();
	await fire({ role: "user", content: [{ type: "text", text: "Synthetic terminal message." }] });
	const cliStamp = readPersistentRoomLastUsed(cliRoom);
	assert(cliStamp !== null && cliStamp.door === "cli" && Date.parse(cliStamp.lastUsedAt) >= cliBefore, "a user message in the terminal stamps the room, door cli");
	assert(getPersistentAgentThread(cliRoom, cliThreadId)?.items.length === 2, "and the hook still records the messages it always recorded");
	status = getPersistentAgentStatus(cliRoom);
	assert(status.lastUsedAt === cliStamp.lastUsedAt && status.lastUsedIsEstimate === false, "the server's status reads the terminal's stamp");
	// A stamp that cannot be written does not cost the terminal its message either.
	fs.rmSync(persistentRoomLastUsedPath(cliRoom));
	fs.mkdirSync(persistentRoomLastUsedPath(cliRoom));
	const cliBroken = await (async () => {
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
		try { await fire({ role: "user", content: "Second synthetic terminal message." }); } finally { console.warn = original; }
		return warnings;
	})();
	assert(cliBroken.length === 1 && cliBroken[0].includes("door=cli"), "the terminal's failed stamp is logged, door cli");
	assert(getPersistentAgentThread(cliRoom, cliThreadId)?.items.length === 3, "and the message is recorded all the same");

	console.log("room-last-used smoke: ok");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
