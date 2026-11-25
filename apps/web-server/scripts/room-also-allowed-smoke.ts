// A room's Also allowed list in Room settings: the routes the Folder pane uses,
// driven as the page drives them, and what a real command and a real file call
// can reach after each change. Add a folder opens the computer's own window
// (here a stand-in for the program it runs) and reads no path from the page; a
// refused pick says why and leaves the list as it was; iCloud Drive and each
// cloud drive its provider marks open to a pick and nothing else in ~/Library does; while the room answers, only
// what narrows works; the cross keeps the entry for Undo; a pick replaces what it
// covers; an entry unsound for one conversation's folder stays on the list; a
// room with no folder shows the sites its web reader's yes added, alone, and
// none on a shared server. Every refused row has an allowed neighbour.
//
// It plants folders in the home it runs under, so it refuses to start anywhere
// but the throwaway home `npm run smokes` makes. The rows that run a command in
// the box need a Mac; elsewhere each says it was skipped, by name.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

import { SMOKE_SERVER_AUTH_ENV } from "./smoke-server-process.js";

const home = fs.realpathSync(os.homedir());
const sharedTemp = fs.realpathSync(os.tmpdir());
if (path.dirname(home) !== sharedTemp || !path.basename(home).startsWith("exxperts-smoke-home-")) {
	console.error(`room also-allowed smoke refused: ${home} is not a throwaway smoke home. Run it with: npm run smokes -- room-also-allowed`);
	process.exit(1);
}
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV);
// A model rooms are offered, so a turn can be marked as running.
const appDir = path.join(home, ".exxperts", "app");
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model" }], maintenanceModel: "room-model" }));
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }));

