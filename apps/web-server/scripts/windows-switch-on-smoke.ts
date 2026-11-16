// The Windows box switched on, on any computer. In one process, acting as
// Windows through the test setter (room-box/box-available.ts): the computer's
// box from the check's answer, the wait for it, the check's three answers with
// the stand-in for Microsoft's kit (windows-box-stand-in.mjs) and the note that
// a PC passed, the folder a room's protection judges, the site decision with a
// stand-in questions object, with the stand-in's network through a real
// engine, the copies of the Mac's reasons, the fault that runs nothing, and a
// repository's HEAD left as a link. Then real servers acting as Windows
// (EXXPERTS_TEST_WINDOWS_BOX on, off, broken) and a plain one, each sent one
// command by a synthetic model: the check's line in the log, the pane's
// protection and Git line, the model's box line and command tool, and where
// the command went. Acting as Windows there is no box, so a command there is
// refused with the fault line, never run in Git Bash. Last, servers whose
// check at start is the stand-in's, held until this smoke answers it: what a
// bind, the one-time grant and the file tools' wait do while it runs.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire, register } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { authedFetch, type AuthedFetchInit, freePort, putRunWithoutAsking, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function row(name: string, body: () => Promise<void> | void): Promise<void> {
	try {
		await body();
		console.log(`ok: ${name}`);
	} catch (error) {
		console.error(`FAIL: ${name}\n${(error as Error).stack}`);
		process.exit(1);
	}
}

const show = (value: unknown) => JSON.stringify(value);
const settle = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- The stand-in for the kit, as the worker smoke runs it ------------------------------------------

const require = createRequire(import.meta.url);
const TSX = pathToFileURL(require.resolve("tsx/esm")).href;
const STAND_IN = pathToFileURL(path.join(import.meta.dirname, "windows-box-stand-in.mjs")).href;
const WORKER_FILE = path.join(import.meta.dirname, "../src/room-box/windows/box-worker-windows.ts");
let configs = 0;

/** A worker whose kit is the stand-in, answering by `settings`, its files in `folder`; `spawns` counts the commands it started. */
function standIn(settings: Record<string, string> = {}, folder = work) {
	configs += 1;
	const file = path.join(folder, `config-${configs}.json`);
	const log = path.join(folder, `log-${configs}.jsonl`);
	fs.writeFileSync(file, JSON.stringify({ ...settings, log }));
	const spawns = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((line) => line.includes("\"spawn\"")).length : 0);
	return { worker: { file: WORKER_FILE, execArgv: ["--import", TSX, "--import", `${STAND_IN}?config=${encodeURIComponent(file)}&register`] }, spawns };
}

const WINDOWS_11 = { platform: "win32", arch: "x64", release: "10.0.26200", product: "Windows 11 Pro" };
const MACHINE = {
	revision: 9711,
	profile: String.raw`C:\Users\Ana`,
	personal: [String.raw`C:\Users\Ana\Documents`],
	environment: { SystemRoot: String.raw`C:\Windows`, USERPROFILE: String.raw`C:\Users\Ana`, PATH: String.raw`C:\Windows\System32` },
	pathFolders: [String.raw`C:\Windows\System32`],
	programs: { folder: String.raw`C:\Users\Ana\AppData\Local\Programs`, names: [] },
};

// ---- Run as a server whose check at start is held --------------------------------------------------
// With WINDOWS_SWITCH_ON_HELD set, this file is a server's own start (section 10): start-check.ts's
// windowsStartAnswer, which index.ts and the engine both call, waits until the file that variable names
// says on, off or broken, then gives the real check's answer with the stand-in answering that way, on a PC
// that never passed it. With no answer within WINDOWS_SWITCH_ON_HELD_LIMIT_MS it is broken, as a check
// that never answers.
const held = process.env.WINDOWS_SWITCH_ON_HELD;
if (held) {
	const startCheck = pathToFileURL(path.join(import.meta.dirname, "../src/room-box/windows/start-check.ts")).href;
	const wrapper = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(startCheck)}; export function windowsStartAnswer() { return globalThis.windowsSwitchOnHeldCheck(); }`)}`;
	// Every import of start-check.ts but the wrapper's own gets the wrapper.
	register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) { const resolved = await next(specifier, context); if (resolved.url.split("?")[0] === ${JSON.stringify(startCheck)} && !String(context.parentURL).startsWith("data:")) return { url: ${JSON.stringify(wrapper)}, shortCircuit: true }; return resolved; }`)}`);
	const { runStartCheck: heldCheck, withinStartWait: heldWithin } = await import("../src/room-box/windows/start-check.js");
	const { BOX_ROOT_NAME: heldRoot } = await import("../src/room-box/windows/box-root.js");
	// @ts-expect-error: plain JavaScript, the stand-in's path helper.
	const { requestPath: heldPath } = await import("./windows-box-stand-in.mjs");
	const folder = path.dirname(held);
	const kinds: Record<string, Record<string, string>> = { on: {}, off: { probe: "appcontainer" }, broken: { crash: "check" } };
	let answer: ReturnType<typeof heldCheck> | null = null;
	(globalThis as { windowsSwitchOnHeldCheck?: () => ReturnType<typeof heldCheck> }).windowsSwitchOnHeldCheck = () => (answer ??= heldWithin(async () => {
		while (!fs.existsSync(held)) await settle(50);
		const kind = fs.readFileSync(held, "utf8").trim();
		return heldCheck({ system: WINDOWS_11, readMachine: async () => MACHINE, worker: standIn(kinds[kind], folder).worker, root: path.join(folder, heldRoot), requestPath: heldPath, passed: { before: () => false, note: () => {} } });
	}, Number(process.env.WINDOWS_SWITCH_ON_HELD_LIMIT_MS)));
	await import("../src/index.js");
	// The server runs until the smoke stops it; nothing below runs here.
	await new Promise<never>(() => {});
}

// Every room and note of the in-process rows lives in this temp home, set before the modules that read it load.
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "windows-switch-on-")));
process.env.EXXPERTS_STATE_HOME = path.join(work, "state");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(work, "state", ".exxperts", "app", "personalized-agents");
fs.mkdirSync(process.env.EXXETA_PERSISTENT_AGENTS_ROOT, { recursive: true });
const folderAt = (name: string) => {
	fs.mkdirSync(path.join(work, name), { recursive: true });
	return fs.realpathSync(path.join(work, name));
};

const { noteWindowsBoxState, roomBoxAvailable, roomBoxComputer, roomBoxSettled, setRoomBoxForTests, windowsBoxChecks, windowsBoxState } = await import("../src/room-box/box-available.js");
const { notePassed, passedBefore, runStartCheck, withinStartWait } = await import("../src/room-box/windows/start-check.js");
type StartAnswer = Awaited<ReturnType<typeof runStartCheck>>;
const { defaultFolderJudged, persistentRoomProtection, protectionJudgesFolder, protectionOf, writePersistentRoomProtection } = await import("../src/persistent-room-protection.js");
const { createPersistentRoomWorkspaceTools } = await import("../src/persistent-room-workspace-tools.js");
const { claimPersistentRoomBashAutoApproveDefaults, persistentRoomBashSettingsPath, readPersistentRoomBashSettingsIn } = await import("../src/persistent-room-bash-settings.js");
const { fileToolsWait, folderWait } = await import("../src/room-box/windows/folder-wait.js");
const { createPersistentRoomDefaultCapabilityPolicy, persistentAgentRootPath, readPersistentRoomDefaultCapabilityPolicy, writePersistentRoomDefaultCapabilityPolicy } = await import("../src/persistent-room-workspace-policy.js");
const { addAlsoAllowedSite, readAlsoAllowed } = await import("../src/room-box/also-allowed.js");
const { BoxFault } = await import("../src/room-box/box-process.js");
const { ASK_AGAIN_FROM_COMPUTER, BOX_FAULT_SENTENCE, PROTECTION_UNAVAILABLE_COMPUTER } = await import("../src/room-box/card-text.js");
const { roomFolderGrantable } = await import("../src/room-box/folder-offer.js");
const lines = await import("../src/room-box/windows/model-lines.js");
const { windowsSiteDecision } = await import("../src/room-box/windows/site-decision.js");
const { QuestionDeclined } = await import("../src/web-ui-context.js");
const { conversationFolder, WindowsRoomBox } = await import("../src/room-box/windows/windows-engine.js");
const { BOX_ROOT_NAME } = await import("../src/room-box/windows/box-root.js");
// @ts-expect-error: plain JavaScript, loaded as the kit in the worker and for its path helpers here.
const { requestPath } = await import("./windows-box-stand-in.mjs");

let notes = 0;

/** The check as the server runs it, with the stand-in and a note of its own, passed before or not. */
function check(settings: Record<string, string>, passed: boolean, system = WINDOWS_11): { answer: Promise<StartAnswer>; note: string } {
	notes += 1;
	const note = path.join(work, `notes-${notes}`, "windows-box-passed.json");
	if (passed) notePassed(note);
	const answer = runStartCheck({ system, readMachine: async () => MACHINE, worker: standIn(settings).worker, root: path.join(work, BOX_ROOT_NAME), requestPath, passed: { before: () => passedBefore(note), note: () => notePassed(note) } });
	return { answer, note };
}

