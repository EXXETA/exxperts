// A data folder can sync between computers, or a person can go back to an
// older version of exxperts, and the older app reads what this one wrote. These
// rows run the older app's own reading code, as its tag has it, against the files
// this version writes through its routes: there the room keeps its folder, its
// file tools keep to it, no command runs, and commands the person turns on there
// ask before each one. Then the other way: files an older app wrote, read here
// through the Room settings routes and the setting a conversation runs under,
// for the room's own setting and a conversation's, on every read.
//
// The older app's files are in fixtures/older-app, each as `git show <tag>:<path>`
// gives it with `.txt` added, so no check reads them as this app's code; the
// smoke copies them out under their own names. Taking them again from another
// tag means OLDER_APP below changes with them.
// Run: npm run smokes -- room-older-app
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SMOKE_SERVER_AUTH_ENV } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const OLDER_APP = "v0.15.2";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-older-app-")));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const agentsRoot = path.join(home, ".exxperts", "app", "personalized-agents");
const folders = path.join(home, "Documents");
for (const dir of [agentDir, agentsRoot, folders]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

for (const name of ["EXXPERTS_DATA_DIR", "EXXPERTS_STATE_HOME", "EXXPERTS_REAL_HOME", "EXXPERTS_TEST_SHELL_PLATFORM"]) delete process.env[name];
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV, {
	HOME: home,
	USERPROFILE: home,
	EXXETA_HOME: repoRoot,
	EXXPERTS_CODING_AGENT_DIR: agentDir,
	EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
	EXXPERTS_TEST_INTROSPECTION: "1",
	LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
});

