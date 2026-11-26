// The room asks for a folder, or to turn on commands, and how a room's commands
// stand: on by themselves in a new room where they stay inside it, off with a
// mark when the person switches them off, and off in every conversation then.
//
// The first rows drive the asks and the stored settings as the server calls
// them, with the real question bridge, and read the frames a page gets and the
// lines the model gets. The live rows run a real server in this process with a
// gateway playing the model, on a Mac only. A shared server comes last: once
// its hooks are in, they stay. Each refused row has an allowed neighbour.
// Run: npm run smokes -- room-asks
import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { authedFetch, freePort, putRunWithoutAsking, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";
import { waitEvery } from "./smoke-wait.js";
import { threadSaveBody } from "../../web-ui/src/room-thread-items.js";

if (os.platform() === "win32") {
	console.log("SKIPPED: not yet on a real Windows PC: the folder window's stand-in answers for the Mac's window, and Windows opens its own with PowerShell");
	process.exit(0);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const onMac = process.platform === "darwin";
const waitUntil = waitEvery(25, 30_000);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-asks-")));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");
// Folders a person could pick live in the home: the computer's shared temp is never offered.
const folders = path.join(home, "Documents");
for (const dir of [agentDir, agentsRoot, folders]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const MODEL = { provider: "openai-compatible", model: "room-model" };

for (const name of ["EXXPERTS_DATA_DIR", "EXXPERTS_STATE_HOME", "EXXPERTS_REAL_HOME", "EXXPERTS_TEST_SHELL_PLATFORM"]) delete process.env[name];
const port = await freePort();
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV, {
	HOME: home,
	USERPROFILE: home,
	PORT: String(port),
	EXXETA_HOME: repoRoot,
	EXXPERTS_CODING_AGENT_DIR: agentDir,
	EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
	EXXPERTS_TEST_INTROSPECTION: "1",
	LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
});

// The computer's folder window, for the live rows: the program the server starts for it answers with this folder.
const folderWindow = { pick: "" };
const realExecFile = childProcess.execFile;
(childProcess as any).execFile = (command: string, args: readonly string[], options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
	if (path.basename(command).toLowerCase() !== "osascript") return (realExecFile as any)(command, args, options, callback);
	// The window's script prints the pick as JSON.
	setImmediate(() => callback(null, `${JSON.stringify(folderWindow.pick)}\n`, ""));
	return { kill() {}, on() {} } as any;
};
syncBuiltinESMExports();

const policy = await import("../src/persistent-room-workspace-policy.js");
const bashSettings = await import("../src/persistent-room-bash-settings.js");
const { persistentRoomProtection } = await import("../src/persistent-room-protection.js");
const asks = await import("../src/room-box/folder-question.js");
const cards = await import("../src/room-box/card-text.js");
const { SUGGESTION_JUDGE_MS } = await import("../src/room-box/folder-suggestion.js");
const { addAlsoAllowedFolder, readAlsoAllowed, saveAlsoAllowedFolders } = await import("../src/room-box/also-allowed.js");
const { closedForReading } = await import("../src/room-box/box-closed.js");
const { roomBoxAvailable } = await import("../src/room-box/box-available.js");
const { createWebUiContext } = await import("../src/web-ui-context.js");

/** Plays the computer with no protection for commands, as the shell-missing smoke does. */
function withoutProtection<T>(body: () => T): T {
	process.env.EXXPERTS_TEST_SHELL_PLATFORM = "linux";
	try {
		return body();
	} finally {
		delete process.env.EXXPERTS_TEST_SHELL_PLATFORM;
	}
}
/** Plays a Mac, where the room's protection runs, on any computer. */
function withProtection<T>(body: () => T): T {
	process.env.EXXPERTS_TEST_SHELL_PLATFORM = "darwin";
	try {
		return body();
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
async function macRow(name: string, body: () => Promise<void>): Promise<void> {
	if (!onMac) {
		console.log(`  skip ${name} (needs a Mac)`);
		return;
	}
	await row(name, body);
}

// --- Rooms on disk, as the server keeps them.
let rooms = 0;
function newFolder(name: string): string {
	const dir = path.join(folders, name);
	fs.mkdirSync(dir, { recursive: true });
	return fs.realpathSync(dir);
}
/** Puts a new, empty folder in place of `target`, under its name. The new one is made beside the old before the old is removed: the disk may hand a removed folder's file number to the next folder made, and the new one would then pass for the old. */
function replaceFolder(target: string): void {
	const fresh = `${target} new`;
	fs.mkdirSync(fresh);
	fs.rmSync(target, { recursive: true });
	fs.renameSync(fresh, target);
}
/** A room's folder, and a room made where its protection runs when `startsOn`. */
function plantRoom(startsOn: boolean): { id: string; folder: string } {
	const id = `asks-room-${++rooms}`;
	const root = policy.persistentAgentRootPath(id);
	fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
	if (startsOn) for (const [rel, body] of withProtection(() => bashSettings.newRoomCommandFiles(new Date()))) fs.writeFileSync(path.join(root, rel), body);
	return { id, folder: newFolder(`room-folder-${rooms}`) };
}
/** `bashEnabled` left out: the Folder pane's switch was never touched. */
const defaultPolicy = (id: string, folder: string, bashEnabled: boolean | undefined) =>
	policy.createPersistentRoomDefaultCapabilityPolicy({ agentId: id, repoRoot, root: folder, workspaceAccessMode: "localFiles", displayLabel: "Sales", source: "manual", bashEnabled });
const saveDefault = (id: string, folder: string, bashEnabled: boolean | undefined) => policy.writePersistentRoomDefaultCapabilityPolicy(defaultPolicy(id, folder, bashEnabled));
const setSwitch = (id: string, bashEnabled: boolean) => {
	const stored = policy.readPersistentRoomDefaultCapabilityPolicy(id);
	assert(stored, `${id} has a folder`);
	policy.writePersistentRoomDefaultCapabilityPolicy(policy.updatePersistentRoomCapabilityPolicyWorkspaceSettings(stored, { bashEnabled }));
};
const commandsOf = (id: string) => policy.persistentRoomCommandsOf(policy.readPersistentRoomDefaultCapabilityPolicy(id)!);
const effectiveCommands = (id: string, conversation = "conversation-1") => policy.resolvePersistentRoomEffectiveWorkspacePolicy(id, conversation).bashEnabled;
const askState = (id: string, folder: string | null, conversation = "conversation-1") =>
	asks.commandsAskState({ on: effectiveCommands(id, conversation), atComputer: true, folder, fullAccess: true, switchedOff: () => policy.persistentRoomCommandsSwitchedOff(id, conversation) });

// --- The asks, with the real bridge: the frames a page gets, and what each ask gives the model.
type Frame = { type: string; id?: string; kind?: string; [key: string]: unknown };
type Picked = Awaited<ReturnType<Parameters<typeof asks.chooseFolderForRoom>[0]["pickFolder"]>>;
const PRESSES = cards.FOLDER_PANEL_PRESSES;
function askBench(input: { roomId?: string; room?: Partial<import("../src/room-box/folder-question.js").RoomAskView>; picks?: Array<Picked | Promise<Picked> | (() => Picked)>; authority?: "computer" | "phone"; look?: (folder: string) => Promise<import("../src/room-box/folder-question.js").FirstLook>; turnOn?: () => void; show?: boolean; onWait?: () => void; homeNow?: () => string } = {}) {
	const frames: Frame[] = [];
	// The bridge's clock: each answer comes a floor later than the last, unless a row sends it sooner.
	const clock = { now: 0 };
	const bridge = createWebUiContext((frame) => frames.push(frame as Frame), undefined, input.authority ?? "computer", { now: () => clock.now });
	const roomId = input.roomId ?? plantRoom(false).id;
	const view = { folder: null, canChangeFiles: true, commands: "may-ask" as const, boxed: true, ...input.room };
	const picks = [...(input.picks ?? [])];
	const notNow = new asks.NotNowCount();
	// The running answer's own folders; `endAnswer` is the answer's end.
	let answer = new asks.AnswerFolders();
	let turnedOn = 0;
	const reasons = new Map<string, string>();
	const suggested = new Map<string, string>();
	// Where each window opened, and each wait the ask took before its card: the bench never sleeps.
	const starts: Array<string | undefined> = [];
	const waits: number[] = [];
	// How many cards the page had when each wait began: a card comes only after its wait.
	const cardsAtWait: number[] = [];
	const made = asks.createRoomAsks({
		roomId,
		reasonOf: (toolCallId, fallback) => reasons.get(toolCallId) ?? String(fallback ?? ""),
		folderOf: (toolCallId, fallback) => suggested.get(toolCallId) ?? String(fallback ?? ""),
		questions: bridge,
		room: () => view,
		pickFolder: async (_signal, startAt) => {
			starts.push(startAt);
			// A function is the window's answer made when the window answers, after anything it does to the disk.
			const next = picks.shift();
			return (typeof next === "function" ? next() : await next) ?? { ok: true, supported: true, cancelled: true, path: null };
		},
		wait: async (ms) => {
			waits.push(ms);
			cardsAtWait.push(frames.filter((frame) => frame.type === "ui_request").length);
			input.onWait?.();
		},
		// Read at each judgement, so a row can move the judge's home between the look and the press.
		get suggestionHome() {
			return input.homeNow?.() ?? home;
		},
		...(input.show === undefined ? {} : { showSuggestionBeforeClick: input.show }),
		turnOnCommands: () => {
			input.turnOn?.();
			turnedOn += 1;
		},
		notNow,
		answer: () => answer,
		look: input.look,
	});
	const [folderTool, commandsTool] = made.tools;
	let calls = 0;
	let lastDetails: Record<string, unknown> = {};
	const run = (tool: typeof folderTool, args: Record<string, unknown>) => {
		const id = `call-${++calls}`;
		if (typeof args.reason === "string") reasons.set(id, args.reason);
		if (typeof args.folder === "string") suggested.set(id, args.folder);
		return tool.execute(id, args as any, undefined, undefined, undefined as any).then((result: any) => {
			lastDetails = result.details ?? {};
			return String(result.content?.[0]?.text ?? "");
		});
	};
	const requests = () => frames.filter((frame) => frame.type === "ui_request");
	return {
		bridge,
		frames,
		requests,
		view,
		roomId,
		turnedOn: () => turnedOn,
		details: () => lastDetails,
		notNow,
		answerFolders: () => answer,
		endAnswer() {
			answer.end();
			answer = new asks.AnswerFolders();
		},
		personSpoke: made.personSpoke,
		askFolder: (access: "read" | "change", reason = "To read the quarter's numbers.", folder?: string) => run(folderTool, { access, reason, ...(folder === undefined ? {} : { folder }) }),
		starts,
		waits,
		cardsAtWait,
		askCommands: (reason = "To make a chart from the spreadsheet.") => run(commandsTool, { reason }),
		clock,
		/** Answers the newest card the page has; a folder panel's presses are `PRESSES`. `after`: how long after the card's last frame, by the bridge's clock. */
		answer(value: unknown, authority: "computer" | "phone" = "computer", after = cards.ANSWER_FLOOR_MS) {
			const open = requests().at(-1);
			assert(open?.id, "a card is showing");
			clock.now += after;
			bridge.resolveResponse(open.id, value, authority);
		},
		/** The panel's reply to the press just sent: its update, or its close. */
		async replyFrom(from: number): Promise<Frame> {
			const id = requests().at(-1)?.id;
			await waitUntil(() => frames.slice(from).some((frame) => frame.id === id && (frame.type === "ui_request_update" || frame.type === "ui_request_closed")), "the press's reply");
			return frames.slice(from).find((frame) => frame.id === id && (frame.type === "ui_request_update" || frame.type === "ui_request_closed"))!;
		},
		/**
		 * A pick from the folder window, given as the person gives it: for this
		 * room, Allow for this room on the panel with nothing shown; for this
		 * answer, Choose folder, then Allow this time on the folder it shows.
		 */
		async give(lasts: "answer" | "room") {
			if (lasts === "room") return this.answer(PRESSES.room);
			const reply = await (async () => {
				const from = frames.length;
				this.answer(PRESSES.choose);
				return this.replyFrom(from);
			})();
			if ((reply.suggested as { once?: boolean } | null | undefined)?.once) this.answer(PRESSES.thisTime);
		},
	};
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

console.log("room asks smoke");

await row("a new room is made with commands on where they stay inside it, and with them off elsewhere", () => {
	const made = withProtection(() => bashSettings.newRoomCommandFiles(new Date()));
	assert(made.map(([rel]) => rel).sort().join() === "runtime/bash-settings.json,runtime/commands-start-on.json", `the files: ${made.map(([rel]) => rel)}`);
	assert(JSON.parse(made.find(([rel]) => rel === "runtime/bash-settings.json")![1]).runWithoutAsking === "automatic", "Run without asking came by itself");
	assert(withoutProtection(() => bashSettings.newRoomCommandFiles(new Date())).length === 0, "a room made with no protection starts with commands on");
});

await row("a new room's first folder takes commands on by themselves, unless switched off before it; a room made before keeps them off", () => {
	const fresh = plantRoom(true);
	const startOnFile = path.join(policy.persistentAgentRootPath(fresh.id), policy.PERSISTENT_ROOM_COMMANDS_START_ON_FILE);
	assert(fs.existsSync(startOnFile), "a new room with no folder keeps that its commands start on");
	// The page leaves an untouched switch out of the room's first folder.
	saveDefault(fresh.id, fresh.folder, undefined);
	assert(commandsOf(fresh.id) === "automatic" && withProtection(() => effectiveCommands(fresh.id)), `the first folder's commands: ${commandsOf(fresh.id)}`);
	// Switched off before that first save: the person switched them off, so the room never asks.
	const offFirst = plantRoom(true);
	saveDefault(offFirst.id, offFirst.folder, false);
	assert(commandsOf(offFirst.id) === "switched-off" && askState(offFirst.id, offFirst.folder) === "switched-off", `switched off before the first folder: ${commandsOf(offFirst.id)}`);
	assert(!fs.existsSync(startOnFile), "the start-on record outlived the first folder");
	// Another folder, with the switch showing on: still on by themselves where the protection runs.
	withProtection(() => saveDefault(fresh.id, newFolder("fresh-second"), true));
	assert(commandsOf(fresh.id) === "automatic", `another folder, the switch on: ${commandsOf(fresh.id)}`);
	const before = plantRoom(false);
	saveDefault(before.id, before.folder, false);
	assert(commandsOf(before.id) === "off" && !effectiveCommands(before.id), `a room made before: ${commandsOf(before.id)}`);
});

await row("commands that came on by themselves run only where they stay inside the room; the person's own on is kept", () => {
	const automatic = plantRoom(true);
	saveDefault(automatic.id, automatic.folder, undefined);
	assert(withProtection(() => effectiveCommands(automatic.id)), "on with the protection");
	assert(!withoutProtection(() => effectiveCommands(automatic.id)), "an automatic yes held with no protection");
	assert(withoutProtection(() => askState(automatic.id, automatic.folder)) === "may-ask", "with no protection the room may ask, for Turn on anyway");
	const own = plantRoom(true);
	saveDefault(own.id, own.folder, true);
	assert(commandsOf(own.id) === "on" && withoutProtection(() => effectiveCommands(own.id)), `the person's own on: ${commandsOf(own.id)}`);
});

await row("a commands card's yes with the protection holds only with it, and Turn on anyway is the person's own; a Bounded room reads switched off until the person turns commands on", () => {
	const carded = plantRoom(false);
	saveDefault(carded.id, carded.folder, false);
	withProtection(() => asks.setRoomCommands(carded.id, "conversation-1", true));
	assert(commandsOf(carded.id) === "automatic" && withProtection(() => effectiveCommands(carded.id)), `the card's yes with the protection: ${commandsOf(carded.id)}`);
	assert(!withoutProtection(() => effectiveCommands(carded.id)) && withoutProtection(() => askState(carded.id, carded.folder)) === "may-ask", "a yes given under the protection ran commands without it");
	withoutProtection(() => asks.setRoomCommands(carded.id, "conversation-1", true));
	assert(commandsOf(carded.id) === "on" && withoutProtection(() => effectiveCommands(carded.id)), `Turn on anyway: ${commandsOf(carded.id)}`);
	// A Bounded room reads as the one mode with commands switched off: it never asks, a save that leaves commands off keeps them so, and the person's on turns them on.
	const bounded = plantRoom(false);
	saveDefault(bounded.id, bounded.folder, true);
	const stored = policy.readPersistentRoomDefaultCapabilityPolicy(bounded.id)!;
	policy.writePersistentRoomDefaultCapabilityPolicy(policy.updatePersistentRoomCapabilityPolicyWorkspaceSettings(stored, { workspaceAccessMode: "bounded", bashEnabled: false }));
	assert(commandsOf(bounded.id) === "switched-off" && askState(bounded.id, bounded.folder) !== "may-ask", `Access set to Bounded: ${commandsOf(bounded.id)}, ${askState(bounded.id, bounded.folder)}`);
	policy.writePersistentRoomDefaultCapabilityPolicy(policy.updatePersistentRoomCapabilityPolicyWorkspaceSettings(policy.readPersistentRoomDefaultCapabilityPolicy(bounded.id)!, { workspaceAccessMode: "localFiles", bashEnabled: false }));
	assert(askState(bounded.id, bounded.folder) !== "may-ask", `saved again with commands off, the room asks: ${askState(bounded.id, bounded.folder)}`);
	policy.writePersistentRoomDefaultCapabilityPolicy(policy.updatePersistentRoomCapabilityPolicyWorkspaceSettings(policy.readPersistentRoomDefaultCapabilityPolicy(bounded.id)!, { bashEnabled: true }));
	assert(commandsOf(bounded.id) === "on", `turned on after Bounded: ${commandsOf(bounded.id)}`);
});

await row("Run without asking that came by itself holds only with the protection; the person's own is kept where she gave it", () => {
	const automatic = plantRoom(true);
	assert(withProtection(() => bashSettings.readPersistentRoomBashSettings(automatic.id).autoApprove), "with the protection");
	assert(!withoutProtection(() => bashSettings.readPersistentRoomBashSettings(automatic.id).autoApprove), "Run without asking held with no protection");
	const own = plantRoom(false);
	withoutProtection(() => bashSettings.writePersistentRoomBashSettings(own.id, { autoApprove: true, protection: persistentRoomProtection(own.id) }));
	assert(withoutProtection(() => bashSettings.readPersistentRoomBashSettings(own.id).autoApprove), "the person's own Run without asking was dropped");
	// A card's yes adds it only where no choice is stored, and only with the protection.
	const asked = plantRoom(false);
	withoutProtection(() => bashSettings.grantAutomaticRunWithoutAsking(asked.id));
	assert(!fs.existsSync(bashSettings.persistentRoomBashSettingsPath(asked.id)), "a yes with no protection stored Run without asking");
	withProtection(() => bashSettings.grantAutomaticRunWithoutAsking(asked.id));
	assert(withProtection(() => bashSettings.readPersistentRoomBashSettings(asked.id).autoApprove), "a yes with the protection");
	const askEach = plantRoom(false);
	withProtection(() => bashSettings.writePersistentRoomBashSettings(askEach.id, { autoApprove: false, protection: persistentRoomProtection(askEach.id) }));
	withProtection(() => bashSettings.grantAutomaticRunWithoutAsking(askEach.id));
	assert(!withProtection(() => bashSettings.readPersistentRoomBashSettings(askEach.id).autoApprove), "a yes replaced the person's Ask before each command");
});

await row("switching commands off leaves a mark, so the room never asks; a room never turned on has none and asks", async () => {
	const switched = plantRoom(false);
	saveDefault(switched.id, switched.folder, true);
	setSwitch(switched.id, false);
	assert(commandsOf(switched.id) === "switched-off", `on, then off: ${commandsOf(switched.id)}`);
	const never = plantRoom(false);
	saveDefault(never.id, never.folder, false);
	setSwitch(never.id, false);
	assert(commandsOf(never.id) === "off", `never on, saved off again: ${commandsOf(never.id)}`);
	// A room switched off before the update stored only false: it has no mark and keeps the card.
	const old = plantRoom(false);
	const stored = defaultPolicy(old.id, old.folder, false) as any;
	delete stored.commands;
	policy.writePersistentRoomDefaultCapabilityPolicy(stored);
	assert(commandsOf(old.id) === "off", `an old room: ${commandsOf(old.id)}`);
	for (const [room, expected] of [[switched, "switched-off"], [never, "may-ask"], [old, "may-ask"]] as const) {
		const state = askState(room.id, room.folder);
		assert(state === expected, `${room.id}: ${state}`);
		const bench = askBench({ roomId: room.id, room: { folder: room.folder, commands: state } });
		const asked = bench.askCommands();
		await settle();
		if (expected === "switched-off") {
			assert((await asked) === asks.COMMANDS_SWITCHED_OFF && bench.requests().length === 0, "a room switched off showed a commands card");
		} else {
			assert(bench.requests().at(-1)?.kind === "commands", `${room.id} showed no commands card`);
			bench.answer(false);
			assert((await asked) === asks.COMMANDS_NOT_NOW, "Not now");
		}
	}
	// And on again is the person's own on.
	setSwitch(switched.id, true);
	assert(commandsOf(switched.id) === "on", `off, then on: ${commandsOf(switched.id)}`);
});

await row("choosing another folder keeps commands as they stood, switched off included", () => {
	const room = plantRoom(false);
	saveDefault(room.id, room.folder, true);
	saveDefault(room.id, newFolder("moved-on"), false);
	assert(commandsOf(room.id) === "switched-off", `on, then another folder with the switch off: ${commandsOf(room.id)}`);
	saveDefault(room.id, newFolder("moved-again"), false);
	assert(commandsOf(room.id) === "switched-off" && askState(room.id, room.folder) === "switched-off", `another folder after switching off: ${commandsOf(room.id)}`);
	const never = plantRoom(false);
	saveDefault(never.id, never.folder, false);
	saveDefault(never.id, newFolder("never-moved"), false);
	assert(commandsOf(never.id) === "off", `never on, another folder: ${commandsOf(never.id)}`);
});

await row("commands switched off for the room are off in a conversation with its own settings too", () => {
	const room = plantRoom(false);
	saveDefault(room.id, room.folder, true);
	const own = policy.createPersistentRoomCapabilityPolicy({ agentId: room.id, conversationId: "conversation-own", repoRoot, root: room.folder, workspaceAccessMode: "localFiles", displayLabel: "Sales", source: "manual", bashEnabled: true });
	policy.writePersistentRoomCapabilityPolicy(own);
	assert(effectiveCommands(room.id, "conversation-own"), "a conversation's own on, with the room's on");
	setSwitch(room.id, false);
	assert(!effectiveCommands(room.id, "conversation-own"), "a conversation's own settings kept commands on after the room's switch went off");
	assert(askState(room.id, room.folder, "conversation-own") === "switched-off", "the conversation may ask for commands the person switched off");
});

await row("asks show one at a time, a folder before commands; after Not now on the folder the commands ask is withdrawn and not counted", async () => {
	const folder = newFolder("ordered-room");
	const bench = askBench({ room: { folder } });
	// One answer's calls, commands asked first: the folder card still comes first.
	const first = bench.askCommands("First.");
	const second = bench.askCommands("Second.");
	const asked = bench.askFolder("read");
	await settle();
	assert(bench.requests().length === 1 && bench.requests()[0].kind === "folder", `one card, the folder first: ${JSON.stringify(bench.requests())}`);
	bench.answer(false);
	assert((await asked) === asks.FOLDER_NOT_NOW, "the folder's Not now");
	assert((await first) === asks.COMMANDS_WITHDRAWN && (await second) === asks.COMMANDS_WITHDRAWN && bench.requests().length === 1 && bench.turnedOn() === 0, `a commands ask showed after a folder Not now: ${JSON.stringify(bench.requests())}`);
	bench.notNow.notNow();
	bench.notNow.notNow();
	assert(bench.notNow.reached(), "the withdrawn asks counted as a Not now, or the folder's didn't");
	// With no folder in line, commands asks show in the order the room asked.
	const later = askBench({ room: { folder } });
	const one = later.askCommands("First.");
	const two = later.askCommands("Second.");
	await settle();
	assert(later.requests().length === 1 && later.requests()[0].reason === "First.", `the first commands ask first: ${JSON.stringify(later.requests())}`);
	later.answer(true);
	assert((await one) === asks.COMMANDS_TURNED_ON && later.turnedOn() === 1, "the yes turned commands on");
	await settle();
	assert(later.requests().length === 2 && later.requests()[1].reason === "Second.", `the second ask came next: ${JSON.stringify(later.requests())}`);
	later.answer(false);
	await two;
});

await row("asks queued together stop at the limit: after three Not nows in a row the fourth waiting card never shows", async () => {
	const bench = askBench({ room: { folder: newFolder("queued-room") } });
	const queued = [bench.askFolder("read"), bench.askFolder("read"), bench.askFolder("read"), bench.askFolder("read")];
	for (let at = 0; at < 3; at += 1) {
		await settle();
		bench.answer(false);
		assert((await queued[at]) === asks.FOLDER_NOT_NOW, `Not now ${at + 1}`);
	}
	await settle();
	assert((await queued[3]) === asks.ASKED_TOO_OFTEN && bench.requests().length === 3, `a fourth card showed after three Not nows: ${bench.requests().length} cards`);
});

await row("three Not nows in a row end the asking until the person writes, and a message withdraws waiting asks", async () => {
	const bench = askBench({ room: { folder: newFolder("asked-room") } });
	for (let at = 0; at < 3; at += 1) {
		const asked = bench.askFolder("read");
		await settle();
		bench.answer(false);
		assert((await asked) === asks.FOLDER_NOT_NOW, `Not now ${at + 1}`);
	}
	const shown = bench.requests().length;
	assert((await bench.askFolder("read")) === asks.ASKED_TOO_OFTEN && (await bench.askCommands()) === asks.ASKED_TOO_OFTEN && bench.requests().length === shown, "a fourth card showed");
	bench.personSpoke();
	const open = bench.askFolder("read");
	const waiting = bench.askCommands();
	await settle();
	assert(bench.requests().length === shown + 1, "after a message the room may ask again");
	bench.personSpoke();
	assert((await waiting) === asks.ASK_WITHDRAWN_FOR_MESSAGE, "a message left a waiting ask in line");
	bench.answer(false);
	await open;
});

await row("after a Not now, and once asking has stopped, the room offers no step by hand, and once it has stopped it says the person can ask again", () => {
	const noSteps = "Don't give commands to type, steps to do it by hand or a settings path, and don't suggest attaching, pasting, copying or exporting the files, or saving them another way.";
	for (const [name, sentence] of [["folder", asks.FOLDER_NOT_NOW], ["commands", asks.COMMANDS_NOT_NOW], ["too often", asks.ASKED_TOO_OFTEN], ["withdrawn", asks.COMMANDS_WITHDRAWN]] as const) {
		assert(sentence.endsWith(` ${noSteps}`), `${name}: ${sentence}`);
	}
	assert(asks.FOLDER_NOT_NOW.includes("that they can ask again or choose a folder.") && asks.COMMANDS_NOT_NOW.includes("that they can ask again."), `Not now: ${asks.FOLDER_NOT_NOW} | ${asks.COMMANDS_NOT_NOW}`);
	assert(asks.ASKED_TOO_OFTEN.startsWith("The person has said Not now several times, so don't ask again or try another way until they write. Say what you couldn't do, and that they can ask for it again in a new message. "), `too often: ${asks.ASKED_TOO_OFTEN}`);
	assert(asks.COMMANDS_WITHDRAWN.startsWith("Not asked: the person said Not now to the folder this job needed, so there's no folder for commands to work in. If the job still needs commands, you can ask again with a new reason. "), `withdrawn: ${asks.COMMANDS_WITHDRAWN}`);
});

await row("a refused command points to the commands ask only where the room may ask", () => {
	assert(asks.commandOffLine("on") === null, "on: a refusal");
	assert(asks.commandOffLine("may-ask") === asks.COMMAND_OFF_NOTHING_RAN, `may ask: ${asks.commandOffLine("may-ask")}`);
	assert(asks.commandOffLine("switched-off") === asks.COMMAND_SWITCHED_OFF_NOTHING_RAN, `switched off: ${asks.commandOffLine("switched-off")}`);
	// Unavailable (the folder gone, or Bounded mid-conversation): the room has no ask_for_commands to call.
	assert(asks.commandOffLine("unavailable") === asks.COMMANDS_UNAVAILABLE, `unavailable: ${asks.commandOffLine("unavailable")}`);
});

await row("nobody there: the ask answers at once with no card", async () => {
	const bench = askBench({ room: { folder: newFolder("away-room") } });
	bench.bridge.detach("nobody");
	assert((await bench.askFolder("change", "Reports in /Users/ana/Secret Plans")) === asks.NOBODY_FOR_FOLDER, "the folder ask");
	assert((await bench.askCommands()) === asks.NOBODY_FOR_COMMANDS, "the commands ask");
	assert(bench.requests().length === 0, `cards: ${bench.requests().length}`);
	// With somebody there, the same ask shows a card.
	const there = askBench({ room: { folder: newFolder("there-room") } });
	const asked = there.askFolder("read");
	await settle();
	assert(there.requests().length === 1, "with somebody there");
	there.answer(false);
	await asked;
});

await row("a phone sees the card without the room's reason and can't answer it; the computer sees the reason", async () => {
	const reason = "To read /Users/ana/Finance/q3.xlsx";
	const phone = askBench({ authority: "phone", room: { folder: newFolder("phone-room") } });
	const asked = phone.askFolder("read", reason);
	await settle();
	const card = phone.requests()[0];
	assert(card?.kind === "folder" && !("reason" in card) && !JSON.stringify(phone.frames).includes("Finance"), `the phone's card: ${JSON.stringify(card)}`);
	phone.answer(PRESSES.room, "phone");
	phone.answer(PRESSES.choose, "phone");
	phone.answer(false, "phone");
	await settle();
	// Each counts for nothing and gets the card again, still without the reason or a line, and notifying nobody.
	const again = phone.frames.slice(1);
	assert(again.length === 3 && again.every((frame) => frame.type === "ui_request" && frame.id === card.id && frame.again === true && !("reason" in frame) && !("line" in frame)), `the phone's replies: ${JSON.stringify(again)}`);
	let ended = false;
	void asked.then(() => { ended = true; });
	await settle();
	assert(!ended, "a phone's answer ended the card");
	// The card stays open across the move back to the computer, with the reason there.
	phone.bridge.detach("moved");
	phone.bridge.attach("computer");
	assert(phone.requests().at(-1)?.reason === reason, "the computer's card has the reason");
	phone.answer(false);
	assert((await asked) === asks.FOLDER_NOT_NOW, "the computer's Not now");
});

await row("the room's reason leaves the model's message before anything saves it, and only the card gets it", () => {
	const keeper = asks.createReasonKeeper();
	let onEnd: ((event: any) => any) | null = null;
	keeper.extension({ on: (name: string, handler: (event: any) => any) => { if (name === "message_end") onEnd = handler; } });
	const reason = "To read /Users/ana/Finance/q3.xlsx";
	const ended = onEnd!({ message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "ask_for_folder", arguments: { access: "read", reason } }, { type: "toolCall", id: "c2", name: "write", arguments: { path: "a.txt", reason } }] } });
	assert(ended?.message && !JSON.stringify(ended.message.content[0]).includes("Finance"), `the ask kept its reason: ${JSON.stringify(ended?.message?.content?.[0])}`);
	assert(ended.message.content[1].arguments.reason === reason, "another tool's arguments changed");
	assert(keeper.take("c1", "") === reason && keeper.take("c1", "") === "", "the card gets the reason once");
	// A turn with the provider's own search keeps a wire copy of its blocks: the ask's reason leaves that copy too, and the search block stays as it came.
	const search = { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "Finance q3" } };
	const withWire = onEnd!({ message: { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "ask_for_commands", arguments: { reason } }], rawContent: [search, { type: "web_search_tool_result", tool_use_id: "s1", content: [] }, { type: "tool_use", id: "c3", name: "ask_for_commands", input: { reason } }] } });
	assert(withWire?.message && !JSON.stringify(withWire.message).includes(reason), `the wire copy kept the reason: ${JSON.stringify(withWire?.message?.rawContent)}`);
	assert(JSON.stringify(withWire.message.rawContent[0]) === JSON.stringify(search) && withWire.message.rawContent[2].id === "c3", "the wire copy's other blocks changed");
	// The folder the room suggests leaves the message too, alone or beside a reason, and only the judge gets it, once.
	const guess = "~/Documents/Finance";
	const withFolder = onEnd!({ message: { role: "assistant", content: [{ type: "toolCall", id: "c4", name: "ask_for_folder", arguments: { access: "read", reason, folder: guess } }, { type: "toolCall", id: "c5", name: "ask_for_folder", arguments: { access: "read", reason: "", folder: guess } }], rawContent: [{ type: "tool_use", id: "c4", name: "ask_for_folder", input: { access: "read", reason, folder: guess } }, { type: "tool_use", id: "c5", name: "ask_for_folder", input: { access: "read", reason: "", folder: guess } }] } });
	assert(withFolder?.message && !JSON.stringify(withFolder.message).includes("Finance"), `the message kept the folder: ${JSON.stringify(withFolder?.message)}`);
	assert(keeper.takeFolder("c4", "") === guess && keeper.takeFolder("c4", "") === "" && keeper.take("c4", "") === reason, "the judge gets the folder once, and the card the reason");
	assert(keeper.takeFolder("c5", "") === guess && keeper.take("c5", "") === "", "a folder with no reason is kept");
	// A folder or reason that isn't text leaves the message all the same, and the judge and the card get nothing from it.
	const odd = onEnd!({ message: { role: "assistant", content: [{ type: "toolCall", id: "c6", name: "ask_for_folder", arguments: { access: "read", reason: ["Finance"], folder: [guess] } }, { type: "toolCall", id: "c7", name: "ask_for_folder", arguments: { access: "read", reason: { why: "Finance" }, folder: { path: guess } } }], rawContent: [{ type: "tool_use", id: "c6", name: "ask_for_folder", input: { access: "read", reason: ["Finance"], folder: [guess] } }, { type: "tool_use", id: "c7", name: "ask_for_folder", input: { access: "read", reason: { why: "Finance" }, folder: { path: guess } } }] } });
	assert(odd?.message && !JSON.stringify(odd.message).includes("Finance"), `a list or an object stayed in the message: ${JSON.stringify(odd?.message)}`);
	assert(["c6", "c7"].every((id) => keeper.takeFolder(id, "") === "" && keeper.take(id, "") === ""), "a list or an object reached the judge or the card");
});