// ---- 1. The computer's box ---------------------------------------------------------------------------

await row("the computer's box: Windows by its check (not known while it runs, on and broken box, off doesn't), the Mac always, Linux never", () => {
	const cases = [
		[{ platform: "win32", windows: null }, "unknown", false],
		[{ platform: "win32", windows: "on" }, "windows", true],
		[{ platform: "win32", windows: "broken" }, "windows", true],
		[{ platform: "win32", windows: "off" }, null, false],
		[{ platform: "darwin", windows: null }, "mac", true],
		[{ platform: "linux", windows: null }, null, false],
	] as const;
	for (const [acted, computer, available] of cases) {
		setRoomBoxForTests(acted);
		assert(roomBoxComputer() === computer && roomBoxAvailable() === available, `${show(acted)}: ${roomBoxComputer()} ${roomBoxAvailable()}`);
		assert(windowsBoxChecks() === (acted.platform === "win32"), `${show(acted)}: the check runs ${windowsBoxChecks()}`);
	}
	// The first answer holds: a later one changes nothing.
	setRoomBoxForTests({ platform: "win32", windows: null });
	noteWindowsBoxState("off");
	noteWindowsBoxState("on");
	assert(windowsBoxState() === "off", `a second answer was taken: ${windowsBoxState()}`);
});

await row("a bind and a new room wait for Windows' check: until its answer, or its limit; on a Mac never", async () => {
	setRoomBoxForTests({ platform: "win32", windows: null });
	let settled = false;
	const waiting = roomBoxSettled(10_000).then(() => { settled = true; });
	await settle(100);
	assert(!settled && persistentRoomProtection("any-room").state === "off", "the wait ended before the check answered, or the room read protected while it ran");
	assert(show(persistentRoomProtection("any-room")) === show({ state: "off", cause: "unknown" }), show(persistentRoomProtection("any-room")));
	noteWindowsBoxState("on");
	await waiting;
	assert(settled && roomBoxComputer() === "windows", "the wait didn't end at the check's answer");
	setRoomBoxForTests({ platform: "win32", windows: null });
	const started = Date.now();
	await roomBoxSettled(150);
	assert(Date.now() - started >= 140 && roomBoxComputer() === "unknown", "the wait didn't end at its limit");
	setRoomBoxForTests({ platform: "darwin", windows: null });
	const mac = Date.now();
	await roomBoxSettled(5_000);
	assert(Date.now() - mac < 100, "a Mac waited");
});

await row("the one-time grant: its rooms are picked and its mark written at start, while Windows' check runs; once the check answers it grants only those rooms, and never one deleted meanwhile", () => {
	const options = { persistentAgentsRoot: path.join(work, "grant-rooms") };
	for (const id of ["older-room", "newer-room", "deleted-room"]) fs.mkdirSync(path.join(options.persistentAgentsRoot, id), { recursive: true });
	setRoomBoxForTests({ platform: "win32", windows: null });
	const grant = claimPersistentRoomBashAutoApproveDefaults([{ id: "older-room", bashEnabled: true }, { id: "newer-room", bashEnabled: false }, { id: "deleted-room", bashEnabled: true }], options);
	assert(grant !== null && fs.existsSync(path.join(options.persistentAgentsRoot, ".bash-auto-approve-defaults-v1")), "the mark wasn't written at start, so a stop while the check runs would pick again later");
	// While the check runs, a request turns the second room's commands on; it has no settings file, as such a room has. The third room is deleted.
	fs.rmSync(path.join(options.persistentAgentsRoot, "deleted-room"), { recursive: true });
	noteWindowsBoxState("off");
	const granted = grant();
	assert(show(granted) === show({ migrated: ["older-room"], failed: [] }), show(granted));
	assert(!fs.existsSync(path.join(options.persistentAgentsRoot, "deleted-room")), "a room deleted while the check ran came back");
	assert(readPersistentRoomBashSettingsIn("older-room", persistentRoomProtection("older-room", options), options).autoApprove === true, "the older room's grant isn't in the state the check gave");
	assert(!fs.existsSync(persistentRoomBashSettingsPath("newer-room", options)), "a room turned on while the check ran was granted Run without asking");
	assert(claimPersistentRoomBashAutoApproveDefaults([{ id: "newer-room", bashEnabled: true }], options) === null, "the step ran again");
});

// ---- 2. The check's three answers -------------------------------------------------------------------

await row("the check: on notes that this PC passed; a lesser answer on a PC that never passed is off, on one that did broken", async () => {
	const ready = check({}, false);
	const on = await ready.answer;
	assert(on.state === "on" && passedBefore(ready.note), `on: ${show(on.state)}, noted ${passedBefore(ready.note)}`);
	for (const probe of ["appcontainer", "no-deny"]) {
		const never = await check({ probe }, false).answer;
		assert(never.state === "off" && /appcontainer-dacl|lacks/.test(never.reason), `${probe}, never passed: ${show(never)}`);
		const before = await check({ probe }, true).answer;
		assert(before.state === "broken" && before.reason === never.reason, `${probe}, passed before: ${show(before)}`);
	}
	// An answer that isn't a lesser box is broken, passed or not.
	for (const settings of [{ probe: "dacl" }, { probe: "error" }, { platform: "no-container" }, { version: "1.0.2" }, { crash: "check" }] as Record<string, string>[]) {
		const answer = await check(settings, false).answer;
		assert(answer.state === "broken", `${show(settings)}: ${show(answer)}`);
	}
	// Windows' own version line is off before the kit loads, passed or not.
	const old = await check({}, true, { ...WINDOWS_11, release: "10.0.19045" }).answer;
	assert(old.state === "off", show(old));
});

await row("the check: no answer within its wait is broken, a throw is broken, and a note that can't be read counts as passed", async () => {
	const late = await withinStartWait(() => new Promise<StartAnswer>(() => {}), 150);
	assert(late.state === "broken" && late.reason.includes("no answer"), show(late));
	const thrown = await withinStartWait(() => Promise.reject(new Error("the check threw")), 1_000);
	assert(thrown.state === "broken" && thrown.reason === "the check threw", show(thrown));
	const quick = await withinStartWait(async () => ({ state: "off", reason: "not Windows" }), 1_000);
	assert(quick.state === "off", show(quick));
	const blocked = path.join(work, "a-file");
	fs.writeFileSync(blocked, "");
	assert(passedBefore(path.join(blocked, "windows-box-passed.json")) === true, "a note that can't be read counts as never passed");
	assert(passedBefore(path.join(work, "no-note-here.json")) === false, "a missing note counts as passed");
});

// ---- 3. The folder a room's protection judges -------------------------------------------------------

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
function room(roomId: string, folder: string) {
	fs.mkdirSync(persistentAgentRootPath(roomId), { recursive: true });
	writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: roomId, repoRoot, root: folder, workspaceAccessMode: "localFiles", displayLabel: "Room Folder", source: "manual" }));
}
const roomFolder = folderAt("room");
room("switch-on-room", roomFolder);

await row("protection: a room whose default folder is local reads a conversation's folder on a share as the folder cause, a local one on, as the box gets it", () => {
	// The folder the bind and each command judge: the conversation's, through the fence by its real path.
	assert(conversationFolder("switch-on-room", "conversation-a") === roomFolder, `the conversation's folder: ${conversationFolder("switch-on-room", "conversation-a")}`);
	// Judged on the stand-in computer side, as room-protection-smoke.ts judges protectionOf.
	const judged = (folder: string | null, computer: boolean | "unknown" = true) => show(protectionOf({ computer, windows: true, folder, turnedOff: false }));
	assert(judged(String.raw`\\server\share\project`) === show({ state: "off", cause: "folder" }), "a conversation on a share");
	assert(judged(String.raw`\\?\UNC\server\share\project`) === show({ state: "off", cause: "folder" }), "a mapped drive the fence resolves to a share");
	assert(judged(String.raw`C:\Users\Ana\Projects\local`) === show({ state: "on" }), "a local conversation");
	assert(judged(String.raw`\\server\share\project`, false) === show({ state: "off", cause: "computer" }), "the computer's cause stands first");
	// The bind works out its folder only where protection judges one, Windows alone, and the judge reads the folder it is handed there alone.
	for (const acted of [{ platform: "win32", windows: "on" }, { platform: "darwin", windows: null }] as const) {
		setRoomBoxForTests(acted);
		const judges = process.platform === "win32" && acted.platform === "win32";
		assert(protectionJudgesFolder() === judges, `${acted.platform}: protection judges the folder ${protectionJudgesFolder()}`);
		const share = show(persistentRoomProtection("switch-on-room", { folder: String.raw`\\server\share\project` }));
		assert(share === show(judges ? { state: "off", cause: "folder" } : { state: "on" }), `${acted.platform}: a conversation on a share handed in reads ${share}`);
	}
	setRoomBoxForTests({ platform: "win32", windows: "on" });
	assert(show(persistentRoomProtection("switch-on-room")) === show({ state: "on" }), show(persistentRoomProtection("switch-on-room")));
});

