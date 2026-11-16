// A room's commands in the box, on a Mac. Every row runs a real command in a real
// box through the room's own tools and reads what a person or the model would get.
// Each refused row has an allowed neighbour.
//
// It plants dotfiles and git settings in the home it runs under, so it refuses to
// start anywhere but the throwaway home `npm run smokes` makes.
//
// On any other computer each row says it was skipped, by name, and the rows that
// hold the other computers' behaviour still run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BoxProcess } from "../src/room-box/box-process.js";
import { RoomBox, type BoxWatcher } from "../src/room-box/box-session.js";
import { boxRefusedLine } from "../src/room-box/card-text.js";
import { AnswerFolders } from "../src/room-box/folder-question.js";
import { createPersistentRoomDefaultCapabilityPolicy, persistentAgentRootPath, writePersistentRoomDefaultCapabilityPolicy } from "../src/persistent-room-workspace-policy.js";
import { createRoomCommandTools, type RoomCommandTools } from "../src/room-command-tool.js";
import { ROOM_FOLDER_REFUSED } from "../src/room-files.js";

const home = fs.realpathSync(os.homedir());
const sharedTemp = fs.realpathSync(os.tmpdir());
if (path.dirname(home) !== sharedTemp || !path.basename(home).startsWith("exxperts-smoke-home-")) {
	console.error(`room box turn-end smoke refused: ${home} is not a throwaway smoke home. Run it with: npm run smokes -- room-box-turn-end`);
	process.exit(1);
}

const onMac = process.platform === "darwin";
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

async function macRow(name: string, body: () => Promise<void> | void): Promise<void> {
	if (!onMac) {
		console.log(`  skip ${name} (needs a Mac)`);
		return;
	}
	await row(name, body);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function waitFor(ready: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const ROOM_ID = "box-turn-end-smoke-room";
fs.mkdirSync(persistentAgentRootPath(ROOM_ID), { recursive: true });
const folder = fs.realpathSync(fs.mkdtempSync(path.join(home, "room-folder-")));
const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(home, "elsewhere-")));
// Chosen as a person chooses a room's folder: a command runs only in the folder the room has stored.
const chooseFolder = (room: string) => writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: room, repoRoot: path.resolve(import.meta.dirname, "..", "..", ".."), root: folder, workspaceAccessMode: "localFiles", displayLabel: "Room Folder", source: "manual" }));
chooseFolder(ROOM_ID);

type Asked = { host: string; port: number; lasting: boolean };
const person = {
	watcher: "computer" as BoxWatcher,
	siteAnswer: "decline" as "once" | "room" | "decline",
	answeredBy: "computer" as BoxWatcher,
	outsideAnswer: false,
	siteCards: [] as Asked[],
	outsideCards: [] as { command: string; reason: string }[],
	canChangeFiles: true,
	skillFolders: [] as string[],
	heldSite: undefined as Promise<{ choice: "room"; answeredBy: BoxWatcher }> | undefined,
	siteCardsClosed: 0,
	offered: true,
	onSiteCard: undefined as (() => void) | undefined,
	/** The room's own folder ask: offered in this turn. */
	folderAskOffered: true,
};
const questions = {
	watcher: () => person.watcher,
	askSite: async (card: Asked) => {
		person.siteCards.push(card);
		person.onSiteCard?.();
		if (person.heldSite) return person.heldSite;
		return { choice: person.siteAnswer, answeredBy: person.answeredBy };
	},
	closeSiteCards: () => { person.siteCardsClosed += 1; },
	askOutside: async (card: { command: string; reason: string }) => {
		person.outsideCards.push(card);
		return person.outsideAnswer;
	},
};