await row("the page saves a room's card without its reason, line, failure, when it was shown or its open window; an outside card keeps the model's reason", () => {
	const reason = "To read the Finance figures";
	const waiting = { line: "/Users/someone/Finance", failure: "Not saved", shownAt: 5, choosing: "room" };
	const card = (uiKind: string, id: string) => ({ kind: "approval" as const, id, requestId: id, uiKind, title: "A card", reason, openedAt: 1, ...waiting });
	const saved = JSON.parse(threadSaveBody({ state: "standby", origin: "home", model: MODEL, items: [card("folder", "f"), card("commands", "c"), card("site", "s"), card("outside", "o")] as any, removed: [] } as any)).items;
	const kept = (item: any) => ["reason", ...Object.keys(waiting)].filter((field) => field in item);
	assert(saved.length === 4 && saved.slice(0, 3).every((item: any) => kept(item).length === 0 && item.title === "A card"), `a room's card was saved with what only the wait needs: ${JSON.stringify(saved.slice(0, 3).map(kept))}`);
	assert(saved[3].reason === reason, `the outside card lost the model's reason: ${JSON.stringify(saved[3])}`);
});

await row("the page saves a folder card without the folder it shows or its press", () => {
	const card = { kind: "approval" as const, id: "f", requestId: "f", uiKind: "folder", title: "A card", openedAt: 1, suggested: { name: "Reports", path: "~/Documents/Reports", once: true }, choosing: PRESSES.choose };
	const saved = JSON.parse(threadSaveBody({ state: "standby", origin: "home", model: MODEL, items: [card] as any, removed: [] } as any)).items;
	assert(saved.length === 1 && saved[0].title === "A card" && !JSON.stringify(saved).includes("Reports") && !("choosing" in saved[0]), `a folder card was saved with its folder: ${JSON.stringify(saved)}`);
});

await row("Choose a folder… keeps the card through a pick it can't use, and a pick it can use answers it", async () => {
	const roomFolder = newFolder("pick-room");
	const parent = path.dirname(roomFolder);
	const finance = newFolder("Finance");
	const bench = askBench({
		room: { folder: roomFolder },
		picks: [
			{ ok: true, supported: true, cancelled: false, path: parent },
			{ ok: true, supported: true, cancelled: false, path: policy.persistentAgentRootPath("asks-room-1") },
			{ ok: true, supported: true, cancelled: true, path: null },
			{ ok: false, supported: true, cancelled: false, code: "choose_folder_failed", error: "failed" },
			{ ok: true, supported: true, cancelled: false, path: `${finance}/` },
		],
	});
	const asked = bench.askFolder("read");
	await settle();
	const updates = () => bench.frames.filter((frame) => frame.type === "ui_request_update").map((frame) => frame.line);
	const press = async (lines: number) => {
		bench.answer("choose");
		await waitUntil(() => updates().length === lines || bench.frames.length > 99, "the window's answer");
	};
	await press(1);
	assert(updates()[0] === cards.folderHoldsRoomLine(path.basename(parent)), `a folder holding the room's: ${updates()[0]}`);
	await press(2);
	// A refusal with a reason says it, in the panel as in Room settings.
	assert(updates()[1] === cards.folderRefusedLine({ reason: "private" }, "", cards.FOLDER_PICK_REFUSED_IN_PANEL), `the app's own files: ${updates()[1]}`);
	// A cancelled window gets its one reply too: the card as it was, its buttons back.
	await press(3);
	assert(updates()[2] === updates()[1], `a cancelled window changed the card's line: ${updates()[2]}`);
	await press(4);
	assert(updates()[3] === cards.FOLDER_CARD_WINDOW_CLOSED, `a window that failed: ${updates()[3]}`);
	assert(readAlsoAllowed(bench.roomId).folders.length === 0, "a pick it can't use went on the list");
	bench.answer("choose");
	const result = await asked;
	assert(result.includes(`The person chose ${finance}.`) && result.includes("read files there"), `the model: ${result}`);
	assert(JSON.stringify(readAlsoAllowed(bench.roomId).folders.map((entry) => [entry.path, entry.access])) === JSON.stringify([[finance, "read"]]), "the pick is on the list to read");
	// The line after the pick names the person's own pick, for its Remove.
	assert(JSON.stringify(bench.details()[cards.ASK_FOLDER]) === JSON.stringify({ path: finance, name: "Finance", access: "read" }), `the line's folder: ${JSON.stringify(bench.details())}`);
	assert(asks.removeAskedFolder(bench.roomId, finance) && readAlsoAllowed(bench.roomId).folders.length === 0 && fs.existsSync(finance), "Remove took the folder off the list and left it on the computer");
	assert(!asks.removeAskedFolder(bench.roomId, roomFolder), "Remove took away a folder that wasn't on the list");
	// A forged answer from the page counts for nothing and is asked again: a folder comes only from the window.
	const forged = askBench({ room: { folder: roomFolder } });
	const forgedAsk = forged.askFolder("read");
	await settle();
	forged.answer({ state: "picked", folder: "/etc", name: "etc", access: "write" });
	assert(forged.frames.at(-1)?.again === true && readAlsoAllowed(forged.roomId).folders.length === 0, `the page's answer picked a folder: ${JSON.stringify(forged.frames.at(-1))}`);
	forged.answer(false);
	assert((await forgedAsk) === asks.FOLDER_NOT_NOW && readAlsoAllowed(forged.roomId).folders.length === 0, "after the forged answer");
});

// --- Every answer told back: one reply per answer, the floor, random ids, and the folder's look before its give.
type Look = import("../src/room-box/folder-question.js").FirstLook;
/** A first look the row releases by hand, as a Mac holds it while its own question is up. */
function heldLook() {
	const waiting: Array<(looked: Look) => void> = [];
	return {
		look: (_folder: string) => new Promise<Look>((resolve) => waiting.push(resolve)),
		started: () => waiting.length,
		release: (looked: Look = "listed") => waiting.shift()?.(looked),
	};
}
/** A window the row closes by hand. */
function heldWindow() {
	let close: (picked: Picked) => void = () => {};
	const picked = new Promise<Picked>((resolve) => { close = resolve; });
	return { picked, close: (folder: string | null) => close(folder === null ? { ok: true, supported: true, cancelled: true, path: null } : { ok: true, supported: true, cancelled: false, path: folder }) };
}
type Bench = ReturnType<typeof askBench>;
/** A site card on the bench's own bridge, applied as `apply` says. */
const askSiteOn = (bench: Bench, apply: (choice: "once" | "room", by: "computer" | "phone") => "once" | "room" | null = (choice) => choice) => bench.bridge.askSite({ host: "pypi.org", port: 443, lasting: true }, apply);
/** The frames the page got since `from`. */
const since = (bench: Bench, from: number) => bench.frames.slice(from);
const oneFrame = (bench: Bench, from: number, label: string): Frame => {
	const got = since(bench, from);
	assert(got.length === 1, `${label}: ${got.length} replies, ${JSON.stringify(got)}`);
	return got[0]!;
};