await row("protection: a room whose default folder is typed as a mapped drive reads the folder cause when the drive resolves to a share", () => {
	// Stored as typed and as the fence resolves it (persistent-room-workspace-policy.ts): a mapped drive's real path is its share.
	const judged = (root: { path: string; realpath?: string }) => show(protectionOf({ computer: true, windows: true, folder: defaultFolderJudged(root), turnedOff: false }));
	assert(judged({ path: String.raw`Z:\proj`, realpath: String.raw`\\srv\share\proj` }) === show({ state: "off", cause: "folder" }), "a mapped drive's folder read on");
	assert(judged({ path: String.raw`\\srv\share\proj`, realpath: String.raw`\\srv\share\proj` }) === show({ state: "off", cause: "folder" }), "a share's folder read on");
	assert(judged({ path: String.raw`C:\Users\Ana\proj`, realpath: String.raw`C:\Users\Ana\proj` }) === show({ state: "on" }), "a local folder read off");
	assert(judged({ path: String.raw`C:\Users\Ana\proj` }) === show({ state: "on" }), "a local folder with no real path stored read off");
});

await row("the file tools' wait: on a Windows PC whose box can run, every room's file tools wait for boxed commands on their folders, its protection off too; a Mac and a shared server's never", async () => {
	// In the home: the computer's shared temp is refused whatever it holds.
	const homeRoom = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), "windows-switch-on-wait-")));
	room("switch-on-off-room", homeRoom);
	writePersistentRoomProtection("switch-on-off-room", "off");
	const policy = readPersistentRoomDefaultCapabilityPolicy("switch-on-off-room")!;
	fs.writeFileSync(path.join(homeRoom, "wait-note.txt"), "WAIT-NOTE\n");
	for (const windows of ["on", "broken"] as const) {
		setRoomBoxForTests({ platform: "win32", windows });
		assert(fileToolsWait() === folderWait, `${windows}: no wait`);
		// Another room's boxed command holds the folder: the read of a room turned off waits for it.
		const hold = await new Promise<{ release: () => void }>((resolve) => { void folderWait.hold("command", [homeRoom], undefined, async () => new Promise<void>((release) => resolve({ release }))); });
		let done = false;
		const read = (createPersistentRoomWorkspaceTools(policy, { folderWait: fileToolsWait() }) as unknown as { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[]).find((tool) => tool.name === "read")!.execute("waits", { path: "wait-note.txt" }).finally(() => { done = true; });
		await settle(50);
		assert(!done, `${windows}: the read of a room turned off ran while another room's command held its folder`);
		hold.release();
		assert(show(await read).includes("WAIT-NOTE"), `${windows}: the read after the release`);
	}
	setRoomBoxForTests({ platform: "win32", windows: "off" });
	assert(fileToolsWait() === undefined, "off: a computer with no box waits");
	setRoomBoxForTests({ platform: "darwin", windows: null });
	assert(fileToolsWait() === undefined, "a Mac's file tools run in its box");
	setRoomBoxForTests({ platform: "win32", windows: "on" });
	fs.rmSync(homeRoom, { recursive: true, force: true });
});

// ---- 4. Sites -------------------------------------------------------------------------------------------

type Card = { host: string; port: number; lasting: boolean; open: boolean; answer: (choice: "once" | "room" | "decline", by?: "computer" | "phone") => void; fail: () => void; message: () => void };

/** A questions object as the room's would be: who watches, and each card's answer when the smoke gives it. */
function questions(watcher: "computer" | "phone" | "none" = "computer") {
	const cards: Card[] = [];
	const closed: string[] = [];
	const state = { watcher };
	return {
		state, cards, closed,
		questions: {
			watcher: () => state.watcher,
			// A yes is applied as the bridge applies it, before the answer comes back; a card its caller closed takes no answer, as on the bridge.
			askSite: (card: { host: string; port: number; lasting: boolean }, apply: (choice: "once" | "room", answeredBy: "computer" | "phone") => unknown, signal?: AbortSignal) => new Promise<{ choice: "once" | "room" | "decline"; answeredBy: "computer" | "phone" | "none" }>((resolve, reject) => {
				const end = (then: () => void) => {
					if (!entry.open) return;
					entry.open = false;
					then();
				};
				const entry: Card = { ...card, open: true, answer: (choice, by = "computer") => end(() => {
					if (choice !== "decline") apply(choice, by);
					resolve({ choice, answeredBy: by });
				}), fail: () => end(() => reject(new Error("gone"))), message: () => end(() => reject(new QuestionDeclined("the person sent a message"))) };
				signal?.addEventListener("abort", () => end(() => reject(new Error("closed"))), { once: true });
				cards.push(entry);
			}),
			closeSiteCards: (sentence: string) => closed.push(sentence),
		},
	};
}

await row("sites: the room's list, then one card per site with its three answers; only the computer's for this room adds to the list, a phone's yes lasts for the turn", async () => {
	addAlsoAllowedSite("switch-on-room", "listed.example", 443);
	const q = questions();
	const sites = windowsSiteDecision({ roomId: "switch-on-room", questions: q.questions });
	assert(show(await sites.ask({ host: "listed.example", port: 443 })) === show({ allow: true }) && q.cards.length === 0, "a listed site asked");
	// Once: this turn only, one card even when asked twice at once.
	const first = sites.ask({ host: "once.example", port: 443 });
	const again = sites.ask({ host: "once.example", port: 443 });
	await settle();
	assert((q.cards.length as number) === 1 && q.cards[0].lasting === true, show(q.cards));
	q.cards[0].answer("once");
	assert(show(await first) === show({ allow: true }) && show(await again) === show({ allow: true }), "Allow this time didn't allow");
	assert(show(await sites.ask({ host: "once.example", port: 443 })) === show({ allow: true }) && (q.cards.length as number) === 1, "a yes this time asked again in its turn");
	// For this room, at the computer: on the list.
	const room = sites.ask({ host: "room.example", port: 8443 });
	await settle();
	q.cards[1].answer("room");
	assert(show(await room) === show({ allow: true }) && readAlsoAllowed("switch-on-room").sites.some((site) => site.host === "room.example" && site.port === 8443), "Allow for this room didn't reach the list");
	// Declined.
	const no = sites.ask({ host: "no.example", port: 443 });
	await settle();
	q.cards[2].answer("decline");
	assert(show(await no) === show({ allow: false, reason: lines.WINDOWS_SITE_DECLINED }), show(await no));
	// A phone's for this room lasts for this turn alone, and its card says so.
	q.state.watcher = "phone";
	const phone = sites.ask({ host: "phone.example", port: 443 });
	await settle();
	assert(q.cards[3].lasting === false, "a phone's card offered to keep it");
	q.cards[3].answer("room", "phone");
	assert(show(await phone) === show({ allow: true }) && !readAlsoAllowed("switch-on-room").sites.some((site) => site.host === "phone.example"), "a phone's yes reached the list");
	sites.endTurn();
	q.state.watcher = "computer";
	for (const host of ["once.example", "phone.example"]) {
		const next = sites.ask({ host, port: 443 });
		await settle();
		assert(q.cards.at(-1)?.host === host, `the next turn didn't ask for ${host} again`);
		q.cards.at(-1)?.answer("decline");
		await next;
	}
	sites.endTurn();
});

await row("sites: nobody there, past the cap of cards in a turn, a person who goes, and the turn's end refuse, and the turn's end closes its cards", async () => {
	const nobody = questions("none");
	const alone = windowsSiteDecision({ roomId: "switch-on-room", questions: nobody.questions });
	assert(show(await alone.ask({ host: "a.example", port: 443 })) === show({ allow: false, reason: lines.WINDOWS_SITE_NOBODY_THERE }) && nobody.cards.length === 0, "nobody there: asked, or not refused");
	const q = questions();
	const sites = windowsSiteDecision({ roomId: "switch-on-room", questions: q.questions });
	const asked = Array.from({ length: 8 }, (_, index) => sites.ask({ host: `cap-${index}.example`, port: 443 }));
	await settle();
	assert(show(await sites.ask({ host: "ninth.example", port: 443 })) === show({ allow: false, reason: lines.WINDOWS_SITE_TOO_MANY }) && q.cards.length === 8, `the cap: ${q.cards.length} cards`);
	q.cards[0].fail();
	assert(show(await asked[0]) === show({ allow: false, reason: lines.WINDOWS_SITE_STOPPED }), show(await asked[0]));
	sites.endTurn();
	assert(show(q.closed) === show([lines.WINDOWS_SITE_TURN_ENDED]), `the turn's end closed: ${show(q.closed)}`);
	q.cards[1].answer("once");
	q.cards[2].fail();
	assert(show(await asked[1]) === show({ allow: false, reason: lines.WINDOWS_SITE_TURN_ENDED }) && show(await asked[2]) === show({ allow: false, reason: lines.WINDOWS_SITE_TURN_ENDED }), "an answer after the turn's end allowed, or said something else");
	for (const card of q.cards.slice(3)) card.answer("decline");
	await Promise.all(asked);
	// A turn that asked nothing closes nothing.
	sites.endTurn();
	assert(show(q.closed) === show([lines.WINDOWS_SITE_TURN_ENDED]), `a turn with no card closed cards: ${show(q.closed)}`);
	// Each refusal is one line, once, however often the proxy reports it.
	const end = sites.startCommand();
	sites.refused({ host: "twice.example", port: 443 }, "the person declined this site");
	sites.refused({ host: "twice.example", port: 443 }, "the person declined this site");
	assert(show(end(false)) === show(["The room's protection refused twice.example: the person declined this site."]) && end(false).length === 0, "a refusal shows twice, or again after it was taken");
});

