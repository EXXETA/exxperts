// One status read judges every room's folder against the same closed places,
// read from the disk once for that read and never kept for the next one.
//
// Rows:
//  count        100 rooms with a folder and an Also allowed folder, eight
//               program connectors: the real-path reads of one status read
//               that aren't of a room's own places are the same as with 20
//               rooms; the rooms' own do grow, so the counter counts.
//  yields       other work gets its turn between two rooms of a pass.
//  same answer  the places and each connector's refusal, by hand, and as each
//               room's own fence judges it alone, over rooms with a folder,
//               without one, read only, archived, on a link, on a folder that
//               became a link, in a closed place, holding the app's data,
//               gone, and with a policy file that can't be read.
//  next read    a room's folder, a link in a closed place, a link at a program
//               folder and a connector's own program changed between two
//               reads: the second sees each, and sees it undone.
//
// Offline, isolated HOME, agent dir and rooms root, set before any import
// that reads them.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "connector-status-pass-")));
const documents = path.join(tempHome, "Documents");
// The app's data a room's folder can hold without being a home: the agent folder, moved.
const dataHolder = path.join(documents, "data-holder");
const agentDir = path.join(dataHolder, "agent");
const roomsRoot = path.join(tempHome, "rooms");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(roomsRoot, { recursive: true });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = roomsRoot;

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const policyMod = await import("../src/persistent-room-workspace-policy.js");
const { addAlsoAllowedFolder } = await import("../src/room-box/also-allowed.js");
const { realPathOf } = await import("../src/room-box/box-closed.js");
const { roomFence, under } = await import("../src/room-files.js");
const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
// The lookup the status route hands in.
const { connectorStartRefusal, roomWritePlaces, startRefusalLookup } = await import("../src/connector-start-check.js");

const READ_ONLY = { kind: "custom" as const, allowedToolNames: ["read", "ls", "find", "grep"] };
const STANDARD = { kind: "standard" as const };

function folderAt(...parts: string[]): string {
	const folder = path.join(...parts);
	fs.mkdirSync(folder, { recursive: true });
	return folder;
}
function linkTo(target: string, link: string): void {
	fs.mkdirSync(path.dirname(link), { recursive: true });
	// A junction on Windows, which needs no right to make.
	fs.symlinkSync(target, link, "junction");
}
function makeRoom(roomId: string, agent: Record<string, unknown> = {}): void {
	fs.writeFileSync(path.join(folderAt(roomsRoot, roomId), "agent.json"), JSON.stringify({ displayName: `Room ${roomId}`, ...agent }));
}
function giveFolder(roomId: string, folder: string, canChange = true): void {
	policyMod.writePersistentRoomDefaultCapabilityPolicy(policyMod.createPersistentRoomDefaultCapabilityPolicy({
		agentId: roomId, repoRoot, root: folder, workspaceAccessMode: "localFiles", displayLabel: roomId, source: "manual",
		toolSelection: canChange ? STANDARD : READ_ONLY,
	}));
}
/** A room stored on a folder no pick gives today, as an older app could have saved it. */
function giveStoredFolder(roomId: string, folder: string): void {
	giveFolder(roomId, folderAt(documents, "picked-then"));
	const file = policyMod.persistentRoomWorkspaceDefaultPath(roomId);
	const stored = JSON.parse(fs.readFileSync(file, "utf8"));
	const real = fs.realpathSync.native(folder);
	Object.assign(stored.roots[0], { path: folder, realpath: real, pathHash: policyMod.hashPersistentRoomPath(real) });
	fs.writeFileSync(file, JSON.stringify(stored));
}
function removeRooms(): void {
	for (const name of fs.readdirSync(roomsRoot)) fs.rmSync(path.join(roomsRoot, name), { recursive: true, force: true });
}
function scriptIn(folder: string): string {
	const script = path.join(folderAt(folder), "program.js");
	fs.writeFileSync(script, "");
	return script;
}
function writeConfig(servers: Record<string, unknown>): void {
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}
const runs = (script: string) => ({ command: process.execPath, args: [script] });

/** Each connector's refusing room by its id, or null, as the status says it. */
async function refusals(): Promise<Record<string, string | null>> {
	const status = await getMcpConnectorsStatus(startRefusalLookup);
	return Object.fromEntries(status.servers.map((server) => [server.name, server.startRefused?.roomId ?? null]));
}
/** The places as `room path`, the path relative to the made-up home. */
const shown = (places: Awaited<ReturnType<typeof roomWritePlaces>>): string[] =>
	places.map((place) => `${place.room.roomId} ${path.relative(tempHome, place.path).split(path.sep).join("/")}`);