await row("every answer to a site, commands or folder card gets exactly one reply, and a no closes as answered", async () => {
	for (const [value, taken] of [["once", "once"], ["room", "room"], ["decline", "decline"]] as const) {
		const bench = askBench();
		const asked = askSiteOn(bench);
		const from = bench.frames.length;
		bench.answer(value);
		const reply = oneFrame(bench, from, `site ${value}`);
		assert(reply.type === "ui_request_closed" && reply.reason === "answered" && reply.taken === taken, `site ${value}: ${JSON.stringify(reply)}`);
		assert((await asked).choice === value, `the caller's answer for ${value}`);
	}
	for (const [value, said] of [[true, asks.COMMANDS_TURNED_ON], [false, asks.COMMANDS_NOT_NOW]] as const) {
		const bench = askBench({ room: { folder: newFolder("reply-commands") } });
		const asked = bench.askCommands();
		await settle();
		const from = bench.frames.length;
		bench.answer(value);
		const reply = oneFrame(bench, from, `commands ${value}`);
		assert(reply.reason === "answered" && reply.taken === value, `commands ${value}: ${JSON.stringify(reply)}`);
		assert((await asked) === said && bench.turnedOn() === (value ? 1 : 0), `the model for commands ${value}`);
	}
	// A folder card: a cancelled window, a press while the window is open, a phone's answer, and Not now.
	const open = heldWindow();
	const bench = askBench({ room: { folder: newFolder("reply-folder-room") }, picks: [{ ok: true, supported: true, cancelled: true, path: null }, open.picked] });
	const folderTool = bench.askFolder("read");
	await settle();
	const id = bench.requests()[0]!.id;
	let from = bench.frames.length;
	bench.answer(PRESSES.room);
	await waitUntil(() => since(bench, from).length > 0, "the cancelled window's reply");
	await settle();
	const cancelled = oneFrame(bench, from, "a cancelled window");
	assert(cancelled.type === "ui_request_update" && cancelled.choosing === null && cancelled.canChoose === true && cancelled.line === null, `a cancelled window: ${JSON.stringify(cancelled)}`);
	bench.answer(PRESSES.choose);
	await settle();
	from = bench.frames.length;
	bench.answer(PRESSES.room);
	const busy = oneFrame(bench, from, "a press while the window is open");
	assert(busy.type === "ui_request" && busy.id === id && busy.again === true && busy.choosing === PRESSES.choose, `a press while the window is open: ${JSON.stringify(busy)}`);
	from = bench.frames.length;
	bench.answer(PRESSES.choose, "phone");
	const phone = oneFrame(bench, from, "a phone's folder answer");
	assert(phone.type === "ui_request" && phone.again === true, `a phone's folder answer: ${JSON.stringify(phone)}`);
	from = bench.frames.length;
	bench.answer(false);
	const notNow = oneFrame(bench, from, "Not now");
	assert(notNow.reason === "answered" && notNow.taken === false, `Not now: ${JSON.stringify(notNow)}`);
	assert((await folderTool) === asks.FOLDER_NOT_NOW, "the model's Not now");
	// The window closing after Not now changes nothing: the card has ended.
	from = bench.frames.length;
	open.close(newFolder("reply-too-late"));
	await settle();
	await settle();
	assert(since(bench, from).length === 0 && readAlsoAllowed(bench.roomId).folders.length === 0, `a pick after Not now: ${JSON.stringify(since(bench, from))}`);
	// A phone's commands answer is asked again too, and the card keeps its protection line.
	const commands = askBench({ room: { folder: newFolder("reply-commands-phone") } });
	const commandsAsk = commands.askCommands();
	await settle();
	from = commands.frames.length;
	commands.answer(true, "phone");
	const phoneCommands = oneFrame(commands, from, "a phone's commands answer");
	assert(phoneCommands.type === "ui_request" && phoneCommands.again === true && phoneCommands.line === "in-box" && commands.turnedOn() === 0, `a phone's commands answer: ${JSON.stringify(phoneCommands)}`);
	commands.answer(false);
	await commandsAsk;
});

await row("a folder card whose window can't even start still gets its reply, and a site's host shows its hidden characters", async () => {
	const bench = askBench();
	const asked = bench.bridge.askFolder({ access: "read", reason: "To read the quarter's numbers.", roomHasFolder: true, held: null, act: () => { throw new Error("the room's settings can't be read"); } });
	const from = bench.frames.length;
	bench.answer(PRESSES.room);
	await settle();
	await settle();
	const reply = oneFrame(bench, from, "a window that couldn't start");
	assert(reply.type === "ui_request_update" && reply.choosing === null, `a window that couldn't start: ${JSON.stringify(reply)}`);
	bench.answer(false);
	assert((await asked).state === "declined", "the Not now after it");
	const site = askBench();
	const siteAsk = site.bridge.askSite({ host: "pypi.org\u200b", port: 443, lasting: true }, (choice) => choice);
	const shown = site.requests().at(-1)!;
	assert(!JSON.stringify(shown).includes("\u200b") && shown.host === "pypi.org⟦U+200B⟧" && shown.title === cards.siteCardQuestion("pypi.org⟦U+200B⟧"), `a host with a hidden character: ${JSON.stringify(shown)}`);
	site.answer("decline");
	await siteAsk;
});

await row("a yes, or a folder card's window press, sooner than the floor after the card, an update, a re-send or the last answer gives nothing and asks again; a no is never held back", async () => {
	const soon = cards.ANSWER_FLOOR_MS - 1;
	// After the card was sent.
	for (const value of ["once", "room"]) {
		const bench = askBench();
		const asked = askSiteOn(bench);
		const from = bench.frames.length;
		bench.answer(value, "computer", soon);
		const again = oneFrame(bench, from, `site ${value} too soon`);
		assert(again.type === "ui_request" && again.again === true && again.kind === "site", `site ${value} too soon: ${JSON.stringify(again)}`);
		// The floor counts from that re-send: a floor later it counts.
		bench.answer(value);
		assert(bench.frames.at(-1)?.reason === "answered" && (await asked).choice === value, `site ${value} after the floor`);
	}
	const commands = askBench({ room: { folder: newFolder("floor-commands") } });
	const commandsAsk = commands.askCommands();
	await settle();
	commands.answer(true, "computer", soon);
	assert(commands.frames.at(-1)?.again === true && commands.turnedOn() === 0, "commands too soon turned them on");
	commands.answer(true);
	assert((await commandsAsk) === asks.COMMANDS_TURNED_ON && commands.turnedOn() === 1, "commands after the floor");
	// A no is taken at once, however soon.
	const quickNo = askBench();
	const quickNoAsk = askSiteOn(quickNo);
	quickNo.answer("decline", "computer", 0);
	assert(quickNo.frames.at(-1)?.reason === "answered" && (await quickNoAsk).choice === "decline", "a quick no was held back");
	const quickNotNow = askBench({ room: { folder: newFolder("floor-folder-no") } });
	const quickNotNowAsk = quickNotNow.askFolder("read");
	await settle();
	quickNotNow.answer(false, "computer", 0);
	assert((await quickNotNowAsk) === asks.FOLDER_NOT_NOW, "a quick Not now was held back");
	// Both folder presses, too soon: no window opens.
	const opened: string[] = [];
	// A window that opens only when the bench's window is asked for, and never closes.
	const windowFor = (label: string) => ({ then: () => { opened.push(label); } }) as unknown as Promise<Picked>;
	for (const value of [PRESSES.choose, PRESSES.room]) {
		const bench = askBench({ room: { folder: newFolder("floor-folder") }, picks: [windowFor(value)] });
		const asked = bench.askFolder("read");
		await settle();
		bench.answer(value, "computer", soon);
		await settle();
		assert(opened.length === 0 && bench.frames.at(-1)?.again === true, `${value} too soon opened the window`);
		bench.answer(false);
		await asked;
	}
	// After an update: the card changed under the pointer.
	const updated = askBench({ room: { folder: newFolder("floor-update") }, picks: [{ ok: true, supported: true, cancelled: true, path: null }, windowFor("after update")] });
	const updatedAsk = updated.askFolder("read");
	await settle();
	updated.answer(PRESSES.room);
	await waitUntil(() => updated.frames.at(-1)?.type === "ui_request_update", "the cancelled window's update");
	updated.answer(PRESSES.room, "computer", soon);
	await settle();
	assert(opened.length === 0 && updated.frames.at(-1)?.again === true, "a press too soon after an update opened the window");
	updated.answer(false);
	await updatedAsk;
	// After a re-send on attach.
	const moved = askBench();
	const movedAsk = askSiteOn(moved);
	moved.clock.now += 10_000;
	// Another window of the computer takes the room over: a site card ends with a detach, so none here.
	moved.bridge.attach("computer");
	moved.answer("once", "computer", soon);
	assert(moved.frames.at(-1)?.again === true, "a yes too soon after the card came back counted");
	moved.answer("once");
	assert((await movedAsk).choice === "once", "after the floor it counts");
	// After the last answer: a second click meant for the card before lands on the next, though both were shown long ago.
	const two = askBench();
	const first = askSiteOn(two);
	const second = askSiteOn(two);
	two.clock.now += 10_000;
	const [firstCard, secondCard] = two.requests();
	two.bridge.resolveResponse(firstCard!.id!, "once", "computer");
	two.clock.now += soon;
	two.bridge.resolveResponse(secondCard!.id!, "once", "computer");
	assert((await first).choice === "once" && two.frames.at(-1)?.id === secondCard!.id && two.frames.at(-1)?.again === true, `a yes right after the last answer: ${JSON.stringify(two.frames.at(-1))}`);
	two.clock.now += cards.ANSWER_FLOOR_MS;
	two.bridge.resolveResponse(secondCard!.id!, "once", "computer");
	assert((await second).choice === "once", "the second card after the floor");
	// After a card that ended with no press at that moment: a folder card closes on its pick, long after its press, while a site card waits.
	const window = heldWindow();
	const pair = askBench({ room: { folder: newFolder("floor-pick-room") }, picks: [window.picked] });
	const folderAsk = pair.askFolder("read");
	await settle();
	const siteAsk = askSiteOn(pair);
	const [folderCard, siteCard] = pair.requests();
	assert(folderCard?.kind === "folder" && siteCard?.kind === "site", `the two cards: ${JSON.stringify(pair.requests())}`);
	pair.clock.now += 10_000;
	pair.bridge.resolveResponse(folderCard.id!, PRESSES.room, "computer");
	await settle();
	pair.clock.now += 10_000;
	window.close(newFolder("floor-picked"));
	await waitUntil(() => pair.frames.some((frame) => frame.id === folderCard.id && frame.reason === "chosen"), "the folder card closes on its pick");
	await folderAsk;
	pair.clock.now += 100;
	const fromPick = pair.frames.length;
	pair.bridge.resolveResponse(siteCard.id!, "once", "computer");
	const afterPick = oneFrame(pair, fromPick, "a yes right after a pick");
	assert(afterPick.type === "ui_request" && afterPick.id === siteCard.id && afterPick.again === true, `a yes right after a pick: ${JSON.stringify(afterPick)}`);
	pair.bridge.resolveResponse(siteCard.id!, "decline", "computer");
	assert(pair.frames.at(-1)?.reason === "answered" && (await siteAsk).choice === "decline", "a Not now right after a pick was held back");
});

await row("a site card its caller closes closes alone, as not answered: another site's card and a page's stay open, and a yes after it applies nothing", async () => {
	const bench = askBench();
	const given: string[] = [];
	const closing = new AbortController();
	const closed = bench.bridge.askSite({ host: "crls.example", port: 80, lasting: true }, (choice) => { given.push(choice); return choice; }, closing.signal);
	const other = bench.bridge.askSite({ host: "other.example", port: 443, lasting: true }, (choice) => choice, new AbortController().signal);
	const page = bench.bridge.askSite({ host: "page.example", port: 443, lasting: false, address: "https://page.example/a" }, (choice) => choice);
	const [closedId, otherId, pageId] = bench.requests().map((frame) => frame.id!);
	bench.clock.now += 10_000;
	const from = bench.frames.length;
	closing.abort();
	const reply = oneFrame(bench, from, "the closed card");
	assert(reply.type === "ui_request_closed" && reply.id === closedId && reply.reason === "unanswered", `the closed card's frame: ${JSON.stringify(reply)}`);
	assert(await closed.then(() => false, () => true), "the closed card's caller got an answer");
	bench.bridge.resolveResponse(closedId, "once", "computer");
	assert(given.length === 0 && since(bench, from).length === 1, `a yes after the close applied, or was told: ${given} ${JSON.stringify(since(bench, from))}`);
	assert(bench.bridge.hasOpenQuestions(), "the other cards closed with it");
	bench.clock.now += 10_000;
	bench.bridge.resolveResponse(otherId, "once", "computer");
	bench.clock.now += 10_000;
	bench.bridge.resolveResponse(pageId, "decline", "computer");
	assert((await other).choice === "once" && (await page).choice === "decline" && !bench.bridge.hasOpenQuestions(), "the other site's card or the page's card didn't take its own answer");
	// A signal already aborted shows no card at all.
	const before = bench.frames.length;
	const gone = new AbortController();
	gone.abort();
	assert(await bench.bridge.askSite({ host: "late.example", port: 80, lasting: true }, (choice) => choice, gone.signal).then(() => false, () => true) && bench.frames.length === before, "a card whose caller had already gone was shown");
});

await row("ids are random, so an answer reaches only its own question, and one to an ended card gives nothing", async () => {
	const a = askBench();
	const b = askBench();
	const askedA = askSiteOn(a);
	const askedB = askSiteOn(b);
	const idA = a.requests()[0]!.id!;
	const idB = b.requests()[0]!.id!;
	assert(idA !== idB && /^ui_[0-9a-f-]{36}$/.test(idA), `the ids: ${idA} ${idB}`);
	a.answer("once");
	await askedA;
	const from = a.frames.length;
	a.bridge.resolveResponse(idA, "room", "computer");
	a.bridge.resolveResponse(idB, "room", "computer");
	assert(since(a, from).length === 0 && b.frames.length === 1, "an answer to an ended card, or to another bridge's, did something");
	b.answer("decline");
	assert((await askedB).choice === "decline", "the other card still asks");
});

await row("an answer to an ended card, or to another bridge's, never reaches the card that is open: it stays open, gives nothing, and its own answer still counts", async () => {
	const other = askBench();
	const otherAsk = askSiteOn(other);
	const otherId = other.requests()[0]!.id!;
	const bench = askBench({ room: { folder: newFolder("stray-answers") } });
	const ended = askSiteOn(bench);
	const endedId = bench.requests()[0]!.id!;
	bench.answer("decline");
	await ended;
	const given: string[] = [];
	let siteDone = false;
	const siteAsk = askSiteOn(bench, (choice) => { given.push(choice); return choice; });
	void siteAsk.then(() => { siteDone = true; });
	const siteId = bench.requests().at(-1)!.id!;
	// Long after the card and the last answer: only the id can keep these from counting.
	bench.clock.now += 10_000;
	let from = bench.frames.length;
	bench.bridge.resolveResponse(endedId, "room", "computer");
	bench.bridge.resolveResponse(otherId, "room", "computer");
	await settle();
	assert(since(bench, from).length === 0 && given.length === 0 && !siteDone && bench.bridge.hasOpenQuestions(), `stray answers reached the site card: ${JSON.stringify(since(bench, from))}, given ${given}`);
	bench.answer("once");
	assert(given.join() === "once" && (await siteAsk).choice === "once" && bench.frames.at(-1)?.id === siteId && bench.frames.at(-1)?.taken === "once", `the site card's own answer: ${JSON.stringify(bench.frames.at(-1))}`);
	let commandsDone = false;
	const commandsAsk = bench.askCommands();
	void commandsAsk.then(() => { commandsDone = true; });
	await settle();
	const commandsId = bench.requests().at(-1)!.id!;
	assert(bench.requests().at(-1)?.kind === "commands", `the commands card: ${JSON.stringify(bench.requests().at(-1))}`);
	bench.clock.now += 10_000;
	from = bench.frames.length;
	for (const stale of [endedId, siteId, otherId]) bench.bridge.resolveResponse(stale, true, "computer");
	await settle();
	assert(since(bench, from).length === 0 && bench.turnedOn() === 0 && !commandsDone && bench.bridge.hasOpenQuestions(), `stray answers reached the commands card: ${JSON.stringify(since(bench, from))}`);
	bench.answer(true);
	assert(bench.turnedOn() === 1 && (await commandsAsk) === asks.COMMANDS_TURNED_ON && bench.frames.at(-1)?.id === commandsId && bench.frames.at(-1)?.taken === true, `the commands card's own answer: ${JSON.stringify(bench.frames.at(-1))}`);
	// The other bridge's card was never touched.
	assert(other.frames.length === 1, `the other bridge's frames: ${JSON.stringify(other.frames)}`);
	other.answer("decline");
	assert((await otherAsk).choice === "decline", "the other bridge's card still asks");
});

await row("a phone gets no question data: no folder line in any frame, and a device that only views gets no update", async () => {
	const room = newFolder("phone-line-room");
	const open = heldWindow();
	const bench = askBench({ room: { folder: room }, picks: [open.picked] });
	const asked = bench.askFolder("read", "To read /Users/ana/Finance");
	await settle();
	bench.answer(PRESSES.room);
	await settle();
	// The room moves to a device that only views: the window's answer reaches nobody.
	bench.bridge.detach("viewing");
	const from = bench.frames.length;
	open.close(path.dirname(room));
	await waitUntil(() => bench.bridge.hasOpenQuestions(), "the card stays");
	await settle();
	await settle();
	assert(since(bench, from).length === 0, `an update while detached: ${JSON.stringify(since(bench, from))}`);
	// Nor is the card asked again while detached: a press too soon, or a phone's, reaches nobody.
	bench.answer(PRESSES.choose, "computer", 0);
	bench.answer(false, "phone");
	assert(since(bench, from).length === 0 && bench.bridge.hasOpenQuestions(), `asked again while detached: ${JSON.stringify(since(bench, from))}`);
	// A phone takes the room: the card comes with its state, and with no line or reason.
	bench.bridge.attach("phone");
	const shown = oneFrame(bench, from, "the phone's card");
	assert(shown.type === "ui_request" && shown.again === true && !("line" in shown) && !("reason" in shown) && !JSON.stringify(shown).includes(path.basename(path.dirname(room))) && !JSON.stringify(shown).includes("Finance"), `the phone's card: ${JSON.stringify(shown)}`);
	// The computer gets the line back.
	bench.bridge.attach("computer");
	assert(bench.frames.at(-1)?.line === cards.folderHoldsRoomLine(path.basename(path.dirname(room))), `the computer's card: ${JSON.stringify(bench.frames.at(-1))}`);
	bench.answer(false);
	await asked;
	// A site card asked at the computer, then taken by a phone: the phone gets no room yes, which it could only give for this time.
	const site = askBench();
	const siteAsk = askSiteOn(site);
	assert(site.requests().at(-1)?.lasting === true, "the computer's site card offers a room yes");
	site.bridge.attach("phone");
	const onPhone = site.frames.at(-1);
	assert(onPhone?.type === "ui_request" && onPhone.again === true && onPhone.lasting === false, `the phone's site card: ${JSON.stringify(onPhone)}`);
	site.answer("decline", "phone");
	await siteAsk;
});

await row("a phone that holds the turn while the computer's folder window answers gets each update without the folder's line; the computer gets the line", async () => {
	const room = newFolder("phone-update-room");
	const parent = path.basename(path.dirname(room));
	const refused = heldWindow();
	const cancelled = heldWindow();
	const atComputer = heldWindow();
	const bench = askBench({ room: { folder: room }, picks: [refused.picked, cancelled.picked, atComputer.picked] });
	const asked = bench.askFolder("read");
	await settle();
	const id = bench.requests().at(-1)!.id!;
	bench.answer(PRESSES.choose);
	await settle();
	bench.bridge.attach("phone");
	const updates = (from: number) => since(bench, from).filter((frame) => frame.type === "ui_request_update");
	// A refused pick: the line names the folder above the room's.
	let from = bench.frames.length;
	refused.close(path.dirname(room));
	await waitUntil(() => updates(from).length > 0, "the refused pick's update");
	const afterRefused = oneFrame(bench, from, "the phone's update after a refused pick");
	assert(afterRefused.line === null && afterRefused.canChoose === true && afterRefused.choosing === null && !JSON.stringify(afterRefused).includes(parent), `the phone's update after a refused pick: ${JSON.stringify(afterRefused)}`);
	// A window closed with no pick: the card's line from before must not come with this update either.
	bench.answer(PRESSES.choose);
	await settle();
	from = bench.frames.length;
	cancelled.close(null);
	await waitUntil(() => updates(from).length > 0, "the cancelled window's update");
	const afterCancelled = oneFrame(bench, from, "the phone's update after a cancelled window");
	assert(afterCancelled.line === null && afterCancelled.canChoose === true && afterCancelled.choosing === null && !JSON.stringify(afterCancelled).includes(parent), `the phone's update after a cancelled window: ${JSON.stringify(afterCancelled)}`);
	// The computer takes the turn back: its own update carries the line.
	bench.bridge.attach("computer");
	bench.answer(PRESSES.choose);
	await settle();
	from = bench.frames.length;
	atComputer.close(path.dirname(room));
	await waitUntil(() => updates(from).length > 0, "the computer's update");
	const atTheComputer = oneFrame(bench, from, "the computer's update after a refused pick");
	assert(atTheComputer.id === id && atTheComputer.line === cards.folderHoldsRoomLine(parent), `the computer's update after a refused pick: ${JSON.stringify(atTheComputer)}`);
	bench.answer(false);
	await asked;
});