const DECLINED = { allow: false, reason: lines.WINDOWS_SITE_DECLINED };
const UNANSWERED = { allow: false, reason: lines.WINDOWS_SITE_UNANSWERED };
const CERTIFICATE = { allow: false, reason: lines.WINDOWS_CERTIFICATE_CHECK };
const ALLOWED = { allow: true };
const signal = () => new AbortController().signal;

await row("sites: Not now, or a message sent while the card waits, refuses that site, its www name and its other web port without a card while any command runs; once none runs, the next command asks again", async () => {
	const q = questions();
	const sites = windowsSiteDecision({ roomId: "switch-on-room", questions: q.questions });
	for (const [how, host] of [["Not now", "no-d.example"], ["a message", "message-d.example"]] as const) {
		const endFirst = sites.startCommand();
		const endSecond = sites.startCommand();
		const asked = sites.ask({ host, port: 443 }, { signal: signal() });
		await settle();
		const card = q.cards.at(-1)!;
		if (how === "Not now") card.answer("decline");
		else card.message();
		assert(show(await asked) === show(DECLINED), `${how}: ${show(await asked)}`);
		const cards = q.cards.length;
		const again = async () => {
			const cards = q.cards.length;
			for (const site of [{ host, port: 443 }, { host: `www.${host}`, port: 443 }, { host, port: 80 }]) assert(show(await sites.ask(site, { signal: signal() })) === show(DECLINED), `${how}: ${show(site)} was not refused`);
			assert(q.cards.length === cards, `${how}: a card for a site the person had declined`);
		};
		await again();
		// Another site still asks.
		const other = sites.ask({ host: `other-${host}`, port: 443 }, { signal: signal() });
		await settle();
		assert(q.cards.length === cards + 1 && q.cards.at(-1)!.host === `other-${host}`, `${how}: another site didn't ask`);
		q.cards.at(-1)!.answer("once");
		assert(show(await other) === show(ALLOWED), `${how}: the other site`);
		// One of the two commands ends: the no still holds.
		endFirst(false);
		await again();
		endSecond(false);
		const endNext = sites.startCommand();
		const next = sites.ask({ host: `www.${host}`, port: 443 }, { signal: signal() });
		await settle();
		assert(q.cards.length === cards + 2 && q.cards.at(-1)!.host === `www.${host}`, `${how}: the next command didn't ask again`);
		q.cards.at(-1)!.answer("once");
		assert(show(await next) === show(ALLOWED), `${how}: the next command's yes`);
		endNext(false);
	}
	sites.endTurn();
});

await row("sites: a card closes, as not answered, when the last connection waiting for it has gone, and no other card does; its line follows once, and the proxy's report of it adds none", async () => {
	const q = questions();
	const sites = windowsSiteDecision({ roomId: "switch-on-room", questions: q.questions });
	const end = sites.startCommand();
	const [first, second, other] = [new AbortController(), new AbortController(), new AbortController()];
	const asks = [sites.ask({ host: "gone.example", port: 80 }, { signal: first.signal }), sites.ask({ host: "gone.example", port: 80 }, { signal: second.signal }), sites.ask({ host: "stays.example", port: 443 }, { signal: other.signal })];
	await settle();
	assert(q.cards.length === 2, `one card per site: ${q.cards.length}`);
	first.abort();
	assert(show(await asks[0]) === show(UNANSWERED) && q.cards[0].open, "the card closed while a connection still waited for it");
	second.abort();
	assert(show(await asks[1]) === show(UNANSWERED) && !q.cards[0].open && q.cards[1].open, `the last connection's going closed the wrong cards: ${show(q.cards.map((card) => card.open))}`);
	// The proxy reports each refusal it gave: these add no line of their own.
	sites.refused({ host: "gone.example", port: 80 }, lines.WINDOWS_SITE_UNANSWERED);
	sites.refused({ host: "gone.example", port: 80 }, lines.WINDOWS_SITE_UNANSWERED);
	q.cards[1].answer("once");
	assert(show(await asks[2]) === show(ALLOWED), "the other site's card");
	assert(show(end(true)) === show([lines.windowsSiteRefusedLine("gone.example", lines.WINDOWS_SITE_UNANSWERED)]) && q.closed.length === 0, `the line, or a card closed through the bridge: ${show(q.closed)}`);
	// A connection gone before it was asked raises no card.
	const late = new AbortController();
	late.abort();
	const endLate = sites.startCommand();
	assert(show(await sites.ask({ host: "late.example", port: 80 }, { signal: late.signal })) === show(UNANSWERED) && q.cards.length === 2, "a card for a connection already gone");
	assert(endLate(false).length === 0, "a line for a connection already gone");
	sites.endTurn();
});

await row("sites: a command's end closes the open cards only when no other command runs: with two side by side, the first's end leaves the card and its wait, the second's closes it, one line per site", async () => {
	const q = questions();
	const sites = windowsSiteDecision({ roomId: "switch-on-room", questions: q.questions });
	const endFirst = sites.startCommand();
	const endSecond = sites.startCommand();
	// One with a signal, one from a caller that can't say it has gone: both close at the end.
	const waiting = sites.ask({ host: "both.example", port: 443 }, { signal: signal() });
	const held = sites.ask({ host: "held.example", port: 443 });
	let settled = false;
	void Promise.all([waiting, held]).then(() => { settled = true; });
	await settle();
	assert(show(endFirst(true)) === show([]) && q.cards.every((card) => card.open), "the first command's end closed a card the other still waits on");
	await settle();
	assert(!settled, "a wait ended with the first command");
	const said = endSecond(false);
	await settle();
	assert(settled, "the last command's end left a wait open");
	assert(show(await waiting) === show(UNANSWERED) && show(await held) === show(UNANSWERED) && q.cards.every((card) => !card.open), "the last command's end left a card open");
	assert(show(said) === show(["both.example", "held.example"].map((host) => lines.windowsSiteRefusedLine(host, lines.WINDOWS_SITE_UNANSWERED))) && q.closed.length === 0, show({ said, closed: q.closed }));
	// A yes after the close gives nothing: the next command asks again.
	q.cards[0].answer("once");
	const endNext = sites.startCommand();
	const next = sites.ask({ host: "both.example", port: 443 }, { signal: signal() });
	await settle();
	assert(q.cards.length === 3, "a yes after the close reached the site");
	q.cards[2].answer("decline");
	await next;
	endNext(false);
	sites.endTurn();
});

await row("sites: a certificate check to a site not allowed is refused at once, with no card and none of the turn's 8; to a site this answer allowed or the room lists it is allowed; its line follows only a command that failed, once per site", async () => {
	const q = questions();
	const sites = windowsSiteDecision({ roomId: "switch-on-room", questions: q.questions });
	const end = sites.startCommand();
	for (const host of ["crl.example", "crl.example", "ocsp.example"]) assert(show(await sites.ask({ host, port: 80 }, { signal: signal(), certificateCheck: true })) === show(CERTIFICATE), `${host} wasn't refused at once`);
	assert(q.cards.length === 0, "a certificate check raised a card");
	// All 8 cards are still the turn's.
	const eight = Array.from({ length: 8 }, (_, index) => sites.ask({ host: `cap-${index}.certificate.example`, port: 443 }, { signal: signal() }));
	await settle();
	assert((q.cards.length as number) === 8, `the cap after the checks: ${q.cards.length}`);
	for (const card of q.cards) card.answer("decline");
	await Promise.all(eight);
	// Allowed ones pass: the room's list, and this answer's yes, its other web port included.
	addAlsoAllowedSite("switch-on-room", "listed-crl.example", 80);
	assert(show(await sites.ask({ host: "listed-crl.example", port: 80 }, { certificateCheck: true })) === show(ALLOWED), "a listed site's check was refused");
	assert(show(await sites.ask({ host: "cap-0.certificate.example", port: 80 }, { certificateCheck: true })) === show(CERTIFICATE), "a declined site's check went through");
	// A command that ended well: no line, and the proxy's own report of the refusal adds none.
	sites.refused({ host: "crl.example", port: 80 }, lines.WINDOWS_CERTIFICATE_CHECK);
	assert(show(end(false)) === show([]), "a line after a command that ended well");
	sites.endTurn();
	const fresh = windowsSiteDecision({ roomId: "switch-on-room", questions: q.questions });
	const endAsk = fresh.startCommand();
	assert(show(await fresh.ask({ host: "yes-crl.example", port: 80 }, { certificateCheck: true })) === show(CERTIFICATE), "a check to a site nobody allowed went through");
	const allowed = fresh.ask({ host: "yes-crl.example", port: 443 }, { signal: signal() });
	await settle();
	q.cards.at(-1)!.answer("once");
	assert(show(await allowed) === show(ALLOWED), "the yes");
	assert(show(await fresh.ask({ host: "yes-crl.example", port: 80 }, { certificateCheck: true })) === show(ALLOWED), "a check to a site this answer allowed was refused");
	endAsk(false);
	// Two side by side: the check comes in the second, the first ends well first, and the second, which failed, still says it.
	const endWell = fresh.startCommand();
	const endBeside = fresh.startCommand();
	await fresh.ask({ host: "beside-crl.example", port: 80 }, { certificateCheck: true });
	assert(show(endWell(false)) === show([]), "a line after the command that ended well");
	assert(show(endBeside(true)) === show([lines.windowsSiteRefusedLine("beside-crl.example", lines.WINDOWS_CERTIFICATE_CHECK)]), "the check's line was lost when the other command ended well");
	// A command that failed: one line per site, once.
	const endFailed = fresh.startCommand();
	for (const host of ["crl.example", "crl.example", "ocsp.example"]) await fresh.ask({ host, port: 80 }, { certificateCheck: true });
	assert(show(endFailed(true)) === show(["crl.example", "ocsp.example"].map((host) => lines.windowsSiteRefusedLine(host, lines.WINDOWS_CERTIFICATE_CHECK))), "the lines after a command that failed");
	fresh.endTurn();
});

