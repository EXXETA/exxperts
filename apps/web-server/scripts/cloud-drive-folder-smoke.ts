// A Mac keeps OneDrive, Google Drive and Dropbox under ~/Library/CloudStorage,
// one folder per account. Each such folder, and any folder below it, can be a
// room's own folder and a folder on its list, to read and to change, by its
// path alone: no mark on it is read and no program starts to judge it.
// CloudStorage itself and the rest of ~/Library stay refused. A refused folder
// says why and what to choose instead, in Room settings and in the folder
// question's panel, in the words of room-box/card-text.ts. Driven through the
// routes Room settings uses, with the computer's folder window stood in for.
//
// It plants folders in the home it runs under, so it refuses to start anywhere
// but the throwaway home `npm run smokes` makes.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

import { SMOKE_SERVER_AUTH_ENV } from "./smoke-server-process.js";

if (process.platform === "win32") {
	console.log("cloud drive folder smoke skipped (a Mac's and Linux's homes; Windows keeps its cloud drives elsewhere)");
	process.exit(0);
}
const home = fs.realpathSync(os.homedir());
const sharedTemp = fs.realpathSync(os.tmpdir());
if (path.dirname(home) !== sharedTemp || !path.basename(home).startsWith("exxperts-smoke-home-")) {
	console.error(`cloud drive folder smoke refused: ${home} is not a throwaway smoke home. Run it with: npm run smokes -- cloud-drive-folder`);
	process.exit(1);
}
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV);

const WINDOW_PROGRAMS = ["osascript", "zenity"];
// Every program the server starts, by name, but the folder window's.
const started: string[] = [];
const folderWindow = { pick: "" };
for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"] as const) {
	const real = (childProcess as any)[fn];
	(childProcess as any)[fn] = (command: string, ...rest: any[]) => {
		const program = path.basename(String(command).split(" ")[0]);
		if (fn === "execFile" && WINDOW_PROGRAMS.includes(program)) {
			const callback = rest.find((each) => typeof each === "function");
			// Each window's script: zenity prints the path itself; osascript prints it as JSON.
			setImmediate(() => callback(null, program === "zenity" ? `${folderWindow.pick}\n` : `${JSON.stringify(folderWindow.pick)}\n`, ""));
			return { kill() {}, on() {} };
		}
		started.push(program);
		return real(command, ...rest);
	};
}
syncBuiltinESMExports();
// zenity opens its window on a display; on a Linux runner with none the chooser answers unavailable before the stand-in above is asked.
process.env.DISPLAY ||= ":0";