await row("a commands yes that couldn't be saved keeps the card open with its line, the model waits, and the card sent again keeps its protection line", async () => {
	let failing = true;
	const bench = askBench({ room: { folder: newFolder("save-fails") }, turnOn: () => { if (failing) throw new Error("disk full"); } });
	const asked = bench.askCommands();
	await settle();
	let done = false;
	void asked.then(() => { done = true; });
	let from = bench.frames.length;
	bench.answer(true);
	const failed = oneFrame(bench, from, "a failed save");
	assert(failed.type === "ui_request_update" && failed.failure === cards.CHANGE_SAVE_FAILED && !("line" in failed), `a failed save: ${JSON.stringify(failed)}`);
	await settle();
	assert(!done && bench.bridge.hasOpenQuestions(), "the model was answered after a failed save");
	// Too soon after that update, it is asked again with its protection line and the failure both.
	from = bench.frames.length;
	bench.answer(true, "computer", 1);
	const again = oneFrame(bench, from, "the card sent again");
	assert(again.type === "ui_request" && again.line === "in-box" && again.failure === cards.CHANGE_SAVE_FAILED, `the card sent again: ${JSON.stringify(again)}`);
	// A paired phone's card keeps the protection line too.
	bench.bridge.attach("phone");
	assert(bench.frames.at(-1)?.line === "in-box", `the phone's card: ${JSON.stringify(bench.frames.at(-1))}`);
	bench.bridge.attach("computer");
	failing = false;
	bench.answer(true);
	assert(bench.frames.at(-1)?.reason === "answered" && bench.frames.at(-1)?.taken === true && (await asked) === asks.COMMANDS_TURNED_ON, "the second yes");
	// A site yes whose save failed: the same line, and the caller waits.
	const site = askBench();
	const siteAsk = askSiteOn(site, () => { throw new Error("disk full"); });
	from = site.frames.length;
	site.answer("room");
	const siteFailed = oneFrame(site, from, "a site's failed save");
	assert(siteFailed.type === "ui_request_update" && siteFailed.failure === cards.CHANGE_SAVE_FAILED, `a site's failed save: ${JSON.stringify(siteFailed)}`);
	site.answer("decline");
	assert((await siteAsk).choice === "decline", "the no after it");
	// A caller whose turn already ended: the card reads as not answered, and the caller gets a no.
	const late = askBench();
	const lateAsk = askSiteOn(late, () => null);
	late.answer("once");
	assert(late.frames.at(-1)?.reason === "unanswered" && (await lateAsk).choice === "decline", `a yes after the turn: ${JSON.stringify(late.frames.at(-1))}`);
});

await row("a commands yes whose save fails after its first write puts back what was stored: commands stay as they were and no Run without asking is left", () => {
	const room = plantRoom(false);
	saveDefault(room.id, room.folder, false);
	const stored = () => JSON.stringify(policy.readPersistentRoomDefaultCapabilityPolicy(room.id));
	const before = stored();
	const settings = bashSettings.persistentRoomBashSettingsPath(room.id);
	// A folder where Run without asking's file is first written: the last write fails, after the room's own policy was written.
	const blocker = `${settings}.${process.pid}.tmp`;
	fs.mkdirSync(blocker, { recursive: true });
	let threw = false;
	try {
		withProtection(() => asks.setRoomCommands(room.id, "a-conversation", true));
	} catch {
		threw = true;
	}
	fs.rmSync(blocker, { recursive: true });
	assert(threw, "the failed save didn't reach the caller");
	assert(stored() === before && commandsOf(room.id) === "off", `a failed save left commands changed: ${commandsOf(room.id)}`);
	assert(!fs.existsSync(settings), "a failed save left Run without asking stored");
	// With the fault gone, the same yes turns them on.
	withProtection(() => asks.setRoomCommands(room.id, "a-conversation", true));
	assert(commandsOf(room.id) !== "off" && withProtection(() => bashSettings.readPersistentRoomBashSettings(room.id).autoApprove), "the yes after it");
});

await row("a folder's give that couldn't be written says so in a field of its own, beside its line", async () => {
	const room = plantRoom(false);
	const picked = newFolder("give-fails");
	// This answer's folders, whose give fails as a full disk would.
	const answer = Object.assign(new asks.AnswerFolders(), { give: () => { throw new Error("disk full"); } });
	const outcome = await asks.chooseFolderForRoom({ roomId: room.id, room: { folder: room.folder, canChangeFiles: true, commands: "may-ask", boxed: true }, access: "read", pickFolder: async () => ({ ok: true, supported: true, cancelled: false, path: picked }), signal: new AbortController().signal, answer, lasts: "answer", look: async () => "listed" });
	assert("line" in outcome && outcome.unsaved === true && outcome.line === cards.CHANGE_SAVE_FAILED && outcome.canChoose, `a give that couldn't be written: ${JSON.stringify(outcome)}`);
	// A refusal is no failed save.
	const refused = await asks.chooseFolderForRoom({ roomId: room.id, room: { folder: room.folder, canChangeFiles: true, commands: "may-ask", boxed: true }, access: "read", pickFolder: async () => ({ ok: true, supported: true, cancelled: false, path: picked }), signal: new AbortController().signal, answer, lasts: "answer", look: async () => "refused" });
	assert("line" in refused && !("unsaved" in refused), `a refused look: ${JSON.stringify(refused)}`);
});

await row("a closing frame lost with the connection comes back on attach, before any open question", async () => {
	const bench = askBench({ room: { folder: newFolder("lost-reply") } });
	const roomYes = askSiteOn(bench);
	// A room's own ask stays open across the move; a site card ends with the connection.
	const stillOpen = bench.askCommands();
	await settle();
	const [answered, open] = bench.requests();
	bench.clock.now += cards.ANSWER_FLOOR_MS;
	bench.bridge.resolveResponse(answered!.id!, "room", "computer");
	// The connection went before the page read it.
	bench.frames.length = 0;
	bench.bridge.detach("gone");
	bench.bridge.attach("computer");
	assert(bench.frames.length === 2 && bench.frames[0].type === "ui_request_closed" && bench.frames[0].id === answered!.id && bench.frames[0].taken === "room" && bench.frames[1].type === "ui_request" && bench.frames[1].id === open!.id, `on attach: ${JSON.stringify(bench.frames)}`);
	assert((await roomYes).choice === "room", "the room yes");
	bench.answer(false);
	assert((await stillOpen) === asks.COMMANDS_NOT_NOW, "the commands card after the move");
	// The next answer starts: what the last one took is nobody's to catch up on.
	bench.bridge.reopen();
	bench.frames.length = 0;
	bench.bridge.attach("computer");
	assert(bench.frames.length === 0, `the last answer's closing frames after the next began: ${JSON.stringify(bench.frames)}`);
});

await row("a folder is given only after the look, while the card is open and the folder unchanged; Not now, Stop or a message during the look gives nothing", async () => {
	const room = newFolder("look-room");
	const run = async (label: string, during: (bench: Bench, look: ReturnType<typeof heldLook>, picked: string) => void, expect: { said: string; line?: string }, looked: Look = "listed", lasts: "answer" | "room" = "answer") => {
		const picked = newFolder(`look-${label.replace(/\W+/g, "-")}`);
		const look = heldLook();
		const bench = askBench({ room: { folder: room }, picks: [{ ok: true, supported: true, cancelled: false, path: picked }], look: look.look });
		const given = bench.answerFolders().over([]);
		const asked = bench.askFolder("read");
		await settle();
		await bench.give(lasts);
		await waitUntil(() => look.started() === 1, `${label}: the look starts`);
		const pressed = bench.frames.length;
		assert(readAlsoAllowed(bench.roomId).folders.length === 0 && bench.answerFolders().over([]).length === 0, `${label}: given before the look`);
		during(bench, look, picked);
		look.release(looked);
		await settle();
		await settle();
		if (expect.line) {
			await waitUntil(() => since(bench, pressed).some((frame) => frame.type === "ui_request_update"), `${label}: the line`);
			assert(bench.frames.at(-1)?.line === expect.line && bench.answerFolders().over([]).length === 0, `${label}: ${JSON.stringify(bench.frames.at(-1))}`);
			bench.answer(false);
		}
		const said = await asked;
		assert(said === expect.said, `${label}: the model was told ${said}`);
		assert(readAlsoAllowed(bench.roomId).folders.length === 0 && JSON.stringify(bench.answerFolders().over([])) === JSON.stringify(given), `${label}: something was given`);
		return bench;
	};
	await run("Not now", (bench) => bench.answer(false), { said: asks.FOLDER_NOT_NOW });
	await run("Not now, for this room", (bench) => bench.answer(false), { said: asks.FOLDER_NOT_NOW }, "listed", "room");
	await run("Stop, for this room", (bench) => bench.bridge.declineOpenQuestions("Stopped."), { said: "Stopped." }, "listed", "room");
	await run("Stop", (bench) => bench.bridge.declineOpenQuestions("Stopped."), { said: "Stopped." });
	await run("a message", (bench) => bench.bridge.declineOpenQuestionsOnce("A message came."), { said: "A message came." });
	await run("a refused look", () => {}, { said: asks.FOLDER_NOT_NOW, line: cards.FOLDER_PICK_REFUSED_IN_PANEL }, "refused");
	await run("a look over its limit", () => {}, { said: asks.FOLDER_NOT_NOW, line: cards.FOLDER_PICK_REFUSED_IN_PANEL }, "slow");
	await run("a folder replaced during the look", (_bench, _look, picked) => replaceFolder(picked), { said: asks.FOLDER_NOT_NOW, line: cards.FOLDER_PICK_REFUSED_IN_PANEL });
	await run("a folder turned into a link during the look", (_bench, _look, picked) => {
		fs.rmSync(picked, { recursive: true });
		fs.symlinkSync(newFolder("look-elsewhere"), picked);
	}, { said: asks.FOLDER_NOT_NOW, line: cards.FOLDER_PICK_REFUSED_IN_PANEL });
	// A parent of the pick moved during the look, with a link left at its old name: the folder keeps its disk and file number, but its path now passes through a link.
	for (const lasts of ["answer", "room"] as const) {
		const parent = newFolder(`look-parent-${lasts}`);
		const inside = path.join(parent, "inside");
		fs.mkdirSync(inside);
		const swapLook = heldLook();
		const swapped = askBench({ room: { folder: room }, picks: [{ ok: true, supported: true, cancelled: false, path: inside }], look: swapLook.look });
		const swappedAsk = swapped.askFolder("read");
		await settle();
		await swapped.give(lasts);
		await waitUntil(() => swapLook.started() === 1, `a parent swapped (${lasts}): the look starts`);
		// For this answer, the folder shown before the press is an update too: only what comes after the swap counts.
		const swappedAt = swapped.frames.length;
		fs.renameSync(parent, `${parent}-moved`);
		fs.symlinkSync(`${parent}-moved`, parent);
		swapLook.release("listed");
		await waitUntil(() => since(swapped, swappedAt).some((frame) => frame.type === "ui_request_update"), `a parent swapped (${lasts}): the line`);
		assert(swapped.frames.at(-1)?.line === cards.FOLDER_PICK_REFUSED_IN_PANEL && readAlsoAllowed(swapped.roomId).folders.length === 0 && swapped.answerFolders().over([]).length === 0, `a parent swapped for a link (${lasts}): ${JSON.stringify(swapped.frames.at(-1))}`);
		swapped.answer(false);
		assert((await swappedAsk) === asks.FOLDER_NOT_NOW, `a parent swapped (${lasts}): the Not now after it`);
	}
	// While a look waits, the server goes on answering: another card is asked and answered.
	const look = heldLook();
	const picked = newFolder("look-given");
	const bench = askBench({ room: { folder: room }, picks: [{ ok: true, supported: true, cancelled: false, path: picked }], look: look.look });
	const asked = bench.askFolder("read");
	await settle();
	await bench.give("answer");
	await waitUntil(() => look.started() === 1, "the look starts");
	const other = askBench();
	const otherAsk = askSiteOn(other);
	other.answer("once");
	assert((await otherAsk).choice === "once", "another card waited on the look");
	// Released, with a Not now queued right behind it: the folder is given and the card closed first, so the Not now finds nothing.
	look.release("listed");
	setImmediate(() => bench.answer(false));
	const said = await asked;
	await settle();
	assert(said.includes(`The person chose ${picked} for this answer only.`), `the model: ${said}`);
	const closing = bench.frames.filter((frame) => frame.type === "ui_request_closed");
	assert(closing.length === 1 && closing[0].reason === "chosen" && bench.answerFolders().over([]).some((entry) => entry.path === picked), `the give and its close: ${JSON.stringify(closing)}`);
});