await row("sites: each reason is the Mac's own, word for word, and so is the line it ends", () => {
	const mac = fs.readFileSync(path.join(import.meta.dirname, "../src/room-box/box-session.ts"), "utf8");
	for (const copy of [lines.WINDOWS_SITE_TURN_ENDED, lines.WINDOWS_SITE_TOO_MANY, lines.WINDOWS_SITE_DECLINED, lines.WINDOWS_SITE_STOPPED]) assert(mac.includes(show(copy)), `not the Mac's words: ${copy}`);
	assert(mac.includes("`nobody is here to allow this site; ${ASK_AGAIN_FROM_COMPUTER}`") && lines.WINDOWS_SITE_NOBODY_THERE === `nobody is here to allow this site; ${ASK_AGAIN_FROM_COMPUTER}`, "nobody there: not the Mac's words");
	assert(mac.includes("`The room's protection refused ${(declined ?? ask).host}: ${answer.reason}.`") && lines.windowsSiteRefusedLine("h.example", "why") === "The room's protection refused h.example: why.", "the refusal line: not the Mac's");
});

// ---- 5. Through a real engine, with the stand-in's network --------------------------------------------

const kit = standIn();
const ready = await runStartCheck({ system: WINDOWS_11, readMachine: async () => MACHINE, worker: kit.worker, root: path.join(work, BOX_ROOT_NAME), requestPath });
assert(ready.state === "on", show(ready));
const engine = (more: Record<string, unknown> = {}, start: Promise<StartAnswer> = Promise.resolve(ready)) =>
	new WindowsRoomBox({ roomId: "switch-on-room", conversationId: () => "c", rights: () => ({ canChangeFiles: true, skillFolders: [] }), warn: () => {}, folders: () => ({ folder: roomFolder, alsoAllowed: [] }), roomData: folderAt("room-data"), startAnswer: () => start, ...more });
async function exec(box: InstanceType<typeof WindowsRoomBox>, command: string, signal?: AbortSignal) {
	let output = "";
	try {
		const { exitCode } = await box.operations().exec(command, roomFolder, { onData: (chunk) => { output += chunk.toString("utf8"); }, signal });
		return { output, exitCode, error: null as Error | null };
	} catch (error) {
		return { output, exitCode: null, error: error as Error };
	}
}
const CURL = (url: string) => `& "$env:SystemRoot\\System32\\curl.exe" -sS '${url}'`;

await row("engine: a site a command asks for gets the room's decision, and each refusal follows its command once", async () => {
	const q = questions();
	const box = engine({ sites: windowsSiteDecision({ roomId: "switch-on-room", questions: q.questions }) });
	assert((await exec(box, "Write-Output warm")).exitCode === 0, "the first command");
	// Asked three times in one command, declined once: the no holds for that site, its www name included, until the command ends.
	let done = false;
	const running = exec(box, `${CURL("http://declined.example/")}\n${CURL("http://declined.example/")}\n${CURL("http://www.declined.example/")}`).finally(() => { done = true; });
	let answered = 0;
	while (!done) {
		if (q.cards.length > answered) q.cards[answered++].answer("decline");
		await settle(20);
	}
	const declined = await running;
	const line = lines.windowsSiteRefusedLine("declined.example", lines.WINDOWS_SITE_DECLINED);
	assert(answered === 1 && declined.output.split(line).length === 2, `asked again after a no, or the refusal shows other than once: ${show({ answered, declined })}`);
	assert(!declined.output.includes("refused www.declined.example"), `one site gave two lines: ${show(declined)}`);
	// The next command asks again.
	let nextDone = false;
	const nextRun = exec(box, `${CURL("http://declined.example/")}\nWrite-Output next`).finally(() => { nextDone = true; });
	while (!nextDone) {
		if (q.cards.length > answered) q.cards[answered++].answer("decline");
		await settle(20);
	}
	const next = await nextRun;
	assert(answered === 2 && next.output.split(line).length === 2, `the next command didn't ask again: ${show({ answered, next })}`);
	// Nobody there: refused without a card, said after the command.
	q.state.watcher = "none";
	const alone = await exec(box, CURL("http://alone.example/"));
	assert(alone.output.includes(lines.windowsSiteRefusedLine("alone.example", lines.WINDOWS_SITE_NOBODY_THERE)) && q.cards.length === 2, show(alone));
	await box.endTurn();
});

await row("engine: a site's card closes, as not answered, when the program waiting for it gives up, or when its command ends; its line follows the command once", async () => {
	const q = questions();
	const box = engine({ sites: windowsSiteDecision({ roomId: "switch-on-room", questions: q.questions }) });
	assert((await exec(box, "Write-Output warm")).exitCode === 0, "the first command");
	const line = (host: string) => lines.windowsSiteRefusedLine(host, lines.WINDOWS_SITE_UNANSWERED);
	// curl gives up after a second; the command goes on and ends well.
	const gaveUp = await exec(box, `& "$env:SystemRoot\\System32\\curl.exe" -sS --max-time 1 'http://slow.example/'\nWrite-Output after`);
	assert(q.cards.length === 1 && !q.cards[0].open, `the card stayed open after its program gave up: ${show(q.cards.map((card) => card.open))}`);
	assert(gaveUp.output.split(line("slow.example")).length === 2, show(gaveUp));
	// Stop ends the command while its card waits: the card closes with it.
	const stop = new AbortController();
	const stopped = exec(box, CURL("http://stopped.example/"), stop.signal);
	while (q.cards.length < 2) await settle(20);
	stop.abort();
	await stopped;
	assert(!q.cards[1].open && q.closed.length === 0, `the card stayed open after its command ended, or every card was closed: ${show({ open: q.cards[1].open, closed: q.closed })}`);
	// A yes after the close gives nothing: the next command asks again.
	q.cards[1].answer("once");
	const again = exec(box, CURL("http://stopped.example/"));
	while (q.cards.length < 3) await settle(20);
	q.cards[2].answer("decline");
	const said = await again;
	assert(!said.output.includes(line("slow.example")), `an old line followed a later command: ${show(said)}`);
	await box.endTurn();
});

await row("engine: two commands side by side: one that ends leaves the other's card open, and the other's end, here by Stop, closes it", async () => {
	const q = questions();
	const box = engine({ sites: windowsSiteDecision({ roomId: "switch-on-room", questions: q.questions }) });
	assert((await exec(box, "Write-Output warm")).exitCode === 0, "the first command");
	let waitingDone = false;
	const stop = new AbortController();
	const waiting = exec(box, CURL("http://overlap.example/"), stop.signal).finally(() => { waitingDone = true; });
	while (q.cards.length === 0) await settle(20);
	const quick = await exec(box, "Write-Output quick");
	await settle(100);
	assert(quick.exitCode === 0 && q.cards[0].open && !waitingDone, `the other command's end closed the card: ${show({ quick, open: q.cards[0].open })}`);
	stop.abort();
	await waiting;
	assert(!q.cards[0].open && q.closed.length === 0, `the last command's end left the card open: ${show({ open: q.cards[0].open, closed: q.closed })}`);
	await box.endTurn();
});

await row("engine: Windows' certificate check through the proxy is refused at once with no card, and said only after a command that failed; one to a listed site goes on", async () => {
	const q = questions();
	const box = engine({ sites: windowsSiteDecision({ roomId: "switch-on-room", questions: q.questions }) });
	assert((await exec(box, "Write-Output warm")).exitCode === 0, "the first command");
	const check = (host: string) => `& "$env:SystemRoot\\System32\\curl.exe" -sS -A 'Microsoft-CryptoAPI/10.0' 'http://${host}/'`;
	const line = lines.windowsSiteRefusedLine("crl.example", lines.WINDOWS_CERTIFICATE_CHECK);
	const well = await exec(box, `${check("crl.example")}\nWrite-Output fine`);
	assert(well.exitCode === 0 && well.output.includes(lines.WINDOWS_CERTIFICATE_CHECK) && !well.output.includes(line) && q.cards.length === 0, show(well));
	const failed = await exec(box, `${check("crl.example")}\n${check("crl.example")}\nexit 2`);
	assert(failed.output.split(line).length === 2 && q.cards.length === 0, show(failed));
	// Any other user agent asks, as before.
	let plainDone = false;
	const plain = exec(box, `& "$env:SystemRoot\\System32\\curl.exe" -sS -A 'curl/8.0' 'http://crl.example/'`).finally(() => { plainDone = true; });
	while (q.cards.length === 0 && !plainDone) await settle(20);
	assert((q.cards.length as number) === 1 && q.cards[0].host === "crl.example", "another user agent didn't ask");
	q.cards[0].answer("decline");
	await plain;
	// Listed: past the decision, on to the lookup, which can't find this name.
	addAlsoAllowedSite("switch-on-room", "listed-crl.invalid", 80);
	const listed = await exec(box, check("listed-crl.invalid"));
	assert(!listed.output.includes(lines.WINDOWS_CERTIFICATE_CHECK) && listed.output.includes("did not resolve"), show(listed));
	await box.endTurn();
});