function newBox(): { box: RoomBox; tools: RoomCommandTools } {
	const box = new RoomBox({
		roomId: ROOM_ID,
		conversationId: () => "conversation-a",
		questions: questions as any,
		rights: () => ({ canChangeFiles: person.canChangeFiles, skillFolders: person.skillFolders }),
		warn: () => {},
		folderAsk: { offered: () => person.folderAskOffered },
	});
	return { box, tools: createRoomCommandTools(folder, { box, outside: { questions: questions as any, setOffered: (offered) => { person.offered = offered; } } }) };
}

let callNumber = 0;
async function call(tools: RoomCommandTools, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; failed: boolean; id: string }> {
	const tool = tools.tools.find((candidate) => candidate.name === name);
	assert(tool, `no ${name} tool`);
	const id = `call-${++callNumber}`;
	try {
		const result: any = await tool.execute(id, input as any, signal as any, undefined as any, undefined as any);
		return { text: (result.content ?? []).map((part: any) => part.text ?? "").join(""), failed: false, id };
	} catch (error) {
		return { text: (error as Error).message, failed: true, id };
	}
}

/** Whether a program is still running. */
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const outsideRoom = (name: string) => path.join(elsewhere, name);
const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

let tools: RoomCommandTools;
let box: RoomBox;
const bash = (command: string) => call(tools, "bash", { command });
/** Ends the turn: the next command starts a fresh box. */
const nextTurn = async () => {
	await box.endTurn();
	({ box, tools } = newBox());
	person.siteCards.length = 0;
};

const plainWork = outsideRoom("plain-work");