await row("the first look itself: a folder the person can't list gives nothing and shows the line, and a listing that waits past the limit gives nothing", async () => {
	const readable = newFolder("first-look-readable");
	assert((await asks.firstLook(readable)) === "listed", "a folder that lists");
	// chmod has no teeth on Windows or as root.
	if (process.platform === "win32" || process.getuid?.() === 0) {
		console.log("  skip the first look's refusal and limit: no chmod or FIFOs here");
		return;
	}
	const shut = newFolder("first-look-shut");
	fs.chmodSync(shut, 0o000);
	try {
		assert((await asks.firstLook(shut)) === "refused", "a folder that can't be listed");
		const bench = askBench({ room: { folder: newFolder("first-look-room") }, picks: [{ ok: true, supported: true, cancelled: false, path: shut }] });
		const asked = bench.askFolder("read");
		await settle();
		bench.answer(PRESSES.room);
		await waitUntil(() => bench.frames.at(-1)?.type === "ui_request_update", "the refused pick's line");
		assert(bench.frames.at(-1)?.line === cards.FOLDER_PICK_REFUSED_IN_PANEL && readAlsoAllowed(bench.roomId).folders.length === 0, `a folder that can't be listed: ${JSON.stringify(bench.frames.at(-1))}`);
		bench.answer(false);
		assert((await asked) === asks.FOLDER_NOT_NOW, "the Not now after it");
	} finally {
		fs.chmodSync(shut, 0o755);
	}
	// Every thread Node lists folders on waits to open a pipe nobody writes to, so the listing can't answer before the limit.
	const threads = Number(process.env.UV_THREADPOOL_SIZE) || 4;
	const pipes = Array.from({ length: threads }, (_, at) => path.join(newFolder(`first-look-pipe-${at}`), "pipe"));
	for (const pipe of pipes) childProcess.execFileSync("mkfifo", [pipe]);
	const held = pipes.map((pipe) => fs.promises.open(pipe, "r"));
	try {
		const looked = await Promise.race([asks.firstLook(readable, 50), new Promise((resolve) => setTimeout(() => resolve("no answer"), 5_000))]);
		assert(looked === "slow", `a listing past the limit: ${looked}`);
	} finally {
		// A writer that opens each pipe lets its reader go.
		for (const pipe of pipes) fs.closeSync(fs.openSync(pipe, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
		for (const opened of await Promise.all(held)) await opened.close();
	}
});

await row("a pick already allowed says so; a room with no folder of its own gets no folder card and nothing on its list", async () => {
	const roomFolder = newFolder("already-room");
	const inside = newFolder("already-room/Reports");
	const bench = askBench({ room: { folder: roomFolder }, picks: [{ ok: true, supported: true, cancelled: false, path: inside }] });
	const asked = bench.askFolder("change");
	await settle();
	bench.answer("choose");
	assert((await asked).startsWith("This room can already read and change files in"), "inside the room's folder");
	const kept = bench.details()[cards.ASK_FOLDER] as { name?: string; access?: string } | undefined;
	assert(kept?.name === "Reports" && kept.access === "write", `the step keeps no folder for the line under it: ${JSON.stringify(bench.details())}`);
	assert(readAlsoAllowed(bench.roomId).folders.length === 0, "a folder already allowed went on the list");
	const plans = newFolder("Plans");
	const none = askBench({ room: { folder: null }, picks: [{ ok: true, supported: true, cancelled: false, path: plans }] });
	assert((await none.askFolder("read")) === asks.NO_FOLDER_OF_ITS_OWN && none.requests().length === 0, `a room with no folder showed a folder card: ${JSON.stringify(none.requests())}`);
	assert(readAlsoAllowed(none.roomId).folders.length === 0, "a room with no folder got a folder on its list");
	// A folder on the list that may change, in a room whose writing tools are off: the room can only read it.
	const readOnlyRoom = newFolder("already-read-only-room");
	const ledger = newFolder("Ledger");
	const readOnly = askBench({ room: { folder: readOnlyRoom, canChangeFiles: false }, picks: [{ ok: true, supported: true, cancelled: false, path: ledger }] });
	addAlsoAllowedFolder(readOnly.roomId, ledger, "write");
	const readAsk = readOnly.askFolder("read");
	await settle();
	readOnly.answer("choose");
	const readAnswer = await readAsk;
	const readKept = readOnly.details()[cards.ASK_FOLDER] as { access?: string } | undefined;
	assert(readAnswer.startsWith("This room can already read files in") && readKept?.access === "read", `a room that can't change files was told it can change a listed folder: ${readAnswer} ${JSON.stringify(readKept)}`);
});

await row("a folder on the list that can only read, asked for with access change on the folder card: Allow for this room… turns its entry to Can read and change, and Only allow reading takes it back; Not now leaves it", async () => {
	const finance = newFolder("Finance Q9");
	const pick = { ok: true, supported: true, cancelled: false, path: finance } as const;
	const bench = askBench({ room: { folder: newFolder("change-room") }, picks: [pick, pick] });
	addAlsoAllowedFolder(bench.roomId, finance, "read");
	const access = () => readAlsoAllowed(bench.roomId).folders.find((entry) => entry.path === finance)?.access;
	const asked = bench.askFolder("change");
	await settle();
	const card = bench.requests().at(-1);
	assert(card?.kind === "folder" && card.access === "write", `the card: ${JSON.stringify(card)}`);
	bench.answer(PRESSES.room);
	assert((await asked).startsWith(`The person chose ${finance}. This room can now read and change files there`) && access() === "write", `after Allow for this room…: ${access()}`);
	assert(readAlsoAllowed(bench.roomId).folders.length === 1, `one entry: ${JSON.stringify(readAlsoAllowed(bench.roomId).folders)}`);
	assert(asks.undoAllowChanges(bench.roomId, finance) && access() === "read", `after Only allow reading: ${access()}`);
	assert(!asks.undoAllowChanges(bench.roomId, finance), "back to reading on a folder that can only read");
	const notNow = bench.askFolder("change");
	await settle();
	bench.answer(false);
	assert((await notNow) === asks.FOLDER_NOT_NOW && access() === "read" && bench.answerFolders().over([]).length === 0, "Not now let it change files");
});

const json2 = (value: unknown) => JSON.stringify(value);
const pickOf = (folder: string): Picked => ({ ok: true, supported: true, cancelled: false, path: folder });

await row("Allow this time… gives the picked folder for this answer only: nothing goes on the list, the model is told so, and the next answer starts with none", async () => {
	const invoices = newFolder("Invoices");
	const bench = askBench({ room: { folder: newFolder("this-time-room") }, picks: [pickOf(invoices)] });
	const asked = bench.askFolder("read");
	await settle();
	await bench.give("answer");
	const result = await asked;
	assert(result.includes(`The person chose ${invoices} for this answer only.`) && result.includes("until it finishes answering this message") && result.includes("Don't count on it in a later answer."), `the model: ${result}`);
	assert(readAlsoAllowed(bench.roomId).folders.length === 0, `the list: ${json2(readAlsoAllowed(bench.roomId).folders)}`);
	assert(json2(bench.details()[cards.ASK_FOLDER]) === json2({ path: invoices, name: "Invoices", access: "read", lasts: "answer" }), `the line's folder: ${json2(bench.details())}`);
	assert(json2(bench.answerFolders().over([])) === json2([{ path: invoices, access: "read" }]), `this answer's folders: ${json2(bench.answerFolders().over([]))}`);
	bench.endAnswer();
	assert(bench.answerFolders().over([]).length === 0, "the next answer started with the folder");
	// Allow for this room… is today's Choose a folder…: the pick goes on the list, and says it lasts.
	const room = askBench({ room: { folder: newFolder("for-room-room") }, picks: [pickOf(invoices)] });
	const roomAsk = room.askFolder("change");
	await settle();
	room.answer(PRESSES.room);
	assert((await roomAsk).startsWith(`The person chose ${invoices}. This room can now read and change files there`), "Allow for this room…");
	assert(json2(readAlsoAllowed(room.roomId).folders) === json2([{ path: invoices, access: "write" }]) && room.answerFolders().over([]).length === 0, `for this room: ${json2(readAlsoAllowed(room.roomId).folders)}`);
	assert(json2(room.details()[cards.ASK_FOLDER]) === json2({ path: invoices, name: "Invoices", access: "write" }), `the line's folder: ${json2(room.details())}`);
});

await row("already knows how long: a this-time pick another this-time pick or the list covers answers already; Allow for this room… on a folder only this answer has goes on the list", async () => {
	const ledgers = newFolder("Ledgers");
	const bench = askBench({ room: { folder: newFolder("already-how-long-room") }, picks: [pickOf(ledgers), pickOf(ledgers), pickOf(ledgers), pickOf(ledgers)] });
	const pickWith = async (lasts: "answer" | "room") => {
		const asked = bench.askFolder("read");
		await settle();
		await bench.give(lasts);
		return { text: await asked, outcome: bench.details()[cards.ASK_OUTCOME] };
	};
	assert((await pickWith("answer")).outcome === "yes", "the first pick this time");
	const again = await pickWith("answer");
	assert(again.outcome === "already" && again.text.startsWith(`This room can already read files in ${ledgers}`), `the second this time: ${json2(again)}`);
	const lasting = await pickWith("room");
	assert(lasting.outcome === "yes" && json2(readAlsoAllowed(bench.roomId).folders) === json2([{ path: ledgers, access: "read" }]), `for this room, over this time only: ${json2(lasting)} ${json2(readAlsoAllowed(bench.roomId).folders)}`);
	assert(bench.answerFolders().over([]).length === 0, `the folder is the list's now, not this answer's too: ${json2(bench.answerFolders().over([]))}`);
	const listed = await pickWith("answer");
	assert(listed.outcome === "already", `this time, over the list: ${json2(listed)}`);
});

await row("a folder given this time and then for this room is the list's: Remove takes it away, a change given this time stays for this answer over an entry that reads, and Undo brings back no change", async () => {
	const reports = newFolder("Reports");
	const bench = askBench({ room: { folder: newFolder("then-for-room-room") }, picks: [pickOf(reports), pickOf(reports), pickOf(reports), pickOf(reports), pickOf(reports)] });
	const list = () => readAlsoAllowed(bench.roomId).folders;
	const reach = () => json2(bench.answerFolders().over(list()));
	const pick = async (access: "read" | "change", lasts: "answer" | "room") => {
		const asked = bench.askFolder(access);
		await settle();
		await bench.give(lasts);
		return asked;
	};
	await pick("read", "answer");
	await pick("read", "room");
	assert(asks.removeAskedFolder(bench.roomId, reports, bench.answerFolders()) === "read" && reach() === "[]", `after Remove, read this time: ${reach()}`);
	await pick("change", "answer");
	await pick("read", "room");
	assert(json2(list()) === json2([{ path: reports, access: "read" }]) && reach() === json2([{ path: reports, access: "write" }]), `the list reads, this answer changes: ${json2(list())} ${reach()}`);
	// Remove, then Undo before any tool looks: Undo puts the entry back as it was saved.
	assert(asks.removeAskedFolder(bench.roomId, reports, bench.answerFolders()) === "read", "Remove, changed this time");
	addAlsoAllowedFolder(bench.roomId, reports, "read");
	assert(reach() === json2([{ path: reports, access: "read" }]), `after Remove and Undo: ${reach()}`);
	// A folder on the list to read, picked this time to change: this answer's own pick, which a remove in another window leaves, as it leaves any pick for this answer.
	await pick("change", "answer");
	assert(reach() === json2([{ path: reports, access: "write" }]), `picked this time to change: ${reach()}`);
	assert(asks.removeAskedFolder(bench.roomId, reports) === "read" && reach() === json2([{ path: reports, access: "write" }]), `after a remove in another window: ${reach()}`);
	bench.endAnswer();
	assert(bench.answerFolders().over(list()).length === 0, `the next answer: ${json2(bench.answerFolders().over(list()))}`);
});

await row("a refused pick is refused the same under either button; a pick through a link planted in a folder given this time to change is refused, and the same pick through a folder given to read is not", async () => {
	const roomFolder = newFolder("refused-both-room");
	for (const lasts of ["answer", "room"] as const) {
		const bench = askBench({ room: { folder: roomFolder }, picks: [pickOf(path.dirname(roomFolder)), pickOf(policy.persistentAgentRootPath("asks-room-1"))] });
		const asked = bench.askFolder("read");
		await settle();
		const updates = () => bench.frames.filter((frame) => frame.type === "ui_request_update").map((frame) => frame.line);
		for (const lines of [1, 2]) {
			bench.answer(lasts === "room" ? PRESSES.room : PRESSES.choose);
			await waitUntil(() => updates().length === lines, `${lasts}: the window's answer`);
		}
		assert(json2(updates()) === json2([cards.folderHoldsRoomLine(path.basename(path.dirname(roomFolder))), cards.folderRefusedLine({ reason: "private" }, "", cards.FOLDER_PICK_REFUSED_IN_PANEL)]), `${lasts}: ${json2(updates())}`);
		assert(readAlsoAllowed(bench.roomId).folders.length === 0 && bench.answerFolders().over([]).length === 0, `${lasts}: a refused pick was given`);
		bench.answer(false);
		await asked;
	}
	const target = newFolder("Planted Target");
	for (const [given, refused] of [["write", true], ["read", false]] as const) {
		const holder = newFolder(`planted-in-${given}`);
		const link = path.join(holder, "looks-like-reports");
		fs.symlinkSync(target, link);
		for (const lasts of ["answer", "room"] as const) {
			const bench = askBench({ room: { folder: roomFolder }, picks: [pickOf(link)] });
			bench.answerFolders().give(holder, given);
			const asked = bench.askFolder("read");
			await settle();
			await bench.give(lasts);
			if (refused) {
				await waitUntil(() => bench.frames.some((frame) => frame.type === "ui_request_update"), `${given} ${lasts}: the window's answer`);
				assert(bench.frames.find((frame) => frame.type === "ui_request_update")?.line === cards.FOLDER_PICK_REFUSED_IN_PANEL && readAlsoAllowed(bench.roomId).folders.length === 0, `a link planted in a folder given to ${given}, ${lasts}`);
				bench.answer(false);
				await asked;
			} else {
				const result = await asked;
				assert(result.includes(`The person chose ${target}`), `a link in a folder given to read, ${lasts}: ${result}`);
			}
		}
	}
});

await row("a yes never opens an agent folder a setting moved out of the app's data: a pick of it, of a folder in it or of one that holds it is refused, for reading and for changing; a folder beside it is given", async () => {
	const roomFolder = newFolder("moved-agent-room");
	const moved = newFolder("Code/agent");
	const library = newFolder("Code/agent/skills/report");
	const beside = newFolder("Code/project");
	process.env.EXXPERTS_CODING_AGENT_DIR = moved;
	try {
		for (const access of ["read", "change"] as const) {
			for (const picked of [moved, library, path.dirname(moved)]) {
				const bench = askBench({ room: { folder: roomFolder }, picks: [pickOf(picked)] });
				const asked = bench.askFolder(access);
				await settle();
				bench.answer(PRESSES.choose);
				await waitUntil(() => bench.frames.some((frame) => frame.type === "ui_request_update"), `${access} ${picked}: the window's answer`);
				const line = bench.frames.find((frame) => frame.type === "ui_request_update")?.line;
				const why = picked === path.dirname(moved) ? cards.folderRefusedLine({ reason: "holds-closed" }, path.basename(picked), "") : cards.folderRefusedLine({ reason: "private" }, "", "");
				assert(line === why && readAlsoAllowed(bench.roomId).folders.length === 0 && bench.answerFolders().over([]).length === 0, `${access} ${picked}: ${json2({ line, list: readAlsoAllowed(bench.roomId).folders })}`);
				bench.answer(false);
				await asked;
			}
			const bench = askBench({ room: { folder: roomFolder }, picks: [pickOf(beside)] });
			const asked = bench.askFolder(access);
			await settle();
			await bench.give("answer");
			const result = await asked;
			assert(result.includes(`The person chose ${beside}`), `${access}, the folder beside it: ${result}`);
		}
	} finally {
		process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	}
});

await row("inside a folder given this time to change, Allow for this room… and Choose folder say the room can already use it and the card stays; inside one given this time to read, the pick goes on the list", async () => {
	const roomFolder = newFolder("usable-this-time-room");
	const changed = newFolder("Changed This Time");
	const inside = newFolder(path.join("Changed This Time", "March"));
	const bench = askBench({ room: { folder: roomFolder }, picks: [pickOf(inside), pickOf(inside)] });
	bench.answerFolders().give(changed, "write");
	const asked = bench.askFolder("read");
	await settle();
	bench.answer(PRESSES.room);
	await waitUntil(() => bench.frames.some((frame) => frame.type === "ui_request_update"), "the window's answer");
	const update = bench.frames.find((frame) => frame.type === "ui_request_update");
	assert(update?.line === cards.folderUsableThisTimeLine("March") && cards.folderUsableThisTimeLine("March") === "This room can already use March while it answers this message. You can allow it for this room in Room settings after that.", `Allow for this room…: ${json2(update)}`);
	assert(update?.canChoose === true && !bench.frames.some((frame) => frame.type === "ui_request_closed") && readAlsoAllowed(bench.roomId).folders.length === 0, `the card stays and nothing is listed: ${json2(bench.frames)} ${json2(readAlsoAllowed(bench.roomId).folders)}`);
	const from = bench.frames.length;
	bench.answer(PRESSES.choose);
	const chosen = await bench.replyFrom(from);
	assert(chosen.line === cards.folderUsableThisTimeLine("March") && chosen.suggested === null && readAlsoAllowed(bench.roomId).folders.length === 0, `Choose folder: ${json2(chosen)}`);
	bench.answer(false);
	assert((await asked) === asks.FOLDER_NOT_NOW, "the card after Choose folder");
	// Given this time only to read: nothing a command can change holds the pick, so the room's list takes it.
	const read = askBench({ room: { folder: roomFolder }, picks: [pickOf(inside)] });
	read.answerFolders().give(changed, "read");
	const readAsk = read.askFolder("read");
	await settle();
	read.answer(PRESSES.room);
	const listed = await readAsk;
	assert(listed.startsWith(`The person chose ${inside}.`) && json2(readAlsoAllowed(read.roomId).folders) === json2([{ path: inside, access: "read" }]), `inside a folder given to read: ${listed} ${json2(readAlsoAllowed(read.roomId).folders)}`);
});

await row("a pick that lands after its answer ended adds nothing, and the card stays for Not now", async () => {
	const late = newFolder("Late Pick");
	let land: (picked: Picked) => void = () => {};
	const held = new Promise<Picked>((resolve) => { land = resolve; });
	const bench = askBench({ room: { folder: newFolder("late-room") }, picks: [held as unknown as Picked] });
	const asked = bench.askFolder("read");
	await settle();
	bench.answer(PRESSES.choose);
	await settle();
	const ended = bench.answerFolders();
	bench.endAnswer();
	land(pickOf(late));
	await settle();
	await settle();
	assert(!bench.frames.some((frame) => frame.type === "ui_request_closed") && ended.over([]).length === 0 && bench.answerFolders().over([]).length === 0, `the late pick landed: ${json2(bench.frames)}`);
	assert(!ended.give(late, "read"), "an ended answer took a folder");
	bench.answer(false);
	assert((await asked) === asks.FOLDER_NOT_NOW && readAlsoAllowed(bench.roomId).folders.length === 0, "after the late pick");
});

await row("Allow this time… with access change on a folder on the list that can only read: this answer changes files there, the list stays at Can read, and the next answer reads only", async () => {
	const listed = newFolder("Listed Q9");
	const bench = askBench({ room: { folder: newFolder("change-this-time-room") }, picks: [pickOf(listed)] });
	addAlsoAllowedFolder(bench.roomId, listed, "read");
	const asked = bench.askFolder("change");
	await settle();
	await bench.give("answer");
	const result = await asked;
	assert(result.includes(`The person chose ${listed} for this answer only.`) && bench.details()[cards.ASK_OUTCOME] === "yes", `Allow this time…: ${result}`);
	assert(json2(readAlsoAllowed(bench.roomId).folders) === json2([{ path: listed, access: "read" }]), `the list after this time: ${json2(readAlsoAllowed(bench.roomId).folders)}`);
	assert(json2(bench.answerFolders().over(readAlsoAllowed(bench.roomId).folders)) === json2([{ path: listed, access: "write" }]), "this answer can change it, once on the list");
	bench.endAnswer();
	assert(json2(bench.answerFolders().over(readAlsoAllowed(bench.roomId).folders)) === json2([{ path: listed, access: "read" }]), "the next answer can change it");
});

// --- The folder the room suggests: what the panel shows, what a press gives, and what the model learns.
/** A folder under the home, outside Documents. */
function homeFolder(rel: string): string {
	const dir = path.join(home, rel);
	fs.mkdirSync(dir, { recursive: true });
	return fs.realpathSync(dir);
}
/**
 * The room's guess at a folder, in other letters where the file system
 * ignores case. Elsewhere other letters name no folder, so the guess keeps the
 * folder's own and says the other letters were not tried.
 */
const ignoresCase = fs.existsSync(path.join(home, "documents"));
function roomSpelling(otherLetters: string, ownLetters: string): string {
	if (ignoresCase) return otherLetters;
	console.log(`SKIPPED: the room's guess ${otherLetters} for ${ownLetters} (only where the file system ignores case)`);
	return ownLetters;
}
type Shown = { name: string; path: string; once: boolean };
const cardOf = (bench: Bench) => bench.requests().at(-1)!;
const listed = (bench: Bench) => readAlsoAllowed(bench.roomId).folders;
/** A suggestion's card, open on the bench: the folder it shows, or none. */
async function suggest(bench: Bench, folder: string, access: "read" | "change" = "read") {
	const asked = bench.askFolder(access, "The invoices are in another folder.", folder);
	await waitUntil(() => bench.requests().length > 0, "the card");
	return { asked, shown: cardOf(bench).suggested as Shown | undefined };
}
/** One press, and the panel's reply to it. */
async function press(bench: Bench, value: string): Promise<Frame> {
	const from = bench.frames.length;
	bench.answer(value);
	return bench.replyFrom(from);
}

await row("a suggestion reaches the computer as the folder's real name and path, never as the room's words, and Allow this time gives it for this answer", async () => {
	const reports = newFolder("Reports");
	const guess = roomSpelling("~/documents/reports/", "~/Documents/Reports/");
	const bench = askBench({ room: { folder: newFolder("guess-room") } });
	const { asked, shown } = await suggest(bench, guess);
	assert(JSON.stringify(shown) === JSON.stringify({ name: "Reports", path: "~/Documents/Reports", once: true }), `the folder shown: ${JSON.stringify(shown)}`);
	bench.answer(PRESSES.thisTime);
	const said = await asked;
	assert(said.includes(`The person chose ${reports} for this answer only.`) && listed(bench).length === 0, `the model: ${said}`);
	const all = JSON.stringify(bench.frames);
	assert(!all.includes("documents/reports") && !all.includes("reports/") && !all.includes(guess), `a frame holds the guess: ${all}`);
});

await row("Allow this time and Allow for this room are pressed only beside a folder with one click; elsewhere they count for nothing", async () => {
	homeFolder("Projects/app");
	const bench = askBench({ room: { folder: newFolder("no-once-room") } });
	const { asked, shown } = await suggest(bench, "~/Projects/app");
	assert(shown?.name === "app" && shown.once === false, `the folder shown: ${JSON.stringify(shown)}`);
	for (const value of [PRESSES.thisTime, PRESSES.room]) {
		const from = bench.frames.length;
		bench.answer(value);
		await settle();
		const again = oneFrame(bench, from, `${value} without one click`);
		assert(again.type === "ui_request" && again.again === true && bench.starts.length === 0 && listed(bench).length === 0 && bench.answerFolders().over([]).length === 0, `${value} without one click: ${JSON.stringify(again)}`);
	}
	bench.answer(false);
	assert((await asked) === asks.FOLDER_NOT_NOW, "Not now");
});

await row("Choose folder on a suggestion without one click opens the window at the home and holds the pick; a pick of the home gives a line", async () => {
	const pick = newFolder("Held From Home");
	// The room's own folder outside Documents, so Documents is a folder it may be offered.
	const bench = askBench({ room: { folder: homeFolder("Rooms/choose-home-room") }, picks: [pickOf(pick), pickOf(home)] });
	const { asked, shown } = await suggest(bench, "~/Documents");
	assert(shown?.name === "Documents" && shown.once === false, `the folder shown: ${JSON.stringify(shown)}`);
	const held = await press(bench, PRESSES.choose);
	assert(JSON.stringify(bench.starts) === JSON.stringify([home]), `the window opened at: ${JSON.stringify(bench.starts)}`);
	assert(JSON.stringify(held.suggested) === JSON.stringify({ name: "Held From Home", path: "~/Documents/Held From Home", once: true }) && held.line === null && listed(bench).length === 0, `the pick: ${JSON.stringify(held)}`);
	const homePick = await press(bench, PRESSES.choose);
	assert(homePick.line === cards.folderHoldsRoomLine(path.basename(home)) && homePick.suggested === null && listed(bench).length === 0, `a pick of the home: ${JSON.stringify(homePick)}`);
	bench.answer(false);
	assert((await asked) === asks.FOLDER_NOT_NOW, "Not now");
});

await row("at the press the folder shown is judged again: removed, renamed, a link, another folder of its name or a link above it gives nothing and drops it, for a suggestion and for a pick", async () => {
	const changes: Array<[string, (target: string) => void]> = [
		["removed", (target) => fs.rmSync(target, { recursive: true })],
		["renamed", (target) => fs.renameSync(target, `${target} old`)],
		["a link", (target) => { fs.rmSync(target, { recursive: true }); fs.symlinkSync(newFolder(`Elsewhere ${path.basename(path.dirname(target))}`), target); }],
		["another folder of its name", replaceFolder],
		["a link above it", (target) => { const above = path.dirname(target); fs.renameSync(above, `${above} moved`); fs.symlinkSync(`${above} moved`, above); }],
	];
	let n = 0;
	for (const [label, change] of changes) {
		for (const value of [PRESSES.thisTime, PRESSES.room]) {
			for (const from of ["room", "window"] as const) {
				const target = newFolder(path.join(`Recheck ${++n}`, "Target"));
				const bench = askBench({ room: { folder: newFolder(`recheck-room-${n}`) }, picks: [pickOf(target), pickOf(target)] });
				const { asked } = from === "room" ? await suggest(bench, target) : { asked: bench.askFolder("read") };
				if (from === "window") {
					await waitUntil(() => bench.requests().length > 0, "the card");
					const held = await press(bench, PRESSES.choose);
					assert((held.suggested as Shown | null)?.once === true, `${label}: the window's pick is held: ${JSON.stringify(held)}`);
				} else assert((cardOf(bench).suggested as Shown | undefined)?.once === true, `${label}: the suggestion is shown`);
				change(target);
				const reply = await press(bench, value);
				assert(reply.type === "ui_request_update" && typeof reply.line === "string" && reply.line !== "" && reply.suggested === null, `${label}, ${value}, ${from}: ${JSON.stringify(reply)}`);
				assert(listed(bench).length === 0 && bench.answerFolders().over([]).length === 0, `${label}, ${value}, ${from}: given`);
				bench.answer(false);
				assert((await asked) === asks.FOLDER_NOT_NOW, `${label}, ${value}, ${from}: Not now`);
			}
		}
	}
});

await row("at the press the room's suggestion goes through the judge again on the folder shown, and a window's pick does not", async () => {
	// No change on disk tells the judge's recheck from the pick's own: what shows it ran is its call on the folder shown, the only one made through fs.promises.
	const resolved: string[] = [];
	const original = fs.promises.realpath;
	fs.promises.realpath = (async (place: any, options?: any) => {
		resolved.push(String(place));
		return original(place, options);
	}) as typeof fs.promises.realpath;
	try {
		for (const from of ["room", "window"] as const) {
			const target = newFolder(path.join(`Judged ${from}`, "Target"));
			const bench = askBench({ room: { folder: newFolder(`judged-room-${from}`) }, picks: [pickOf(target)] });
			const { asked } = from === "room" ? await suggest(bench, target) : { asked: bench.askFolder("read") };
			if (from === "window") {
				await waitUntil(() => bench.requests().length > 0, "the card");
				await press(bench, PRESSES.choose);
			}
			resolved.length = 0;
			await press(bench, PRESSES.thisTime);
			const onTarget = resolved.filter((place) => place === target).length;
			assert(from === "room" ? onTarget > 0 : onTarget === 0, `${from}: the judge's calls on the folder at the press: ${onTarget}`);
			assert((await asked).length > 0 && bench.answerFolders().over([]).some((entry) => entry.path === target), `${from}: the folder was given this time`);
		}
	} finally {
		fs.promises.realpath = original;
	}
});

await row("Not now during the press's recheck of a suggested folder starts no look, and gives nothing", async () => {
	const target = newFolder(path.join("Recheck Held", "Target"));
	const look = heldLook();
	const bench = askBench({ room: { folder: newFolder("recheck-held-room") }, look: look.look });
	const { asked } = await suggest(bench, target);
	// The judge's recheck waits on its first call on the folder until the row lets it go.
	let holding = true;
	let reached = false;
	let resolved = false;
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => { release = resolve; });
	const original = fs.promises.realpath;
	fs.promises.realpath = (async (place: any, options?: any) => {
		if (holding && String(place) === target) {
			reached = true;
			await held;
			const real = await original(place, options);
			resolved = true;
			return real;
		}
		return original(place, options);
	}) as typeof fs.promises.realpath;
	try {
		bench.answer(PRESSES.thisTime);
		await waitUntil(() => reached, "the recheck reaches the folder");
		bench.answer(false);
		assert((await asked) === asks.FOLDER_NOT_NOW, "Not now during the recheck");
		holding = false;
		release();
		// The recheck goes on from its held call: once that call has its answer, what follows runs without the disk.
		await waitUntil(() => resolved, "the held call answers");
		await settle();
		await settle();
		assert(look.started() === 0 && bench.answerFolders().over([]).length === 0, `after Not now, a look started (${look.started()}) or a folder was given`);
	} finally {
		fs.promises.realpath = original;
	}
});

await row("a suggested folder whose parent is swapped for a link to its moved self during the look is not given, and the line shows", async () => {
	const target = newFolder(path.join("Swap Batch", "Reports"));
	const look = heldLook();
	const bench = askBench({ room: { folder: newFolder("swap-room") }, look: look.look });
	const { asked, shown } = await suggest(bench, target);
	assert(shown?.once === true, `one click is offered: ${JSON.stringify(shown)}`);
	const pressed = bench.frames.length;
	bench.answer(PRESSES.thisTime);
	await waitUntil(() => look.started() === 1, "the look starts");
	// The folder keeps its disk and file number; only the way to it now passes a link.
	const parent = path.dirname(target);
	fs.renameSync(parent, `${parent} moved`);
	fs.symlinkSync(`${parent} moved`, parent);
	look.release("listed");
	await waitUntil(() => since(bench, pressed).some((frame) => frame.type === "ui_request_update" || frame.type === "ui_request_closed"), "the press's reply");
	const reply = since(bench, pressed).find((frame) => frame.type === "ui_request_update" || frame.type === "ui_request_closed");
	assert(reply?.type === "ui_request_update" && reply.line === cards.FOLDER_PICK_REFUSED_IN_PANEL && bench.answerFolders().over([]).length === 0, `given through a link: ${JSON.stringify(reply)}`);
	bench.answer(false);
	assert((await asked) === asks.FOLDER_NOT_NOW, "Not now after the line");
});

await row("Allow this time gives a suggested folder only while the judge still offers one click for it at the press; with nothing changed it gives", async () => {
	for (const moved of [false, true]) {
		const target = newFolder(path.join(`Once Again ${moved}`, "Target"));
		let judgeHome = home;
		const bench = askBench({ room: { folder: newFolder(`once-again-room-${moved}`) }, homeNow: () => judgeHome });
		const { asked, shown } = await suggest(bench, target);
		assert(shown?.once === true, `${moved}: one click is offered: ${JSON.stringify(shown)}`);
		// The same folder, judged from a home in which it is in no Desktop, Documents or Downloads: no one click any more.
		if (moved) judgeHome = folders;
		const reply = await press(bench, PRESSES.thisTime);
		const given = bench.answerFolders().over([]).some((entry) => entry.path === target);
		if (moved) {
			assert(!given && reply.type === "ui_request_update" && reply.line === cards.FOLDER_PICK_REFUSED_IN_PANEL, `no one click at the press, yet given: ${JSON.stringify(reply)}`);
			bench.answer(false);
		} else assert(given, `with nothing changed, Allow this time gave nothing: ${JSON.stringify(reply)}`);
		await asked;
	}
});

await row("the model gets the same words and the same wait whatever its guess was, and an ask with no card waits for nothing", async () => {
	const link = path.join(folders, "Linked Guess");
	fs.symlinkSync(newFolder("Linked Target"), link);
	homeFolder("Projects/kept");
	const roomFolder = newFolder("same-words-room");
	const onList = newFolder("Same Words Listed");
	const guesses: Array<[string, string | undefined]> = [
		["no field", undefined],
		["empty", ""],
		["refused by its text", "/Volumes/NAS/x"],
		["missing", "~/Documents/Nowhere"],
		["a link", link],
		["covered", onList],
		["one click", newFolder("Same Words Once")],
		["no one click", "~/Projects/kept"],
	];
	const said = new Set<string>();
	for (const [label, folder] of guesses) {
		const bench = askBench({ room: { folder: roomFolder } });
		addAlsoAllowedFolder(bench.roomId, onList, "read");
		const asked = bench.askFolder("read", "The invoices are in another folder.", folder);
		await waitUntil(() => bench.requests().length > 0, `${label}: the card`);
		assert(JSON.stringify(bench.waits) === JSON.stringify([SUGGESTION_JUDGE_MS]) && JSON.stringify(bench.cardsAtWait) === "[0]", `${label}: waits ${JSON.stringify(bench.waits)} ${JSON.stringify(bench.cardsAtWait)}`);
		bench.answer(false);
		said.add(`${await asked}|${JSON.stringify(bench.details())}`);
	}
	assert(said.size === 1, `the model told apart: ${JSON.stringify([...said])}`);
	// The answers that come before any card wait for nothing.
	const none = askBench({ room: { folder: null } });
	assert((await none.askFolder("read", "x", "~/Documents/Same Words Once")) === asks.NO_FOLDER_OF_ITS_OWN && none.waits.length === 0, "a room with no folder waited");
	const nobody = askBench({ room: { folder: newFolder("same-words-away") } });
	nobody.bridge.detach("nobody");
	assert((await nobody.askFolder("read", "x", "~/Documents/Same Words Once")) === asks.NOBODY_FOR_FOLDER && nobody.waits.length === 0, "nobody there, and it waited");
	// A message during the wait: no card, and the model is told to read it.
	let spoke = () => {};
	const spoken = askBench({ room: { folder: newFolder("same-words-spoken") }, onWait: () => spoke() });
	spoke = spoken.personSpoke;
	const spokenAsk = spoken.askFolder("read", "x", "~/Documents/Same Words Once");
	let spokenSaid = "";
	void spokenAsk.then((text) => { spokenSaid = text; });
	await waitUntil(() => spokenSaid !== "" || spoken.requests().length > 0, "the ask after the person wrote");
	assert(spokenSaid === asks.ASK_WITHDRAWN_FOR_MESSAGE && spoken.requests().length === 0, `a card after the person wrote: ${JSON.stringify(spoken.requests())}`);
});

await row("a phone never gets the folder shown: not on its first card, not when a pick is held while it holds the room", async () => {
	const once = newFolder("Phone Once");
	const phone = askBench({ authority: "phone", room: { folder: newFolder("phone-suggest-room") } });
	const phoneAsk = phone.askFolder("read", "x", once);
	await waitUntil(() => phone.requests().length > 0, "the phone's card");
	assert(!("suggested" in cardOf(phone)) && !JSON.stringify(phone.frames).includes("Phone Once"), `the phone's card: ${JSON.stringify(cardOf(phone))}`);
	phone.answer(PRESSES.thisTime, "phone");
	await settle();
	assert(phone.answerFolders().over([]).length === 0 && cardOf(phone).again === true, "a phone's Allow this time gave the folder");
	phone.bridge.attach("computer");
	assert((cardOf(phone).suggested as Shown | undefined)?.name === "Phone Once", "the computer gets the folder back");
	phone.answer(false);
	await phoneAsk;
	// The computer opens the window; the pick lands while a phone holds the room.
	const open = heldWindow();
	const bench = askBench({ room: { folder: newFolder("phone-held-room") }, picks: [open.picked] });
	const asked = bench.askFolder("read");
	await waitUntil(() => bench.requests().length > 0, "the card");
	bench.answer(PRESSES.choose);
	await settle();
	// While the window is open, a computer that joins learns a press is under way; a phone that takes the room over doesn't.
	bench.bridge.attach("computer");
	assert(cardOf(bench).choosing === PRESSES.choose, `a computer joining while the window is open: ${JSON.stringify(cardOf(bench))}`);
	bench.bridge.attach("phone");
	assert(cardOf(bench).choosing == null, `a phone taking the room over while the window is open: ${JSON.stringify(cardOf(bench))}`);
	const from = bench.frames.length;
	open.close(newFolder("Phone Held"));
	await waitUntil(() => since(bench, from).some((frame) => frame.type === "ui_request_update"), "the pick's update");
	const toPhone = since(bench, from).filter((frame) => frame.type === "ui_request" || frame.type === "ui_request_update");
	assert(toPhone.length > 0 && toPhone.every((frame) => frame.suggested == null && frame.line == null) && !JSON.stringify(toPhone).includes("Phone Held"), `the phone's frames: ${JSON.stringify(toPhone)}`);
	bench.bridge.attach("computer");
	assert((cardOf(bench).suggested as Shown | undefined)?.name === "Phone Held", `the computer's card: ${JSON.stringify(cardOf(bench))}`);
	bench.answer(false);
	await asked;
});

await row("the page names no folder: a path, an object, a prototype key or an old card value is asked again, and the window opens only at the folder held or the home", async () => {
	const once = newFolder("Values Once");
	const bench = askBench({ room: { folder: newFolder("values-room") }, picks: [pickOf(once), pickOf(once)] });
	const { asked } = await suggest(bench, once);
	for (const value of [once, { path: once }, "toString", "__proto__", "choose-this-time", "answer", "room"]) {
		const from = bench.frames.length;
		bench.answer(value);
		await settle();
		const again = oneFrame(bench, from, JSON.stringify(value));
		assert(again.again === true && bench.starts.length === 0, `${JSON.stringify(value)}: ${JSON.stringify(again)}`);
	}
	// Allow for this room on a one-click suggestion opens the window at that folder; Choose folder at the room's suggestion too.
	await press(bench, PRESSES.room);
	assert(JSON.stringify(bench.starts) === JSON.stringify([once]), `the window opened at: ${JSON.stringify(bench.starts)}`);
	await asked;
	// With nothing shown, the window opens where the computer chooses.
	const plain = askBench({ room: { folder: newFolder("values-plain-room") } });
	const plainAsk = plain.askFolder("read");
	await waitUntil(() => plain.requests().length > 0, "the card");
	await press(plain, PRESSES.choose);
	assert(JSON.stringify(plain.starts) === "[null]", `with nothing shown: ${JSON.stringify(plain.starts)}`);
	plain.answer(false);
	await plainAsk;
});

await row("Allow for this room on a suggestion gives at once only that folder; another pick, the Desktop among them, is held and given by a press, with one window", async () => {
	const suggested = newFolder("Twenty One");
	const bench = askBench({ room: { folder: newFolder("twenty-one-room") }, picks: [pickOf(suggested)] });
	const { asked } = await suggest(bench, suggested);
	bench.answer(PRESSES.room);
	assert((await asked).startsWith(`The person chose ${suggested}.`) && JSON.stringify(listed(bench)) === JSON.stringify([{ path: suggested, access: "read" }]), `the suggested folder: ${JSON.stringify(listed(bench))}`);
	const desktop = homeFolder("Desktop");
	for (const other of [newFolder("Twenty One Other"), desktop]) {
		const held = askBench({ room: { folder: newFolder(`twenty-one-held-${path.basename(other)}`) }, picks: [pickOf(other)] });
		const heldAsk = (await suggest(held, suggested)).asked;
		const reply = await press(held, PRESSES.room);
		assert((reply.suggested as Shown | null)?.name === path.basename(other) && listed(held).length === 0, `${other}: ${JSON.stringify(reply)}`);
		const given = await press(held, PRESSES.room);
		assert(given.type === "ui_request_closed" && held.starts.length === 1, `${other}: Allow for this room on the pick opened another window: ${JSON.stringify(held.starts)} ${JSON.stringify(given)}`);
		const said = await heldAsk;
		assert(said.startsWith(`The person chose ${other}.`) && JSON.stringify(listed(held)) === JSON.stringify([{ path: other, access: "read" }]) && held.starts.length === 1, `${other} given: ${said} ${JSON.stringify(held.starts)}`);
	}
	// Choose folder, then Allow this time: the pick given with no second window.
	const pick = newFolder("One Window");
	const once = askBench({ room: { folder: newFolder("one-window-room") }, picks: [pickOf(pick)] });
	const onceAsk = once.askFolder("read");
	await waitUntil(() => once.requests().length > 0, "the card");
	await press(once, PRESSES.choose);
	once.answer(PRESSES.thisTime);
	assert((await onceAsk).includes(`The person chose ${pick} for this answer only.`) && once.starts.length === 1, `one window: ${JSON.stringify(once.starts)}`);
});

/**
 * Records the paths the disk calls name and the programs started while `body`
 * runs, through the fs and child_process functions every module calls,
 * named imports included. Put back as they were after.
 */
async function diskAndPrograms<T>(body: () => Promise<T>): Promise<{ value: T; calls: Array<{ fn: string; name: string }> }> {
	const calls: Array<{ fn: string; name: string }> = [];
	const named = (value: unknown): string[] => (typeof value === "string" ? [value] : value instanceof URL ? [value.pathname] : Array.isArray(value) ? value.flatMap(named) : []);
	const kept: Array<[Record<string, any>, string, unknown]> = [];
	// A disk call is recorded by the paths in its first two arguments, a program start by its command alone.
	const recordOn = (owner: Record<string, any>, name: string, fn: string, reach = 2) => {
		const original = owner[name];
		if (typeof original !== "function") return;
		const recorded = function (this: unknown, ...args: unknown[]) {
			calls.push(...args.slice(0, reach).flatMap(named).map((place) => ({ fn, name: place })));
			return original.apply(this, args);
		};
		for (const key of Object.keys(original)) (recorded as any)[key] = original[key];
		kept.push([owner, name, original]);
		owner[name] = recorded;
	};
	for (const name of ["lstat", "stat", "realpath", "statfs", "readdir", "opendir", "open", "readFile", "readlink", "access", "exists"]) {
		recordOn(fs as any, name, name);
		recordOn(fs as any, `${name}Sync`, `${name}Sync`);
		recordOn(fs.promises as any, name, `promises.${name}`);
	}
	recordOn(fs.realpathSync as any, "native", "realpathSync.native");
	for (const name of PROGRAM_STARTS) recordOn(childProcess as any, name, name, 1);
	syncBuiltinESMExports();
	try {
		return { value: await body(), calls };
	} finally {
		for (const [owner, name, original] of kept.reverse()) owner[name] = original;
		syncBuiltinESMExports();
	}
}
const PROGRAM_STARTS = ["execFile", "execFileSync", "spawn", "spawnSync", "exec", "execSync", "fork"];

await row("before any press, a suggestion's card touches no folder on the room's list and starts no program: not a cloud folder, a linked entry, its target outside the home or a network share", async () => {
	const outside = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, "outside-")));
	const cloud = homeFolder("Library/CloudStorage/OneDrive-Org/Team");
	const linked = path.join(home, "Linked Away");
	fs.symlinkSync(outside, linked);
	const share = "/Volumes/TeamShare/Projects";
	const room = plantRoom(false);
	saveAlsoAllowedFolders(room.id, [{ path: cloud, access: "read" }, { path: linked, access: "read" }, { path: share, access: "read" }]);
	const guess = newFolder("Guard Fifteen");
	const bench = askBench({ roomId: room.id, room: { folder: room.folder } });
	// The system's shared-folder names are read once per server, with fixed arguments, before anything is asked.
	closedForReading();
	const { value: card, calls } = await diskAndPrograms(() => suggest(bench, guess));
	assert(card.shown?.name === "Guard Fifteen" && card.shown.once, `the folder shown: ${JSON.stringify(card.shown)}`);
	const on = (place: string) => calls.filter((call) => call.name.toLowerCase() === place.toLowerCase() || call.name.toLowerCase().startsWith(`${place.toLowerCase()}/`));
	const touched = [cloud, linked, outside, share].flatMap(on);
	const programs = calls.filter((call) => PROGRAM_STARTS.includes(call.fn));
	assert(touched.length === 0 && programs.length === 0, `before the press: ${touched.length} calls on the list's folders ${JSON.stringify(touched.slice(0, 4))}, ${programs.length} programs ${JSON.stringify(programs.slice(0, 2))}`);
	bench.answer(false);
	await card.asked;
});