await row("engine: with two commands side by side, a refusal shows once in the turn, by the Mac's rule: after the command of the run that ends next, here the other one, never twice and never lost", async () => {
	const q = questions();
	const decision = windowsSiteDecision({ roomId: "switch-on-room", questions: q.questions });
	// The proxy's report, seen as it reaches the decision: the other command starts only once the refusal is there to carry.
	let reported = () => {};
	const isReported = new Promise<void>((resolve) => { reported = resolve; });
	const box = engine({ sites: { ...decision, refused: (ask: Parameters<typeof decision.refused>[0], reason: string) => { decision.refused(ask, reason); reported(); } } });
	assert((await exec(box, "Write-Output warm")).exitCode === 0, "the first command");
	// The proxy reports refusals per run, with no command (box-session.ts:346-352 on a Mac), so the command that ends next carries it.
	const asking = exec(box, `${CURL("http://beside.example/")}\nStart-Sleep -Milliseconds 4000`);
	while (q.cards.length === 0) await settle(20);
	q.cards[0].answer("decline");
	await isReported;
	const beside = await exec(box, "Write-Output beside");
	const first = await asking;
	const line = lines.windowsSiteRefusedLine("beside.example", lines.WINDOWS_SITE_DECLINED);
	assert(beside.output.includes(line) && !first.output.includes(line), `the refusal didn't follow the command that ended next, once: ${show({ beside, first })}`);
	assert(q.cards.length === 1 && beside.output.split(line).length === 2, `the refusal shows other than once: ${show({ cards: q.cards.length, beside })}`);
	const next = await exec(box, "Write-Output next");
	assert(!next.output.includes(line), `the refusal followed a later command too: ${show(next)}`);
	await box.endTurn();
});

await row("engine: the turn's end closes a site's card a command waits on, and refuses the site", async () => {
	const q = questions();
	const box = engine({ sites: windowsSiteDecision({ roomId: "switch-on-room", questions: q.questions }) });
	assert((await exec(box, "Write-Output warm")).exitCode === 0, "the first command");
	const running = exec(box, CURL("http://late.example/"));
	while (q.cards.length === 0) await settle(20);
	await box.endTurn();
	assert(show(q.closed) === show([lines.WINDOWS_SITE_TURN_ENDED]), `the card stayed open: ${show(q.closed)}`);
	q.cards[0].answer("once");
	const ended = await running;
	assert(ended.error !== null || !ended.output.includes("200"), `the site was reached after the turn's end: ${show(ended)}`);
});

// ---- 6. A box that can't run runs nothing ---------------------------------------------------------------

// A proof that fails is the worker smoke's row "proof: a box that doesn't hold stops the first command with the fault line".
await row("faults: a broken check and a crash mid-command run nothing and end with the fault line, never another shell", async () => {
	const spawned = kit.spawns();
	const broken = await exec(engine({}, Promise.resolve({ state: "broken", reason: "the kit's probe failed" })), "Write-Output never");
	assert(broken.error instanceof BoxFault && broken.error.message === BOX_FAULT_SENTENCE && broken.output === "" && kit.spawns() === spawned, show({ error: String(broken.error), output: broken.output }));
	assert(!BOX_FAULT_SENTENCE.includes(PROTECTION_UNAVAILABLE_COMPUTER), "the fault line names the computer");
	const crashy = standIn({ crash: "run" });
	const crashAnswer = await runStartCheck({ system: WINDOWS_11, readMachine: async () => MACHINE, worker: crashy.worker, root: path.join(work, BOX_ROOT_NAME), requestPath });
	assert(crashAnswer.state === "on", show(crashAnswer));
	const crashed = await exec(engine({}, Promise.resolve(crashAnswer)), "Write-Output never");
	assert(crashed.error instanceof BoxFault && crashed.error.message === BOX_FAULT_SENTENCE, show({ error: String(crashed.error), output: crashed.output }));
});

// ---- 7. A repository's HEAD left as a link --------------------------------------------------------------

await row("folders: HEAD, objects or refs left as a link to a place the walk refuses count as there, unfollowed; a real bare repository is still refused, a plain folder isn't", () => {
	// In the home: the computer's shared temp is refused whatever it holds.
	const homeWork = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), "windows-switch-on-")));
	const folderAt = (name: string) => {
		fs.mkdirSync(path.join(homeWork, name));
		return path.join(homeWork, name);
	};
	const linked = folderAt("linked-head");
	fs.mkdirSync(path.join(linked, "objects"));
	fs.mkdirSync(path.join(linked, "refs"));
	fs.symlinkSync(process.platform === "win32" ? String.raw`\\127.0.0.1\x` : "/net/exx-switch-on-never", path.join(linked, "HEAD"));
	assert(roomFolderGrantable(linked) === false, "a folder whose HEAD links to a network place was given");
	const bare = folderAt("bare");
	for (const name of ["objects", "refs"]) fs.mkdirSync(path.join(bare, name));
	fs.writeFileSync(path.join(bare, "HEAD"), "ref: refs/heads/main\n");
	assert(roomFolderGrantable(bare) === false, "a bare repository was given");
	const local = folderAt("local-link");
	for (const name of ["objects", "refs"]) fs.mkdirSync(path.join(local, name));
	fs.writeFileSync(path.join(homeWork, "head-target"), "ref: refs/heads/main\n");
	fs.symlinkSync(path.join(homeWork, "head-target"), path.join(local, "HEAD"));
	assert(roomFolderGrantable(local) === false, "a HEAD linked to a local file no longer reads as a repository");
	// A room's own folder whose path the walk refuses, as a share is on Windows: its names are read where they are, and none there reads as none.
	assert(roomFolderGrantable(process.platform === "win32" ? String.raw`\\127.0.0.1\exx-switch-on-never\room` : "/net/exx-switch-on-never/room") === true, "a folder on a refused place with no HEAD, objects or refs read as a repository");
	const plain = folderAt("plain");
	fs.mkdirSync(path.join(plain, "objects"));
	assert(roomFolderGrantable(plain) === true, "a plain folder was refused");
	fs.rmSync(homeWork, { recursive: true, force: true });
});

setRoomBoxForTests(null);

// ---- 8. Servers acting as Windows ---------------------------------------------------------------------

const GIT_LINE = "On Windows, shell commands need Git for Windows. Install it from gitforwindows.org; the room can run commands as soon as it is installed. If it still says this, restart exxperts.";
const WINDOWS_BOX_WORDS = "Commands run in Windows PowerShell 5.1 inside this room's protection";
const MAC_BOX_WORDS = "Commands run inside this room's protection";
const webServerDir = path.resolve(import.meta.dirname, "..");
const programFiles = folderAt("program-files");