/** The old way: each room's fence made alone, so nothing read for one room is there for the next. */
function placesJudgedAlone(): Awaited<ReturnType<typeof roomWritePlaces>> {
	const places: Awaited<ReturnType<typeof roomWritePlaces>> = [];
	for (const entry of fs.readdirSync(roomsRoot, { withFileTypes: true })) {
		const agent = JSON.parse(fs.readFileSync(path.join(roomsRoot, entry.name, "agent.json"), "utf8"));
		if (agent.archivedAt) continue;
		const room = { roomId: entry.name, roomName: agent.displayName };
		places.push({ path: realPathOf(path.join(roomsRoot, entry.name, "runtime", "box")), room });
		let policy = null;
		try {
			policy = policyMod.readPersistentRoomDefaultCapabilityPolicy(entry.name);
		} catch {
			// No folder, as in the pass.
		}
		const fence = policy ? roomFence(policy, () => []) : null;
		if (fence?.room?.access === "write") for (const root of fence.roots()) if (root.access === "write") places.push({ path: realPathOf(root.path), room });
	}
	return places;
}

/** The real-path reads of one status read: the rooms' own places (their folders and the app's folder of each), and every other place. */
async function realPathReads(ownPlaces: string[]): Promise<{ own: number; other: number }> {
	const reads = { own: 0, other: 0 };
	const real = fs.realpathSync.native;
	const counting = (...args: Parameters<typeof fs.realpathSync.native>) => {
		reads[ownPlaces.some((place) => under(String(args[0]), place)) ? "own" : "other"] += 1;
		return real(...args);
	};
	fs.realpathSync.native = counting as typeof fs.realpathSync.native;
	try {
		await getMcpConnectorsStatus(startRefusalLookup);
	} finally {
		fs.realpathSync.native = real;
	}
	return reads;
}