await row("the folder window opens at the folder's real path, never at the room's spelling: Allow for this room on a one-click suggestion, and Choose folder where the folder shows only at the press", async () => {
	const real = newFolder("Spelled Apart");
	const guess = roomSpelling("~/documents/spelled apart/", "~/Documents/Spelled Apart/");
	for (const [show, value] of [[true, PRESSES.room], [false, PRESSES.choose]] as const) {
		const bench = askBench({ room: { folder: newFolder(`spelled-apart-${value}`) }, show });
		const { asked } = await suggest(bench, guess);
		await press(bench, value);
		assert(JSON.stringify(bench.starts) === JSON.stringify([real]), `${value}, shown ${show ? "before" : "at"} the press: the window opened at ${JSON.stringify(bench.starts)}`);
		bench.answer(false);
		await asked;
	}
});

await row("Allow for this room on a suggestion whose folder is replaced by a new one of its name while the window is open holds the pick and gives nothing; the same folder untouched is given", async () => {
	const swapped = newFolder("Swapped While Open");
	const bench = askBench({
		room: { folder: newFolder("swapped-room") },
		picks: [() => {
			replaceFolder(swapped);
			return pickOf(swapped);
		}],
	});
	const { asked } = await suggest(bench, swapped);
	const reply = await press(bench, PRESSES.room);
	assert(reply.type === "ui_request_update" && (reply.suggested as Shown | null)?.name === "Swapped While Open" && listed(bench).length === 0 && bench.answerFolders().over([]).length === 0, `the new folder of its name: ${JSON.stringify(reply)} ${JSON.stringify(listed(bench))}`);
	bench.answer(false);
	assert((await asked) === asks.FOLDER_NOT_NOW, "Not now after the held pick");
	const kept = newFolder("Kept While Open");
	const neighbour = askBench({ room: { folder: newFolder("kept-room") }, picks: [() => pickOf(kept)] });
	const keptAsk = (await suggest(neighbour, kept)).asked;
	neighbour.answer(PRESSES.room);
	assert((await keptAsk).startsWith(`The person chose ${kept}.`) && JSON.stringify(listed(neighbour)) === JSON.stringify([{ path: kept, access: "read" }]), `the same folder untouched: ${JSON.stringify(listed(neighbour))}`);
});

await row("with the folder shown only at the press, the card shows only the room's words for it, waits the same, and Choose folder opens the window at the folder or the home", async () => {
	const once = newFolder("Shown Late");
	homeFolder("Projects/late");
	for (const [guess, startAt] of [[once, once], ["~/Projects/late", home]] as const) {
		const bench = askBench({ room: { folder: newFolder(`shown-late-${path.basename(guess)}`) }, show: false, picks: [pickOf(once)] });
		const { asked, shown } = await suggest(bench, guess);
		assert(JSON.stringify(shown) === JSON.stringify({ named: cards.pathAsShown(guess, home, false), once: false }) && JSON.stringify(bench.waits) === JSON.stringify([SUGGESTION_JUDGE_MS]), `${guess}: ${JSON.stringify(cardOf(bench))}`);
		const held = await press(bench, PRESSES.choose);
		assert(JSON.stringify(bench.starts) === JSON.stringify([startAt]) && (held.suggested as Shown | null)?.name === "Shown Late" && listed(bench).length === 0, `${guess}: ${JSON.stringify(bench.starts)} ${JSON.stringify(held)}`);
		bench.answer(false);
		await asked;
	}
});

await row("a suggestion with access change on a folder the list holds to read: Allow this time changes files there for this answer and the list stays; inside a folder given this time to change, only the room's words show", async () => {
	const listedRead = newFolder("Suggested Listed Read");
	const bench = askBench({ room: { folder: newFolder("suggested-change-room") } });
	addAlsoAllowedFolder(bench.roomId, listedRead, "read");
	const { asked, shown } = await suggest(bench, listedRead, "change");
	assert(shown?.once === true, `the folder shown: ${JSON.stringify(shown)}`);
	bench.answer(PRESSES.thisTime);
	assert((await asked).includes(`The person chose ${listedRead} for this answer only.`), "Allow this time");
	assert(JSON.stringify(listed(bench)) === JSON.stringify([{ path: listedRead, access: "read" }]) && JSON.stringify(bench.answerFolders().over(listed(bench))) === JSON.stringify([{ path: listedRead, access: "write" }]), `after: ${JSON.stringify(bench.answerFolders().over(listed(bench)))}`);
	const changed = newFolder("Suggested Changed This Time");
	const inside = newFolder(path.join("Suggested Changed This Time", "April"));
	const within = askBench({ room: { folder: newFolder("suggested-within-room") } });
	within.answerFolders().give(changed, "write");
	const withinAsk = await suggest(within, inside);
	assert(JSON.stringify(withinAsk.shown) === JSON.stringify({ named: "~/Documents/Suggested Changed This Time/April", once: false }), `inside a folder given this time to change: ${JSON.stringify(withinAsk.shown)}`);
	within.answer(false);
	await withinAsk.asked;
});

// --- The place the room names, whatever the judge makes of it: the card says which, and gives no more than before.
type Named = { named: string; once: false };
/** Allow this time and Allow for this room on a card that holds no folder: the first counts for nothing, the second only opens the window, at no place of the room's, and nothing is given. */
async function noOneClick(bench: Bench, label: string): Promise<void> {
	const from = bench.frames.length;
	bench.answer(PRESSES.thisTime);
	await settle();
	const again = oneFrame(bench, from, `${label}: Allow this time`);
	assert(again.type === "ui_request" && again.again === true, `${label}: Allow this time was taken: ${JSON.stringify(again)}`);
	const reply = await press(bench, PRESSES.room);
	assert(JSON.stringify(bench.starts) === JSON.stringify([undefined]) && reply.type === "ui_request_update", `${label}: Allow for this room: ${JSON.stringify(bench.starts)} ${JSON.stringify(reply)}`);
	assert(listed(bench).length === 0 && bench.answerFolders().over([]).length === 0, `${label}: given ${JSON.stringify(listed(bench))}`);
}