async function main(): Promise<void> {
	console.log("room box turn-end smoke");
	fs.mkdirSync(plainWork, { recursive: true });
	if (onMac) ({ box, tools } = newBox());

	// What may be a refusal: the refusal's own words, or a failure with nothing to say. Each of these gets the line, and only these.
	const refusedLine = (asks: boolean) => boxRefusedLine(asks);
	const triggers: [string, Record<string, unknown>][] = [
		["is refused a write outside the room's folder", { command: `echo x > ${quoted(path.join(plainWork, "refused.txt"))}` }],
		["exits non-zero with no output", { command: "exit 3" }],
		["times out with no output", { command: "/bin/sleep 5", timeout: 1 }],
		["prints the refusal's words and exits 0", { command: "echo 'cp: x: Operation not permitted' >&2; true" }],
		["fails with the refusal's words in Node's lower case", { command: "echo \"Error: EPERM: operation not permitted, open '/x.txt'\" >&2; exit 1" }],
	];
	for (const [label, input] of triggers) {
		await macRow(`the fixed line: a command that ${label} tells the model to ask for the folder, where the room may ask`, async () => {
			await nextTurn();
			const result = await call(tools, "bash", input);
			assert(result.text.includes(refusedLine(true)) && !result.text.includes(refusedLine(false)), `the line: ${result.text}`);
		});
	}

	await macRow("the fixed line: a command that fails or times out saying why in words of its own gets none", async () => {
		await nextTurn();
		const ownWords: [string, Record<string, unknown>][] = [
			["Python's missing module", { command: "echo \"ModuleNotFoundError: No module named 'pptx'\" >&2; exit 1" }],
			["git outside a repository", { command: "echo 'fatal: not a git repository (or any of the parent directories): .git' >&2; exit 128" }],
			["a timeout after some output", { command: "echo started; /bin/sleep 5", timeout: 1 }],
		];
		for (const [label, input] of ownWords) {
			const result = await call(tools, "bash", input);
			assert(result.failed && !result.text.includes(refusedLine(true)) && !result.text.includes(refusedLine(false)), `${label}: ${result.text}`);
		}
	});

	await macRow("the fixed line: a command that exits 0 gets none, a listing of a folder outside the room included", async () => {
		await nextTurn();
		for (const command of ["echo fine", `/bin/ls ${quoted(elsewhere)} 2>/dev/null; true`]) {
			const result = await bash(command);
			assert(!result.failed && !result.text.includes("protection"), `${command}: ${result.text}`);
		}
	});

	await macRow("the fixed line: from a phone, or with nobody there, it says the person can ask again from the computer, and nothing waits", async () => {
		await nextTurn();
		person.folderAskOffered = false;
		try {
			const phone = await bash(`echo x > ${quoted(path.join(plainWork, "from-phone.txt"))}`);
			assert(phone.failed && phone.text.includes(refusedLine(false)) && phone.text.includes("ask again from the computer") && !phone.text.includes("ask_for_folder"), `from a phone: ${phone.text}`);
		} finally {
			person.folderAskOffered = true;
		}
		person.watcher = "none";
		try {
			const away = await bash(`echo x > ${quoted(path.join(plainWork, "away.txt"))}`);
			assert(away.failed && away.text.includes(refusedLine(false)), `nobody there: ${away.text}`);
		} finally {
			person.watcher = "computer";
		}
		assert(!fs.existsSync(path.join(persistentAgentRootPath(ROOM_ID), "runtime", "box-requests.json")), "a request was saved");
	});

	await macRow("turn's end: the network closes before the private temp is emptied, and the temp is still emptied", async () => {
		await nextTurn();
		const { text } = await bash(`echo x > "$TMPDIR/still-here"; echo "temp=$TMPDIR"`);
		const temp = /temp=(\S+)/.exec(text)?.[1];
		assert(temp && fs.existsSync(path.join(temp, "still-here")), `the private temp: ${text}`);
		const real = BoxProcess.prototype.request;
		let filledAtClose: boolean | null = null;
		BoxProcess.prototype.request = function request<T>(this: BoxProcess, op: string, payload: Record<string, unknown>): Promise<T> {
			if (op === "closeNetwork") filledAtClose = fs.existsSync(path.join(temp, "still-here"));
			return real.call(this, op, payload) as Promise<T>;
		};
		try {
			await box.endTurn();
		} finally {
			BoxProcess.prototype.request = real;
			({ box, tools } = newBox());
		}
		assert(filledAtClose === true, `the network closed with the temp ${filledAtClose === null ? "never closed" : "already emptied"}`);
		assert(!fs.existsSync(temp), "the private temp is still there");
	});

	await macRow("a stored room on a folder no room may use runs no command, with the line; back on its own folder, the same command runs", async () => {
		await nextTurn();
		const programs = path.join(home, ".local", "bin");
		fs.mkdirSync(programs, { recursive: true });
		// Saved as an older room's folder was, before the rule: nothing at the pick refused it.
		writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: ROOM_ID, repoRoot: path.resolve(import.meta.dirname, "..", "..", ".."), root: programs, workspaceAccessMode: "localFiles", displayLabel: "Programs", source: "manual" }));
		try {
			const refused = await bash(`touch ${quoted(path.join(programs, "planted"))} && echo ran`);
			assert(refused.failed && refused.text.includes(ROOM_FOLDER_REFUSED) && !fs.existsSync(path.join(programs, "planted")), `on ~/.local/bin: ${refused.text}`);
		} finally {
			chooseFolder(ROOM_ID);
			await nextTurn();
		}
		const ran = await bash("touch back-home && echo ran");
		assert(ran.text.includes("ran") && fs.existsSync(path.join(folder, "back-home")), `back on its own folder: ${ran.text}`);
	});

	await macRow("turn's end: a job a command left writing into a folder given this time ends with the answer, and the next answer can't write there; the room's folder still can", async () => {
		await box.endTurn();
		const given = fs.realpathSync(fs.mkdtempSync(path.join(home, "given-this-time-")));
		let answer = new AnswerFolders();
		answer.give(given, "write");
		const answerBox = () => {
			const made = new RoomBox({ roomId: ROOM_ID, conversationId: () => "conversation-a", questions: questions as any, rights: () => ({ canChangeFiles: true, skillFolders: [] }), warn: () => {}, answer: () => answer });
			return { box: made, tools: createRoomCommandTools(folder, { box: made, outside: { questions: questions as any, setOffered: () => {} } }) };
		};
		try {
			({ box, tools } = answerBox());
			const ticks = path.join(given, "ticks");
			const started = await bash(`( while :; do echo tick >> ${quoted(ticks)}; /bin/sleep 0.05; done ) > /dev/null 2>&1 & echo "job=$!"`);
			const job = Number(/job=(\d+)/.exec(started.text)?.[1]);
			assert(job > 0, `the command left no job: ${started.text}`);
			await waitFor(() => fs.existsSync(ticks), "the job writes in the folder given this time");
			assert(alive(job), "the job ended with its command, so this row proves nothing");
			answer.end();
			await box.endTurn();
			await waitFor(() => !alive(job), "the job left running to end with the answer");
			answer = new AnswerFolders();
			({ box, tools } = answerBox());
			const after = path.join(given, "after-the-answer");
			await bash(`echo x > ${quoted(after)}`);
			assert(!fs.existsSync(after), "the next answer wrote in a folder given only to the one before");
			const inRoom = await bash("echo x > still-in-room && echo wrote");
			assert(inRoom.text.includes("wrote") && fs.existsSync(path.join(folder, "still-in-room")), `the room's folder: ${inRoom.text}`);
		} finally {
			await box.endTurn();
			({ box, tools } = newBox());
			fs.rmSync(given, { recursive: true, force: true });
		}
	});

	await macRow("Stop: a job a command left running ends as Stop is accepted, before the answer ends; the room's next command runs", async () => {
		await nextTurn();
		const stop = new AbortController();
		const ticks = path.join(folder, "ticks-until-stop");
		const started = await call(tools, "bash", { command: `( while :; do echo tick >> ${quoted(ticks)}; /bin/sleep 0.05; done ) > /dev/null 2>&1 & echo "job=$!"` }, stop.signal);
		const job = Number(/job=(\d+)/.exec(started.text)?.[1]);
		assert(job > 0, `the command left no job: ${started.text}`);
		await waitFor(() => fs.existsSync(ticks), "the job writes in the room's folder");
		assert(alive(job), "the job ended with its command, so this row proves nothing");
		stop.abort();
		await waitFor(() => !alive(job), "the job to end at Stop, with the answer not yet ended");
		await nextTurn();
		const ran = await bash("echo ran");
		assert(ran.text.includes("ran"), `the next command: ${ran.text}`);
	});

	// A job that hands off: it waits past its command, then starts a writer in the same group and exits, so nothing that ran at the command's return is left.
	// The writer notes its own process number, so the row judges that process, not the file it writes.
	const handOff = async (signal?: AbortSignal) => {
		const release = path.join(folder, `release-${callNumber}`);
		const ticks = path.join(folder, `handed-ticks-${callNumber}`);
		const noted = path.join(folder, `handed-writer-${callNumber}`);
		const writer = `/bin/sh -c ${quoted(`echo $$ > ${quoted(noted)}; while :; do echo tick >> ${quoted(ticks)}; /bin/sleep 0.05; done`)} &`;
		const started = await call(tools, "bash", { command: `( while [ ! -e ${quoted(release)} ]; do /bin/sleep 0.05; done; ${writer} ) > /dev/null 2>&1 & echo started` }, signal);
		assert(started.text.includes("started"), `the command: ${started.text}`);
		await bash(`touch ${quoted(release)}`);
		await waitFor(() => fs.existsSync(ticks), "the handed-off writer to write");
		const pid = Number(fs.readFileSync(noted, "utf8").trim());
		assert(pid > 0 && alive(pid), `the handed-off writer's number: ${pid}`);
		return { pid, ticks };
	};
	const endsAndStaysQuiet = async (writer: { pid: number; ticks: string }, at: string) => {
		await waitFor(() => !alive(writer.pid), `the handed-off writer to end at ${at}`);
		const size = fs.statSync(writer.ticks).size;
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert(fs.statSync(writer.ticks).size === size, `the handed-off writer's file still grows after it ended at ${at}`);
	};
	await macRow("a job that hands off to a writer in its own group after its command returned ends at the answer's end and at Stop", async () => {
		const writers: number[] = [];
		try {
			await nextTurn();
			const atAnswersEnd = await handOff();
			writers.push(atAnswersEnd.pid);
			await box.endTurn();
			await endsAndStaysQuiet(atAnswersEnd, "the answer's end");
			({ box, tools } = newBox());
			const stop = new AbortController();
			const atStop = await handOff(stop.signal);
			writers.push(atStop.pid);
			stop.abort();
			await endsAndStaysQuiet(atStop, "Stop, with the answer not yet ended");
			await nextTurn();
		} finally {
			// A failed row leaves no writer behind for the rows after it.
			for (const pid of writers) if (alive(pid)) process.kill(pid, "SIGKILL");
		}
	});

	// The keepers this room's open run noted, one per command, by the notes its shells write: another smoke's keepers are in their own rooms' notes.
	const boxFolder = path.join(persistentAgentRootPath(ROOM_ID), "runtime", "box");
	const keepers = () => fs.readdirSync(boxFolder).filter((name) => name.startsWith("groups-")).flatMap((name) => fs.readFileSync(path.join(boxFolder, name), "utf8").split("\n").filter(Boolean).map((line) => Number(line.split(" ")[2])));
	const groupKillsDuring = async (body: () => Promise<void>) => {
		const groupKills: number[] = [];
		const kill = process.kill;
		process.kill = ((pid: number, signal?: string | number) => {
			if (pid < 0 && signal === "SIGKILL") groupKills.push(-pid);
			return kill.call(process, pid, signal);
		}) as typeof process.kill;
		try {
			await body();
		} finally {
			process.kill = kill;
		}
		return groupKills;
	};
	await macRow("a command that leaves nothing running leaves no keeper behind, and the answer's end then stops no group", async () => {
		await nextTurn();
		const ran = await bash("echo ran");
		assert(ran.text.includes("ran"), `the command: ${ran.text}`);
		const keeper = keepers();
		assert(keeper.length === 1, `the command's keeper: ${JSON.stringify(keeper)}`);
		await waitFor(() => !alive(keeper[0]), "the command's keeper to go");
		const kills = await groupKillsDuring(() => box.endTurn());
		assert(kills.length === 0, `the answer's end stopped groups ${kills.join(", ")}`);
		({ box, tools } = newBox());
	});

	await macRow("a group whose keeper has gone is left alone at the answer's end, as its number may be another program's by then", async () => {
		await nextTurn();
		const started = await bash(`/bin/sleep 30 > /dev/null 2>&1 & echo "job=$!"`);
		const job = Number(/job=(\d+)/.exec(started.text)?.[1]);
		assert(job > 0, `the command left no job: ${started.text}`);
		const keeper = keepers();
		assert(keeper.length === 1, `the command's keeper: ${JSON.stringify(keeper)}`);
		process.kill(keeper[0], "SIGKILL");
		await waitFor(() => !alive(keeper[0]), "the keeper to end");
		try {
			const kills = await groupKillsDuring(() => box.endTurn());
			assert(kills.length === 0, `the answer's end stopped groups ${kills.join(", ")}`);
		} finally {
			process.kill(job, "SIGKILL");
		}
		({ box, tools } = newBox());
	});
}

main().catch((error) => {
	failures.push(`crashed: ${(error as Error).stack}`);
}).finally(() => {
	fs.rmSync(folder, { recursive: true, force: true });
	fs.rmSync(elsewhere, { recursive: true, force: true });
	console.log(`room box turn-end smoke: ${passed} passed, ${failures.length} failed`);
	for (const failure of failures) console.log(`  failed: ${failure}`);
	process.exit(failures.length ? 1 : 0);
});