// The synthetic model: the first request of a turn runs one command, or a read where the prompt asks, and keeps what the model was given; the follow-up keeps the result.
// The hold's command writes, as its last step, the note the read opens.
type Seen = { asked: string; call: string; system: string; bash: string; result?: string };
const seen: Seen[] = [];
const COMMAND_PROMPT = "Run a command, please.";
const HOLD_PROMPT = "Hold the folder for a while, please.";
const READ_PROMPT = "Read the note, please.";
const textOf = (m: any) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content));
const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const gateway = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		const tools = messages.filter((m) => m?.role === "tool");
		const asked = messages.filter((m) => m?.role === "user").map(textOf).join("\n");
		res.writeHead(200, { "content-type": "text/event-stream" });
		const base = { id: `c${seen.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "room-model" };
		if (tools.length === 0) {
			// The room's standing lines ride in the system prompt and the turn's own context message alike.
			const system = messages.map(textOf).join("\n");
			const bash = String((parsed?.tools ?? []).find((tool: any) => tool?.function?.name === "bash")?.function?.description ?? "");
			const call = `call_${seen.length}`;
			seen.push({ asked, call, system, bash });
			const [name, args] = asked.includes(HOLD_PROMPT) ? ["bash", { command: "Start-Sleep -Milliseconds 4000\nSet-Content -LiteralPath wait-note.txt -Value WAIT-NOTE\nWrite-Output held" }] : asked.includes(READ_PROMPT) ? ["read", { path: "wait-note.txt" }] : ["bash", { command: "Write-Output switched-on" }];
			res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: call, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
		} else {
			// Two turns may run side by side: the result goes to the request that asked for it.
			const asking = seen.find((entry) => entry.call === tools.at(-1)?.tool_call_id);
			if (asking) asking.result = tools.map(textOf).join("\n");
			res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gatewayPort = (gateway.address() as AddressInfo).port;

type Server = { process: ChildProcessWithoutNullStreams; baseUrl: string; port: number; output: string[]; home: string };

/** A server on `label`'s home, started from `entry`: the server's own, or this file holding its check (section 10). */
async function startServer(label: string, env: Record<string, string>, entry = "src/index.ts"): Promise<Server> {
	const home = path.join(work, `server-${label}`);
	const agentDir = path.join(home, ".exxperts", "agent");
	const app = path.join(home, ".exxperts", "app");
	fs.mkdirSync(path.join(app, "personalized-agents"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-switch-on-key" } }), { mode: 0o600 });
	fs.writeFileSync(path.join(app, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }), { mode: 0o600 });
	fs.writeFileSync(path.join(app, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }), { mode: 0o600 });
	const port = await freePort();
	const baseEnv: Record<string, string | undefined> = { ...process.env };
	for (const name of ["ProgramFiles(x86)", "LOCALAPPDATA", "EXXPERTS_STATE_HOME", "EXXETA_PERSISTENT_AGENTS_ROOT", "EXXPERTS_TEST_INTROSPECTION", "EXXPERTS_TEST_SHELL_PLATFORM", "EXXPERTS_TEST_WINDOWS_BOX"]) delete baseEnv[name];
	const child = spawn(process.execPath, ["--import", TSX, entry], {
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...baseEnv, HOME: home, USERPROFILE: home, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: path.join(app, "personalized-agents"), ...env },
	});
	const output: string[] = [];
	child.stdout.on("data", (chunk) => output.push(String(chunk)));
	child.stderr.on("data", (chunk) => output.push(String(chunk)));
	const baseUrl = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 30_000;
	for (;;) {
		if (child.exitCode != null) throw new Error(`server ${label} exited at start: ${output.join("").slice(-2000)}`);
		try {
			if ((await fetch(`${baseUrl}/healthz`)).ok) break;
		} catch {}
		if (Date.now() > deadline) throw new Error(`server ${label} did not start`);
		await settle(150);
	}
	return { process: child, baseUrl, port, output, home };
}

async function requestJson(server: Server, pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${server.baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** A room in the server's one workspace folder, in Full access, its commands on or off. */
async function folderRoom(server: Server, name: string, bashEnabled: boolean): Promise<string> {
	const made = await requestJson(server, "/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(made.status === 201, `room: ${made.status} ${show(made.body)}`);
	const id = String(made.body.agent.id);
	const folder = path.join(server.home, "workspace");
	fs.mkdirSync(folder, { recursive: true });
	const put = await requestJson(server, `/api/persistent-agents/${encodeURIComponent(id)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: folder, displayLabel: "Workspace", workspaceAccessMode: "localFiles", bashEnabled }) });
	assert(put.status === 200, `folder: ${put.status} ${show(put.body)}`);
	return id;
}

async function bashRoom(server: Server, name: string): Promise<string> {
	const id = await folderRoom(server, name, true);
	assert((await putRunWithoutAsking(`${server.baseUrl}/api/persistent-agents/${encodeURIComponent(id)}/bash-settings`, true)).status === 200, "Run without asking");
	return id;
}

const WebSocketImpl: any = (await import("ws")).default;

/**
 * One turn that runs one command, or a read: what the chat showed of its result, and what the model was given.
 * `meanwhile` runs once the prompt is sent, given how many requests the model had before it.
 */
