// A settings lock left in a room's folder, as a cloned or unpacked project can
// carry one, never makes the app delete a file it names. The lock's note is a
// second name for the lock while it lands, so a contender that proves the owner
// dead removes the lock and that note. A dead owner's lock whose note leaves
// the writer's own shape names no owner: nothing is removed at once, and the
// stale rule later removes the lock alone, so the settings file is not blocked
// for ever. Beside it, a dead owner's lock in the writer's shape is cleared at
// once, its note included, and a live owner's lock is left alone.
//
// Each row reads a room's settings through the runtime's SettingsManager, which
// takes the lock on `.exxperts/settings.json` whenever that file exists. The
// files a note could reach are the ones `${lock}.${note}` names on this
// platform: a backslash is a separator on Windows only, and an absolute note is
// appended, so it lands under a folder beside the lock.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsManager } from "@exxeta/exxperts-runtime";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-lock-note-"));
const THEME = "lock-note-theme";
// Past proper-lockfile's default stale time, which the sync path uses.
const PAST_STALE_MS = 60_000;

type Room = { name: string; cwd: string; agentDir: string; lock: string };

function makeRoom(name: string): Room {
	const cwd = path.join(tempRoot, name, "room");
	const agentDir = path.join(tempRoot, name, "agent");
	fs.mkdirSync(path.join(cwd, ".exxperts"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(cwd, ".exxperts", "settings.json"), JSON.stringify({ theme: THEME }));
	return { name, cwd, agentDir, lock: path.join(cwd, ".exxperts", "settings.json.lock") };
}

function plantLock(room: Room, pid: number, note: string): void {
	fs.writeFileSync(room.lock, JSON.stringify({ pid, host: os.hostname(), run: "an-earlier-run", note }));
}

/** Writes a file at each place given, and returns those places. */
function plantFiles(places: string[]): string[] {
	for (const place of places) {
		fs.mkdirSync(path.dirname(place), { recursive: true });
		fs.writeFileSync(place, "keep me");
	}
	return places;
}

/** Every file and folder under the row's scratch folder. */
function filesOf(room: Room): string[] {
	const rowRoot = path.join(tempRoot, room.name);
	return (fs.readdirSync(rowRoot, { recursive: true }) as string[]).map((entry) => path.join(rowRoot, entry)).sort();
}

function readSettings(room: Room): { codes: string[]; theme: string | undefined } {
	const settings = SettingsManager.create(room.cwd, room.agentDir);
	const codes = settings.drainErrors().map(({ error }) => (error as NodeJS.ErrnoException).code ?? error.message);
	return { codes, theme: settings.getTheme() };
}

const shown = (room: Room, files: string[]) => files.map((file) => path.relative(path.join(tempRoot, room.name), file)).join(", ") || "nothing";

function sameFiles(room: Room, expected: string[], actual: string[], when: string): string[] {
	const gone = expected.filter((file) => !actual.includes(file));
	const added = actual.filter((file) => !expected.includes(file));
	if (gone.length === 0 && added.length === 0) return [];
	return [`${room.name}: ${when}, gone: ${shown(room, gone)}; still there or new: ${shown(room, added)}`];
}

const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

/** A dead owner's lock whose note is not in the writer's shape: nothing goes at once, and past the stale time the lock alone goes. */
function refusedNoteRow(name: string, note: (room: Room) => string): string[] {
	const room = makeRoom(name);
	const noteText = note(room);
	fs.mkdirSync(`${room.lock}.x`);
	const absolute = path.isAbsolute(noteText);
	// On Windows an absolute note appended to the lock's name puts a drive's colon mid-name, where no file can be.
	const reached = absolute && process.platform === "win32" ? [] : [path.resolve(`${room.lock}.${noteText}`)];
	const planted = plantFiles([...reached, ...(absolute ? [noteText] : [])]);
	plantLock(room, deadPid(), noteText);
	const before = filesOf(room);
	console.log(`${room.name}: note ${JSON.stringify(noteText)} reaches ${shown(room, planted)}`);

	const problems: string[] = [];
	const fresh = readSettings(room);
	if (fresh.codes.join() !== "ELOCKED") problems.push(`${room.name}: a fresh lock should still refuse its settings file, errors: ${fresh.codes.join() || "none"}`);
	problems.push(...sameFiles(room, before, filesOf(room), "right after the read"));
	if (!fs.existsSync(room.lock)) return problems;

	const past = new Date(Date.now() - PAST_STALE_MS);
	fs.utimesSync(room.lock, past, past);
	const later = readSettings(room);
	if (later.codes.length > 0 || later.theme !== THEME) problems.push(`${room.name}: past the stale time the settings should read, errors: ${later.codes.join() || "none"}, theme: ${later.theme}`);
	problems.push(...sameFiles(room, before.filter((file) => file !== room.lock), filesOf(room), "past the stale time"));
	return problems;
}

/** A dead owner's lock in the writer's shape is cleared at once, its note with it. */
function validNoteRow(): string[] {
	const room = makeRoom("valid-note");
	const note = "tmp-1-1-a";
	plantFiles([`${room.lock}.${note}`]);
	plantLock(room, deadPid(), note);
	const before = filesOf(room);

	const problems: string[] = [];
	const read = readSettings(room);
	if (read.codes.length > 0 || read.theme !== THEME) problems.push(`${room.name}: the settings should read at once, errors: ${read.codes.join() || "none"}, theme: ${read.theme}`);
	problems.push(...sameFiles(room, before.filter((file) => file !== room.lock && file !== `${room.lock}.${note}`), filesOf(room), "after the read"));
	return problems;
}

/** A live owner's lock in the writer's shape stays, and so does its note. */
async function liveOwnerRow(): Promise<string[]> {
	const room = makeRoom("live-owner");
	const note = "tmp-1-1-b";
	const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	try {
		await new Promise<void>((resolve, reject) => holder.once("spawn", resolve).once("error", reject));
		plantFiles([`${room.lock}.${note}`]);
		plantLock(room, holder.pid!, note);
		const before = filesOf(room);

		const problems: string[] = [];
		const read = readSettings(room);
		if (read.codes.join() !== "ELOCKED") problems.push(`${room.name}: a live owner's lock should refuse its settings file, errors: ${read.codes.join() || "none"}`);
		problems.push(...sameFiles(room, before, filesOf(room), "after the read"));
		return problems;
	} finally {
		holder.kill("SIGKILL");
	}
}

let problems: string[] = [];
try {
	problems = [
		...refusedNoteRow("slash-note", () => "x/../../victim"),
		...refusedNoteRow("backslash-note", () => "x\\..\\..\\victim"),
		...refusedNoteRow("absolute-note", (room) => path.join(tempRoot, room.name, "outside", "victim")),
		...validNoteRow(),
		...(await liveOwnerRow()),
	];
} finally {
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

if (problems.length > 0) {
	for (const problem of problems) console.error(`FAIL ${problem}`);
	process.exit(1);
}
console.log("settings lock note smoke: ok");
