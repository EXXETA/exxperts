import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, freePort, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer } from "./smoke-server-process.js";

// A skill in the folder shared with other tools whose SKILL.md is a link to
// another file, as a dotfiles tool leaves it: read where the link's way ends,
// listed, switched on and given to a room, when no room's folder lies on that
// way. Unreadable, with none of the file in any answer, when one does, when the
// way ends in the app's own data, dangles, loops or passes 16 links, or ends at
// anything but a plain file of its own; and in the app's own store and on a
// shared server, wherever it leads. Through the server for the library and the
// room's switch, and read_skill as a room's turn calls it.

const tempHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-linked-")));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(tempHome, "rooms");
// The agent folder moved out of ~/.exxperts, so it counts as the app's data on its own.
const agentDir = path.join(tempHome, "agent");
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV);

const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const sharedDir = path.join(tempHome, ".agents", "skills");
const dotfiles = path.join(tempHome, "dotfiles");
for (const folder of [sharedDir, dotfiles, agentDir, path.join(agentDir, "skills")]) fs.mkdirSync(folder, { recursive: true });

const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
const { createPersistentRoomDefaultCapabilityPolicy, writePersistentRoomDefaultCapabilityPolicy } = await import("../src/persistent-room-workspace-policy.js");
const { addAlsoAllowedFolder } = await import("../src/room-box/also-allowed.js");
const { readLibrarySkill } = await import("../src/skills-executable.js");
const { getUserSkillFile, listSkills } = await import("../src/skills-library.js");
const { createReadSkillTool } = await import("../src/persistent-room-skill-tool.js");

const failures: string[] = [];
const check = (condition: unknown, message: string): void => {
	if (!condition) failures.push(message);
};

const LINK_KIND = process.platform === "win32" ? "file" : undefined;
const link = (target: string, at: string): void => fs.symlinkSync(target, at, LINK_KIND);
const made = (...parts: string[]): string => {
	const folder = path.join(tempHome, ...parts);
	fs.mkdirSync(folder, { recursive: true });
	return folder;
};
/** A SKILL.md's text, its body carrying a line no other file holds. */
const manifestOf = (name: string): string => `---\nname: ${name}\ndescription: ${name} from the dotfiles\n---\n\nThe body of ${name}: only its file holds this line.\n`;
const bodyLine = (name: string): string => `The body of ${name}:`;
/** A file at `at` holding `name`'s manifest; its path. */
const written = (at: string, name: string): string => {
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, manifestOf(name));
	return at;
};
/** A file named SKILL.md in `folder`'s `name` folder, holding `name`'s manifest: the only end a link is read at. */
const skillFile = (folder: string, name: string): string => written(path.join(folder, name, "SKILL.md"), name);
/** A shared-folder skill `name` whose SKILL.md links to `target`. */
const linkedSkill = (name: string, target: string): void => {
	fs.mkdirSync(path.join(sharedDir, name), { recursive: true });
	link(target, path.join(sharedDir, name, "SKILL.md"));
};

/** A room with its folder chosen, as the pane saves it. */
function roomWith(label: string, folder: string): string {
	const roomId = String(createPersistentAgentFromScaffoldInput({ displayName: label, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId);
	writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: roomId, repoRoot, root: folder, workspaceAccessMode: "localFiles", displayLabel: label, source: "manual" }));
	return roomId;
}

// --- What is read: a link to a SKILL.md outside every room's folders, and a chain of two.
linkedSkill("dot-linked", skillFile(dotfiles, "dot-linked"));
link(skillFile(dotfiles, "dot-chain"), path.join(dotfiles, "chain-hop"));
linkedSkill("dot-chain", path.join(dotfiles, "chain-hop"));
// A way of 16 links, the most it follows (the SKILL.md link and 15 more).
const chain = (name: string, links: number): void => {
	let target = skillFile(dotfiles, name);
	for (let hop = 1; hop < links; hop += 1) {
		const at = path.join(dotfiles, `${name}-hop-${hop}`);
		link(target, at);
		target = at;
	}
	linkedSkill(name, target);
};
chain("sixteen-links", 16);