async function turn(server: Server, id: string, conversationId: string, options: { prompt?: string; meanwhile?: (before: number) => Promise<void> } = {}): Promise<{ text: string; seen: Seen }> {
	const seeded = await requestJson(server, `/api/persistent-agents/${encodeURIComponent(id)}/threads/${encodeURIComponent(conversationId)}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }) });
	assert(seeded.status === 200, `thread: ${seeded.status} ${show(seeded.body).slice(0, 300)}`);
	const socket = new WebSocketImpl(`ws://127.0.0.1:${server.port}/ws?persistentAgentId=${id}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("no websocket"))); });
	const before = seen.length;
	const prompt = options.prompt ?? COMMAND_PROMPT;
	// Its own request, found by its prompt: another turn may run beside it.
	const mine = () => seen.slice(before).find((entry) => entry.asked.includes(prompt));
	socket.send(JSON.stringify({ type: "prompt", text: prompt }));
	await options.meanwhile?.(before);
	const deadline = Date.now() + 40_000;
	while (Date.now() < deadline) {
		const asked = mine();
		if (asked?.result !== undefined && frames.some((frame) => frame?.type === "event" && frame?.event?.type === "agent_end")) {
			await waitForTurnSettled((pathname) => requestJson(server, pathname), id, `${conversationId}: settled`);
			try { socket.close(); } catch {}
			const result = frames.find((frame) => frame?.type === "event" && frame?.event?.type === "message_end" && frame?.event?.message?.role === "toolResult")?.event?.message;
			const text = (result?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
			return { text, seen: asked };
		}
		const errors = frames.filter((frame) => String(frame?.type ?? "").includes("error"));
		if (errors.length > 0) throw new Error(`turn: ${show(errors[0]).slice(0, 400)}`);
		await settle(100);
	}
	throw new Error(`the turn didn't end: ${frames.map((frame) => frame?.type).join(", ")}`);
}

const pane = async (server: Server, id: string) => (await requestJson(server, `/api/persistent-agents/${encodeURIComponent(id)}/workspace-default`)).body;
const startLine = (server: Server) => server.output.join("").split("\n").find((line) => line.includes("the Windows box's check at start")) ?? "";
const actingAsWindows = { EXXPERTS_TEST_INTROSPECTION: "1", EXXPERTS_TEST_SHELL_PLATFORM: "win32", ProgramFiles: programFiles };
const actingAs = (state: string) => ({ ...actingAsWindows, EXXPERTS_TEST_WINDOWS_BOX: state });

const servers: Server[] = [];
try {
	await row("server acting as Windows, check on: the log says on, the pane shows protection and no Git line, the model reads the Windows box line and PowerShell, and a command gets the fault line, never Git Bash", async () => {
		const server = await startServer("on", actingAs("on"));
		servers.push(server);
		const line = startLine(server);
		assert(line.includes("\"state\":\"on\"") && line.includes("acting as Windows, with no box"), `the log: ${line}`);
		const id = await bashRoom(server, "On Room");
		const before = await pane(server, id);
		assert(show(before.protection) === show({ state: "on" }) && before.shellMissingNote === null && before.commandsStartOn !== undefined, show(before));
		const ran = await turn(server, id, "conversation-on");
		assert(ran.text.includes(BOX_FAULT_SENTENCE) && !ran.text.includes(GIT_LINE) && !ran.text.includes("switched-on"), `the command: ${ran.text}`);
		assert(ran.seen.system.includes(WINDOWS_BOX_WORDS) && !ran.seen.system.includes(MAC_BOX_WORDS), "the model's box line");
		assert(ran.seen.bash.startsWith("Run a Windows PowerShell 5.1 command"), `the command tool: ${ran.seen.bash.slice(0, 80)}`);
		// Turned off: Git Bash as today, and the Git line where it's missing.
		const off = await requestJson(server, `/api/persistent-agents/${encodeURIComponent(id)}/protection`, { method: "PUT", body: JSON.stringify({ state: "off" }) });
		assert(off.status === 200 && show(off.body.protection) === show({ state: "off" }), show(off));
		const after = await pane(server, id);
		assert(after.shellMissingNote === GIT_LINE, `turned off: ${show(after.shellMissingNote)}`);
		// A yes given while protected holds only there: the person gives Run without asking again.
		assert((await putRunWithoutAsking(`${server.baseUrl}/api/persistent-agents/${encodeURIComponent(id)}/bash-settings`, true)).status === 200, "Run without asking, turned off");
		const unprotected = await turn(server, id, "conversation-off");
		assert(unprotected.text === GIT_LINE && !unprotected.seen.system.includes(WINDOWS_BOX_WORDS) && !unprotected.seen.system.includes(MAC_BOX_WORDS), `turned off: ${unprotected.text}`);
		assert(!unprotected.seen.bash.startsWith("Run a Windows PowerShell"), "turned off: still PowerShell");
	});

	await row("server acting as Windows, check broken: protected, no Git line, and a command gets the fault line", async () => {
		const server = await startServer("broken", actingAs("broken"));
		servers.push(server);
		assert(startLine(server).includes("\"state\":\"broken\""), `the log: ${startLine(server)}`);
		const id = await bashRoom(server, "Broken Room");
		const read = await pane(server, id);
		assert(show(read.protection) === show({ state: "on" }) && read.shellMissingNote === null, show(read));
		const ran = await turn(server, id, "conversation-broken");
		assert(ran.text.includes(BOX_FAULT_SENTENCE) && !ran.text.includes("switched-on"), `the command: ${ran.text}`);
	});

	await row("server acting as Windows, check off: this computer's cause, the Git line, Git Bash as today, and never a word of restarting", async () => {
		const server = await startServer("off", actingAs("off"));
		servers.push(server);
		assert(startLine(server).includes("\"state\":\"off\""), `the log: ${startLine(server)}`);
		const id = await bashRoom(server, "Off Room");
		const read = await pane(server, id);
		assert(show(read.protection) === show({ state: "off", cause: "computer" }) && read.shellMissingNote === GIT_LINE, show(read));
		const ran = await turn(server, id, "conversation-off");
		assert(ran.text === GIT_LINE && !ran.seen.system.includes(WINDOWS_BOX_WORDS) && !ran.seen.system.includes(MAC_BOX_WORDS), `the command: ${ran.text}`);
		assert(!/try restarting/i.test(`${show(read)}\n${ran.text}\n${ran.seen.system}`), "off reads Try restarting");
	});

	await row("a server that isn't acting as Windows runs no check", async () => {
		const server = await startServer("plain", {});
		servers.push(server);
		await bashRoom(server, "Plain Room");
		assert(startLine(server) === "", `the check ran: ${startLine(server)}`);
	});

	// ---- 10. Servers whose check at start is held ----------------------------------------------------------
	// Each home's rooms are made by a server acting as Windows, which then stops: they stand as an older app
	// left them, before the one-time grant (its mark and their Run without asking gone). The same home's next
	// server runs this file, whose check at start waits for the row's answer (section "Run as a server").
	const agentsOf = (server: Server) => path.join(server.home, ".exxperts", "app", "personalized-agents");
	const settingsOf = (server: Server, id: string) => persistentRoomBashSettingsPath(id, { persistentAgentsRoot: agentsOf(server) });
	async function olderRooms(label: string): Promise<{ older: string; later: string }> {
		const maker = await startServer(label, actingAs("on"));
		try {
			const rooms = { older: await folderRoom(maker, "Older Room", true), later: await folderRoom(maker, "Later Room", false) };
			await stopSmokeServer(maker.process);
			fs.rmSync(path.join(agentsOf(maker), ".bash-auto-approve-defaults-v1"), { force: true });
			for (const id of Object.values(rooms)) fs.rmSync(settingsOf(maker, id), { force: true });
			return rooms;
		} catch (error) {
			await stopSmokeServer(maker.process);
			throw error;
		}
	}
	/** The server on `label`'s home again, its check held until `answer(kind)`, or broken past `limitMs` with none. */
	async function heldServer(label: string, limitMs = 30_000) {
		const answerFile = path.join(work, `server-${label}`, "held-check", "answer");
		fs.mkdirSync(path.dirname(answerFile), { recursive: true });
		const server = await startServer(label, { ...actingAsWindows, WINDOWS_SWITCH_ON_HELD: answerFile, WINDOWS_SWITCH_ON_HELD_LIMIT_MS: String(limitMs) }, "scripts/windows-switch-on-smoke.ts");
		servers.push(server);
		assert(startLine(server) === "", `the check answered before the row did: ${startLine(server)}`);
		const logs = () => fs.readdirSync(path.dirname(answerFile)).filter((name) => name.startsWith("log-")).flatMap((name) => fs.readFileSync(path.join(path.dirname(answerFile), name), "utf8").split("\n"));
		return { server, answer: (kind: "on" | "off" | "broken") => fs.writeFileSync(answerFile, kind), spawned: (text: string) => logs().some((line) => line.includes("\"spawn\"") && line.includes(text)) };
	}
	async function waitFor(done: () => boolean, what: string): Promise<void> {
		const deadline = Date.now() + 20_000;
		while (!done()) {
			if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
			await settle(50);
		}
	}
	/** While the check runs, the room's bind waits: the model isn't asked for the turn, so no command runs anywhere. Then `then`. */
	const bindWaits = (then: () => void) => async (before: number) => {
		await settle(800);
		const asked = seen.slice(before).filter((entry) => entry.asked.includes(COMMAND_PROMPT));
		assert(asked.length === 0, `the model was asked for the turn before Windows' check answered, so its command could run outside the box: ${show(asked.map((entry) => entry.call))}`);
		then();
	};

	let heldOn: { server: Server; older: string; answer: (kind: "on") => void; spawned: (text: string) => boolean } | null = null;
	await row("held check, then on: a command sent while it runs waits, then runs in the box, never in Git Bash first; the one-time grant goes to the rooms picked at start, not to one whose commands came on meanwhile", async () => {
		const { older, later } = await olderRooms("held-on");
		const { server, answer, spawned } = await heldServer("held-on");
		heldOn = { server, older, answer, spawned };
		// While the check runs, a request turns the later room's commands on.
		const on = await requestJson(server, `/api/persistent-agents/${encodeURIComponent(later)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: path.join(server.home, "workspace"), displayLabel: "Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }) });
		assert(on.status === 200, `commands on while the check runs: ${on.status} ${show(on.body)}`);
		const ran = await turn(server, older, "conversation-held-on", { meanwhile: bindWaits(() => answer("on")) });
		assert(startLine(server).includes("\"state\":\"on\""), `the log: ${startLine(server)}`);
		assert(ran.text.includes("switched-on") && !ran.text.includes(GIT_LINE) && !ran.text.includes(BOX_FAULT_SENTENCE), `the command: ${ran.text}`);
		assert(spawned("switched-on"), "the command didn't run in the box");
		assert(fs.existsSync(settingsOf(server, older)), "the room picked at start wasn't granted Run without asking");
		assert(!fs.existsSync(settingsOf(server, later)), "a room whose commands came on while the check ran was granted Run without asking");
	});

	await row("held check, then on: a room turned off on a protected room's folder waits, at its bind's file tools, while the protected room's command holds the folder", async () => {
		assert(heldOn !== null, "the row above starts the server");
		const { server, older, answer, spawned } = heldOn;
		// The check's answer, if the row above failed before it gave it; the first answer holds.
		answer("on");
		const beside = await folderRoom(server, "Beside Room", false);
		const off = await requestJson(server, `/api/persistent-agents/${encodeURIComponent(beside)}/protection`, { method: "PUT", body: JSON.stringify({ state: "off" }) });
		assert(off.status === 200 && show(off.body.protection) === show({ state: "off" }), show(off));
		const holding = turn(server, older, "conversation-holding", { prompt: HOLD_PROMPT });
		await waitFor(() => spawned("Start-Sleep"), "the protected room's command runs");
		// The note doesn't exist until the command's last step: a read that didn't wait for it finds none.
		const done = await turn(server, beside, "conversation-reading", { prompt: READ_PROMPT });
		const held = await holding;
		assert(held.text.includes("held"), `the command: ${held.text}`);
		assert(done.text.includes("WAIT-NOTE"), `the read ran while the other room's command held its folder: ${done.text}`);
	});

	for (const [kind, line] of [["off", GIT_LINE], ["broken", BOX_FAULT_SENTENCE]] as const) {
		await row(`held check, then ${kind}: a command sent while it runs waits, then ${kind === "off" ? "runs in Git Bash as today" : "runs nothing and gets the fault line"}`, async () => {
			const { older } = await olderRooms(`held-${kind}`);
			const { server, answer } = await heldServer(`held-${kind}`);
			const ran = await turn(server, older, `conversation-held-${kind}`, { meanwhile: bindWaits(() => answer(kind)) });
			assert(startLine(server).includes(`"state":"${kind}"`), `the log: ${startLine(server)}`);
			assert(kind === "off" ? ran.text === line : ran.text.includes(line) && !ran.text.includes(GIT_LINE), `the command: ${ran.text}`);
		});
	}

	await row("held check that never answers: a command sent while it runs waits for the check's limit, which reads broken: the fault line, never Git Bash", async () => {
		const { older } = await olderRooms("held-slow");
		const { server } = await heldServer("held-slow", 6_000);
		const ran = await turn(server, older, "conversation-held-slow", { meanwhile: bindWaits(() => {}) });
		const logged = startLine(server);
		assert(logged.includes("\"state\":\"broken\"") && logged.includes("no answer within 6 s"), `the log: ${logged}`);
		assert(ran.text.includes(BOX_FAULT_SENTENCE) && !ran.text.includes(GIT_LINE), `the command: ${ran.text}`);
	});
} catch (error) {
	for (const server of servers) console.error(server.output.join("").split("\n").filter((line) => !line.includes("token=")).join("\n").slice(-4000));
	throw error;
} finally {
	gateway.close();
	for (const server of servers) await stopSmokeServer(server.process);
}

// ---- 9. A shared server ----------------------------------------------------------------------------
// Last: a process registers its hooks once, for its whole life.

await row("a shared server runs no check and has no box, acting as Windows or not", async () => {
	const { registerServerHooks } = await import("../src/server-hooks.js");
	registerServerHooks({});
	setRoomBoxForTests({ platform: "win32", windows: "on" });
	assert(!windowsBoxChecks() && roomBoxComputer() === null && windowsBoxState() === null && !roomBoxAvailable(), "a shared server checks or boxes on Windows");
	setRoomBoxForTests({ platform: "darwin", windows: null });
	assert(roomBoxComputer() === null && !roomBoxAvailable(), "a shared server boxes on a Mac");
	// Where a shared server decides its file tools get no wait: fileToolsWait in room-box/windows/folder-wait.ts.
	setRoomBoxForTests({ platform: "win32", windows: "on" });
	assert(fileToolsWait() === undefined, "a shared server's file tools wait");
	// The bind, a new room and the background run await it: on a shared server it is already there.
	setRoomBoxForTests({ platform: "win32", windows: null });
	let settled = false;
	void roomBoxSettled().then(() => { settled = true; });
	await settle();
	assert(settled, "a shared server waits for a check it never runs");
	setRoomBoxForTests(null);
});

fs.rmSync(work, { recursive: true, force: true });
console.log("windows-switch-on-smoke: ok");