const agents = await import("../src/persistent-agents.js");
const { readAlsoAllowed, saveAlsoAllowedFolders } = await import("../src/room-box/also-allowed.js");
const cards = await import("../src/room-box/card-text.js");
const { realPathOf } = await import("../src/room-box/box-closed.js");
const { folderGrantable, roomFolderGrantable } = await import("../src/room-box/folder-offer.js");
const { judgePick } = await import("../src/room-box/folder-question.js");
const { persistentAgentRootPath } = await import("../src/persistent-room-workspace-policy.js");
await import("../src/room-settings-routes.js");
const { app, AUTH_HEADER_NAME, AUTH_TOKEN } = await import("../src/server-app.js");
app.log.level = "silent";

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
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const made = (...parts: string[]) => {
	const folder = path.join(home, ...parts);
	fs.mkdirSync(folder, { recursive: true });
	return realPathOf(folder);
};
const headers = { [AUTH_HEADER_NAME]: AUTH_TOKEN, "content-type": "application/json" };
type Answer = { status: number; body: any };
async function call(method: "GET" | "POST" | "PUT", url: string, payload?: unknown, extra: Record<string, string> = {}): Promise<Answer> {
	const answer = await app.inject({ method, url, headers: { ...headers, ...extra }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
	return { status: answer.statusCode, body: answer.body ? JSON.parse(answer.body) : null };
}

const room = String(agents.createPersistentAgentFromScaffoldInput({ displayName: "Cloud Desk", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId);
const desk = made("Documents", "Desk");
/** Room settings' Folder, Choose folder: the folder the person picked, saved as the room's own, or why not. */
const chooseRoomFolder = (folder: string) => call("PUT", `/api/persistent-agents/${room}/workspace-default`, { root: folder, workspaceAccessMode: "localFiles" });
const roomFolderNow = async () => (await call("GET", `/api/persistent-agents/${room}/workspace-default`)).body;
/** Room settings' Add a folder…, with the window's pick. */
const addFolder = (folder: string) => {
	folderWindow.pick = folder;
	return call("POST", `/api/persistent-agents/${room}/also-allowed/folders`, {}, { "x-exxperts-local-action": "choose-folder" });
};
const allowChanges = (folder: string) => call("POST", `/api/persistent-agents/${room}/also-allowed/access`, { path: folder, access: "write" });

const oneDrive = made("Library", "CloudStorage", "OneDrive-Contoso");
const plans = made("Library", "CloudStorage", "OneDrive-Contoso", "Plans");
const googleDrive = made("Library", "CloudStorage", "GoogleDrive-ana@example.com", "My Drive", "Budget");
const dropbox = made("Library", "CloudStorage", "Dropbox", "Clients");
const storage = made("Library", "CloudStorage");
const caches = made("Library", "Caches", "Notes");

// What is taken and what is refused first, the words of a refusal in the last row: a build without those words still runs these rows.
await row("Room settings' Folder takes a folder in OneDrive, Google Drive or Dropbox that carries no mark, an account's own folder included; CloudStorage itself and another folder in Library are refused, and the room keeps its folder", async () => {
	for (const folder of [oneDrive, plans, googleDrive, dropbox]) {
		const saved = await chooseRoomFolder(folder);
		assert(saved.status === 200, `${folder}: ${saved.status} ${JSON.stringify(saved.body)}`);
		const now = await roomFolderNow();
		assert(now.policy?.roots?.[0]?.path === folder && now.folderRefused === false, `${folder} as it reads back: ${JSON.stringify({ roots: now.policy?.roots, refused: now.folderRefused })}`);
	}
	assert((await chooseRoomFolder(desk)).status === 200, "Documents/Desk");
	for (const folder of [storage, caches]) {
		const refused = await chooseRoomFolder(folder);
		assert(refused.status === 400 && refused.body?.code === "folder_refused", `${folder}: ${refused.status} ${JSON.stringify(refused.body)}`);
		assert((await roomFolderNow()).policy?.roots?.[0]?.path === desk, `${folder}: the room lost its folder`);
	}
});

await row("Room settings' Add a folder… takes a cloud drive folder with no mark to read, and Allow changes then lets the room change it; CloudStorage itself and Library/Caches are refused and the list stays as it was", async () => {
	assert((await chooseRoomFolder(desk)).status === 200, "the room's folder");
	saveAlsoAllowedFolders(room, []);
	for (const folder of [plans, googleDrive, dropbox]) {
		const added = await addFolder(folder);
		assert(added.status === 200 && added.body.state === "added", `${folder}: ${JSON.stringify(added.body)}`);
		const row = added.body.list.folders.find((entry: { path: string }) => entry.path === folder);
		assert(row?.access === "read" && row.canAllowChanges === true, `${folder} on the list: ${JSON.stringify(row)}`);
		const changed = await allowChanges(folder);
		assert(changed.status === 200 && readAlsoAllowed(room).folders.some((entry) => entry.path === folder && entry.access === "write"), `${folder}, Allow changes: ${changed.status} ${JSON.stringify(changed.body)}`);
	}
	const before = JSON.stringify(readAlsoAllowed(room));
	for (const folder of [storage, caches]) {
		const refused = await addFolder(folder);
		assert(refused.status === 200 && refused.body.state === "refused", `${folder}: ${JSON.stringify(refused.body)}`);
	}
	assert(JSON.stringify(readAlsoAllowed(room)) === before, "a refused pick changed the list");
	saveAlsoAllowedFolders(room, []);
});

await row("judging a cloud drive folder starts no program, xattr none, for the room's folder, the list and the folder question alike", async () => {
	// Once first, so what the computer reads once per server (its shared folders' names) is read.
	roomFolderGrantable(plans);
	const from = started.length;
	assert(roomFolderGrantable(plans) && roomFolderGrantable(oneDrive), "the room's folder");
	assert(folderGrantable(googleDrive, "write", [desk], desk), "a folder on the list");
	const judged = judgePick(dropbox, { roomId: room, room: { folder: desk, canChangeFiles: true } as any, access: "write", lasts: "room" });
	assert("folder" in judged && judged.folder === dropbox, `the folder question: ${"line" in judged ? judged.line : "folder" in judged ? judged.folder : "already"}`);
	assert(started.length === from, `programs started: ${JSON.stringify(started.slice(from))}`);
	assert(!started.includes("xattr"), `xattr started in this run: ${JSON.stringify(started)}`);
});

await row("a refused folder says why and what to choose instead, the folder in the way named: in Room settings and in the folder question's panel the same; an allowed neighbour beside each", async () => {
	assert((await chooseRoomFolder(desk)).status === 200, "the room's folder");
	const work = made("Work");
	const tools = made("Work", "tools", "bin");
	const beside = made("Work", "notes");
	const pathBefore = process.env.PATH;
	process.env.PATH = `${tools}${path.delimiter}${pathBefore ?? ""}`;
	try {
		const appData = realPathOf(persistentAgentRootPath(room));
		const holds = cards.folderRefusedLine({ reason: "holds-programs", inner: path.join("tools", "bin") }, "Work", "");
		const library = cards.folderRefusedLine({ reason: "library" }, "", "");
		const cases: [string, string][] = [
			[work, holds],
			[tools, cards.folderRefusedLine({ reason: "programs" }, "", "")],
			[storage, library],
			[caches, library],
			// It holds .config/gh, which no room may open, and .config/git, which apps read settings from: the first names it.
			[made(".config"), cards.folderRefusedLine({ reason: "holds-closed" }, ".config", "")],
			[made(".ssh", "work"), cards.folderRefusedLine({ reason: "private" }, "", "")],
			// The app's own data, whose name is also one apps read settings from: what is kept there is the reason.
			[appData, cards.folderRefusedLine({ reason: "private" }, "", "")],
		];
		for (const [folder, line] of cases) {
			// Room settings turns the app's own data down before this rule, in words of its own.
			const settings = await chooseRoomFolder(folder);
			assert(settings.status === 400 && (folder === appData || settings.body?.error === line), `Room settings, ${folder}: ${JSON.stringify(settings.body)}`);
			const listed = await addFolder(folder);
			assert(listed.body?.state === "refused" && listed.body.line === line, `Add a folder, ${folder}: ${JSON.stringify(listed.body)}`);
			const panel = judgePick(folder, { roomId: room, room: { folder: desk, canChangeFiles: true } as any, access: "read", lasts: "room", refused: cards.FOLDER_PICK_REFUSED_IN_PANEL });
			assert("line" in panel && panel.line === line, `the panel, ${folder}: ${JSON.stringify("line" in panel ? panel.line : "given")}`);
		}
		// The folder beside the one in the way is taken, in each place.
		const panel = judgePick(beside, { roomId: room, room: { folder: desk, canChangeFiles: true } as any, access: "read", lasts: "room", refused: cards.FOLDER_PICK_REFUSED_IN_PANEL });
		assert("folder" in panel, `the panel, ${beside}: ${"line" in panel ? panel.line : "already"}`);
		const listed = await addFolder(beside);
		assert(listed.body?.state === "added", `Add a folder, ${beside}: ${JSON.stringify(listed.body)}`);
		assert((await chooseRoomFolder(beside)).status === 200, `Room settings, ${beside}`);
	} finally {
		process.env.PATH = pathBefore;
		saveAlsoAllowedFolders(room, []);
	}
});

console.log(`cloud drive folder smoke: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	for (const name of failures) console.log(`  failed: ${name}`);
	process.exit(1);
}
process.exit(0);