// The older app's own files, under their own names, beside a link to this checkout's packages.
const olderRoot = path.join(tempRoot, OLDER_APP);
const fixtures = path.join(scriptDir, "fixtures", "older-app");
for (const fixture of fs.readdirSync(fixtures, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts.txt"))) {
	const file = path.join(olderRoot, fixture.slice(0, -".txt".length));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.copyFileSync(path.join(fixtures, fixture), file);
}
// Junctions work on Windows without symlink privileges; "dir" everywhere else.
fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(olderRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
fs.writeFileSync(path.join(olderRoot, "package.json"), JSON.stringify({ type: "module" }));
const olderModule = (file: string) => import(pathToFileURL(path.join(olderRoot, "apps/web-server/src", file)).href);
const older = {
	policy: await olderModule("persistent-room-workspace-policy.ts"),
	bash: await olderModule("persistent-room-bash-settings.ts"),
	approval: await olderModule("persistent-room-bash-approval.ts"),
};

const agents = await import("../src/persistent-agents.js");
const policy = await import("../src/persistent-room-workspace-policy.js");
const { setRoomCommands } = await import("../src/room-box/folder-question.js");
await import("../src/room-settings-routes.js");
const { app, AUTH_HEADER_NAME, AUTH_TOKEN } = await import("../src/server-app.js");
app.log.level = "silent";

/** Plays a Mac, where the room's protection runs, or a computer where it doesn't, on any computer. */
async function on<T>(platform: "darwin" | "linux", body: () => Promise<T> | T): Promise<T> {
	process.env.EXXPERTS_TEST_SHELL_PLATFORM = platform;
	try {
		return await body();
	} finally {
		delete process.env.EXXPERTS_TEST_SHELL_PLATFORM;
	}
}

let passed = 0;
const failures: string[] = [];
async function row(name: string, body: () => Promise<void> | void): Promise<void> {
	try {
		await body();
		passed += 1;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures.push(name);
		console.log(`  FAIL ${name}: ${(error as Error).message}`);
	}
}

// --- Rooms, made and changed as the page does it.
let made = 0;
function newFolder(): string {
	const dir = path.join(folders, `folder-${++made}`);
	fs.mkdirSync(dir, { recursive: true });
	return fs.realpathSync(dir);
}
let rooms = 0;
async function newRoom(platform: "darwin" | "linux"): Promise<string> {
	return on(platform, () => String(agents.createPersistentAgentFromScaffoldInput({ displayName: `Older App ${++rooms}`, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId));
}
async function call(method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown): Promise<any> {
	const answer = await app.inject({ method, url, headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN }, ...(payload === undefined ? {} : { payload: payload as any }) });
	assert(answer.statusCode === 200, `${method} ${url}: ${answer.statusCode} ${answer.body}`);
	return JSON.parse(answer.body);
}
const roomUrl = (roomId: string, tail: string) => `/api/persistent-agents/${encodeURIComponent(roomId)}/${tail}`;
/** The Folder pane's save: `bashEnabled` left out when the switch was never touched. */
const saveFolder = (roomId: string, body: Record<string, unknown>) => call("PUT", roomUrl(roomId, "workspace-default"), body);
const saveConversationFolder = (roomId: string, conversationId: string, body: Record<string, unknown>) => call("POST", roomUrl(roomId, "workspace/validate"), { conversationId, source: "manual", ...body });
/** The chip's write, given in the protection it read. */
const chip = async (roomId: string, autoApprove: boolean) => call("PUT", roomUrl(roomId, "bash-settings"), { autoApprove, protection: (await call("GET", roomUrl(roomId, "bash-settings"))).protection });

// --- What the older app makes of a room, by its own code.
const OLDER = { persistentAgentsRoot: agentsRoot };
const CONVERSATION = "conversation-1";

/** The older app's own start: its one-time grant runs on a data folder it has never opened. */
function olderAppStarts(roomIds: string[]): void {
	older.bash.migratePersistentRoomBashAutoApproveDefaults(roomIds.map((id) => ({ id, bashEnabled: older.policy.readPersistentRoomDefaultCapabilityPolicy(id, OLDER)?.bashEnabled === true })), OLDER);
}

/** Whether the older app's command guard asks before a command, with a person there to answer. */
async function olderAppAsks(roomId: string): Promise<boolean> {
	let asked = 0;
	const guard = older.approval.createPersistentRoomBashApprovalGuard({ isAutoApproved: () => older.bash.readPersistentRoomBashSettings(roomId, OLDER).autoApprove === true });
	const decision = await guard.beforeBashCall("ls", { hasUI: true, cwd: folders, ui: { confirm: async () => ((asked += 1), true), watcher: () => "watching" } });
	assert(decision.allow === true, "the older app's guard refused with a person there");
	return asked === 1;
}

/** In the older app, for the room and a conversation: the folder kept, file tools held to it, no command. Then she turns commands on there, and every command asks. */
async function olderAppHolds(id: string, roomId: string, conversations: string[] = [CONVERSATION]): Promise<void> {
	for (const conversationId of conversations) {
		const seen = older.policy.resolvePersistentRoomEffectiveWorkspacePolicy(roomId, conversationId, OLDER);
		if (seen.policy) {
			assert(seen.workspaceToolsEnabled && seen.allowedToolNames.length > 0, `${id}: the older app dropped the folder of ${conversationId}`);
			assert(seen.pathAccess === "workspace-only" && seen.nativePiFilesystemToolsEnabled === false, `${id}: in the older app the file tools of ${conversationId} reach beyond the folder: ${seen.workspaceAccessMode}`);
		}
		assert(seen.bashEnabled === false, `${id}: the older app runs commands in ${conversationId}`);
	}
	// She turns commands on there, the only way it has: Full access and Bash on, for the room or with no folder a new one.
	const stored = older.policy.readPersistentRoomDefaultCapabilityPolicy(roomId, OLDER);
	const turnedOn = stored
		? older.policy.updatePersistentRoomCapabilityPolicyWorkspaceSettings(stored, { workspaceAccessMode: "localFiles", bashEnabled: true })
		: older.policy.createPersistentRoomDefaultCapabilityPolicy({ agentId: roomId, root: newFolder(), repoRoot, workspaceAccessMode: "localFiles", source: "manual", bashEnabled: true });
	older.policy.writePersistentRoomDefaultCapabilityPolicy(turnedOn, OLDER);
	assert(older.policy.resolvePersistentRoomEffectiveWorkspacePolicy(roomId, "conversation-later", OLDER).bashEnabled === true, `${id}: turned on in the older app, commands stay off`);
	assert(await olderAppAsks(roomId), `${id}: turned on in the older app, a command ran without asking`);
}

/** This version's own read, as the pane and the chip get it and as a conversation runs. */
async function shownHere(roomId: string, conversationId = CONVERSATION): Promise<{ access: string | null; commands: boolean; runWithoutAsking: boolean }> {
	const room = (await call("GET", roomUrl(roomId, "workspace-default"))).policy;
	const live = policy.resolvePersistentRoomEffectiveWorkspacePolicy(roomId, conversationId);
	const settings = (await call("GET", roomUrl(roomId, "bash-settings"))).settings;
	assert(room === null || room.bashEnabled === live.bashEnabled, `the pane and the conversation disagree on commands`);
	return { access: live.policy ? live.workspaceAccessMode : null, commands: live.bashEnabled, runWithoutAsking: settings.autoApprove === true };
}

console.log(`room older-app smoke: ${OLDER_APP}'s readers against what this version writes, and the other way`);

// --- What this version writes, read by the older app.

await row("O1 a new room on a Mac: commands on by themselves, Run without asking; the older app keeps the folder, fenced, and runs nothing", async () => {
	const roomId = await newRoom("darwin");
	await on("darwin", () => saveFolder(roomId, { root: newFolder(), displayLabel: "Sales", workspaceAccessMode: "localFiles" }));
	assert(JSON.stringify(await on("darwin", () => shownHere(roomId))) === JSON.stringify({ access: "localFiles", commands: true, runWithoutAsking: true }), "O1: this version no longer reads the new room as Full access with commands on, without asking");
	olderAppStarts([roomId]);
	await olderAppHolds("O1", roomId);
});

await row("O2 a room whose person turned commands on, for the room, a conversation, and by a card's yes: off in the older app, and asking there", async () => {
	const roomId = await newRoom("linux");
	await on("linux", async () => {
		await saveFolder(roomId, { root: newFolder(), displayLabel: "Sales", workspaceAccessMode: "localFiles", bashEnabled: true });
		await saveConversationFolder(roomId, CONVERSATION, { root: newFolder(), workspaceAccessMode: "localFiles", bashEnabled: true });
	});
	assert((await on("linux", () => shownHere(roomId))).commands, "O2: this version no longer reads the conversation's commands as on");
	assert((await on("linux", () => shownHere(roomId, "conversation-2"))).commands, "O2: this version no longer reads the room's commands as on");
	const carded = await newRoom("darwin");
	await on("darwin", async () => {
		await saveFolder(carded, { root: newFolder(), workspaceAccessMode: "localFiles", bashEnabled: false });
		setRoomCommands(carded, CONVERSATION, true);
	});
	assert((await on("darwin", () => shownHere(carded))).commands, "O2: a card's yes no longer turns commands on here");
	olderAppStarts([roomId, carded]);
	await olderAppHolds("O2 turned on", roomId, [CONVERSATION, "conversation-2"]);
	await olderAppHolds("O2 a card's yes", carded);
});

await row("O3 a room whose person chose Run without asking, and one with Ask first: the older app asks before each command either way", async () => {
	for (const autoApprove of [true, false]) {
		const roomId = await newRoom("linux");
		await on("linux", async () => {
			await saveFolder(roomId, { root: newFolder(), workspaceAccessMode: "localFiles", bashEnabled: true });
			await chip(roomId, autoApprove);
		});
		assert((await on("linux", () => shownHere(roomId))).runWithoutAsking === autoApprove, `O3: this version no longer reads the chip as ${autoApprove ? "Run without asking" : "Ask first"}`);
		olderAppStarts([roomId]);
		await olderAppHolds(`O3 ${autoApprove ? "Run without asking" : "Ask first"}`, roomId);
	}
});

await row("O4 a room with commands switched off, after Run without asking: none in the older app, and asking there", async () => {
	const roomId = await newRoom("darwin");
	await on("darwin", async () => {
		await saveFolder(roomId, { root: newFolder(), workspaceAccessMode: "localFiles" });
		await chip(roomId, true);
		await saveFolder(roomId, { workspaceAccessMode: "localFiles", bashEnabled: false });
	});
	assert(JSON.stringify(await on("darwin", () => shownHere(roomId))) === JSON.stringify({ access: "localFiles", commands: false, runWithoutAsking: true }), "O4: this version no longer reads the switched-off room as Full access, commands off");
	await olderAppHolds("O4", roomId);
});

await row("O5 a room with no folder, made on a Mac: in the older app commands turned on there ask before each one", async () => {
	const roomId = await newRoom("darwin");
	assert((await on("darwin", () => shownHere(roomId))).runWithoutAsking, "O5: a new room on a Mac no longer starts with Run without asking");
	olderAppStarts([roomId]);
	await olderAppHolds("O5", roomId);
});

await row("O6 Bounded, as an older page still sends it: here the one mode with commands switched off, and fenced in the older app", async () => {
	const roomId = await newRoom("linux");
	await on("linux", () => saveFolder(roomId, { root: newFolder(), workspaceAccessMode: "bounded", bashEnabled: true }));
	const shown = await on("linux", () => shownHere(roomId));
	assert(JSON.stringify(shown) === JSON.stringify({ access: "localFiles", commands: false, runWithoutAsking: false }), `O6: Bounded reads here as ${JSON.stringify(shown)}`);
	await olderAppHolds("O6", roomId);
});

// --- What an older app writes, read by this version, every time.

/** A room an older app last saved: Full access or Bounded, its tools, Bash, and how commands are answered. */
async function olderAppSaves(roomId: string, settings: { access: "bounded" | "localFiles"; tools?: readonly string[]; bash: boolean; autoApprove?: boolean; conversation?: boolean }): Promise<void> {
	const input = { agentId: roomId, root: newFolder(), repoRoot, workspaceAccessMode: settings.access, source: "manual", bashEnabled: settings.bash, ...(settings.tools ? { toolSelection: { kind: "custom", allowedToolNames: settings.tools } } : {}) };
	if (settings.conversation) older.policy.writePersistentRoomCapabilityPolicy(older.policy.createPersistentRoomCapabilityPolicy({ ...input, conversationId: CONVERSATION }), OLDER);
	else older.policy.writePersistentRoomDefaultCapabilityPolicy(older.policy.createPersistentRoomDefaultCapabilityPolicy(input), OLDER);
	if (settings.autoApprove !== undefined) older.bash.writePersistentRoomBashSettings(roomId, { autoApprove: settings.autoApprove }, OLDER);
}

// A conversation's own setting gives way to its room's, so a conversation row, whose room has none, reads no folder and no commands.
const TABLE = [
	{ today: "Bounded", saved: { access: "bounded", bash: false }, here: { access: "localFiles", commands: false, runWithoutAsking: false } },
	{ today: "write tools off, readers on", saved: { access: "localFiles", tools: ["read", "ls", "find", "grep"], bash: false }, here: { access: "localFiles", commands: false, runWithoutAsking: false }, reads: ["read", "ls", "find", "grep"] },
	// List, Find and Search come back; with no protection, commands run only while the room can change files.
	{ today: "its own tool list, Bash on", saved: { access: "localFiles", tools: ["read"], bash: true }, here: { access: "localFiles", commands: true, runWithoutAsking: false }, withoutProtection: { commands: false }, reads: ["read", "ls", "find", "grep"] },
	{ today: "Full access, Bash off", saved: { access: "localFiles", bash: false }, here: { access: "localFiles", commands: false, runWithoutAsking: false } },
	{ today: "Full access, Bash on, Ask first", saved: { access: "localFiles", bash: true, autoApprove: false }, here: { access: "localFiles", commands: true, runWithoutAsking: false } },
	// Read first on a Mac, it converts to a yes given with protection, which never holds without it.
	{ today: "Full access, Bash on, Run without asking", saved: { access: "localFiles", bash: true, autoApprove: true }, here: { access: "localFiles", commands: true, runWithoutAsking: true }, withoutProtection: { runWithoutAsking: false } },
] as const;

for (const [index, { today, saved, here }] of TABLE.entries()) {
	await row(`N${index + 1} ${today}, as an older app saved it, for the room and for a conversation: read here in the one mode, on a Mac and elsewhere`, async () => {
		for (const conversation of [false, true]) {
			const roomId = await newRoom("linux");
			await olderAppSaves(roomId, { ...saved, conversation });
			for (const platform of ["darwin", "linux"] as const) {
				const shown = await on(platform, () => shownHere(roomId));
				const where = `N${index + 1} ${conversation ? "a conversation's" : "the room's"} setting, ${platform === "darwin" ? "on a Mac" : "with no protection"}`;
				const forRoom = platform === "linux" && "withoutProtection" in TABLE[index] ? { ...here, ...TABLE[index].withoutProtection } : here;
				const expected = conversation ? { access: null, commands: false, runWithoutAsking: forRoom.runWithoutAsking } : forRoom;
				assert(JSON.stringify(shown) === JSON.stringify(expected), `${where}: ${JSON.stringify(shown)}`);
				if ("reads" in TABLE[index]) {
					const live = await on(platform, () => policy.resolvePersistentRoomEffectiveWorkspacePolicy(roomId, CONVERSATION));
					const reads = conversation ? [] : TABLE[index].reads;
					assert(JSON.stringify(live.allowedToolNames) === JSON.stringify(reads), `${where}: its own tool list reads ${JSON.stringify(live.allowedToolNames)}`);
				}
			}
		}
	});
}

await row("N7 a room with no folder an older app used: nothing here until commands are on", async () => {
	const roomId = await newRoom("linux");
	older.bash.writePersistentRoomBashSettings(roomId, { autoApprove: true }, OLDER);
	const shown = await on("darwin", () => shownHere(roomId));
	assert(shown.access === null && shown.commands === false, `N7: ${JSON.stringify(shown)}`);
});

await row("N8 Run without asking that came by itself holds only where the protection runs; the person's own holds where she gave it", async () => {
	const automatic = await newRoom("darwin");
	await on("darwin", () => saveFolder(automatic, { root: newFolder(), workspaceAccessMode: "localFiles" }));
	assert((await on("darwin", () => shownHere(automatic))).runWithoutAsking, "N8: an automatic yes no longer holds on a Mac");
	assert(!(await on("linux", () => shownHere(automatic))).runWithoutAsking, "N8: an automatic yes holds with no protection");
	const own = await newRoom("linux");
	await on("linux", async () => {
		await saveFolder(own, { root: newFolder(), workspaceAccessMode: "localFiles", bashEnabled: true });
		await chip(own, true);
	});
	assert((await on("linux", () => shownHere(own))).runWithoutAsking, "N8: the person's own Run without asking was dropped with no protection");
});

await row("N9 this version's writes never set the old flags: Bounded and off on disk for what reads only them", async () => {
	const roomId = await newRoom("darwin");
	await on("darwin", async () => {
		await saveFolder(roomId, { root: newFolder(), workspaceAccessMode: "localFiles" });
		await saveConversationFolder(roomId, CONVERSATION, { root: newFolder(), workspaceAccessMode: "localFiles", bashEnabled: true });
		await chip(roomId, true);
	});
	const runtime = path.join(policy.persistentAgentRootPath(roomId), "runtime");
	for (const file of ["workspace-default.json", `workspace-policies/${CONVERSATION}.json`]) {
		const stored = JSON.parse(fs.readFileSync(path.join(runtime, file), "utf8"));
		assert(stored.workspaceAccessMode === "bounded" && stored.bashEnabled === false, `N9: ${file} stores ${stored.workspaceAccessMode} and bashEnabled ${stored.bashEnabled}`);
	}
	const settings = JSON.parse(fs.readFileSync(path.join(runtime, "bash-settings.json"), "utf8"));
	assert(settings.autoApprove === false, `N9: bash-settings.json stores autoApprove ${settings.autoApprove}`);
});

await row("N10 the old flags an older app writes back are read on every read: on, off, on again, then this version's own save clears them", async () => {
	const roomId = await newRoom("linux");
	await on("linux", () => saveFolder(roomId, { root: newFolder(), workspaceAccessMode: "localFiles", bashEnabled: true }));
	const olderSwitch = (bashEnabled: boolean, autoApprove: boolean) => {
		older.policy.writePersistentRoomDefaultCapabilityPolicy(older.policy.updatePersistentRoomCapabilityPolicyWorkspaceSettings(older.policy.readPersistentRoomDefaultCapabilityPolicy(roomId, OLDER), { workspaceAccessMode: "localFiles", bashEnabled }), OLDER);
		older.bash.writePersistentRoomBashSettings(roomId, { autoApprove }, OLDER);
	};
	for (const [step, bashEnabled, autoApprove] of [[1, true, true], [2, false, false], [3, true, false], [4, true, true]] as const) {
		olderSwitch(bashEnabled, autoApprove);
		const shown = await on("linux", () => shownHere(roomId));
		assert(shown.commands === bashEnabled && shown.runWithoutAsking === (bashEnabled && autoApprove), `N10 step ${step}: the older app saved Bash ${bashEnabled ? "on" : "off"}, ${autoApprove ? "Run without asking" : "Ask first"}; here ${JSON.stringify(shown)}`);
	}
	// Saved here once more: still on and without asking here, and nothing in the older app.
	await on("linux", () => saveFolder(roomId, { workspaceAccessMode: "localFiles", bashEnabled: true }));
	await on("linux", () => chip(roomId, true));
	assert(JSON.stringify(await on("linux", () => shownHere(roomId))) === JSON.stringify({ access: "localFiles", commands: true, runWithoutAsking: true }), "N10: this version's save changed the room");
	await olderAppHolds("N10", roomId);
});

await row("O7 a room an older app saved with commands on and Run without asking, changed here by one control only: held in the older app all the same", async () => {
	const changes: Array<[string, (roomId: string) => Promise<unknown> | void]> = [
		["the chip", (roomId) => chip(roomId, true)],
		["the Folder pane", (roomId) => saveFolder(roomId, { workspaceAccessMode: "localFiles", bashEnabled: true })],
		["a conversation's own folder", (roomId) => saveConversationFolder(roomId, "conversation-3", { root: newFolder(), workspaceAccessMode: "bounded" })],
		["a card's Turn off", (roomId) => setRoomCommands(roomId, CONVERSATION, false)],
		["a card's yes", (roomId) => setRoomCommands(roomId, CONVERSATION, true)],
		["Clear in the Folder pane", (roomId) => call("DELETE", roomUrl(roomId, "workspace-default"))],
		["a conversation's own folder removed", (roomId) => call("DELETE", roomUrl(roomId, `workspace-policy?conversationId=${CONVERSATION}`))],
	];
	for (const [control, change] of changes) {
		const roomId = await newRoom("linux");
		await olderAppSaves(roomId, { access: "localFiles", bash: true, autoApprove: true });
		await olderAppSaves(roomId, { access: "localFiles", bash: true, conversation: true });
		await on("darwin", () => change(roomId));
		await olderAppHolds(`O7 ${control}`, roomId, [CONVERSATION, "conversation-2"]);
	}
});

await row("O8 a room on Auto, chosen here on a Mac: the older app reads it as asking, and asks before each command there", async () => {
	const roomId = await newRoom("darwin");
	await on("darwin", async () => {
		await saveFolder(roomId, { root: newFolder(), workspaceAccessMode: "localFiles" });
		const protection = (await call("GET", roomUrl(roomId, "bash-settings"))).protection;
		await call("PUT", roomUrl(roomId, "bash-settings"), { autoApprove: true, free: true, protection });
	});
	const here = (await on("darwin", () => call("GET", roomUrl(roomId, "bash-settings")))).settings;
	assert(here.free === true && here.autoApprove === true, `O8: this version no longer reads the room as Auto: ${JSON.stringify(here)}`);
	assert(older.bash.readPersistentRoomBashSettings(roomId, OLDER).autoApprove === false, "O8: the older app reads Auto as Run without asking");
	olderAppStarts([roomId]);
	await olderAppHolds("O8", roomId);
});

await row("N11 an older app's own Run without asking, read here: Auto on a Mac, also after the person turned protection off there and on again; a yes of this computer's where no protection runs; its Ask first stays Ask", async () => {
	const read = async (platform: "darwin" | "linux", roomId: string) => (await on(platform, () => call("GET", roomUrl(roomId, "bash-settings")))).settings;
	const mac = await newRoom("linux");
	await olderAppSaves(mac, { access: "localFiles", bash: true, autoApprove: true });
	const onMac = await read("darwin", mac);
	assert(onMac.free === true && onMac.autoApprove === true, `N11 on a Mac: ${JSON.stringify(onMac)}`);
	await on("darwin", () => call("PUT", roomUrl(mac, "protection"), { state: "off" }));
	const off = await read("darwin", mac);
	assert(off.free === undefined && off.autoApprove === false, `N11 turned off: ${JSON.stringify(off)}`);
	await on("darwin", () => call("PUT", roomUrl(mac, "protection"), { state: "on" }));
	assert((await read("darwin", mac)).free === true, "N11: turned on again, the room isn't on Auto");
	const elsewhere = await newRoom("linux");
	await olderAppSaves(elsewhere, { access: "localFiles", bash: true, autoApprove: true });
	const noProtection = await read("linux", elsewhere);
	assert(noProtection.free === undefined && noProtection.autoApprove === true, `N11 with no protection: ${JSON.stringify(noProtection)}`);
	const asks = await newRoom("linux");
	await olderAppSaves(asks, { access: "localFiles", bash: true, autoApprove: false });
	const askFirst = await read("darwin", asks);
	assert(askFirst.free === undefined && askFirst.autoApprove === false, `N11 Ask first: ${JSON.stringify(askFirst)}`);
});

await row("N12 an older app's own Run without asking in a room whose commands it left off, read here on a Mac: Semi, not Auto, since that room never ran commands", async () => {
	const roomId = await newRoom("linux");
	await olderAppSaves(roomId, { access: "localFiles", bash: false, autoApprove: true });
	const read = (await on("darwin", () => call("GET", roomUrl(roomId, "bash-settings")))).settings;
	assert(read.free === undefined && read.autoApprove === true, `N12: ${JSON.stringify(read)}`);
});

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	console.log(`failed: ${failures.join("; ")}`);
	process.exit(1);
}
process.exit(0);