await row("a path the judge refuses shows on the card as the room's words, with Choose folder and no one click: hidden, outside the home, a link, too deep, another disk, not there", async () => {
	homeFolder(".config/tools");
	const target = newFolder("Link Target");
	fs.symlinkSync(target, path.join(folders, "Linked Scripts"));
	const deep = `~/Documents/${Array.from({ length: 8 }, (_, at) => `d${at}`).join("/")}`;
	fs.mkdirSync(path.join(home, deep.slice(2)), { recursive: true });
	const outsideHome = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, "outside-")));
	for (const [label, guess, drawn] of [
		["hidden", "~/.config/tools", "~/.config/tools"],
		["outside the home", outsideHome, outsideHome],
		["a link", path.join(folders, "Linked Scripts"), "~/Documents/Linked Scripts"],
		["too deep", deep, deep],
		["another disk", "/Volumes/Backup/Scripts", "/Volumes/Backup/Scripts"],
		["not there", "~/Documents/Nowhere Yet", "~/Documents/Nowhere Yet"],
	] as const) {
		const bench = askBench({ room: { folder: newFolder(`named-${label.replace(/ /g, "-")}`) } });
		const { asked, shown } = await suggest(bench, guess);
		assert(JSON.stringify(shown) === JSON.stringify({ named: drawn, once: false }), `${label}: the card shows ${JSON.stringify(shown)}`);
		await noOneClick(bench, label);
		bench.answer(false);
		assert((await asked) === asks.FOLDER_NOT_NOW, `${label}: Not now`);
	}
	// The neighbour the judge passes shows by its own name and path, with one click.
	const bench = askBench({ room: { folder: newFolder("named-neighbour") } });
	const { asked, shown } = await suggest(bench, newFolder("Named Neighbour"));
	assert(JSON.stringify(shown) === JSON.stringify({ name: "Named Neighbour", path: "~/Documents/Named Neighbour", once: true }), `the neighbour: ${JSON.stringify(shown)}`);
	bench.answer(false);
	await asked;
});

await row("the room's words on the card are one line with every hidden character written out: a direction change or a line break can't change what the person reads", async () => {
	for (const [label, guess] of [["a direction change", "~/Documents/Invoices/‮fdp.exe"], ["a line break", "~/Documents/Invoices\n~/Documents/Safe"], ["a zero-width space", "~/Docu​ments/Invoices"]] as const) {
		const bench = askBench({ room: { folder: newFolder(`hidden-${label.replace(/ /g, "-")}`) } });
		const { asked, shown } = await suggest(bench, guess);
		const named = (shown as Named | undefined)?.named ?? "";
		assert(named === cards.namedPathAsShown(guess, home, false) && !/[‮\n​]/.test(named) && /⟦U\+(202E|000A|200B)⟧/.test(named), `${label}: ${JSON.stringify(shown)}`);
		assert(!JSON.stringify(bench.frames).includes(JSON.stringify(guess).slice(1, -1)), `${label}: a frame carries the room's raw words`);
		bench.answer(false);
		await asked;
	}
	assert(cards.namedPathAsShown("~/Documents/a‮b", home, false) === "~/Documents/a⟦U+202E⟧b" && cards.namedPathAsShown("~/a\tb", home, false) === "~/a⟦U+0009⟧b", "each written out by its code");
});

await row("a long path the room names is cut in the middle at its slashes, keeping its start and its last names whole; one that fits is whole", async () => {
	const long = `~/Documents/${Array.from({ length: 30 }, (_, at) => `Folder number ${at}`).join("/")}/fetch_transcript.py`;
	const shown = cards.namedPathAsShown(long, home, false);
	assert([...shown].length <= cards.NAMED_PATH_MAX_CHARS && shown.startsWith("~/Documents/Folder number 0/") && shown.endsWith("/Folder number 29/fetch_transcript.py") && shown.split("…").length === 2, `cut: ${shown}`);
	// No name shows in part: each one beside the cut is one of the path's own.
	const names = new Set(long.split("/"));
	assert(shown.includes("/…/") && shown.split("/").every((name) => name === "…" || names.has(name)), `a name cut in part: ${shown}`);
	const oneName = cards.namedPathAsShown(`~/${"x".repeat(200)}`, home, false);
	assert([...oneName].length <= cards.NAMED_PATH_MAX_CHARS && oneName.startsWith("~/…x") && oneName.split("…").length === 2, `a name longer than the row is cut by characters: ${oneName}`);
	const fits = `~/Documents/${"x".repeat(cards.NAMED_PATH_MAX_CHARS - 12)}`;
	assert(cards.namedPathAsShown(fits, home, false) === fits && [...fits].length === cards.NAMED_PATH_MAX_CHARS, "one that fits is cut");
	// A cut never splits a character: the emoji at the cut stays whole or goes whole.
	const emoji = cards.namedPathAsShown(`~/${"😀".repeat(200)}`, home, false);
	assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji), "a character split by the cut");
	const bench = askBench({ room: { folder: newFolder("long-named") } });
	const card = await suggest(bench, long);
	assert(JSON.stringify(card.shown) === JSON.stringify({ named: shown, once: false }), `the card: ${JSON.stringify(card.shown)}`);
	bench.answer(false);
	await card.asked;
});

await row("a file's path: the card names the file and the folder that holds it, with one click exactly where that folder would have it, and a press gives the whole folder", async () => {
	const scripts = newFolder("Scripts");
	fs.writeFileSync(path.join(scripts, "fetch_transcript.py"), "print(1)\n");
	const bench = askBench({ room: { folder: newFolder("file-once-room") } });
	const { asked, shown } = await suggest(bench, path.join(scripts, "fetch_transcript.py"));
	assert(JSON.stringify(shown) === JSON.stringify({ name: "Scripts", path: "~/Documents/Scripts", once: true, file: "fetch_transcript.py" }), `the card: ${JSON.stringify(shown)}`);
	bench.answer(PRESSES.thisTime);
	const said = await asked;
	assert(said.includes(`The person chose ${scripts} for this answer only.`) && JSON.stringify(bench.answerFolders().over([])) === JSON.stringify([{ path: scripts, access: "read" }]), `the whole folder: ${said}`);
	// Outside Desktop, Documents and Downloads the folder shows without one click, as it would by its own path.
	const tools = homeFolder("Projects/tools");
	fs.writeFileSync(path.join(tools, "run.sh"), "echo\n");
	const noOnce = askBench({ room: { folder: newFolder("file-no-once-room") } });
	const card = await suggest(noOnce, "~/Projects/tools/run.sh");
	assert(JSON.stringify(card.shown) === JSON.stringify({ name: "tools", path: "~/Projects/tools", once: false, file: "run.sh" }), `without one click: ${JSON.stringify(card.shown)}`);
	const from = noOnce.frames.length;
	noOnce.answer(PRESSES.thisTime);
	await settle();
	assert(oneFrame(noOnce, from, "Allow this time without one click").again === true && noOnce.answerFolders().over([]).length === 0, "Allow this time was taken without one click");
	noOnce.answer(false);
	await card.asked;
});

await row("a file's path whose folder the judge refuses, or that isn't a plain file, shows as the room's words with no one click", async () => {
	const hidden = homeFolder(".local/bin");
	fs.writeFileSync(path.join(hidden, "fetch_transcript.py"), "x");
	fs.writeFileSync(path.join(home, "loose.py"), "x");
	const holder = newFolder("Link Holder");
	fs.writeFileSync(path.join(newFolder("Link Real"), "real.py"), "x");
	fs.symlinkSync(path.join(folders, "Link Real", "real.py"), path.join(holder, "linked.py"));
	for (const [label, guess] of [
		["in a hidden folder", "~/.local/bin/fetch_transcript.py"],
		["right in the home, which no room is given", "~/loose.py"],
		["a link to a file", "~/Documents/Link Holder/linked.py"],
		["no file there", "~/Documents/Link Holder/missing.py"],
	] as const) {
		const bench = askBench({ room: { folder: newFolder(`file-refused-${label.split(" ").slice(0, 2).join("-")}`) } });
		const { asked, shown } = await suggest(bench, guess);
		assert(JSON.stringify(shown) === JSON.stringify({ named: guess, once: false }), `${label}: ${JSON.stringify(shown)}`);
		await noOneClick(bench, label);
		bench.answer(false);
		await asked;
	}
});

await row("ask_for_folder refuses an empty reason with a line the room can act on, and asks with any other", async () => {
	for (const reason of ["", "   ", "\n"]) {
		const bench = askBench({ room: { folder: newFolder(`no-reason-${reason.length}`) } });
		let answered = false;
		const asked = bench.askFolder("read", reason, "~/Documents/Reports").finally(() => { answered = true; });
		// Answered at once, or a card shows: a card is answered so the row ends.
		await waitUntil(() => answered || bench.requests().length > 0, "the answer or a card");
		if (!answered) bench.answer(false);
		const said = await asked;
		assert(said === asks.FOLDER_REASON_MISSING && bench.details()[cards.ASK_OUTCOME] === "not-asked" && bench.requests().length === 0 && bench.waits.length === 0, `${JSON.stringify(reason)}: ${said}`);
	}
	assert(asks.FOLDER_REASON_MISSING.includes(cards.ASK_FOR_FOLDER_TOOL_NAME) && asks.FOLDER_REASON_MISSING.includes("the folder that holds fetch_transcript.py"), "the line names the tool and how to say it");
	const bench = askBench({ room: { folder: newFolder("with-reason") } });
	const asked = bench.askFolder("read", "The folder that holds fetch_transcript.py.");
	await waitUntil(() => bench.requests().length > 0, "the card");
	bench.answer(false);
	assert((await asked) === asks.FOLDER_NOT_NOW, "a reason asks");
});

await row("ask_for_folder's instructions: the reason names the file or folder by name and holds no path, a file's path counts, and the room names a folder it knows in its own message", () => {
	const [folderTool] = asks.createRoomAsks({ roomId: "instructions", reasonOf: () => "", questions: {} as never, room: () => ({ folder: null, canChangeFiles: true, commands: "may-ask", boxed: true }), pickFolder: async () => ({ ok: true, supported: true, cancelled: true, path: null }), turnOnCommands: () => {}, notNow: new asks.NotNowCount(), answer: () => new asks.AnswerFolders() }).tools;
	const fields = (folderTool.parameters as any).properties;
	assert(String(fields.reason.description).includes('Name the file or folder by its name, as "the folder that holds fetch_transcript.py"') && String(fields.reason.description).includes("No paths."), `the reason: ${fields.reason.description}`);
	assert(String(fields.folder.description).includes("or of the one file the job needs"), `the folder: ${fields.folder.description}`);
	assert(folderTool.description.includes("Say in it what you're looking for, by name.") && folderTool.description.includes("When you know the folder, also name it in your own message."), `the tool: ${folderTool.description}`);
});

await row("a one-click yes is given only after the look, while the card is open: Not now or Stop during the look gives nothing", async () => {
	for (const [label, during, expected] of [
		["Not now", (bench: Bench) => bench.answer(false), asks.FOLDER_NOT_NOW],
		["Stop", (bench: Bench) => bench.bridge.declineOpenQuestions("Stopped."), "Stopped."],
	] as const) {
		const look = heldLook();
		const once = newFolder(`Look Once ${label}`);
		const bench = askBench({ room: { folder: newFolder(`look-once-${label}`) }, look: look.look });
		const { asked } = await suggest(bench, once);
		bench.answer(PRESSES.thisTime);
		await waitUntil(() => look.started() === 1, `${label}: the look`);
		during(bench);
		look.release("listed");
		assert((await asked) === expected && listed(bench).length === 0 && bench.answerFolders().over([]).length === 0, `${label}: given`);
	}
});

await row("the commands card says what a yes gives: inside the room, a room that can't change files, and Turn on anyway with no protection", async () => {
	for (const [view, line, anyway] of [
		[{ boxed: true, canChangeFiles: true }, "in-box", false],
		[{ boxed: true, canChangeFiles: false }, "in-box-read-only", false],
		[{ boxed: false, canChangeFiles: true }, "no-box", true],
	] as const) {
		const bench = askBench({ room: { folder: newFolder(`card-${line}`), ...view } });
		const asked = bench.askCommands();
		await settle();
		const card = bench.requests()[0];
		assert(card?.title === cards.COMMANDS_ASK_TITLE && card.line === line && card.anyway === anyway, `${line}: ${JSON.stringify(card)}`);
		bench.answer(false);
		await asked;
	}
	const off = askBench({ room: { folder: null, commands: "unavailable" } });
	assert((await off.askCommands()) === asks.COMMANDS_UNAVAILABLE && off.requests().length === 0, "a card where commands can't come on");
});

// --- Live rows: a real server, a gateway playing the model.
type Call = { name: string; args: Record<string, unknown> };
let legs: Call[][] = [];
let toolResults: string[] = [];
let offered: string[] = [];
let sentBodies: string[] = [];
// While set, the model's call waits before it is answered: a window can close in between. With a leg named, only that leg's call waits.
let gatewayHold: Promise<void> | null = null;
let gatewayHoldAt: number | null = null;
let gatewayHeld = false;
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const gateway = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", async () => {
		const parsed = JSON.parse(body || "{}");
		const messages: any[] = Array.isArray(parsed.messages) ? parsed.messages : [];
		const sinceUser = messages.slice(messages.map((message) => message?.role).lastIndexOf("user") + 1);
		const withTools = (parsed.tools ?? []).length > 0;
		if (withTools) {
			sentBodies.push(body);
			offered = (parsed.tools as any[]).map((tool) => String(tool?.function?.name ?? ""));
			toolResults = sinceUser.filter((message) => message?.role === "tool").map((message) => (typeof message.content === "string" ? message.content : message.content.map((part: any) => String(part?.text ?? "")).join("")));
		}
		const done = sinceUser.filter((message) => message?.role === "assistant").length;
		const leg = withTools ? legs[done] : undefined;
		const base = { id: `cmpl_${done}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL.model };
		if (leg && gatewayHold && (gatewayHoldAt === null || gatewayHoldAt === done)) {
			gatewayHeld = true;
			await gatewayHold;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		if (leg) {
			const tool_calls = leg.map((call, index) => ({ index, id: `call_${done}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 4, total_tokens: 154 } }));
		}
		res.end("data: [DONE]\n\n");
	});
});