// --- What stays unreadable: each with a file whose body no answer may carry. Every end is a
// SKILL.md, so each row holds what it names, but for the rows about the name and the sign-in
// and connector files, which the name check refuses before the app's data check is reached.
const roomFolder = made("work", "room-a");
const alsoRead = made("work", "also-read");
const alsoWrite = made("work", "also-write");
const roomA = roomWith("Room A", roomFolder);
addAlsoAllowedFolder(roomA, alsoRead, "read");
addAlsoAllowedFolder(roomA, alsoWrite, "write");
const refusedNames: string[] = [];
const refusedCase = (name: string, setUp: () => void): void => {
	setUp();
	refusedNames.push(name);
};
// The skill's folder really lies in the room's folder: a link to it from the shared folder.
refusedCase("folder-in-room", () => {
	const real = made("work", "room-a", "skills", "folder-in-room");
	link(skillFile(dotfiles, "folder-in-room"), path.join(real, "SKILL.md"));
	fs.symlinkSync(real, path.join(sharedDir, "folder-in-room"), process.platform === "win32" ? "junction" : "dir");
});
refusedCase("hop-in-room", () => {
	link(skillFile(dotfiles, "hop-in-room"), path.join(roomFolder, "hop-in-room-hop"));
	linkedSkill("hop-in-room", path.join(roomFolder, "hop-in-room-hop"));
});
refusedCase("hop-in-also-write", () => {
	link(skillFile(dotfiles, "hop-in-also-write"), path.join(alsoWrite, "hop"));
	linkedSkill("hop-in-also-write", path.join(alsoWrite, "hop"));
});
refusedCase("file-in-room", () => linkedSkill("file-in-room", skillFile(path.join(roomFolder, "notes"), "file-in-room")));
refusedCase("file-in-also-read", () => linkedSkill("file-in-also-read", skillFile(alsoRead, "file-in-also-read")));
refusedCase("file-in-also-write", () => linkedSkill("file-in-also-write", skillFile(alsoWrite, "file-in-also-write")));
refusedCase("sign-in-file", () => linkedSkill("sign-in-file", written(path.join(agentDir, "auth.json"), "sign-in-file")));
refusedCase("connector-settings", () => linkedSkill("connector-settings", written(path.join(agentDir, "mcp.json"), "connector-settings")));
refusedCase("app-data", () => linkedSkill("app-data", skillFile(path.join(tempHome, ".exxperts", "app"), "app-data")));
// A SKILL.md in the agent folder, moved out of ~/.exxperts: the app's data too.
refusedCase("agent-folder", () => linkedSkill("agent-folder", skillFile(path.join(agentDir, "notes"), "agent-folder")));
refusedCase("dangling", () => linkedSkill("dangling", path.join(dotfiles, "gone", "SKILL.md")));
refusedCase("looping", () => {
	link(path.join(dotfiles, "loop-b"), path.join(dotfiles, "loop-a"));
	link(path.join(dotfiles, "loop-a"), path.join(dotfiles, "loop-b"));
	linkedSkill("looping", path.join(dotfiles, "loop-a"));
});
refusedCase("seventeen-links", () => chain("seventeen-links", 17));
refusedCase("to-a-folder", () => linkedSkill("to-a-folder", made("dotfiles", "a-folder", "SKILL.md")));
refusedCase("second-name", () => {
	const file = skillFile(dotfiles, "second-name");
	fs.linkSync(file, path.join(dotfiles, "second-name-too.md"));
	linkedSkill("second-name", file);
});
const pipes = process.platform !== "win32" && spawnSync("mkfifo", [path.join(made("dotfiles", "a-pipe"), "SKILL.md")]).status === 0;
if (pipes) refusedCase("to-a-pipe", () => linkedSkill("to-a-pipe", path.join(dotfiles, "a-pipe", "SKILL.md")));
else console.log("SKIPPED: the named pipe row (no mkfifo here)");
// The name: the end of the way is read only as a file named SKILL.md, whoever made the link and
// whenever. A made-up key file with no room anywhere on the way, and a plain file of another name.
const keys = made("keys");
refusedCase("key-file", () => linkedSkill("key-file", written(path.join(keys, "id_made_up"), "key-file")));
refusedCase("other-name", () => linkedSkill("other-name", written(path.join(dotfiles, "other-name.md"), "other-name")));
// A room's command plants a link to a key file in its folder; the room then moves to another
// folder, so the link's folder is no room's any more: still unreadable (checked after the server starts).
const freedFolder = made("work", "freed");
const freedRoom = roomWith("Freed Room", freedFolder);
link(written(path.join(keys, "id_planted"), "planted-then-freed"), path.join(freedFolder, "planted-hop"));
refusedCase("planted-then-freed", () => linkedSkill("planted-then-freed", path.join(freedFolder, "planted-hop")));
// The app's own store: a link there is never followed, wherever it leads.
fs.mkdirSync(path.join(agentDir, "skills", "own-linked"), { recursive: true });
link(skillFile(dotfiles, "own-linked"), path.join(agentDir, "skills", "own-linked", "SKILL.md"));
// Read now; a room made later whose folder holds its file makes it unreadable.
const laterFolder = made("work", "later");
linkedSkill("later-room", skillFile(laterFolder, "later-room"));

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const request = async (pathname: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any; text: string }> => {
	const response = await authedFetch(`${baseUrl}${pathname}`, { method: init.method, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } }) });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null, text };
};
const libraryRow = async (name: string): Promise<any> => ((await request("/api/skills")).body as any[]).find((skill) => skill.name === name);