// The computer's folder window, as the program the server starts for it answers: what the person picks, or a cancel.
const folderWindow = { calls: 0, answer: { pick: "" } as { pick: string } | { cancel: true } | { missing: true }, onOpen: undefined as (() => void) | undefined };
const realExecFile = childProcess.execFile;
(childProcess as any).execFile = (command: string, args: readonly string[], options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
	const program = path.basename(command).toLowerCase();
	if (!["osascript", "zenity", "powershell.exe"].includes(program)) return (realExecFile as any)(command, args, options, callback);
	folderWindow.calls += 1;
	folderWindow.onOpen?.();
	const answer = folderWindow.answer;
	setImmediate(() => {
		if ("missing" in answer) return callback(Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" }), "", "");
		if ("cancel" in answer) return program === "powershell.exe" ? callback(null, "CANCEL\n", "") : callback(Object.assign(new Error("User canceled. (-128)"), { code: 1 }), "", "execution error: User canceled. (-128)");
		// Each window's script: zenity prints the path itself; osascript and PowerShell print it as JSON.
		callback(null, program === "powershell.exe" ? `OK:${JSON.stringify(answer.pick)}\n` : program === "zenity" ? `${answer.pick}\n` : `${JSON.stringify(answer.pick)}\n`, "");
	});
	return { kill() {}, on() {} } as any;
};
syncBuiltinESMExports();
// zenity opens its window on a display; on a Linux runner with none the chooser answers unavailable before the stand-in above is asked.
process.env.DISPLAY ||= ":0";

const agents = await import("../src/persistent-agents.js");
const policyStore = await import("../src/persistent-room-workspace-policy.js");
const { readAlsoAllowed, saveAlsoAllowedFolders, writeRoomJson } = await import("../src/room-box/also-allowed.js");
const cards = await import("../src/room-box/card-text.js");
const { realPathOf } = await import("../src/room-box/box-closed.js");
const { AnswerFolders } = await import("../src/room-box/folder-question.js");
const { RoomBox, roomBoxAvailable } = await import("../src/room-box/box-session.js");
const { createRoomCommandTools } = await import("../src/room-command-tool.js");
const { createPersistentRoomWorkspaceTools } = await import("../src/persistent-room-workspace-tools.js");
const { createRoomWebReaderExtension } = await import("../src/room-web-reader.js");
const { classifyRemoteRoute } = await import("../src/remote-route-policy.js");
const { boxRules, homeLinksTo } = await import("../src/room-box/box-rules.js");
await import("../src/room-settings-routes.js");
await import("../src/remote-routes.js");
const { app, AUTH_HEADER_NAME, AUTH_TOKEN } = await import("../src/server-app.js");
app.log.level = "silent";
// A paired phone, as the tunnel's check marks one: the remote gate and the routes read this mark.
app.addHook("onRequest", async (req) => {
	if (req.headers["x-smoke-phone"] === "1") (req as any).exxRemoteDevice = { id: "smoke-phone", capability: "full" };
});

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

/** A row that runs a command in the box: only a Mac has one. */
async function boxRow(name: string, body: () => Promise<void> | void): Promise<void> {
	if (!roomBoxAvailable()) {
		console.log(`  skip ${name} (needs a Mac's box)`);
		return;
	}
	await row(name, body);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const made = (...parts: string[]) => {
	const folder = path.join(home, ...parts);
	fs.mkdirSync(folder, { recursive: true });
	return realPathOf(folder);
};
const plant = (folder: string, name: string, text: string) => fs.writeFileSync(path.join(folder, name), text);

/** A room with its folder chosen, as the pane saves it. */
function roomWith(label: string, folder: string): string {
	const roomId = String(agents.createPersistentAgentFromScaffoldInput({ displayName: label, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId);
	policyStore.writePersistentRoomDefaultCapabilityPolicy(policyStore.createPersistentRoomDefaultCapabilityPolicy({ agentId: roomId, repoRoot, root: folder, workspaceAccessMode: "localFiles", displayLabel: label, source: "manual" }));
	return roomId;
}

/**
 * A room with a folder on its list and then none of its own: the pick goes on
 * the list, and Clear takes the room's folder and leaves the list as it is.
 */
async function roomWithoutFolder(label: string, listed: string): Promise<string> {
	const roomId = roomWith(label, sales);
	pick(listed);
	const added = await add(roomId);
	assert(added.status === 200 && added.body.state === "added", `${label}'s folder pick: ${JSON.stringify(added.body)}`);
	const cleared = await app.inject({ method: "DELETE", url: `/api/persistent-agents/${roomId}/workspace-default`, headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN } });
	assert(cleared.statusCode === 200 && policyStore.readPersistentRoomDefaultCapabilityPolicy(roomId) === null, `${label}'s Clear: ${cleared.body}`);
	return roomId;
}

/**
 * The room's web reader as a turn's fetch_url call meets it, each call in a
 * turn of its own, its page card answered at the computer: `asked` counts the
 * cards so far, and `open` says whether the call went on.
 */
function webReaderOf(roomId: string) {
	let cards = 0;
	let answer: "once" | "room" | "decline" = "decline";
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	// A yes is applied as the bridge applies it, before the answer comes back.
	const questions = { watcher: () => "computer" as const, askSite: async (_card: unknown, apply: (choice: "once" | "room", answeredBy: "computer") => unknown) => {
		cards += 1;
		if (answer !== "decline") apply(answer, "computer");
		return { choice: answer, answeredBy: "computer" as const };
	} };
	createRoomWebReaderExtension({ roomId, questions })({ on: (event: string, handler: any) => { handlers[event] = handler; } } as any);
	return {
		asked: () => cards,
		async open(url: string, choice: typeof answer): Promise<boolean> {
			answer = choice;
			handlers.agent_start({}, {});
			const decision = await handlers.tool_call({ type: "tool_call", toolName: "fetch_url", toolCallId: "call", input: { url } }, {});
			return !decision?.block;
		},
	};
}

type Answer = { status: number; body: any };
async function api(method: "GET" | "POST", roomId: string, tail: string, body?: unknown, phone = false, mark = true): Promise<Answer> {
	// The app's own page marks the window's request, as it does for the room's folder.
	const window = mark && tail === "/folders" ? { "x-exxperts-local-action": "choose-folder" } : {};
	const answer = await app.inject({ method, url: `/api/persistent-agents/${roomId}/also-allowed${tail}`, headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN, ...window, ...(phone ? { "x-smoke-phone": "1" } : {}) }, ...(body === undefined ? {} : { payload: body as any }) });
	return { status: answer.statusCode, body: answer.body ? JSON.parse(answer.body) : null };
}
const pick = (folder: string) => {
	folderWindow.answer = { pick: folder };
};
const add = (roomId: string, body: unknown = {}) => api("POST", roomId, "/folders", body);
const listOf = (roomId: string) => readAlsoAllowed(roomId);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const XATTR = "/usr/bin/xattr";

/** A turn in flight in the room, as a message being answered makes one; `end` finishes it. */
function answering(roomId: string): { end: () => void } {
	const threadId = `also_allowed_turn_${Math.random().toString(36).slice(2, 10)}`;
	agents.writePersistentAgentThread(roomId, threadId, { state: "standby", origin: "home", model: { provider: "openai-compatible", model: "room-model", label: "Room Model" }, items: [{ kind: "user", id: "u1", text: "Synthetic message." }] } as any);
	const turn = agents.beginPersistentAgentTurn(roomId, threadId, { turnId: `turn-${threadId}`, connectionId: "synthetic-ws" });
	return { end: () => agents.finishPersistentAgentTurn(roomId, threadId, { turnId: turn.turnId, terminalReason: "completed" }) };
}

/**
 * The room's commands and file tools as one answer holds them: the same box for
 * the whole turn. `answer`: the running answer's own folders, as the live room
 * passes them. `file` runs as on a computer without the box, `boxFile` in the
 * box.
 */
function roomTools(roomId: string, folder: string, conversationId = "conversation-a", live: { answer?: () => InstanceType<typeof AnswerFolders> } = {}) {
	const box = new RoomBox({
		roomId,
		conversationId: () => conversationId,
		questions: { watcher: () => "none", askSite: async () => ({ choice: "decline", answeredBy: "none" }), closeSiteCards: () => {} } as any,
		rights: () => ({ canChangeFiles: true, skillFolders: [] }),
		warn: () => {},
		...(live.answer ? { answer: live.answer } : {}),
	});
	const commands = createRoomCommandTools(folder, { box, outside: { questions: { watcher: () => "none" } as any, setOffered: () => {} } });
	const bash = async (command: string): Promise<{ text: string; failed: boolean }> => {
		const tool = commands.tools.find((each) => each.name === "bash")!;
		try {
			const result: any = await tool.execute(`c-${Math.random()}`, { command } as any, undefined as any, undefined as any, undefined as any);
			return { text: (result.content ?? []).map((part: any) => part.text ?? "").join(""), failed: false };
		} catch (error) {
			return { text: (error as Error).message, failed: true };
		}
	};
	const fileTool = async (name: "read" | "write", params: Record<string, unknown>, inBox: boolean): Promise<{ text: string; failed: boolean }> => {
		const policy = policyStore.readPersistentRoomDefaultCapabilityPolicy(roomId);
		const tool = createPersistentRoomWorkspaceTools(policy!, { ...(inBox ? { box } : {}), ...live }).find((each) => each.name === name) as any;
		try {
			const result = await tool.execute(`f-${Math.random()}`, params, undefined, undefined, {} as any);
			return { text: (result?.content ?? []).map((part: any) => String(part.text ?? "")).join("\n"), failed: false };
		} catch (error) {
			return { text: (error as Error).message, failed: true };
		}
	};
	const file = (name: "read" | "write", params: Record<string, unknown>) => fileTool(name, params, false);
	const boxFile = (name: "read" | "write", params: Record<string, unknown>) => fileTool(name, params, true);
	return { bash, file, boxFile, end: () => box.endTurn() };
}
const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// Ana's room, its folder in Documents, and the folders she keeps elsewhere.
const sales = made("Documents", "Sales Review");
const finance = made("Finance");
const finance2025 = made("Finance", "2025");
const reports = made("Reports");
plant(finance, "figures.md", "finance figures\n");
plant(finance2025, "q3.md", "q3 figures\n");
plant(reports, "draft.md", "report draft\n");
const room = roomWith("Sales Review", sales);

async function main(): Promise<void> {
	console.log("room also-allowed smoke");

	await row("each new route has its remote class: a phone may read the list, and only the computer changes it", () => {
		const base = "/api/persistent-agents/:id/also-allowed";
		assert(classifyRemoteRoute("GET", base) === "read", "the read");
		for (const tail of ["/folders", "/access", "/remove", "/restore"]) assert(classifyRemoteRoute("POST", `${base}${tail}`) === "local", `POST ${tail}`);
	});

	await row("the list: folders with their access, sites with host and port; a phone gets names and no path", async () => {
		writeRoomJson(path.join(policyStore.persistentAgentRootPath(room), "runtime", "also-allowed.json"), { folders: [{ path: reports, access: "write" }, { path: finance, access: "read" }], sites: [{ host: "pypi.org", port: 443 }] });
		const computer = await api("GET", room, "");
		assert(computer.status === 200, `the read: ${computer.status}`);
		assert(same(computer.body.folders.map((each: any) => [each.name, each.access, each.path]), [["Reports", "write", reports], ["Finance", "read", finance]]), `folders: ${JSON.stringify(computer.body.folders)}`);
		assert(same(computer.body.sites, [{ host: "pypi.org", port: 443 }]), `sites: ${JSON.stringify(computer.body.sites)}`);
		const phone = await api("GET", room, "", undefined, true);
		assert(phone.status === 200 && same(phone.body.folders.map((each: any) => each.name), ["Reports", "Finance"]), `the phone's read: ${JSON.stringify(phone.body)}`);
		assert(!JSON.stringify(phone.body).includes(home) && phone.body.folders.every((each: any) => !("path" in each)), `a path reached the phone: ${JSON.stringify(phone.body)}`);
	});

	await row("a phone is refused every change, and the list stays as it was", async () => {
		const before = listOf(room);
		const calls = folderWindow.calls;
		for (const [tail, body] of [["/folders", {}], ["/access", { path: finance, access: "write" }], ["/remove", { path: finance }], ["/restore", { path: finance }], ["/access", { path: reports, access: "read" }]] as const) {
			const answer = await api("POST", room, tail, body, true);
			assert(answer.status === 403 && answer.body.code === "remote_local_only", `${tail}: ${answer.status} ${JSON.stringify(answer.body)}`);
		}
		assert(same(listOf(room), before) && folderWindow.calls === calls, "a phone changed the list or opened the window");
	});

	await row("Add opens the window, reads no path from the page, starts at Can read, and stores the disk's own spelling", async () => {
		saveAlsoAllowedFolders(room, []);
		const calls = folderWindow.calls;
		const spelled = fs.existsSync(path.join(home, "REPORTS")) ? path.join(home, "REPORTS") : reports;
		pick(`${spelled}/`);
		const answer = await add(room, { path: finance, access: "write" });
		assert(answer.status === 200 && answer.body.state === "added" && answer.body.name === "Reports", `the add: ${JSON.stringify(answer.body)}`);
		assert(folderWindow.calls === calls + 1, "the window didn't open once");
		assert(same(listOf(room).folders, [{ path: reports, access: "read" }]), `stored: ${JSON.stringify(listOf(room).folders)}`);
	});

	await row("Add opens the window only for the app's own page: a request without its mark, or from another site, is refused", async () => {
		const before = listOf(room);
		const calls = folderWindow.calls;
		pick(finance);
		const unmarked = await api("POST", room, "/folders", {}, false, false);
		assert(unmarked.status === 403 && unmarked.body.code === "local_request_required", `no mark: ${unmarked.status} ${JSON.stringify(unmarked.body)}`);
		const elsewhere = await app.inject({ method: "POST", url: `/api/persistent-agents/${room}/also-allowed/folders`, headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN, "x-exxperts-local-action": "choose-folder", origin: "https://example.com" }, payload: {} });
		assert(elsewhere.statusCode === 403, `another site: ${elsewhere.statusCode}`);
		assert(folderWindow.calls === calls && same(listOf(room), before), "the window opened or the list changed");
	});

	await row("the pane leaves out a row the room's own folder makes unusable, and the room's list keeps it", async () => {
		const before = listOf(room);
		const inside = made("Documents", "Sales Review", "Drafts");
		saveAlsoAllowedFolders(room, [{ path: inside, access: "read" }, { path: finance, access: "read" }]);
		const view = await api("GET", room, "");
		assert(same(view.body.folders.map((each: any) => each.name), ["Finance"]), `the pane's rows: ${JSON.stringify(view.body.folders)}`);
		assert(listOf(room).folders.some((each) => each.path === inside), "the room's list lost the row");
		saveAlsoAllowedFolders(room, before.folders);
	});

	await row("a cancel changes nothing", async () => {
		const before = listOf(room);
		folderWindow.answer = { cancel: true };
		const answer = await add(room);
		assert(answer.status === 200 && answer.body.state === "unchanged" && same(listOf(room), before), `the cancel: ${JSON.stringify(answer.body)}`);
	});

	await row("a computer with no folder window says so and changes nothing", async () => {
		const before = listOf(room);
		folderWindow.answer = { missing: true };
		const answer = await add(room);
		assert(answer.status === 200 && answer.body.state === "refused" && answer.body.line === cards.NO_FOLDER_WINDOW && same(listOf(room), before), `no window: ${JSON.stringify(answer.body)}`);
	});

	await row("a refused pick gets its line: already covered, holds this room's folder, or any other it can't use", async () => {
		const before = listOf(room);
		pick(path.join(reports));
		const covered = await add(room);
		assert(covered.body.state === "already" && covered.body.line === "This room can already use that folder.", `covered: ${JSON.stringify(covered.body)}`);
		pick(path.join(home, "Documents"));
		const holds = await add(room);
		assert(holds.body.state === "refused" && holds.body.line === "This room can't use Documents, because this room's folder is inside it. Choose a folder inside Documents.", `holds the room: ${JSON.stringify(holds.body)}`);
		pick(made("Library", "Preferences"));
		const other = await add(room);
		assert(other.body.state === "refused" && other.body.line === "This room can't use that folder. Choose another one.", `~/Library/Preferences: ${JSON.stringify(other.body)}`);
		assert(same(listOf(room), before), "a refused pick changed the list");
		// The allowed neighbour: a folder inside Documents, beside the room's.
		pick(made("Documents", "Contracts"));
		assert((await add(room)).body.state === "added", "a folder beside the room's");
		saveAlsoAllowedFolders(room, before.folders);
	});

	await row("the list stays unchanged for home's own places, ~/Library, .ssh in another case, ~/.claude for change, a parent of the room, and a link into a place commands write", async () => {
		const before = listOf(room);
		const ssh = made(".ssh");
		const claude = made(".claude");
		const inRoom = made("Documents", "Sales Review", "drafts");
		const link = path.join(home, "drafts-link");
		fs.symlinkSync(inRoom, link);
		const caseFolds = fs.existsSync(path.join(home, ".SSH"));
		const refusedPicks = [home, made("Library", "Preferences"), made("Library"), caseFolds ? path.join(home, ".SSH") : ssh, claude, path.join(home, "Documents"), link, inRoom];
		for (const folder of refusedPicks) {
			pick(folder);
			const answer = await add(room);
			assert(answer.status === 200 && answer.body.state !== "added" && same(listOf(room), before), `${folder}: ${JSON.stringify(answer.body)}`);
		}
		// ~/.claude on the list by hand, for reading: no command can use it, so the pane draws no row, and Allow changes is refused.
		saveAlsoAllowedFolders(room, [...before.folders, { path: claude, access: "read" }]);
		const view = (await api("GET", room, "")).body.folders.find((each: any) => each.path === claude);
		assert(view === undefined, `the pane draws ~/.claude: ${JSON.stringify(view)}`);
		const widen = await api("POST", room, "/access", { path: claude, access: "write" });
		assert(widen.status === 400 && listOf(room).folders.find((each) => each.path === claude)?.access === "read", `~/.claude for change: ${widen.status}`);
		// The allowed neighbour: a listed folder elsewhere can be widened.
		const neighbour = (await api("GET", room, "")).body.folders.find((each: any) => each.path === reports);
		assert(neighbour?.canAllowChanges === true, `Reports can't be widened: ${JSON.stringify(neighbour)}`);
		saveAlsoAllowedFolders(room, before.folders);
	});

	await row("a pick through a link in a place commands write is refused; the same folder through a link elsewhere is added", async () => {
		const before = listOf(room);
		// A command in the room could leave this link, so that a pick in the window leads somewhere the person didn't choose.
		const planted = path.join(sales, "finance-shortcut");
		fs.symlinkSync(finance, planted);
		pick(planted);
		const refused = await add(room);
		assert(refused.body.state === "refused" && refused.body.line === cards.FOLDER_PICK_REFUSED && same(listOf(room), before), `through the room: ${JSON.stringify(refused.body)}`);
		const own = path.join(home, "finance-shortcut");
		fs.symlinkSync(finance, own);
		pick(own);
		const added = await add(room);
		assert(added.body.state === "added" && listOf(room).folders.some((each) => each.path === finance), `through home: ${JSON.stringify(added.body)}`);
		saveAlsoAllowedFolders(room, before.folders);
	});

	await row("iCloud Drive and each marked cloud drive open to a pick, account roots included; Mobile Documents, CloudStorage and a folder there without a provider's mark stay closed", async () => {
		const before = listOf(room);
		const tryPick = async (folder: string) => {
			pick(folder);
			const answer = await add(room);
			saveAlsoAllowedFolders(room, before.folders);
			return answer.body.state as string;
		};
		const icloud = made("Library", "Mobile Documents", "com~apple~CloudDocs");
		assert(await tryPick(made("Library", "Mobile Documents", "com~apple~CloudDocs", "Budget")) === "added", "a folder in iCloud Drive");
		assert(await tryPick(icloud) === "added", "iCloud Drive's root");
		assert(await tryPick(made("Library", "Mobile Documents")) === "refused", "Mobile Documents itself");
		assert(await tryPick(made("Library", "Mobile Documents", "com~apple~Pages", "Documents")) === "refused", "another app's iCloud folder");
		// A provider's mark is read with the Mac's own program: elsewhere the CloudStorage half has nothing to read.
		if (!fs.existsSync(XATTR)) {
			console.log("room also-allowed smoke skipped the CloudStorage half (needs a Mac's xattr)");
			assert(same(listOf(room), before), "the list changed");
			return;
		}
		const mark = (folder: string, provider: string) => childProcess.execFileSync(XATTR, ["-w", "com.apple.file-provider-domain-id", provider, folder]);
		const storage = made("Library", "CloudStorage");
		const contoso = made("Library", "CloudStorage", "OneDrive-Contoso");
		mark(contoso, "com.microsoft.OneDrive-mac.FileProvider/contoso");
		assert(await tryPick(made("Library", "CloudStorage", "OneDrive-Contoso", "Q3")) === "added", "a folder in OneDrive");
		assert(await tryPick(made("Library", "CloudStorage", "OneDrive-Contoso", "Shared Library - Sales")) === "added", "a SharePoint library under OneDrive");
		assert(await tryPick(contoso) === "added", "OneDrive's account root");
		assert(await tryPick(storage) === "refused", "CloudStorage itself");
		// A work account sorted after a personal one opens as the first does.
		const personal = made("Library", "CloudStorage", "OneDrive-Personal");
		mark(personal, "com.microsoft.OneDrive-mac.FileProvider/personal");
		const work = made("Library", "CloudStorage", "OneDrive-Zeta", "Plans");
		mark(path.dirname(work), "com.microsoft.OneDrive-mac.FileProvider/zeta");
		assert(await tryPick(work) === "added", "a folder in a second OneDrive account");
		const dropbox = made("Library", "CloudStorage", "Dropbox", "Clients");
		mark(path.dirname(dropbox), "com.getdropbox.dropbox.fileprovider/ana");
		assert(await tryPick(path.dirname(dropbox)) === "added", "another provider's account root");
		assert(await tryPick(dropbox) === "added", "a folder in another provider's account");
		// No mark, then a mark: the refusal isn't kept, so the next pick reads it again.
		const google = made("Library", "CloudStorage", "GoogleDrive-ana", "My Drive");
		assert(await tryPick(google) === "refused", "a CloudStorage folder without a provider's mark");
		mark(path.dirname(google), "com.google.drivefs.fpext/ana");
		assert(await tryPick(google) === "added", "the same folder once its mark reads");
		assert(same(listOf(room), before), "the list changed");
	});

	await boxRow("a pick in iCloud Drive and one in OneDrive are used by the next command", async () => {
		const before = listOf(room);
		const budget = made("Library", "Mobile Documents", "com~apple~CloudDocs", "Budget");
		const q3 = made("Library", "CloudStorage", "OneDrive-Contoso", "Q3");
		plant(budget, "budget.md", "icloud budget\n");
		plant(q3, "q3.md", "onedrive q3\n");
		const tools = roomTools(room, sales);
		const both = `cat ${quoted(path.join(budget, "budget.md"))} ${quoted(path.join(q3, "q3.md"))}`;
		assert((await tools.bash(both)).failed, "the command read the cloud files before any pick");
		for (const folder of [budget, q3]) {
			pick(folder);
			assert((await add(room)).body.state === "added", `the pick of ${folder}`);
		}
		const after = await tools.bash(both);
		assert(!after.failed && after.text.includes("icloud budget") && after.text.includes("onedrive q3"), `after the picks: ${after.text}`);
		await tools.end();
		saveAlsoAllowedFolders(room, before.folders);
	});

	await boxRow("a room whose folder is reached through OneDrive's home link runs its commands, and that link alone is open for reading", async () => {
		const project = made("Library", "CloudStorage", "OneDrive-Contoso", "Project");
		plant(project, "plan.md", "the plan\n");
		const link = path.join(home, "OneDrive - Contoso");
		fs.symlinkSync(path.dirname(project), link);
		const unrelated = path.join(home, "Elsewhere link");
		fs.symlinkSync(finance2025, unrelated);
		const cloudRoom = roomWith("Cloud Plan", path.join(link, "Project"));
		const tools = roomTools(cloudRoom, path.join(link, "Project"));
		const ran = await tools.bash("cat plan.md && pwd");
		assert(!ran.failed && ran.text.includes("the plan"), `the command: ${ran.text}`);
		await tools.end();
		assert(same(homeLinksTo([project]), [link]), `links opened: ${JSON.stringify(homeLinksTo([project]))}`);
		const places = { temp: made("box-temp"), caches: made("box-caches"), shim: made("box-shim"), gitTemplate: made("box-git") };
		const rules = boxRules({ folder: project, canChangeFiles: true, alsoAllowed: [], skillFolders: [], places }).profileRules;
		assert(rules.includes(`(allow file-read* (literal ${JSON.stringify(link)}))`) && !rules.includes(JSON.stringify(unrelated)), `the rules: ${rules}`);
	});

	await row("while the room answers: adding a folder, Allow changes and Undo are refused as a Save is; the cross and the button back to Can read work", async () => {
		saveAlsoAllowedFolders(room, [{ path: finance, access: "read" }, { path: reports, access: "write" }]);
		const turn = answering(room);
		try {
			const calls = folderWindow.calls;
			pick(made("Contracts"));
			for (const [tail, body] of [["/folders", {}], ["/access", { path: finance, access: "write" }]] as const) {
				const answer = await api("POST", room, tail, body);
				assert(answer.status === 409 && answer.body.code === "active_turn_in_flight" && answer.body.error === "The room is answering right now. Save again when it has finished; nothing was changed.", `${tail}: ${answer.status} ${JSON.stringify(answer.body)}`);
			}
			assert(folderWindow.calls === calls, "the window opened while the room answered");
			const narrowed = await api("POST", room, "/access", { path: reports, access: "read" });
			assert(narrowed.status === 200 && listOf(room).folders.find((each) => each.path === reports)?.access === "read", `back to Can read: ${JSON.stringify(narrowed.body)}`);
			const removed = await api("POST", room, "/remove", { path: finance });
			assert(removed.status === 200 && !listOf(room).folders.some((each) => each.path === finance), `the cross: ${JSON.stringify(removed.body)}`);
			const undo = await api("POST", room, "/restore", { path: finance });
			assert(undo.status === 409 && !listOf(room).folders.some((each) => each.path === finance), `Undo while answering: ${undo.status}`);
			for (const [tail, body] of [["/remove", { path: reports }], ["/access", { path: reports, access: "read" }]] as const) {
				assert((await api("POST", room, tail, body, true)).status === 403, `a phone, ${tail}`);
			}
		} finally {
			turn.end();
		}
		assert((await api("POST", room, "/restore", { path: finance })).status === 200 && listOf(room).folders.some((each) => each.path === finance), "Undo once the answer ended");
	});

	await row("a window still open when the room starts answering adds nothing", async () => {
		const before = listOf(room);
		let turn: { end: () => void } | undefined;
		folderWindow.onOpen = () => { turn = answering(room); };
		pick(made("Contracts"));
		try {
			const answer = await add(room);
			assert(answer.status === 409 && same(listOf(room), before), `the late pick: ${answer.status} ${JSON.stringify(answer.body)}`);
		} finally {
			folderWindow.onOpen = undefined;
			turn?.end();
		}
	});

	await row("a room that starts answering during the first look into the pick writes nothing", async () => {
		const before = listOf(room);
		const picked = made("Minutes");
		let turn: { end: () => void } | undefined;
		// The look lists the pick once before it is given: the room's turn starts while it does.
		const readdir = fs.promises.readdir;
		(fs.promises as any).readdir = (target: string, ...rest: unknown[]) => {
			if (target === picked) turn = answering(room);
			return (readdir as any)(target, ...rest);
		};
		pick(picked);
		try {
			const answer = await add(room);
			assert(turn && answer.status === 409 && answer.body.code === "active_turn_in_flight" && same(listOf(room), before), `the pick during the look: ${answer.status} ${JSON.stringify(answer.body)}`);
		} finally {
			(fs.promises as any).readdir = readdir;
			turn?.end();
		}
		// The same pick with nobody answering goes on the list.
		pick(picked);
		const added = await add(room);
		assert(added.status === 200 && added.body.state === "added" && listOf(room).folders.some((each) => each.path === picked), `the pick after: ${added.status} ${JSON.stringify(added.body)}`);
		saveAlsoAllowedFolders(room, before.folders);
	});

	await boxRow("a row removed mid-turn: the next command and the next file call can't reach it; back to Can read: they can only read", async () => {
		saveAlsoAllowedFolders(room, [{ path: finance, access: "read" }, { path: reports, access: "write" }]);
		const tools = roomTools(room, sales);
		const turn = answering(room);
		try {
			const figures = path.join(finance, "figures.md");
			assert(!(await tools.bash(`cat ${quoted(figures)}`)).failed && !(await tools.file("read", { path: figures })).failed, "Finance before the cross");
			assert((await api("POST", room, "/remove", { path: finance })).status === 200, "the cross");
			assert((await tools.bash(`cat ${quoted(figures)}`)).failed, "the next command still read Finance");
			assert((await tools.file("read", { path: figures })).failed, "the next file call still read Finance");
			const draft = path.join(reports, "draft.md");
			assert(!(await tools.bash(`echo more >> ${quoted(draft)}`)).failed, "Reports before the button");
			assert((await api("POST", room, "/access", { path: reports, access: "read" })).status === 200, "back to Can read");
			assert((await tools.bash(`echo again >> ${quoted(draft)}`)).failed, "the next command still changed Reports");
			assert((await tools.file("write", { path: draft, content: "replaced\n" })).failed, "the next file call still changed Reports");
			const read = await tools.bash(`cat ${quoted(draft)}`);
			assert(!read.failed && read.text.includes("more"), `Reports can still be read: ${read.text}`);
		} finally {
			turn.end();
			await tools.end();
		}
	});

	await row("the cross keeps what it took for Undo, which puts it back with the access it had; a site the same; nothing kept, nothing put back", async () => {
		writeRoomJson(path.join(policyStore.persistentAgentRootPath(room), "runtime", "also-allowed.json"), { folders: [{ path: reports, access: "write" }], sites: [{ host: "pypi.org", port: 443 }] });
		const folder = await api("POST", room, "/remove", { path: reports });
		assert(folder.status === 200 && same(folder.body.removed, { kind: "folder", name: "Reports", path: reports, access: "write" }) && listOf(room).folders.length === 0, `the cross: ${JSON.stringify(folder.body)}`);
		const site = await api("POST", room, "/remove", { host: "pypi.org", port: 443 });
		assert(site.status === 200 && listOf(room).sites.length === 0, `a site's cross: ${JSON.stringify(site.body)}`);
		assert((await api("POST", room, "/restore", { path: reports })).status === 200 && same(listOf(room).folders, [{ path: reports, access: "write" }]), "Undo on the folder");
		assert((await api("POST", room, "/restore", { host: "pypi.org", port: 443 })).status === 200 && same(listOf(room).sites, [{ host: "pypi.org", port: 443 }]), "Undo on the site");
		assert((await api("POST", room, "/restore", { path: reports })).status === 404, "a second Undo put something back");
		const neverListed = made("Never Listed");
		assert((await api("POST", room, "/restore", { path: neverListed })).status === 404 && !listOf(room).folders.some((each) => each.path === neverListed), "Undo put back a path the page named");
		assert((await api("POST", room, "/remove", { path: neverListed })).status === 404, "a cross on what isn't listed");
		// Undo puts a row back where it stood, not at the list's end.
		saveAlsoAllowedFolders(room, [{ path: finance, access: "read" }, { path: reports, access: "write" }, { path: neverListed, access: "read" }]);
		await api("POST", room, "/remove", { path: reports });
		await api("POST", room, "/restore", { path: reports });
		assert(same(listOf(room).folders.map((each) => each.path), [finance, reports, neverListed]), `the order after Undo: ${JSON.stringify(listOf(room).folders)}`);
		saveAlsoAllowedFolders(room, []);
	});

	await row("a room with no folder: the site its web reader's yes for the room added is listed; the cross takes it off and the reader asks again; Undo puts it back and the reader opens it with no card", async () => {
		const bare = await roomWithoutFolder("No Folder Site Desk", reports);
		const reader = webReaderOf(bare);
		assert(await reader.open("https://docs.python.org/3/", "room") && reader.asked() === 1, `the first call: ${reader.asked()}`);
		assert(await reader.open("https://docs.python.org/3/library/", "decline") && reader.asked() === 1, "the room's yes still asked");
		const listed = await api("GET", bare, "");
		assert(listed.status === 200 && same(listed.body.sites, [{ host: "docs.python.org", port: 443 }]), `the list: ${JSON.stringify(listed.body)}`);
		const removed = await api("POST", bare, "/remove", { host: "docs.python.org", port: 443 });
		assert(removed.status === 200 && same(removed.body.removed, { kind: "site", host: "docs.python.org", port: 443 }) && same(removed.body.list.sites, []), `the cross: ${JSON.stringify(removed.body)}`);
		assert(!(await reader.open("https://docs.python.org/3/library/", "decline")) && reader.asked() === 2, `after the cross: ${reader.asked()}`);
		const restored = await api("POST", bare, "/restore", { host: "docs.python.org", port: 443 });
		assert(restored.status === 200 && same(restored.body.list.sites, [{ host: "docs.python.org", port: 443 }]), `Undo: ${JSON.stringify(restored.body)}`);
		assert(await reader.open("https://docs.python.org/3/library/", "decline") && reader.asked() === 2, "after Undo the reader asked");
	});

	await row("a pick replaces the rows it covers with the same or less access, and keeps a narrower row with more access", async () => {
		const q4 = made("Finance", "2025", "Q4");
		saveAlsoAllowedFolders(room, [{ path: finance2025, access: "write" }, { path: q4, access: "read" }, { path: reports, access: "read" }]);
		pick(finance);
		assert((await add(room)).body.state === "added", "the pick of Finance");
		assert(same(listOf(room).folders, [{ path: finance2025, access: "write" }, { path: reports, access: "read" }, { path: finance, access: "read" }]), `a read pick: ${JSON.stringify(listOf(room).folders)}`);
		assert((await api("POST", room, "/access", { path: finance, access: "write" })).status === 200, "Allow changes on Finance");
		assert(same(listOf(room).folders, [{ path: reports, access: "read" }, { path: finance, access: "write" }]), `Allow changes covers 2025: ${JSON.stringify(listOf(room).folders)}`);
	});

	await boxRow("after the cross on a narrower row another still covers, the folder stays readable and the answer names that row; after Allow changes a command can write", async () => {
		saveAlsoAllowedFolders(room, [{ path: finance, access: "read" }, { path: finance2025, access: "write" }]);
		const tools = roomTools(room, sales);
		const q3 = path.join(finance2025, "q3.md");
		assert(!(await tools.bash(`echo more >> ${quoted(q3)}`)).failed, "2025 can change before the cross");
		const removed = await api("POST", room, "/remove", { path: finance2025 });
		assert(removed.body.stillReadThrough === "Finance", `the answer: ${JSON.stringify(removed.body)}`);
		assert((await tools.bash(`echo again >> ${quoted(q3)}`)).failed, "2025 can still change");
		const read = await tools.bash(`cat ${quoted(q3)}`);
		assert(!read.failed && read.text.includes("q3 figures"), `2025 can't be read: ${read.text}`);
		const lone = await api("POST", room, "/remove", { path: finance });
		assert(lone.status === 200 && !("stillReadThrough" in lone.body), `the last row: ${JSON.stringify(lone.body)}`);
		await api("POST", room, "/restore", { path: finance });
		assert((await tools.bash(`echo x >> ${quoted(path.join(finance, "figures.md"))}`)).failed, "Finance changes before Allow changes");
		assert((await api("POST", room, "/access", { path: finance, access: "write" })).status === 200, "Allow changes");
		assert(!(await tools.bash(`echo x >> ${quoted(path.join(finance, "figures.md"))}`)).failed, "Finance can't change after Allow changes");
		await tools.end();
	});

	// Allow this time and Allow changes this time: the running answer's own folders, read at each call beside the list, and gone with the answer.
	const plans = made("Plans");
	plant(plans, "plan.md", "the plan\n");
	const plan = path.join(plans, "plan.md");

	await row("given this time, without the box: this answer's file tools read the folder, can't change a folder given to read, and the next answer's can't open it; the list never holds it", async () => {
		saveAlsoAllowedFolders(room, []);
		let answer = new AnswerFolders();
		const tools = roomTools(room, sales, "conversation-a", { answer: () => answer });
		try {
			assert((await tools.file("read", { path: plan })).failed, "the folder opened before the pick");
			assert(answer.give(plans, "read"), "the pick");
			const read = await tools.file("read", { path: plan });
			assert(!read.failed && read.text.includes("the plan"), `this answer's read: ${read.text}`);
			const write = await tools.file("write", { path: path.join(plans, "new.md"), content: "x" });
			assert(write.failed && write.text.includes("in a folder this room can only read"), `a write into a folder given to read: ${write.text}`);
			answer.end();
			answer = new AnswerFolders();
			const after = await tools.file("read", { path: plan });
			assert(after.failed && after.text.includes("outside this room's folder"), `the next answer's read: ${after.text}`);
			assert(listOf(room).folders.length === 0, "the list holds a folder given this time");
			answer.end();
			assert(!answer.give(plans, "read"), "an ended answer took a pick");
			assert((await tools.file("read", { path: plan })).failed, "a pick after its answer ended opened the folder");
		} finally {
			await tools.end();
		}
	});

	await boxRow("given this time, in the box: this answer's commands and file tools reach the folder, a changeable one before its first command; the next answer's can't", async () => {
		saveAlsoAllowedFolders(room, []);
		let answer = new AnswerFolders();
		const tools = roomTools(room, sales, "conversation-a", { answer: () => answer });
		try {
			assert((await tools.bash(`cat ${quoted(plan)}`)).failed, "a command read the folder before the pick");
			answer.give(plans, "write");
			const read = await tools.bash(`echo more >> ${quoted(plan)} && cat ${quoted(plan)}`);
			assert(!read.failed && read.text.includes("more"), `this answer's command: ${read.text}`);
			const boxed = await tools.boxFile("read", { path: plan });
			assert(!boxed.failed && boxed.text.includes("more"), `this answer's file tool in the box: ${boxed.text}`);
			answer.end();
			await tools.end();
			answer = new AnswerFolders();
			assert((await tools.bash(`cat ${quoted(plan)}`)).failed, "the next answer's command read the folder");
			assert((await tools.boxFile("read", { path: plan })).failed, "the next answer's file tool in the box read the folder");
			assert(listOf(room).folders.length === 0, "the list holds a folder given this time");
		} finally {
			answer.end();
			await tools.end();
		}
	});

	await row("Allow this time with access change on a Can read folder of the list: writes land until the answer ends, the list still says Can read, and the next answer's write is refused", async () => {
		saveAlsoAllowedFolders(room, [{ path: finance, access: "read" }]);
		let answer = new AnswerFolders();
		const tools = roomTools(room, sales, "conversation-a", { answer: () => answer });
		try {
			const refused = await tools.file("write", { path: path.join(finance, "before.md"), content: "zero" });
			assert(refused.failed && refused.text.includes("in a folder this room can only read"), `the write before the pick: ${refused.text}`);
			answer.give(finance, "write");
			const first = await tools.file("write", { path: path.join(finance, "this-time.md"), content: "one" });
			const second = await tools.file("write", { path: path.join(finance, "this-time-2.md"), content: "two" });
			assert(!first.failed && !second.failed, `the writes after the pick: ${first.text} ${second.text}`);
			assert(same(listOf(room).folders, [{ path: finance, access: "read" }]), `the list after: ${JSON.stringify(listOf(room).folders)}`);
			answer.end();
			answer = new AnswerFolders();
			const next = await tools.file("write", { path: path.join(finance, "next.md"), content: "three" });
			assert(next.failed && next.text.includes("in a folder this room can only read") && !fs.existsSync(path.join(finance, "next.md")), `the next answer's write: ${next.text}`);
		} finally {
			answer.end();
			await tools.end();
		}
	});

	await boxRow("a change given this time reaches the answer's commands, and ends with it", async () => {
		saveAlsoAllowedFolders(room, [{ path: finance, access: "read" }]);
		let answer = new AnswerFolders();
		const tools = roomTools(room, sales, "conversation-a", { answer: () => answer });
		const figures = path.join(finance, "figures.md");
		try {
			assert((await tools.bash(`echo before >> ${quoted(figures)}`)).failed, "a command changed a Can read folder");
			answer.give(finance, "write");
			assert(!(await tools.bash(`echo during >> ${quoted(figures)}`)).failed, "the command after the pick this time");
			answer.end();
			await tools.end();
			answer = new AnswerFolders();
			assert((await tools.bash(`echo after >> ${quoted(figures)}`)).failed, "the next answer's command changed the folder");
			const read = await tools.bash(`cat ${quoted(figures)}`);
			assert(!read.failed && read.text.includes("during"), `the folder can still be read: ${read.text}`);
		} finally {
			answer.end();
			await tools.end();
		}
	});

	await row("a change given this time over a listed folder is this answer's own: removing the entry in Room settings leaves it until the answer ends, and putting the entry back brings back reading only", async () => {
		saveAlsoAllowedFolders(room, [{ path: finance, access: "read" }]);
		let answer = new AnswerFolders();
		const tools = roomTools(room, sales, "conversation-a", { answer: () => answer });
		try {
			answer.give(finance, "write");
			assert(!(await tools.file("write", { path: path.join(finance, "removed.md"), content: "x" })).failed, "the write before the cross");
			assert((await api("POST", room, "/remove", { path: finance })).status === 200, "the cross");
			assert(!(await tools.file("write", { path: path.join(finance, "removed-2.md"), content: "x" })).failed, "the answer lost its own pick with the list's entry");
			answer.end();
			answer = new AnswerFolders();
			assert((await tools.file("read", { path: path.join(finance, "figures.md") })).failed, "the next answer still opened the folder");
			assert((await api("POST", room, "/restore", { path: finance })).status === 200 && same(listOf(room).folders, [{ path: finance, access: "read" }]), `Undo: ${JSON.stringify(listOf(room).folders)}`);
			const back = await tools.file("write", { path: path.join(finance, "removed-3.md"), content: "x" });
			assert(back.failed && back.text.includes("in a folder this room can only read"), `the change came back with the folder: ${back.text}`);
			assert(!(await tools.file("read", { path: path.join(finance, "figures.md") })).failed, "the folder put back can be read");
		} finally {
			answer.end();
			await tools.end();
		}
	});

	await row("a folder given this time and swapped for a link mid-answer drops out at the next call", async () => {
		saveAlsoAllowedFolders(room, []);
		const swapped = made("Swapped");
		plant(swapped, "notes.md", "notes\n");
		const elsewhere = made("Elsewhere");
		plant(elsewhere, "notes.md", "elsewhere\n");
		const answer = new AnswerFolders();
		const tools = roomTools(room, sales, "conversation-a", { answer: () => answer });
		try {
			answer.give(swapped, "read");
			assert(!(await tools.file("read", { path: path.join(swapped, "notes.md") })).failed, "the read before the swap");
			fs.renameSync(swapped, `${swapped}-moved`);
			fs.symlinkSync(elsewhere, swapped);
			const after = await tools.file("read", { path: path.join(swapped, "notes.md") });
			assert(after.failed && !after.text.includes("elsewhere"), `the read through the link: ${after.text}`);
			if (roomBoxAvailable()) assert((await tools.bash(`cat ${quoted(path.join(elsewhere, "notes.md"))}`)).failed, "a command read where the link leads");
		} finally {
			answer.end();
			await tools.end();
		}
	});
}

await main();
await pageRows();
console.log(`room also-allowed smoke: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
	for (const name of failures) console.log(`  failed: ${name}`);
	process.exit(1);
}
process.exit(0);

/**
 * The pane in the page, against a real server: the rows and their words, each
 * change saving on its click, Undo, a failed save, the window's answers (the
 * page sends no path), what waits while the room answers, and a phone.
 */
async function pageRows(): Promise<void> {
	const { chromium } = await import("playwright");
	const browserPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!browserPath || !fs.existsSync(browserPath)) {
		console.log("room also-allowed smoke skipped the pane's rows (Chromium not installed)");
		return;
	}
	const http = await import("node:http");
	const { freePort, SMOKE_AUTH_TOKEN, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } = await import("./smoke-server-process.js");
	const { closeBrowser } = await import("./smoke-close-context.js");
	const { waitEvery } = await import("./smoke-wait.js");
	const waitUntil = waitEvery(100, 15_000);

	// The room's model: it answers at once, or, while `holding` is set, starts and holds its answer.
	let holding = false;
	const held: Array<() => void> = [];
	const gateway = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const base = { id: "cmpl", object: "chat.completion.chunk", created: 0, model: "room-model" };
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Working on it." }, finish_reason: null }] })}\n\n`);
			const finish = () => {
				res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
				res.end();
			};
			if (holding) held.push(finish);
			else finish();
		});
	});
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const agentDir = path.join(home, ".exxperts", "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${(gateway.address() as any).port}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }));
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-also-allowed-key" } }), { mode: 0o600 });

	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const output: string[] = [];
	const server = childProcess.spawn("npx", ["tsx", "src/index.ts"], { shell: process.platform === "win32", ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: path.resolve(import.meta.dirname, ".."), env: smokeHomeEnv(home, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir }) as NodeJS.ProcessEnv });
	server.stdout?.on("data", (chunk) => output.push(String(chunk)));
	server.stderr?.on("data", (chunk) => output.push(String(chunk)));
	const browser = await chromium.launch();
	try {
		await waitUntil(() => fetch(`${baseUrl}/healthz`).then((answer) => answer.ok).catch(() => false), "the server is ready");
		const listFile = (roomId: string) => path.join(policyStore.persistentAgentRootPath(roomId), "runtime", "also-allowed.json");
		const desk = roomWith("Pane Desk", sales);
		const emptyDesk = roomWith("Empty List Desk", sales);
		// Rooms with no folder: one whose web reader was given a site for the room, one with a folder alone on its list.
		const bareDesk = await roomWithoutFolder("Bare Site Desk", reports);
		const bareReader = webReaderOf(bareDesk);
		assert(await bareReader.open("https://docs.python.org/3/", "room"), "Bare Site Desk's yes for the room");
		const bareEmpty = await roomWithoutFolder("Bare Empty Desk", finance);
		const clearDesk = roomWith("Clear Undo Desk", sales);
		const setList = (roomId: string, folders: { path: string; access: "read" | "write" }[], sites: { host: string; port: number }[] = []) => writeRoomJson(listFile(roomId), { folders, sites });

		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await context.newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		// On a phone, Escape goes back to the list of panes first, then closes.
		const closeSettings = async (on: typeof page) => {
			const dialog = on.locator(".settings-dialog").first();
			for (let presses = 0; presses < 3 && (await on.locator(".settings-dialog").count()) > 0; presses += 1) {
				await on.keyboard.press("Escape");
				await dialog.waitFor({ state: "detached", timeout: 2_000 }).catch(() => undefined);
			}
			await dialog.waitFor({ state: "detached", timeout: 10_000 });
		};
		const openList = async (on: typeof page, roomName: string) => {
			// A row that failed may have left the dialog open: each row starts from Home.
			if (await on.locator(".settings-dialog").count()) await closeSettings(on);
			const card = on.locator(".persistent-agent-card").filter({ hasText: roomName });
			await card.waitFor({ timeout: 10_000 });
			await card.locator(".card-gear-btn").click();
			await on.locator(".settings-dialog-nav-item").filter({ hasText: /^Folder/ }).first().click();
			const list = on.locator(".room-settings-section:not([hidden]) section.also-allowed");
			await list.waitFor({ timeout: 10_000 });
			return list;
		};
		/** The list's live line: what a screen reader hears after a change. */
		const heardIn = (list: Awaited<ReturnType<typeof openList>>) => list.locator(":scope > .sr-only[role=status]");
		const rowOf = (list: Awaited<ReturnType<typeof openList>>, name: string) => list.locator(".also-allowed-row").filter({ has: page.locator(".also-allowed-name", { hasText: new RegExp(`^${name}`) }) });
		// How far a row's icon and its cross sit from the row's middle, in pixels: the names set the row's height.
		// No named helper inside: the page has no __name, which tsx adds to one.
		const offCentre = (each: ReturnType<typeof rowOf>) => each.evaluate((rowEl) => [".also-allowed-icon", ".also-allowed-cross"].map((spot) => {
			const [box, outer] = [rowEl.querySelector(spot)!.getBoundingClientRect(), rowEl.getBoundingClientRect()];
			return Math.round(Math.abs(box.top + box.height / 2 - (outer.top + outer.height / 2)));
		}));

		await row("the pane: an empty list shows its heading, its line and Add a folder", async () => {
			const list = await openList(page, "Empty List Desk");
			const text = await list.innerText();
			assert(text.includes(cards.ALSO_ALLOWED) && text.includes(cards.ALSO_ALLOWED_LINE) && await list.getByRole("button", { name: cards.ADD_A_FOLDER }).isEnabled(), `the empty list: ${text}`);
			assert(await list.locator(".also-allowed-row").count() === 0, "rows in an empty list");
			await closeSettings(page);
		});

		await row("the pane: each row says its access, with its one button and the cross; a site says Site; the icon and the cross sit centred in the row", async () => {
			setList(desk, [{ path: reports, access: "write" }, { path: finance, access: "read" }], [{ host: "pypi.org", port: 443 }]);
			const list = await openList(page, "Pane Desk");
			const [reportsRow, financeRow, siteRow] = [rowOf(list, "Reports"), rowOf(list, "Finance"), rowOf(list, "pypi.org")];
			assert((await reportsRow.innerText()).includes(cards.CAN_READ_AND_CHANGE) && await reportsRow.getByRole("button", { name: cards.ONLY_ALLOW_READING }).count() === 1 && await reportsRow.getByRole("button", { name: cards.ALLOW_CHANGES }).count() === 0, `Reports: ${await reportsRow.innerText()}`);
			assert((await financeRow.innerText()).includes(cards.CAN_READ) && await financeRow.getByRole("button", { name: cards.ALLOW_CHANGES }).count() === 1, `Finance: ${await financeRow.innerText()}`);
			// A folder's row is its name with its access under it; its path shows only where the pointer rests on the name.
			for (const [each, name, access, folder] of [[reportsRow, "Reports", cards.CAN_READ_AND_CHANGE, reports], [financeRow, "Finance", cards.CAN_READ, finance]] as const) {
				const [label, under] = [await each.locator(".also-allowed-name").textContent(), await each.locator(".settings-row-sub").allTextContents()];
				assert(label === name && same(under, [access]) && !(await each.innerText()).includes(folder) && await each.locator(".also-allowed-name").getAttribute("title") === folder, `${name}: the name, ${access} under it and no path, got ${label} / ${JSON.stringify(under)} / ${await each.innerText()}`);
			}
			assert((await siteRow.innerText()).includes(cards.SITE), `the site: ${await siteRow.innerText()}`);
			for (const each of [reportsRow, financeRow, siteRow]) assert(await each.locator(".also-allowed-cross").getAttribute("title") === cards.REMOVE_FROM_LIST, "the cross's label");
			assert(await list.getByRole("button", { name: `${cards.REMOVE_FROM_LIST}: Finance` }).count() === 1, "a screen reader hears which row the cross takes off");
			for (const each of [reportsRow, financeRow, siteRow]) assert((await offCentre(each)).every((off) => off <= 1), `the icon and the cross centred in their row: ${await each.innerText()}: ${JSON.stringify(await offCentre(each))}`);
			await closeSettings(page);
		});

		await row("the pane: Allow changes and Only allow reading save at once; a screen reader hears Saved, and no row shows it", async () => {
			setList(desk, [{ path: finance, access: "read" }]);
			const list = await openList(page, "Pane Desk");
			await rowOf(list, "Finance").getByRole("button", { name: cards.ALLOW_CHANGES }).click();
			await rowOf(list, "Finance").getByText(cards.CAN_READ_AND_CHANGE).waitFor({ timeout: 10_000 });
			await waitUntil(async () => (await heardIn(list).textContent()) === cards.SAVED, "a screen reader hears Saved");
			assert(!(await rowOf(list, "Finance").innerText()).includes(cards.SAVED) && listOf(desk).folders[0].access === "write", "Allow changes saved, and the row shows no Saved");
			await rowOf(list, "Finance").getByRole("button", { name: cards.ONLY_ALLOW_READING }).click();
			await rowOf(list, "Finance").getByRole("button", { name: cards.ALLOW_CHANGES }).waitFor({ timeout: 10_000 });
			assert(listOf(desk).folders[0].access === "read", "Only allow reading saved");
			await closeSettings(page);
		});

		await row("the pane: the cross leaves its line with Undo, and Undo puts the row back as it was; a site and a narrower row get their own lines", async () => {
			setList(desk, [{ path: finance, access: "read" }, { path: finance2025, access: "write" }], [{ host: "pypi.org", port: 443 }]);
			const list = await openList(page, "Pane Desk");
			await rowOf(list, "2025").locator(".also-allowed-cross").click();
			await list.locator(".also-allowed-removed").getByText(cards.folderStillReadLine("2025", "Finance"), { exact: true }).waitFor({ timeout: 10_000 });
			await list.getByRole("button", { name: cards.UNDO }).click();
			await rowOf(list, "2025").getByText(cards.CAN_READ_AND_CHANGE).waitFor({ timeout: 10_000 });
			await rowOf(list, "Finance").locator(".also-allowed-cross").click();
			await list.locator(".also-allowed-removed").getByText(cards.folderRemovedLine("Finance"), { exact: true }).waitFor({ timeout: 10_000 });
			assert(await page.evaluate(() => document.activeElement?.textContent) === cards.UNDO, "the keyboard goes on from Undo");
			// The line takes the name's column, as a row's words do, not a word to a line.
			const lineWidth = await list.locator(".also-allowed-removed").getByText(cards.folderRemovedLine("Finance"), { exact: true }).evaluate((el) => el.getBoundingClientRect().width);
			assert(lineWidth > 300, `the line is ${lineWidth}px wide`);
			assert(!listOf(desk).folders.some((each) => each.path === finance), "the cross saved at once");
			await list.getByRole("button", { name: cards.UNDO }).click();
			await rowOf(list, "Finance").waitFor({ timeout: 10_000 });
			assert(same(listOf(desk).folders.find((each) => each.path === finance), { path: finance, access: "read" }), "Undo put Finance back as it was");
			await rowOf(list, "pypi.org").locator(".also-allowed-cross").click();
			await list.locator(".also-allowed-removed").getByText(cards.siteRemovedLine("pypi.org"), { exact: true }).waitFor({ timeout: 10_000 });
			await closeSettings(page);
		});

		await row("the pane: the line in a removed row's place, and its Undo, start at the row's left edge, where its icon stood, at desktop and phone width", async () => {
			for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
				setList(desk, [{ path: finance, access: "read" }], [{ host: "pypi.org", port: 443 }]);
				const narrow = viewport.width === 1280 ? null : await browser.newContext({ viewport });
				const on = narrow ? await narrow.newPage() : page;
				try {
					if (narrow) {
						await on.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
						await on.waitForLoadState("networkidle");
						const close = on.locator(".whats-new-close");
						if (await close.count()) await close.click();
					}
					const list = await openList(on, "Pane Desk");
					const rowIn = (name: string) => list.locator(".also-allowed-row").filter({ has: on.locator(".also-allowed-name", { hasText: new RegExp(`^${name}`) }) });
					const iconLeft = await rowIn("pypi.org").locator(".also-allowed-icon").evaluate((el) => el.getBoundingClientRect().left);
					await rowIn("Finance").locator(".also-allowed-cross").click();
					const removed = list.locator(".also-allowed-removed");
					await removed.getByText(cards.folderRemovedLine("Finance"), { exact: true }).waitFor({ timeout: 10_000 });
					const lefts = await removed.evaluate((rowEl) => ({ row: rowEl.getBoundingClientRect().left, line: rowEl.querySelector(".settings-row-sub")!.getBoundingClientRect().left, undo: rowEl.querySelector(".rs-btn")!.getBoundingClientRect().left }));
					const at = `${viewport.width} px`;
					assert(Math.abs(lefts.line - lefts.row) <= 1 && Math.abs(lefts.line - iconLeft) <= 1, `${at}: the line starts at the row's left edge, where the icon stood (${JSON.stringify({ ...lefts, iconLeft })})`);
					// Narrow, Undo goes under the line, from the same edge; wide, it keeps the row's right end.
					if (viewport.width < 760) assert(Math.abs(lefts.undo - lefts.row) <= 1, `${at}: Undo, under the line, starts at the same edge (${JSON.stringify(lefts)})`);
					await list.getByRole("button", { name: cards.UNDO }).click();
					await rowIn("Finance").waitFor({ timeout: 10_000 });
					await closeSettings(on);
				} finally {
					await narrow?.close();
				}
			}
		});

		/** A request the page sends for this room's list, from the moment this is called. */
		const listRequest = (on: typeof page, roomId: string, tail: string) => on.waitForRequest((request) => request.method() === (tail ? "POST" : "GET") && new URL(request.url()).pathname === `/api/persistent-agents/${roomId}/also-allowed${tail}`, { timeout: 10_000 });
		// Two frames after an answer the page has drawn what it brought.
		const drawn = (on: typeof page) => on.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const openFolderPane = async (on: typeof page, roomName: string) => {
			if (await on.locator(".settings-dialog").count()) await closeSettings(on);
			const card = on.locator(".persistent-agent-card").filter({ hasText: roomName });
			await card.waitFor({ timeout: 10_000 });
			await card.locator(".card-gear-btn").click();
			await on.locator(".settings-dialog-nav-item").filter({ hasText: /^Folder/ }).first().click();
			return on.locator(".room-settings-section:not([hidden])");
		};

		await row("the pane in a room with no folder: its site's row says Site, with the cross; no folder row, no line about folders, no Add a folder; the icon and the cross centred in the row; the list is read once, after the room's folder", async () => {
			const reads: string[] = [];
			const count = (request: { method(): string; url(): string }) => {
				const at = new URL(request.url()).pathname;
				if (request.method() === "GET" && at.startsWith(`/api/persistent-agents/${bareDesk}/`)) reads.push(at.slice(at.lastIndexOf("/") + 1));
			};
			page.on("request", count);
			const list = await openList(page, "Bare Site Desk");
			const site = rowOf(list, "docs.python.org");
			await site.waitFor({ timeout: 10_000 });
			await drawn(page);
			page.off("request", count);
			const order = reads.filter((each) => each === "workspace-default" || each === "also-allowed");
			assert(same(order, ["workspace-default", "also-allowed"]), `the pane's reads: ${JSON.stringify(reads)}`);
			assert((await site.innerText()).includes(cards.SITE) && await site.locator(".also-allowed-cross").getAttribute("title") === cards.REMOVE_FROM_LIST, `the site: ${await site.innerText()}`);
			assert((await offCentre(site)).every((off) => off <= 1), `the icon and the cross centred in the site's row: ${JSON.stringify(await offCentre(site))}`);
			const text = await list.innerText();
			assert(text.includes(cards.ALSO_ALLOWED) && !text.includes(cards.ALSO_ALLOWED_LINE) && !text.includes("Reports") && await list.locator(".also-allowed-row").count() === 1, `the list: ${text}`);
			assert(await list.getByRole("button", { name: cards.ADD_A_FOLDER }).count() === 0, "Add a folder in a room with no folder");
			await closeSettings(page);
		});

		await row("the pane in a room with no folder: the cross saves through the remove route, with its line and Undo, and the reader asks again; Undo saves through the restore route and the keyboard goes on from the row's cross", async () => {
			const list = await openList(page, "Bare Site Desk");
			const removeSent = listRequest(page, bareDesk, "/remove");
			await rowOf(list, "docs.python.org").locator(".also-allowed-cross").click();
			await removeSent;
			const removed = list.locator(".also-allowed-removed");
			await removed.getByText(cards.siteRemovedLine("docs.python.org"), { exact: true }).waitFor({ timeout: 10_000 });
			assert(await page.evaluate(() => document.activeElement?.textContent) === cards.UNDO && listOf(bareDesk).sites.length === 0, "the cross saved, and the keyboard is on Undo");
			const asked = bareReader.asked();
			assert(!(await bareReader.open("https://docs.python.org/3/library/", "decline")) && bareReader.asked() === asked + 1, "the reader didn't ask after the cross");
			const restoreSent = listRequest(page, bareDesk, "/restore");
			await removed.getByRole("button", { name: cards.UNDO }).click();
			await restoreSent;
			const cross = rowOf(list, "docs.python.org").locator(".also-allowed-cross");
			await page.waitForFunction(() => document.activeElement?.classList.contains("also-allowed-cross"), undefined, { timeout: 10_000 });
			assert(await cross.evaluate((el) => el === document.activeElement) && same(listOf(bareDesk).sites, [{ host: "docs.python.org", port: 443 }]), "Undo put the site back, with the keyboard on its cross");
			assert(await bareReader.open("https://docs.python.org/3/library/", "decline") && bareReader.asked() === asked + 1, "the reader asked after Undo");
			await closeSettings(page);
		});

		await row("the pane in a room with no folder and no site is as before: no list, even with a folder on it", async () => {
			const read = listRequest(page, bareEmpty, "");
			const pane = await openFolderPane(page, "Bare Empty Desk");
			await (await read).response();
			await drawn(page);
			const text = await pane.innerText();
			assert(text.includes(cards.NO_FOLDER_YET_LINE) && await pane.locator("section.also-allowed").count() === 0 && !text.includes(cards.ALSO_ALLOWED) && !text.includes("Finance"), `the pane: ${text}`);
			await closeSettings(page);
		});

		await row("the pane: a failed save leaves the row as it was, with the line under it", async () => {
			setList(desk, [{ path: finance, access: "read" }]);
			const list = await openList(page, "Pane Desk");
			await page.route("**/also-allowed/remove", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal Server Error" }) }));
			await rowOf(list, "Finance").locator(".also-allowed-cross").click();
			await rowOf(list, "Finance").getByText(cards.CHANGE_SAVE_FAILED, { exact: true }).waitFor({ timeout: 10_000 });
			assert((await rowOf(list, "Finance").innerText()).includes(cards.CAN_READ), "the row stays as it was");
			await page.unroute("**/also-allowed/remove");
			await closeSettings(page);
		});

		await row("the pane: a failed Undo keeps the line and its Undo, with the failure under it; Undo again works", async () => {
			setList(desk, [{ path: finance, access: "read" }]);
			const list = await openList(page, "Pane Desk");
			await rowOf(list, "Finance").locator(".also-allowed-cross").click();
			const removed = list.locator(".also-allowed-removed");
			await removed.getByText(cards.folderRemovedLine("Finance"), { exact: true }).waitFor({ timeout: 10_000 });
			await page.route("**/also-allowed/restore", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal Server Error" }) }));
			await removed.getByRole("button", { name: cards.UNDO }).click();
			await removed.getByText(cards.CHANGE_SAVE_FAILED, { exact: true }).waitFor({ timeout: 10_000 });
			assert(await removed.getByText(cards.folderRemovedLine("Finance"), { exact: true }).count() === 1 && await removed.getByRole("button", { name: cards.UNDO }).isEnabled(), `after the failed Undo: ${await list.innerText()}`);
			await page.unroute("**/also-allowed/restore");
			await removed.getByRole("button", { name: cards.UNDO }).click();
			await rowOf(list, "Finance").waitFor({ timeout: 10_000 });
			assert(listOf(desk).folders.some((each) => each.path === finance), "Undo again put Finance back");
			await closeSettings(page);
		});

		await row("the pane: a change that saved but whose answer was lost shows what was saved, with no failure line", async () => {
			setList(desk, [{ path: finance, access: "read" }]);
			const list = await openList(page, "Pane Desk");
			// The server saves; the answer never reaches the page.
			await page.route("**/also-allowed/access", async (route) => {
				await route.fetch();
				await route.abort();
			});
			await rowOf(list, "Finance").getByRole("button", { name: cards.ALLOW_CHANGES }).click();
			await rowOf(list, "Finance").getByRole("button", { name: cards.ONLY_ALLOW_READING }).waitFor({ timeout: 10_000 });
			assert(listOf(desk).folders[0].access === "write" && (await rowOf(list, "Finance").innerText()).includes(cards.CAN_READ_AND_CHANGE) && await list.getByText(cards.CHANGE_SAVE_FAILED).count() === 0, `after the lost answer: ${await list.innerText()}`);
			await page.unroute("**/also-allowed/access");
			await closeSettings(page);
		});

		await row("the pane: a cross that saved but whose answer was lost still shows its line and Undo", async () => {
			setList(desk, [{ path: finance, access: "read" }]);
			const list = await openList(page, "Pane Desk");
			let lost = 0;
			await page.route("**/also-allowed/remove", async (route) => {
				if (lost > 0) return route.continue();
				lost += 1;
				await route.fetch();
				await route.abort();
			});
			await rowOf(list, "Finance").locator(".also-allowed-cross").click();
			await list.locator(".also-allowed-removed").getByText(cards.folderRemovedLine("Finance"), { exact: true }).waitFor({ timeout: 10_000 });
			assert(lost === 1 && await list.getByRole("button", { name: cards.UNDO }).isEnabled() && !listOf(desk).folders.some((each) => each.path === finance), `after the lost answer: ${await list.innerText()}`);
			await page.unroute("**/also-allowed/remove");
			await closeSettings(page);
		});

		await row("the pane: an Undo that saved but whose answer was lost shows the row back, saved", async () => {
			setList(desk, [{ path: finance, access: "read" }]);
			const list = await openList(page, "Pane Desk");
			await rowOf(list, "Finance").locator(".also-allowed-cross").click();
			const removed = list.locator(".also-allowed-removed");
			await removed.getByRole("button", { name: cards.UNDO }).waitFor({ timeout: 10_000 });
			await page.route("**/also-allowed/restore", async (route) => {
				await route.fetch();
				await route.abort();
			});
			await removed.getByRole("button", { name: cards.UNDO }).click();
			await rowOf(list, "Finance").waitFor({ timeout: 10_000 });
			await waitUntil(async () => (await heardIn(list).textContent()) === cards.SAVED, "the Undo is heard as saved");
			assert(await removed.count() === 0 && await list.getByText(cards.CHANGE_SAVE_FAILED).count() === 0 && listOf(desk).folders.some((each) => each.path === finance), `after the lost Undo: ${await list.innerText()}`);
			await page.unroute("**/also-allowed/restore");
			await closeSettings(page);
		});

		await row("the pane: a folder added whose answer was lost shows its new row, saved", async () => {
			setList(desk, []);
			const list = await openList(page, "Pane Desk");
			// The window's pick lands on the list, and the answer never reaches the page.
			await page.route("**/also-allowed/folders", async (route) => {
				setList(desk, [{ path: reports, access: "read" }]);
				await route.abort();
			});
			await list.getByRole("button", { name: cards.ADD_A_FOLDER }).click();
			await rowOf(list, "Reports").waitFor({ timeout: 10_000 });
			await waitUntil(async () => (await heardIn(list).textContent()) === cards.SAVED, "the add is heard as saved");
			assert(await list.getByText(cards.CHANGE_SAVE_FAILED).count() === 0, `after the lost add: ${await list.innerText()}`);
			await page.unroute("**/also-allowed/folders");
			await closeSettings(page);
		});

		await row("the pane: a change whose answer and list are both lost says it couldn't load the list, never the old row", async () => {
			setList(desk, [{ path: finance, access: "read" }]);
			const list = await openList(page, "Pane Desk");
			const lose = async (route: any) => {
				await route.fetch().catch(() => undefined);
				await route.abort();
			};
			await page.route("**/also-allowed/access", lose);
			await page.route("**/also-allowed", lose);
			await rowOf(list, "Finance").getByRole("button", { name: cards.ALLOW_CHANGES }).click();
			const pane = page.locator(".room-settings-section:not([hidden]) section.also-allowed");
			await pane.getByText(cards.ALSO_ALLOWED_LOAD_FAILED, { exact: true }).waitFor({ timeout: 10_000 });
			assert(listOf(desk).folders[0].access === "write" && !(await pane.innerText()).includes("Finance"), `after both were lost: ${await pane.innerText()}`);
			await page.unroute("**/also-allowed");
			await page.unroute("**/also-allowed/access");
			await pane.getByRole("button", { name: "Try again" }).click();
			await rowOf(pane, "Finance").getByText(cards.CAN_READ_AND_CHANGE).waitFor({ timeout: 10_000 });
			await closeSettings(page);
		});

		await row("the pane: a change refused because the room began answering says to change it when the room finishes, with no Save to press", async () => {
			setList(desk, [{ path: finance, access: "read" }]);
			const list = await openList(page, "Pane Desk");
			await page.route("**/also-allowed/access", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "active_turn_in_flight", error: "The room is answering right now. Save again when it has finished; nothing was changed." }) }));
			await rowOf(list, "Finance").getByRole("button", { name: cards.ALLOW_CHANGES }).click();
			await rowOf(list, "Finance").getByText("Change this when the room finishes answering.", { exact: true }).waitFor({ timeout: 10_000 });
			assert(!(await list.innerText()).includes("Save again"), `the line: ${await list.innerText()}`);
			await page.unroute("**/also-allowed/access");
			await closeSettings(page);
		});

		await row("the pane: Add a folder sends no path, and a refused pick shows its line", async () => {
			setList(desk, []);
			const list = await openList(page, "Pane Desk");
			let sent = "";
			const refusedLine = cards.folderHoldsRoomLine("Documents");
			await page.route("**/also-allowed/folders", (route) => {
				sent = `${route.request().postData() ?? ""} ${route.request().headers()["x-exxperts-local-action"] ?? "no mark"}`;
				return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "refused", line: refusedLine, list: { folders: [], sites: [] } }) });
			});
			await list.getByRole("button", { name: cards.ADD_A_FOLDER }).click();
			await list.getByText(refusedLine, { exact: true }).waitFor({ timeout: 10_000 });
			assert(sent === "{} choose-folder", `the page sent: ${sent}`);
			await page.unroute("**/also-allowed/folders");
			await closeSettings(page);
		});

		await row("the pane while the room answers: Add a folder, Allow changes and Undo wait with the reason; the cross and Only allow reading work", async () => {
			setList(desk, [{ path: finance, access: "read" }, { path: reports, access: "write" }]);
			const card = page.locator(".persistent-agent-card").filter({ hasText: "Pane Desk" });
			await card.getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			const composer = page.locator("textarea").first();
			await composer.waitFor({ timeout: 15_000 });
			holding = true;
			await composer.fill("Take your time.");
			await page.locator('button.send-btn[title="Send"]').click();
			await waitUntil(() => held.length > 0, "the room is answering");
			await page.locator(".stop-btn").first().waitFor({ timeout: 10_000 });
			await page.getByRole("button", { name: "Room settings" }).first().click();
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Folder$/ }).first().click();
			const list = page.locator(".room-settings-section:not([hidden]) section.also-allowed");
			await list.waitFor({ timeout: 10_000 });
			const add = list.getByRole("button", { name: cards.ADD_A_FOLDER });
			const allow = rowOf(list, "Finance").getByRole("button", { name: cards.ALLOW_CHANGES });
			await waitUntil(async () => await add.isDisabled(), "Add a folder waits");
			assert(await allow.isDisabled(), "Allow changes waits");
			for (const button of [add, allow]) {
				const reason = await button.evaluate((el) => el.ownerDocument.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? null);
				assert(reason === "Change this when the room finishes answering.", `the reason a screen reader hears: ${reason}`);
			}
			await rowOf(list, "Reports").getByRole("button", { name: cards.ONLY_ALLOW_READING }).click();
			await rowOf(list, "Reports").getByRole("button", { name: cards.ALLOW_CHANGES }).waitFor({ timeout: 10_000 });
			assert(listOf(desk).folders.find((each) => each.path === reports)?.access === "read", "Only allow reading saved while the room answered");
			await rowOf(list, "Finance").locator(".also-allowed-cross").click();
			const undo = list.getByRole("button", { name: cards.UNDO });
			await undo.waitFor({ timeout: 10_000 });
			assert(await undo.isDisabled() && !listOf(desk).folders.some((each) => each.path === finance), "the cross worked, and Undo waits");
			holding = false;
			for (const finish of held.splice(0)) finish();
			await waitUntil(async () => await undo.isEnabled(), "Undo works once the answer ends");
			await undo.click();
			await rowOf(list, "Finance").waitFor({ timeout: 10_000 });
			await closeSettings(page);
			await page.evaluate(() => { window.location.hash = "#/"; });
		});

		await row("the pane in a room with no folder while it answers: no wait line over a cross that works; once the cross is used, Undo waits with the reason", async () => {
			const card = page.locator(".persistent-agent-card").filter({ hasText: "Bare Site Desk" });
			await card.getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			const composer = page.locator("textarea").first();
			await composer.waitFor({ timeout: 15_000 });
			holding = true;
			await composer.fill("Take your time.");
			await page.locator('button.send-btn[title="Send"]').click();
			await waitUntil(() => held.length > 0, "the room is answering");
			await page.locator(".stop-btn").first().waitFor({ timeout: 10_000 });
			await page.getByRole("button", { name: "Room settings" }).first().click();
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Folder/ }).first().click();
			const list = page.locator(".room-settings-section:not([hidden]) section.also-allowed");
			const cross = rowOf(list, "docs.python.org").locator(".also-allowed-cross");
			await cross.waitFor({ timeout: 10_000 });
			assert(await cross.isEnabled() && !(await list.innerText()).includes("Change this when the room finishes answering."), `before the cross: ${await list.innerText()}`);
			await cross.click();
			const undo = list.getByRole("button", { name: cards.UNDO });
			await undo.waitFor({ timeout: 10_000 });
			const reason = await undo.evaluate((el) => el.ownerDocument.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? null);
			assert(await undo.isDisabled() && reason === "Change this when the room finishes answering." && listOf(bareDesk).sites.length === 0, `after the cross: ${reason}`);
			holding = false;
			for (const finish of held.splice(0)) finish();
			await waitUntil(async () => await undo.isEnabled(), "Undo works once the answer ends");
			await undo.click();
			await rowOf(list, "docs.python.org").waitFor({ timeout: 10_000 });
			await closeSettings(page);
			await page.evaluate(() => { window.location.hash = "#/"; });
		});

		await row("the pane: Stop using with a folder's Undo showing starts the list afresh, with the site's row and no folder line", async () => {
			setList(clearDesk, [{ path: finance, access: "read" }], [{ host: "pypi.org", port: 443 }]);
			const list = await openList(page, "Clear Undo Desk");
			await rowOf(list, "Finance").locator(".also-allowed-cross").click();
			await list.locator(".also-allowed-removed").getByText(cards.folderRemovedLine("Finance"), { exact: true }).waitFor({ timeout: 10_000 });
			const pane = page.locator(".room-settings-section:not([hidden])");
			await pane.getByRole("button", { name: cards.STOP_USING_FOLDER }).click();
			await page.getByRole("alertdialog").getByRole("button", { name: cards.STOP_USING, exact: true }).click();
			await pane.getByText(cards.NO_FOLDER_YET_LINE).waitFor({ timeout: 10_000 });
			await rowOf(list, "pypi.org").waitFor({ timeout: 10_000 });
			const text = await list.innerText();
			assert(!text.includes(cards.folderRemovedLine("Finance")) && await list.getByRole("button", { name: cards.UNDO }).count() === 0 && await list.locator(".also-allowed-row").count() === 1, `after Clear: ${text}`);
			await closeSettings(page);
		});

		await row("the pane in a room with no folder whose list can't be read says so, with Try again; a read that works shows the site's row", async () => {
			await page.route("**/also-allowed", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal Server Error" }) }));
			try {
				const list = await openList(page, "Bare Site Desk");
				await list.getByText(cards.ALSO_ALLOWED_LOAD_FAILED, { exact: true }).waitFor({ timeout: 10_000 });
				assert(!(await list.innerText()).includes("docs.python.org"), `the failed read: ${await list.innerText()}`);
			} finally {
				await page.unroute("**/also-allowed");
			}
			const list = page.locator(".room-settings-section:not([hidden]) section.also-allowed");
			await list.getByRole("button", { name: "Try again" }).click();
			await rowOf(list, "docs.python.org").waitFor({ timeout: 10_000 });
			await closeSettings(page);
		});

		await row("the pane on a phone: names without paths, the pane's one computer-only line, no buttons; an empty list says so", async () => {
			setList(desk, [{ path: finance, access: "read" }], [{ host: "pypi.org", port: 443 }]);
			setList(emptyDesk, []);
			const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
			const phonePage = await phone.newPage();
			await phonePage.route("**/api/remote/client-context", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ remote: true, capability: "full", sharedServer: false }) }));
			// A phone is sent names alone: the server's own answer is held by a row above.
			await phonePage.route("**/also-allowed", async (route) => {
				const answer = await route.fetch();
				const body = await answer.json();
				await route.fulfill({ response: answer, json: { ...body, folders: body.folders.map(({ path: _path, ...rest }: any) => rest) } });
			});
			await phonePage.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await phonePage.waitForLoadState("networkidle");
			const close = phonePage.locator(".whats-new-close");
			if (await close.count()) await close.click();
			const list = await openList(phonePage, "Pane Desk");
			await list.getByText("Finance").waitFor({ timeout: 10_000 });
			const text = await list.innerText();
			assert(!text.includes(finance) && await list.getByRole("button").count() === 0, `the phone's list: ${text}`);
			assert(await phonePage.locator(".room-settings-section:not([hidden])").getByText(cards.CHANGEABLE_AT_COMPUTER, { exact: true }).count() === 1, "the pane says once where it can be changed");
			await closeSettings(phonePage);
			const empty = await openList(phonePage, "Empty List Desk");
			await empty.getByText(cards.NO_OTHER_FOLDERS_OR_SITES, { exact: true }).waitFor({ timeout: 10_000 });
			await phone.close();
		});

		/** The page as a phone (`remote`) or a shared server's member sees it, with its client context. */
		const pageAs = async (context: { remote: boolean; sharedServer: boolean; person?: { id: string; name: string; admin: boolean } }) => {
			const as = await browser.newContext({ viewport: { width: 390, height: 844 } });
			const on = await as.newPage();
			await on.route("**/api/remote/client-context", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ capability: "full", ...context }) }));
			await on.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await on.waitForLoadState("networkidle");
			const close = on.locator(".whats-new-close");
			if (await close.count()) await close.click();
			return { on, close: () => as.close() };
		};

		await row("the pane on a phone in a room with no folder: the site's row with no buttons under the pane's one computer-only line; with no site, no list and no list line", async () => {
			const phone = await pageAs({ remote: true, sharedServer: false });
			try {
				const list = await openList(phone.on, "Bare Site Desk");
				await list.getByText("docs.python.org").waitFor({ timeout: 10_000 });
				const text = await list.innerText();
				assert(text.includes(cards.SITE) && await list.getByRole("button").count() === 0, `the phone's list: ${text}`);
				assert(await phone.on.locator(".room-settings-section:not([hidden])").getByText(cards.CHANGEABLE_AT_COMPUTER, { exact: true }).count() === 1, "the pane says once where it can be changed");
				await closeSettings(phone.on);
				const read = listRequest(phone.on, bareEmpty, "");
				const pane = await openFolderPane(phone.on, "Bare Empty Desk");
				await (await read).response();
				await drawn(phone.on);
				const empty = await pane.innerText();
				assert(await pane.locator("section.also-allowed").count() === 0 && !empty.includes(cards.NO_OTHER_FOLDERS_OR_SITES) && await pane.getByText(cards.CHANGEABLE_AT_COMPUTER, { exact: true }).count() === 1, `the phone's pane with no site: ${empty}`);
			} finally {
				await phone.close();
			}
		});

		await row("the pane on a shared server in a room with no folder and a site: no list, and the page never asks for it", async () => {
			const member = await pageAs({ remote: false, sharedServer: true, person: { id: "member-1", name: "member", admin: false } });
			try {
				let asked = 0;
				member.on.on("request", (request) => { if (request.url().includes(`/api/persistent-agents/${bareDesk}/also-allowed`)) asked += 1; });
				const pane = await openFolderPane(member.on, "Bare Site Desk");
				await pane.getByText("On a shared server, rooms don't use a folder.").waitFor({ timeout: 10_000 });
				await drawn(member.on);
				assert(asked === 0 && await pane.locator("section.also-allowed").count() === 0 && !(await pane.innerText()).includes("docs.python.org"), `the shared server's pane: ${await pane.innerText()}`);
			} finally {
				await member.close();
			}
		});
		await context.close();
	} catch (error) {
		console.log(output.join("").slice(-3000));
		throw error;
	} finally {
		holding = false;
		for (const finish of held.splice(0)) finish();
		await closeBrowser(browser);
		gateway.closeAllConnections();
		gateway.close();
		await stopSmokeServer(server as any);
	}
}