async function json(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
/** A room made through the API, as the page makes one. */
async function makeRoom(name: string): Promise<string> {
	const created = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const id = String(created.body?.agent?.id ?? "");
	assert(created.status === 201 && id, `the room was made, got ${created.status}`);
	return id;
}
/** A save from the Folder pane: with `folder`, a folder chosen; without, the Commands switch alone. `bashEnabled` left out: the switch was never touched. */
async function saveFolderPane(room: string, bashEnabled: boolean | undefined, folder?: string): Promise<void> {
	const saved = await json(`/api/persistent-agents/${encodeURIComponent(room)}/workspace-default`, { method: "PUT", body: JSON.stringify({ ...(folder ? { root: folder, displayLabel: "Sales" } : {}), workspaceAccessMode: "localFiles", bashEnabled }) });
	assert(saved.status === 200, `the Folder pane saved, got ${saved.status}: ${JSON.stringify(saved.body)}`);
}
const setRoomFolder = (room: string, folder: string, bashEnabled: boolean | undefined) => saveFolderPane(room, bashEnabled, folder);
/** What the Folder pane's switch shows for a room with no folder yet. */
const startsOnInPane = async (room: string): Promise<unknown> => (await json(`/api/persistent-agents/${encodeURIComponent(room)}/workspace-default`)).body?.commandsStartOn;
// Cards a person answers; a status line is no card.
const ANSWERED_KINDS = new Set(["confirm", "select", "input", "site", "outside", "run", "folder", "commands"]);

const WebSocketImpl: any = (await import("ws")).default;
let conversations = 0;
/** A window on a new conversation of the room. Answers cards by kind, as the person would. */
async function openWindow(room: string, conversation = `conversation-${++conversations}`, { seed = true }: { seed?: boolean } = {}) {
	if (seed) {
		const seeded = await json(`/api/persistent-agents/${encodeURIComponent(room)}/threads/${conversation}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: MODEL, items: [] }) });
		assert(seeded.status === 200, `${conversation} was seeded, got ${seeded.status}: ${JSON.stringify(seeded.body)}`);
	}
	const query = `persistentAgentId=${room}&conversationId=${conversation}&modelProvider=${MODEL.provider}&model=${MODEL.model}&reattach=1`;
	const ws = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?${query}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	const answers = new Map<string, unknown>();
	ws.addEventListener("message", (event: any) => {
		let frame: any;
		try { frame = JSON.parse(String(event.data)); } catch { return; }
		frames.push(frame);
		// After the floor, as a person reads before answering: a yes sooner would be asked again.
		if (frame.type === "ui_request" && answers.has(frame.kind)) {
			const value = answers.get(frame.kind);
			setTimeout(() => ws.send(JSON.stringify({ type: "ui_response", id: frame.id, value })), cards.ANSWER_FLOOR_MS + 50);
		}
		// Choose folder, then Allow this time on the folder the panel shows: a pick given for this answer.
		if (frame.type === "ui_request_update" && answers.get("folder") === PRESSES.choose && frame.suggested?.once) {
			setTimeout(() => ws.send(JSON.stringify({ type: "ui_response", id: frame.id, value: PRESSES.thisTime })), cards.ANSWER_FLOOR_MS + 50);
		}
	});
	await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	await waitUntil(() => frames.some((frame) => frame.type === "ready"), `${conversation} is ready`);
	const ends = () => frames.filter((frame) => frame.type === "event" && frame.event?.type === "agent_end").length;
	return {
		cards: () => frames.filter((frame) => frame.type === "ui_request" && ANSWERED_KINDS.has(frame.kind)),
		frames: () => frames,
		send: (message: Record<string, unknown>) => ws.send(JSON.stringify(message)),
		/** Cards of a kind get the answer given from now on. */
		answerWith(answer: Record<string, unknown>): void {
			answers.clear();
			for (const [kind, value] of Object.entries(answer)) answers.set(kind, value);
		},
		/** One turn whose legs make these calls; cards of a kind get the answer given. */
		async turn(calls: Call[][], answer: Record<string, unknown> = {}): Promise<string[]> {
			this.answerWith(answer);
			const before = ends();
			legs = calls;
			toolResults = [];
			ws.send(JSON.stringify({ type: "prompt", text: "Make the chart." }));
			await waitUntil(() => ends() > before, "the turn ended");
			await waitForTurnSettled(json, room, "the turn has settled");
			return toolResults;
		},
		close: () => ws.close(),
	};
}
const bash = (command: string): Call => ({ name: "bash", args: { command } });
const askFolder = (access: "read" | "change"): Call => ({ name: "ask_for_folder", args: { access, reason: "The invoices are in another folder." } });
const readFile = (file: string): Call => ({ name: "read", args: { path: file } });
const shellQuoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
/** Holds the model's call for this leg until `release`; `held` once it waits. */
function holdLeg(leg: number): { release: () => void } {
	let release = () => {};
	gatewayHold = new Promise<void>((resolve) => { release = resolve; });
	gatewayHoldAt = leg;
	gatewayHeld = false;
	return { release: () => { gatewayHold = null; gatewayHoldAt = null; release(); } };
}
const askCommands = (reason: string): Call => ({ name: "ask_for_commands", args: { reason } });
const ran = (folder: string, name: string) => fs.existsSync(path.join(folder, name));

let serverUp = false;
async function startServer(): Promise<void> {
	if (serverUp) return;
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const writeSetting = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
	writeSetting(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 200000, maxTokens: 4096 }] } } });
	writeSetting(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-room-asks" } });
	writeSetting(path.join(appRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" });
	writeSetting(path.join(appRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });
	await import("../src/index.js");
	await waitUntil(() => fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.ok, () => false), "the server is up", 60_000);
	serverUp = true;
}

try {
	await macRow("live: a new room with a folder starts with commands on, as the Folder pane's switch shows before the save, and its first command runs with no card; switched off before the save, it starts off", async () => {
		await startServer();
		const room = await makeRoom("Sales Review");
		assert(fs.existsSync(path.join(agentsRoot, room, policy.PERSISTENT_ROOM_COMMANDS_START_ON_FILE)), "a new room with no folder keeps that its commands start on");
		assert((await startsOnInPane(room)) === true, "the pane's switch showed off before the first folder");
		const folder = newFolder("live-new");
		await setRoomFolder(room, folder, undefined);
		assert(commandsOf(room) === "automatic" && (await startsOnInPane(room)) === false, `the first folder, switch untouched: ${commandsOf(room)}`);
		const offFirst = await makeRoom("Off First Review");
		await setRoomFolder(offFirst, newFolder("live-off-first"), false);
		assert(commandsOf(offFirst) === "switched-off", `switched off before the first save: ${commandsOf(offFirst)}`);
		const window = await openWindow(room);
		const [result] = await window.turn([[bash("touch first-command.txt && echo ran")]]);
		assert(result?.includes("ran") && ran(folder, "first-command.txt"), `the command: ${result}`);
		assert(window.cards().length === 0, `a card showed: ${JSON.stringify(window.cards())}`);
		window.close();
	});

	await macRow("live: with no protection a new room starts off, the room asks with Turn on anyway, and the reason is kept nowhere", async () => {
		await startServer();
		process.env.EXXPERTS_TEST_SHELL_PLATFORM = "linux";
		try {
			const room = await makeRoom("Plain Review");
			assert((await startsOnInPane(room)) === false, "the pane's switch showed on with no protection");
			const folder = newFolder("live-no-box");
			await setRoomFolder(room, folder, undefined);
			const reason = "To turn sales-ledger-q3.csv into a chart";
			const window = await openWindow(room);
			const results = await window.turn([[bash("touch before.txt")], [askCommands(reason)], [bash("touch after.txt && echo ran")]], { commands: true, run: true });
			assert(results[0]?.includes(asks.COMMAND_OFF_NOTHING_RAN) && !ran(folder, "before.txt"), `a command ran before the yes: ${results[0]}`);
			const card = window.cards().find((frame) => frame.kind === "commands");
			assert(card?.anyway === true && card.line === "no-box" && card.reason === reason, `the card: ${JSON.stringify(card)}`);
			assert(results[1] === asks.COMMANDS_TURNED_ON && results[2]?.includes("ran") && ran(folder, "after.txt"), `after the yes: ${JSON.stringify(results.slice(1))}`);
			// With no protection Run without asking doesn't come with the yes: the command asked first.
			assert(window.cards().some((frame) => frame.kind === "run"), "the command ran without asking");
			const kept = fs.readdirSync(path.join(agentsRoot, room), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).filter((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8").includes("sales-ledger-q3"));
			assert(kept.length === 0, `the reason was kept in ${kept.map((entry) => path.relative(agentsRoot, path.join(entry.parentPath, entry.name)))}`);
			assert(sentBodies.at(-1)?.includes(reason) === false, "the reason went back to the model in the room's saved message");
			window.close();
		} finally {
			delete process.env.EXXPERTS_TEST_SHELL_PLATFORM;
		}
	});

	await macRow("live: commands that came on by themselves run nothing with no protection until Turn on anyway; the person's own Run without asking, given there, is kept", async () => {
		await startServer();
		const automatic = await makeRoom("Automatic Review");
		const automaticFolder = newFolder("live-automatic");
		await setRoomFolder(automatic, automaticFolder, undefined);
		const own = await makeRoom("Own Review");
		const ownFolder = newFolder("live-own");
		await setRoomFolder(own, ownFolder, true);
		process.env.EXXPERTS_TEST_SHELL_PLATFORM = "linux";
		try {
			// A yes holds in the protection it was given in: hers is given with none.
			assert((await putRunWithoutAsking(`http://127.0.0.1:${port}/api/persistent-agents/${encodeURIComponent(own)}/bash-settings`, true)).status === 200, "her own Run without asking");
			const window = await openWindow(automatic);
			const [result] = await window.turn([[bash("touch moved.txt")]]);
			assert(result?.includes(asks.COMMAND_OFF_NOTHING_RAN) && !ran(automaticFolder, "moved.txt"), `a command ran: ${result}`);
			window.close();
			const ownWindow = await openWindow(own);
			const [ownResult] = await ownWindow.turn([[bash("touch own.txt && echo ran")]]);
			assert(ownResult?.includes("ran") && ownWindow.cards().length === 0, `her own Run without asking: ${ownResult}, cards ${ownWindow.cards().length}`);
			ownWindow.close();
		} finally {
			delete process.env.EXXPERTS_TEST_SHELL_PLATFORM;
		}
	});

	await macRow("live: a room with no folder of its own isn't offered the folder ask or commands, though its commands start on, and is told to say what it couldn't do; a room with a folder is offered both", async () => {
		await startServer();
		const none = await makeRoom("No Folder Review");
		const noneWindow = await openWindow(none);
		await noneWindow.turn([[{ name: "read", args: { path: "notes.txt" } }]]);
		assert(!offered.includes("ask_for_folder") && !offered.includes("bash") && !offered.includes("ask_for_commands"), `a room with no folder was offered: ${offered}`);
		assert((await startsOnInPane(none)) === true, "the room with no folder doesn't keep that its commands start on, so this row proves nothing");
		assert(sentBodies.at(-1)?.includes("say what you couldn't do") && !sentBodies.at(-1)?.includes("call ask_for_folder"), "the room with no folder wasn't told to say what it couldn't do");
		noneWindow.close();
		const room = await makeRoom("Folder Review");
		await setRoomFolder(room, newFolder("live-has-folder"), undefined);
		const window = await openWindow(room);
		await window.turn([[{ name: "read", args: { path: "notes.txt" } }]]);
		assert(offered.includes("ask_for_folder") && offered.includes("bash"), `a room with a folder wasn't offered: ${offered}`);
		window.close();
	});

	await macRow("live: switched off in Room settings, no command runs in any conversation, and the room is told and doesn't ask", async () => {
		await startServer();
		const room = await makeRoom("Switched Review");
		const folder = newFolder("live-switched");
		await setRoomFolder(room, folder, true);
		policy.writePersistentRoomCapabilityPolicy(policy.createPersistentRoomCapabilityPolicy({ agentId: room, conversationId: "conversation-own", repoRoot, root: folder, workspaceAccessMode: "localFiles", displayLabel: "Sales", source: "manual", bashEnabled: true }));
		await saveFolderPane(room, false);
		const window = await openWindow(room, "conversation-own");
		const results = await window.turn([[bash("touch switched.txt")], [askCommands("To make the chart.")]]);
		assert(!ran(folder, "switched.txt") && window.cards().length === 0, `a command ran or a card showed: ${JSON.stringify(results)}`);
		assert(!offered.includes("bash") && !offered.includes("ask_for_commands"), `offered: ${offered}`);
		assert(sentBodies.at(-1)?.includes("because the person switched them off in Room settings"), "the room wasn't told commands are off in Room settings");
		window.close();
		// A room never turned on, made before the update, asks by card.
		const before = await makeRoom("Older Review");
		fs.rmSync(path.join(agentsRoot, before, policy.PERSISTENT_ROOM_COMMANDS_START_ON_FILE));
		const beforeFolder = newFolder("live-before");
		await setRoomFolder(before, beforeFolder, false);
		const beforeWindow = await openWindow(before);
		await beforeWindow.turn([[askCommands("To make the chart.")]], { commands: false });
		assert(beforeWindow.cards().some((frame) => frame.kind === "commands" && frame.line === "in-box"), "a room made before showed no commands card");
		beforeWindow.close();
	});
	await macRow("live: a write into a Can read folder is refused with no card of its own; the folder card with access change lets the next write land, and Not now leaves it refused", async () => {
		await startServer();
		const room = await makeRoom("Finance Review");
		const folder = newFolder("live-change-room");
		await setRoomFolder(room, folder, false);
		const finance = newFolder("Live Finance");
		addAlsoAllowedFolder(room, finance, "read");
		folderWindow.pick = finance;
		const write = (name: string): Call => ({ name: "write", args: { path: path.join(finance, name), content: "chart" } });
		const declined = await openWindow(room);
		const [refused, notNow] = await declined.turn([[write("declined.md")], [askFolder("change")]], { folder: false });
		assert(refused?.includes("is in a folder this room can only read") && refused.includes("ask_for_folder with access change") && declined.cards().length === 1 && declined.cards()[0].kind === "folder", `the refused write: ${refused} ${JSON.stringify(declined.cards())}`);
		assert(notNow === asks.FOLDER_NOT_NOW && !fs.existsSync(path.join(finance, "declined.md")) && readAlsoAllowed(room).folders.find((entry) => entry.path === finance)?.access === "read", `Not now: ${notNow}`);
		declined.close();
		const allowed = await openWindow(room);
		const [, chosen, landed] = await allowed.turn([[write("chart.md")], [askFolder("change")], [write("chart.md")]], { folder: PRESSES.room });
		assert(chosen?.startsWith(`The person chose ${finance}.`) && fs.readFileSync(path.join(finance, "chart.md"), "utf8") === "chart", `after Allow for this room…: ${chosen} ${landed}`);
		assert(readAlsoAllowed(room).folders.find((entry) => entry.path === finance)?.access === "write", "the list doesn't show Can read and change");
		allowed.close();
	});

	await macRow("live: a file tool refused for a folder, with the window open and in a turn that goes on after it closes, gives the refusal", async () => {
		await startServer();
		const { detachedCookingRooms } = await import("../src/room-live-sessions.js");
		const room = await makeRoom("Away Review");
		await setRoomFolder(room, newFolder("live-away"), false);
		const read: Call = { name: "read", args: { path: path.join(newFolder("Away Elsewhere"), "q3.csv") } };
		const there = await openWindow(room, "conversation-there");
		await there.turn([[read]]);
		assert(toolResults[0]?.includes("outside this room's folder"), `with the window open: ${toolResults[0]}`);
		there.close();
		const away = await openWindow(room, "conversation-away-live");
		let release = () => {};
		gatewayHold = new Promise<void>((resolve) => { release = resolve; });
		gatewayHeld = false;
		legs = [[read]];
		toolResults = [];
		try {
			away.send({ type: "prompt", text: "Sum the sales." });
			await waitUntil(() => gatewayHeld, "the model's call waits");
			away.close();
			await waitUntil(() => detachedCookingRooms.has(room), "the turn goes on with nobody there");
		} finally {
			gatewayHold = null;
			release();
		}
		await waitUntil(() => toolResults.length > 0, "the read was refused");
		await waitForTurnSettled(json, room, "the away turn has settled");
		assert(toolResults[0]?.includes("outside this room's folder"), `the away turn: ${toolResults[0]}`);
	});

	await macRow("live: a scheduled task's file tool refused for a folder gives the refusal, and a write into a folder it can only read says the person can ask again from the computer", async () => {
		await startServer();
		const { createBackgroundRun } = await import("../src/background-runs.js");
		const { readPersistentRoomScheduleStore, writePersistentRoomScheduleStore } = await import("../../../pi-package/extensions/schedule-prompt/index.js");
		const { executePersistentRoomBackgroundPrompt } = await import("../src/persistent-room-background-execution.js");
		const { AuthStorage, ModelRegistry } = await import("@exxeta/exxperts-runtime");
		const room = await makeRoom("Scheduled Review");
		await setRoomFolder(room, newFolder("live-scheduled"), false);
		const jobId = "sched_0123456789abcdef0123456789abcdef";
		const at = new Date().toISOString();
		// Never due while the smoke runs, and taken off at the end: the server's own scheduler must not run it again into a later row's turn.
		const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
		writePersistentRoomScheduleStore({ ...readPersistentRoomScheduleStore(room), jobs: [{ id: jobId, name: "Weekly Sales", enabled: true, type: "interval", schedule: "1d", prompt: "Sum the sales.", createdAt: at, updatedAt: at, lastRunAt: null, lastStatus: null, lastError: null, nextRunAt: later } as any] });
		const run = createBackgroundRun({ kind: "scheduled-prompt", scope: { kind: "persistent-room", roomId: room }, source: { trigger: "schedule-due", schedulerJobId: jobId }, target: { kind: "fresh-thread", roomId: room } });
		const outside = newFolder("Sales Elsewhere");
		// Nobody can answer a folder card in a scheduled run, so a write into a folder the room can only read sends the person back to the computer.
		const readOnly = newFolder("Sales Read Only");
		addAlsoAllowedFolder(room, readOnly, "read");
		legs = [[{ name: "read", args: { path: path.join(outside, "q3.csv") } }], [{ name: "write", args: { path: path.join(readOnly, "total.md"), content: "total" } }]];
		toolResults = [];
		try {
			await executePersistentRoomBackgroundPrompt({ roomId: room, target: { kind: "fresh-thread", model: MODEL }, prompt: "Sum the sales.", executionId: run.runId, agentDir, modelRegistry: ModelRegistry.create(AuthStorage.create(path.join(agentDir, "auth.json")), path.join(agentDir, "models.json")) } as any);
		} finally {
			writePersistentRoomScheduleStore({ ...readPersistentRoomScheduleStore(room), jobs: [] });
		}
		assert(toolResults[0]?.includes("outside this room's folder"), `the read: ${toolResults[0]}`);
		assert(toolResults[1]?.includes("is in a folder this room can only read") && toolResults[1].includes("ask again from the computer") && !toolResults[1].includes("ask_for_folder"), `the write: ${toolResults[1]}`);
	});

	await macRow("live: Turn off after a yes switches commands off; Remove takes a folder off the list and Undo puts back only what that window removed; ", async () => {
		await startServer();
		const room = await makeRoom("Ways On Review");
		const folder = newFolder("live-ways-on");
		await setRoomFolder(room, folder, true);
		const listed = newFolder("live-listed");
		addAlsoAllowedFolder(room, listed, "read");
		const window = await openWindow(room, "conversation-ways");
		window.send({ type: "room_folder_remove", path: path.join(folder, "not-listed") });
		window.send({ type: "room_folder_remove", path: listed });
		await waitUntil(() => window.frames().filter((frame) => frame.type === "room_folder_removed").length === 2, "both Removes answered");
		const removed = window.frames().filter((frame) => frame.type === "room_folder_removed");
		assert(removed[0].removed === false && removed[1].removed === true && readAlsoAllowed(room).folders.length === 0, `Remove: ${JSON.stringify(removed)}`);
		// Undo puts back only what this window removed, with the access it had; a path it never removed adds nothing.
		window.send({ type: "room_folder_restore", path: path.join(folder, "never-listed") });
		window.send({ type: "room_folder_restore", path: listed });
		await waitUntil(() => window.frames().filter((frame) => frame.type === "room_folder_restored").length === 2, "both Undos answered");
		const restored = window.frames().filter((frame) => frame.type === "room_folder_restored");
		assert(restored[0].restored === false && restored[1].restored === true && JSON.stringify(readAlsoAllowed(room).folders) === JSON.stringify([{ path: listed, access: "read" }]), `Undo: ${JSON.stringify(restored)} ${JSON.stringify(readAlsoAllowed(room).folders)}`);
		const elsewhere = await openWindow(room);
		elsewhere.send({ type: "room_folder_restore", path: listed });
		window.send({ type: "room_folder_remove", path: listed });
		await waitUntil(() => window.frames().filter((frame) => frame.type === "room_folder_removed").length === 3, "the second Remove answered");
		elsewhere.send({ type: "room_folder_restore", path: listed });
		await waitUntil(() => elsewhere.frames().filter((frame) => frame.type === "room_folder_restored").length === 2, "the other window's Undos answered");
		assert(elsewhere.frames().filter((frame) => frame.type === "room_folder_restored").every((frame) => frame.restored === false) && readAlsoAllowed(room).folders.length === 0, "another window put back a folder it never removed");
		elsewhere.close();
		window.send({ type: "room_commands_off" });
		await waitUntil(() => window.frames().some((frame) => frame.type === "room_commands_turned_off"), "Turn off answered");
		assert(commandsOf(room) === "switched-off", `after Turn off: ${commandsOf(room)}`);
		window.close();
	});

	// Allow this time…: the folder lasts until the room finishes answering the message, and the next answer starts with none.
	const thisTimeRoom = async (name: string) => {
		const room = await makeRoom(name);
		await setRoomFolder(room, newFolder(`live-${name.toLowerCase().replaceAll(" ", "-")}`), undefined);
		const given = newFolder(`${name} Invoices`);
		fs.writeFileSync(path.join(given, "q3.csv"), "q3 total 42\n");
		fs.writeFileSync(path.join(given, "march.csv"), "march total 7\n");
		folderWindow.pick = given;
		return { room, given, q3: path.join(given, "q3.csv"), march: path.join(given, "march.csv") };
	};
	const outsideOf = (result: string | undefined) => !!result?.includes("outside this room's folder") && !result.includes("total");

	await macRow("live: Allow this time… gives this answer's file tools and commands the folder; the next answer's can't reach it, and the list never holds it", async () => {
		await startServer();
		const { room, q3 } = await thisTimeRoom("Given Review");
		const window = await openWindow(room);
		const results = await window.turn([[askFolder("read")], [readFile(q3)], [bash(`cat ${shellQuoted(q3)}`)]], { folder: PRESSES.choose });
		assert(results[0]?.includes("for this answer only"), `the ask: ${results[0]}`);
		assert(results[1]?.includes("q3 total 42") && results[2]?.includes("q3 total 42"), `this answer's read and command: ${JSON.stringify(results.slice(1))}`);
		const next = await window.turn([[readFile(q3)], [bash(`cat ${shellQuoted(q3)}`)]]);
		assert(outsideOf(next[0]) && !next[1]?.includes("q3 total 42"), `the next answer: ${JSON.stringify(next)}`);
		assert(readAlsoAllowed(room).folders.length === 0, `the list: ${JSON.stringify(readAlsoAllowed(room).folders)}`);
		window.close();
	});

	await macRow("live: a message sent while the room answers joins that answer and keeps the folder; the next answer starts with none", async () => {
		await startServer();
		const { room, q3, march } = await thisTimeRoom("Steered Review");
		const window = await openWindow(room);
		window.answerWith({ folder: PRESSES.choose });
		const ended = window.frames().length;
		legs = [[askFolder("read")], [readFile(q3)]];
		toolResults = [];
		const hold = holdLeg(1);
		window.send({ type: "prompt", text: "Sum the invoices." });
		await waitUntil(() => gatewayHeld, "the model's call after the pick waits");
		window.send({ type: "steer", id: "steer-march", text: "Add March too." });
		await waitUntil(() => window.frames().slice(ended).some((frame) => typeof frame.type === "string" && frame.type.startsWith("steer_") && frame.id === "steer-march"), "the message was routed");
		// The held call keeps its own leg; after the message is taken, the legs start again.
		legs = [[readFile(march)]];
		hold.release();
		await waitForTurnSettled(json, room, "the answer has settled");
		assert(window.frames().some((frame) => frame.type === "steer_taken" && frame.id === "steer-march"), "the message wasn't taken into the answer");
		assert(toolResults[0]?.includes("march total 7"), `the read after the message: ${toolResults[0]}`);
		const next = await window.turn([[readFile(march)]]);
		assert(outsideOf(next[0]), `the next answer: ${next[0]}`);
		window.close();
	});

	await macRow("live: Stop ends the folder with the answer", async () => {
		await startServer();
		const { room, q3 } = await thisTimeRoom("Stopped Review");
		const conversation = "conversation-stopped";
		const window = await openWindow(room, conversation);
		window.answerWith({ folder: PRESSES.choose });
		legs = [[askFolder("change")], [readFile(q3)]];
		toolResults = [];
		const hold = holdLeg(1);
		window.send({ type: "prompt", text: "Sum the invoices." });
		await waitUntil(() => gatewayHeld, "the model's call after the pick waits");
		assert(toolResults[0]?.includes("for this answer only"), `the pick: ${toolResults[0]}`);
		window.send({ type: "abort" });
		hold.release();
		await waitForTurnSettled(json, room, "the stopped answer has settled");
		const next = await window.turn([[readFile(q3)]]);
		assert(outsideOf(next[0]), `the next answer: ${next[0]}`);
		window.close();
	});

	await macRow("live: a page that leaves mid-answer and comes back keeps the folder for that answer, and the next answer starts with none", async () => {
		await startServer();
		const { detachedCookingRooms } = await import("../src/room-live-sessions.js");
		const { room, q3 } = await thisTimeRoom("Returning Review");
		const conversation = "conversation-returning";
		const window = await openWindow(room, conversation);
		window.answerWith({ folder: PRESSES.choose });
		legs = [[askFolder("read")], [readFile(q3)]];
		toolResults = [];
		const hold = holdLeg(1);
		let back: Awaited<ReturnType<typeof openWindow>> | null = null;
		try {
			window.send({ type: "prompt", text: "Sum the invoices." });
			await waitUntil(() => gatewayHeld, "the model's call after the pick waits");
			window.close();
			await waitUntil(() => detachedCookingRooms.has(room), "the answer goes on with nobody there");
			back = await openWindow(room, conversation, { seed: false });
		} finally {
			hold.release();
		}
		await waitForTurnSettled(json, room, "the answer has settled");
		assert(toolResults[1]?.includes("q3 total 42"), `the read after coming back: ${JSON.stringify(toolResults)}`);
		const next = await back.turn([[readFile(q3)]]);
		assert(outsideOf(next[0]), `the next answer: ${next[0]}`);
		back.close();
	});
} catch (error) {
	failures.push(`the smoke stopped: ${(error as Error).message}`);
	console.log(`  FAIL ${(error as Error).message}`);
}

// Last: a shared server's hooks stay once registered.
await row("a shared server: no asks, no commands card and no Turn on anyway, and new rooms start with commands off", async () => {
	const { registerServerHooks } = await import("../src/server-hooks.js");
	assert(asks.roomAsksOffered(true) && asks.commandsAskState({ on: false, atComputer: true, folder: "/x", fullAccess: true, switchedOff: () => false }) === "may-ask", "at the computer before");
	registerServerHooks({});
	withProtection(() => {
		assert(!roomBoxAvailable() && bashSettings.newRoomCommandFiles(new Date()).length === 0, "a shared server's new room starts with commands on");
		assert(!asks.roomAsksOffered(true), "a shared server offers the asks");
		assert(asks.commandsAskState({ on: false, atComputer: true, folder: "/x", fullAccess: true, switchedOff: () => false }) === "unavailable", "a shared server may show the commands card");
	});
});

if (serverUp) {
	(gateway as any).closeAllConnections?.();
	gateway.close();
}
fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(`room asks smoke: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length > 0 ? 1 : 0);