let server: ChildProcessWithoutNullStreams | null = null;
const output: string[] = [];
try {
	server = spawn("npx", ["tsx", "src/index.ts"], { shell: process.platform === "win32", ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: webServerDir, env: { ...process.env, PORT: String(port), EXXETA_HOME: repoRoot } });
	server.stdout.on("data", (chunk) => output.push(String(chunk)));
	server.stderr.on("data", (chunk) => output.push(String(chunk)));
	await waitForServer(server, baseUrl, 20000);

	const room = String((await request("/api/persistent-agents", { method: "POST", body: { displayName: "Linked Skills Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" } })).body?.agent?.agentId ?? "");
	check(room !== "", "a room is made");
	const enable = (name: string) => request(`/api/persistent-agents/${encodeURIComponent(room)}/skill-settings`, { method: "PUT", body: { action: "enable", name } });
	const readTool = createReadSkillTool({ agentId: room, lookupSkill: readLibrarySkill }) as unknown as { execute(id: string, params: { name: string }): Promise<{ content: Array<{ text?: string }>; details?: { outcome?: string } }> };
	const served = async (name: string): Promise<{ outcome?: string; text: string }> => {
		const result = await readTool.execute("t", { name });
		return { outcome: result.details?.outcome, text: result.content.map((part) => part.text ?? "").join("\n") };
	};
	const roomStatus = async (name: string): Promise<string | undefined> => ((await request(`/api/persistent-agents/${encodeURIComponent(room)}/skill-settings`)).body?.skills as any[] | undefined)?.find((skill) => skill.name === name)?.status;

	for (const name of ["dot-linked", "dot-chain", "sixteen-links", "later-room"]) {
		const row = await libraryRow(name);
		check(row && !row.unreadable && row.description === `${name} from the dotfiles`, `${name}: the library lists it with its description, got ${JSON.stringify(row)}`);
		const switched = await enable(name);
		check(switched.status === 200 && (switched.body.skills as any[]).find((skill) => skill.name === name)?.status === "ok", `${name}: it switches on in a room, got ${switched.status}: ${switched.text}`);
		const answer = await served(name);
		check(answer.outcome === "ok" && answer.text.includes(bodyLine(name)), `${name}: read_skill gives the room its instructions, got ${answer.outcome}: ${answer.text}`);
	}

	/** What a person and the assistant get of a skill that stays unreadable: nothing of its file anywhere. */
	const refused = async (name: string, row: string): Promise<void> => {
		const listed = await libraryRow(name);
		check(listed?.unreadable === true && listed.description === "" && listed.body === "", `${row}: the library lists it as one no room can use, got ${JSON.stringify(listed)}`);
		const page = await request(`/api/skills/${encodeURIComponent(name)}`);
		check(!page.text.includes(bodyLine(name)), `${row}: its page shows none of the file, got ${page.text}`);
		const all = await request("/api/skills");
		check(!all.text.includes(bodyLine(name)), `${row}: the library shows none of the file`);
		const answer = await served(name);
		check(answer.outcome !== "ok" && !answer.text.includes(bodyLine(name)), `${row}: read_skill gives none of it, got ${answer.outcome}: ${answer.text}`);
	};
	for (const name of refusedNames) {
		await enable(name);
		await refused(name, name);
		check((await roomStatus(name)) !== "ok", `${name}: a room can't use it`);
	}
	const own = await libraryRow("own-linked");
	check(own?.unreadable === true && !JSON.stringify(own).includes(bodyLine("own-linked")), `own-linked: in the app's own store a linked SKILL.md stays unreadable, got ${JSON.stringify(own)}`);
	check(getUserSkillFile("own-linked")?.manifest === null, "own-linked: an edit finds no text, so it never writes through the link");

	// The room that planted the link moves to another folder: the link's folder is no room's now, and it stays unreadable.
	writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: freedRoom, repoRoot, root: made("work", "freed-elsewhere"), workspaceAccessMode: "localFiles", displayLabel: "Freed Room", source: "manual" }));
	await refused("planted-then-freed", "the planting room moved to another folder");

	// A room made after the read, whose folder holds the file: unreadable at the next read, and out of the room it was on in.
	roomWith("Later Room", laterFolder);
	await refused("later-room", "a room made later holds its file");
	check((await roomStatus("later-room")) === "unreadable", `later-room: the room that had it on can't use it now, got ${await roomStatus("later-room")}`);
} finally {
	await stopSmokeServer(server);
}

// On a shared server a linked SKILL.md stays unreadable, wherever it leads. Last: hooks can't be taken back.
const { registerServerHooks } = await import("../src/server-hooks.js");
check(!("unreadable" in (readLibrarySkill("dot-linked") ?? { unreadable: true })), "dot-linked reads on this computer");
registerServerHooks({});
const onShared = readLibrarySkill("dot-linked");
check(onShared !== null && "unreadable" in onShared, `on a shared server a linked SKILL.md is unreadable, got ${JSON.stringify(onShared)}`);
check(listSkills().find((skill) => skill.name === "dot-linked")?.unreadable === true, "on a shared server the library lists it as unreadable");

fs.rmSync(tempHome, { recursive: true, force: true });
if (failures.length > 0) {
	console.error(output.join("").slice(-4000));
	throw new Error(`skills-linked-manifest-smoke failed:\n${failures.join("\n")}`);
}
console.log("skills-linked-manifest-smoke: OK");