try {
	// ── Count ───────────────────────────────────────────────────────────────
	const tool = scriptIn(path.join(tempHome, "Tools"));
	writeConfig(Object.fromEntries([
		...[1, 2, 3].map((n) => [`npx-${n}`, { command: "npx", args: ["-y", `package-${n}`] }]),
		...[1, 2].map((n) => [`uvx-${n}`, { command: "uvx", args: [`tool-${n}`] }]),
		...[1, 2, 3].map((n) => [`node-${n}`, runs(tool)]),
		["web", { url: "https://example.org/mcp" }],
	]));
	const many = path.join(documents, "many");
	const addRooms = (from: number, to: number) => {
		for (let n = from; n < to; n += 1) {
			makeRoom(`many-${n}`);
			giveFolder(`many-${n}`, folderAt(many, `folder-${n}`));
			addAlsoAllowedFolder(`many-${n}`, folderAt(many, `extra-${n}`), "write");
		}
	};
	addRooms(0, 20);
	const few = await realPathReads([many, roomsRoot]);
	addRooms(20, 100);
	const all = await realPathReads([many, roomsRoot]);
	console.log(`count: 20 rooms ${JSON.stringify(few)}, 100 rooms ${JSON.stringify(all)}`);
	assert.ok(few.other > 0 && all.own >= few.own * 4, "count: the counter sees the shared places' reads, and the rooms' own grow with the rooms");
	assert.equal(all.other, few.other, "count: the reads of the places that are no room's own don't grow with the rooms");
	assert.equal((await roomWritePlaces()).length, 300, "count: every room's folder, Also allowed folder and box place is there");

	// ── Yields ──────────────────────────────────────────────────────────────
	let turns = 0;
	let done = false;
	const tick = () => {
		turns += 1;
		if (!done) setImmediate(tick);
	};
	setImmediate(tick);
	await roomWritePlaces();
	done = true;
	assert.ok(turns >= 100, `yields: other work has its turn between rooms (${turns} turns over 100 rooms)`);
	removeRooms();

	// ── Same answer ─────────────────────────────────────────────────────────
	const writer = folderAt(documents, "writer");
	const extra = folderAt(documents, "extra");
	const extraRead = folderAt(documents, "extra-read");
	makeRoom("writer");
	giveFolder("writer", writer);
	addAlsoAllowedFolder("writer", extra, "write");
	addAlsoAllowedFolder("writer", extraRead, "read");
	// An Also allowed folder in a closed place, put on the list by hand.
	addAlsoAllowedFolder("writer", folderAt(tempHome, ".ssh", "listed"), "write");
	makeRoom("no-folder");
	const readOnly = folderAt(documents, "read-only");
	makeRoom("read-only");
	giveFolder("read-only", readOnly, false);
	const archived = folderAt(documents, "archived");
	makeRoom("archived", { archivedAt: 1 });
	giveFolder("archived", archived);
	const linkTarget = folderAt(documents, "link-target");
	linkTo(linkTarget, path.join(documents, "link"));
	makeRoom("on-a-link");
	giveFolder("on-a-link", path.join(documents, "link"));
	const turned = folderAt(documents, "turned");
	makeRoom("became-a-link");
	giveFolder("became-a-link", turned);
	fs.rmdirSync(turned);
	const turnedTo = folderAt(documents, "turned-to");
	linkTo(turnedTo, turned);
	const closed = folderAt(tempHome, ".ssh", "kept");
	makeRoom("in-a-closed-place");
	giveStoredFolder("in-a-closed-place", closed);
	makeRoom("holds-the-data");
	giveStoredFolder("holds-the-data", dataHolder);
	const gone = folderAt(documents, "gone");
	makeRoom("gone");
	giveFolder("gone", gone);
	fs.rmdirSync(gone);
	const unread = folderAt(documents, "unread");
	for (const roomId of ["policy-not-json", "policy-a-folder"]) {
		makeRoom(roomId);
		giveFolder(roomId, unread);
		fs.rmSync(policyMod.persistentRoomWorkspaceDefaultPath(roomId));
	}
	fs.writeFileSync(policyMod.persistentRoomWorkspaceDefaultPath("policy-not-json"), "{ not json");
	fs.mkdirSync(policyMod.persistentRoomWorkspaceDefaultPath("policy-a-folder"));

	const connectors: Record<string, string> = {
		"in-writer": scriptIn(path.join(writer, "deep")), "in-extra": scriptIn(extra), "in-extra-read": scriptIn(extraRead), "in-listed-closed": scriptIn(path.join(tempHome, ".ssh", "listed")),
		"in-no-folder-box": scriptIn(path.join(roomsRoot, "no-folder", "runtime", "box", "caches")), "in-archived-box": scriptIn(path.join(roomsRoot, "archived", "runtime", "box")),
		"in-read-only": scriptIn(readOnly), "in-archived": scriptIn(archived), "in-link-target": scriptIn(linkTarget), "by-the-link": path.join(documents, "link", "program.js"),
		"in-turned-to": scriptIn(turnedTo), "in-closed": scriptIn(closed), "in-the-data": scriptIn(path.join(dataHolder, "tools")), "in-unread": scriptIn(unread), outside: tool,
	};
	writeConfig(Object.fromEntries(Object.entries(connectors).map(([name, script]) => [name, runs(script)])));

	const places = await roomWritePlaces();
	const boxed = ["writer", "no-folder", "read-only", "on-a-link", "became-a-link", "in-a-closed-place", "holds-the-data", "gone", "policy-not-json", "policy-a-folder"];
	const byHand = [...boxed.map((roomId) => `${roomId} rooms/${roomId}/runtime/box`), "writer Documents/writer", "writer Documents/extra", "on-a-link Documents/link-target"];
	assert.deepEqual(shown(places).sort(), byHand.sort(), "same answer: the places, by hand");
	const alone = placesJudgedAlone();
	assert.deepEqual(places, alone, "same answer: the places, in their order, as each room's fence judges them alone");

	const refused = await refusals();
	assert.deepEqual(refused, {
		"in-writer": "writer", "in-extra": "writer", "in-extra-read": null, "in-listed-closed": null,
		"in-no-folder-box": "no-folder", "in-archived-box": null,
		"in-read-only": null, "in-archived": null, "in-link-target": "on-a-link", "by-the-link": "on-a-link",
		"in-turned-to": null, "in-closed": null, "in-the-data": null, "in-unread": null, outside: null,
	}, "same answer: each connector's refusal, by hand");
	const refusedAlone = Object.fromEntries(Object.entries(connectors).map(([name, script]) => [name, connectorStartRefusal(runs(script), alone)?.roomId ?? null]));
	assert.deepEqual(refused, refusedAlone, "same answer: each connector's refusal against the places judged alone");
	removeRooms();

	// ── Next read ───────────────────────────────────────────────────────────
	const before = folderAt(documents, "before");
	const after = folderAt(documents, "after");
	makeRoom("mover");
	giveFolder("mover", before);
	const kept = folderAt(documents, "kept");
	makeRoom("keeper");
	giveFolder("keeper", kept);
	const programLink = path.join(tempHome, "Tools", "linked");
	linkTo(path.dirname(tool), programLink);
	writeConfig({ "in-before": runs(scriptIn(before)), "in-after": runs(scriptIn(after)), "in-kept": runs(scriptIn(kept)), linked: runs(path.join(programLink, "program.js")) });
	const first = { "in-before": "mover", "in-after": null, "in-kept": "keeper", linked: null };
	assert.deepEqual(await refusals(), first, "next read: as it stands first");
	assert.deepEqual(await refusals(), first, "next read control: nothing changed, the same answer");

	giveFolder("mover", after);
	assert.deepEqual(await refusals(), { ...first, "in-before": null, "in-after": "mover" }, "next read: the room's new folder");
	giveFolder("mover", before);

	// Each makes the keeper's folder one no room may use, and undoing it gives the folder back.
	const closing: Array<[string, string]> = [
		["a link in the home that is a data profile's name", path.join(tempHome, ".exxperts-other")],
		["a link at a closed place", path.join(tempHome, ".kube")],
		["a link at a closed place deeper in the home", path.join(tempHome, ".config", "gh")],
		["a link at a program folder", path.join(tempHome, ".local", "bin")],
	];
	for (const [what, link] of closing) {
		linkTo(kept, link);
		assert.deepEqual(await refusals(), { ...first, "in-kept": null }, `next read: ${what} leads to the room's folder`);
		fs.unlinkSync(link);
		assert.deepEqual(await refusals(), first, `next read: ${what} is gone again`);
	}

	fs.unlinkSync(programLink);
	linkTo(kept, programLink);
	assert.deepEqual(await refusals(), { ...first, linked: "keeper" }, "next read: the connector's program moved into a room's folder");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}

console.log("connector-status-pass-smoke: one read of the shared places per status, the same answer, nothing kept");
process.exit(0);
