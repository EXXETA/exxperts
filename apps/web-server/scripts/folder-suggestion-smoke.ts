// The judge of a folder the room suggests (src/room-box/folder-suggestion.ts):
// its text rules decide before any call on the path, it follows no link and
// leaves the home's disk at most by one call, it runs within its limit and its
// gate refuses only after an overrun, one click is offered only strictly
// inside Desktop, Documents or Downloads, and before the click only `lstat`
// and `realpath` touch the path, no saved entry is touched and no program
// starts. Every disk call and program start is recorded by the names it was
// given. Windows' rules run on stand-in file calls; the Mac rows on this disk.
//
// It makes folders in the home it runs under, so it refuses to start anywhere
// but the throwaway home `npm run smokes` makes.
import type { BigIntStats } from "node:fs";
import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

import { closedForReading } from "../src/room-box/box-closed.js";
import { folderGrantable } from "../src/room-box/folder-offer.js";
import { CLICK_CHECK_LIMIT_MS, type HeldFolder, judgeSuggestion, SUGGESTION_JUDGE_MS, suggestionBeforeCard, suggestionPlace, type SuggestionFiles, type SuggestionView } from "../src/room-box/folder-suggestion.js";

const home = fs.realpathSync(os.homedir());
const sharedTemp = fs.realpathSync(os.tmpdir());
if (path.dirname(home) !== sharedTemp || !path.basename(home).startsWith("exxperts-smoke-home-")) {
	console.error(`folder suggestion smoke refused: ${home} is not a throwaway smoke home. Run it with: npm run smokes -- folder-suggestion`);
	process.exit(1);
}

const onWindows = process.platform === "win32";
let passed = 0;
const failures: string[] = [];

async function row(name: string, body: () => Promise<void> | void, needs: "any" | "posix" = "any"): Promise<void> {
	if (needs === "posix" && onWindows) {
		console.log(`  skip ${name} (needs a Mac or Linux)`);
		return;
	}
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

// ---- every disk call and program start, recorded by the names it was given ----
type Call = { fn: string; name: string };
const calls: Call[] = [];
let recording = false;
const named = (value: unknown): string[] => (typeof value === "string" ? [value] : value instanceof URL ? [value.pathname] : Buffer.isBuffer(value) ? [value.toString("utf8")] : Array.isArray(value) ? value.flatMap(named) : []);
function recordCalls(owner: Record<string, any>, name: string, fn = name): void {
	const original = owner[name];
	if (typeof original !== "function") return;
	const recorded = function (this: unknown, ...args: unknown[]) {
		if (recording) calls.push(...args.slice(0, 2).flatMap(named).map((place) => ({ fn, name: place })));
		return original.apply(this, args);
	};
	for (const key of Object.keys(original)) (recorded as any)[key] = original[key];
	owner[name] = recorded;
}
const FS_CALLS = ["access", "exists", "lstat", "open", "opendir", "readdir", "readFile", "readlink", "realpath", "stat", "statfs", "watch", "mkdir", "writeFile", "rename", "unlink", "rm", "symlink", "copyFile", "cp"];
for (const name of FS_CALLS) {
	recordCalls(fs, name);
	recordCalls(fs, `${name}Sync`);
	recordCalls(fsPromises, name, `promises.${name}`);
}
recordCalls(fs.realpathSync, "native", "realpathSync.native");
recordCalls(fs.realpath, "native", "realpath.native");
const PROGRAM_CALLS = ["execFile", "execFileSync", "spawn", "spawnSync", "exec", "execSync", "fork"];
for (const name of PROGRAM_CALLS) recordCalls(childProcess, name);
syncBuiltinESMExports();

async function recorded<T>(body: () => Promise<T> | T): Promise<{ value: T; calls: Call[] }> {
	calls.length = 0;
	recording = true;
	try {
		return { value: await body(), calls: [...calls] };
	} finally {
		recording = false;
	}
}

const spelled = (text: string) => text.replace(/\\/g, "/").toLowerCase();
/** The calls on a place or below it, by any spelling of case or slash. */
const onPlace = (seen: readonly Call[], place: string): Call[] => seen.filter((call) => spelled(call.name) === spelled(place) || spelled(call.name).startsWith(`${spelled(place)}/`));
const META = new Set(["lstat", "lstatSync", "promises.lstat", "realpath", "realpathSync", "realpathSync.native", "promises.realpath", "realpath.native"]);
const programs = (seen: readonly Call[]) => seen.filter((call) => PROGRAM_CALLS.includes(call.fn));

// ---- the room, on this disk ----
const made = (...names: string[]) => {
	const place = path.join(home, ...names);
	fs.mkdirSync(place, { recursive: true });
	return fs.realpathSync(place);
};
const roomFolder = made("Rooms", "Planning");
const outside = fs.realpathSync(fs.mkdtempSync(path.join(sharedTemp, "suggestion-outside-")));
const grants = (writable: readonly string[]) => (real: string, at: "before-click" | "click") => folderGrantable(real, "read", writable, roomFolder, { links: "refuse", beforeClick: at === "before-click" });
const macView = (extra: Partial<SuggestionView> = {}): SuggestionView => {
	const writable = [roomFolder, ...(extra.writable ?? [])];
	return { roomFolder, roomRules: grants(writable), home, homes: [home], ...extra, writable };
};

// ---- Windows, on stand-in file calls ----
type Entry = { kind: "folder" | "link" | "file"; dev?: bigint; ino?: bigint };
function windowsDisk(entries: Record<string, Entry>, record: Call[] = []): SuggestionFiles & { hold?: () => void } {
	const find = (place: string) => Object.entries(entries).find(([name]) => name.toLowerCase() === place.toLowerCase());
	const stats = (entry: Entry, at: number): BigIntStats => ({ isDirectory: () => entry.kind === "folder", isSymbolicLink: () => entry.kind === "link", dev: entry.dev ?? 7n, ino: entry.ino ?? BigInt(at + 100) }) as unknown as BigIntStats;
	return {
		async lstat(place) {
			record.push({ fn: "lstat", name: place });
			const found = find(place);
			if (!found) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return stats(found[1], Object.keys(entries).indexOf(found[0]));
		},
		async realpath(place) {
			record.push({ fn: "realpath", name: place });
			const found = find(place);
			if (!found) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return found[0];
		},
		async statfs(place) {
			record.push({ fn: "statfs", name: place });
			return { type: 0 };
		},
	};
}
const ANA = "C:\\Users\\Ana";
const answerOf = (fields: Record<string, unknown>) => JSON.stringify({ profile: ANA, desktop: `${ANA}\\Desktop`, documents: `${ANA}\\Documents`, downloads: `${ANA}\\Downloads`, onedrive: [], ...fields });
const winView = (files: SuggestionFiles, answer: string | undefined, extra: Partial<SuggestionView> = {}): SuggestionView => ({
	roomFolder: `${ANA}\\Rooms\\Planning`,
	writable: [`${ANA}\\Rooms\\Planning`],
	roomRules: () => true,
	files,
	home: ANA,
	rules: path.win32,
	keptAnswer: () => answer,
	homes: [ANA],
	...extra,
});
const folders = (...names: string[]): Record<string, Entry> => Object.fromEntries([ANA, ...names].map((name) => [name, { kind: "folder" as const }]));

async function main(): Promise<void> {
	console.log("folder suggestion smoke");
	// The system's names for its shared folders are asked once per server, with fixed arguments: warmed here, before anything is recorded.
	closedForReading();
	made("Documents", "Reports");
	made("Downloads", "March");
	made("Desktop", "Notes");

	await row("guard 2: the text rules give no suggestion, and no call on the path, for each refused shape (Mac rules)", async () => {
		const dataFolder = made("ExxpertsData");
		const deep = `~/${Array.from({ length: 9 }, (_, at) => `d${at}`).join("/")}`;
		const writableEntry = made("Shared", "Team");
		const refused: [unknown, string][] = [
			["~", "the home"], ["~/", "the home"], [home, "the home by its path"], ["/Volumes/NAS/x", "another disk"], ["/net/h/x", "the automounter"],
			["~/a/../b", "a climb"], ["~/a/./b", "a dot part"], ["~//Documents", "an empty part"], ["Documents/Reports", "a relative path"], ["~ana/Documents", "another user's ~"],
			[`~/${"x".repeat(399)}`, "401 characters"], ["~/Documents/\u202eReports", "a bidi control"], ["~/Docu\nments", "a line end"],
			["~/.ssh/keys", "a dot folder"], ["~/Documents/.git", "a dot part below"], ["~/Library/Mobile Documents/x", "Library"],
			["file:///Users/ana/Documents", "a file address"], ["smb://host/share", "a network address"], [deep, "nine parts below the home"],
			[path.join(dataFolder, "x"), "the app's data folder"], [path.join(writableEntry, "x"), "a folder in a writable entry"], [path.dirname(roomFolder), "the room's folder's parent"],
			[path.join(roomFolder, "x"), "inside the room's folder"], [42, "not text"], [null, "nothing"], [path.join(outside, "x"), "outside the home"],
		];
		for (const [text, label] of refused) {
			const view = macView({ writable: [writableEntry], homes: [home, dataFolder] });
			const { value, calls: seen } = await recorded(() => judgeSuggestion(text, view, "before-click"));
			assert(value === null, `${label}: suggested ${JSON.stringify(value)}`);
			assert(suggestionPlace(text, view) === null, `${label}: the text rules pass it`);
			if (typeof text === "string" && text.length > 1) {
				const place = text.startsWith("~") ? path.join(home, text.slice(1)) : text;
				assert(onPlace(seen, place).length === 0, `${label}: calls on the path ${JSON.stringify(onPlace(seen, place).slice(0, 3))}`);
			}
			assert(seen.every((call) => !spelled(call.name).startsWith(spelled(home))), `${label}: calls below the home ${JSON.stringify(seen.slice(0, 3))}`);
		}
		// The neighbours pass: an ordinary folder, and 400 characters.
		assert(suggestionPlace("~/Documents/Reports", macView()) === path.join(home, "Documents", "Reports"), "an ordinary folder's text passes");
		assert(suggestionPlace(`~/${"x".repeat(398)}`, macView()) !== null, "400 characters pass the text rules");
	}, "posix");

	await row("guard 2: the text rules give no suggestion, and no call at all, for each refused shape (Windows rules)", async () => {
		const record: Call[] = [];
		const files = windowsDisk(folders(`${ANA}\\Documents`, `${ANA}\\Documents\\Reports`), record);
		const refused = ["Z:\\x", "C:\\Users\\Bo\\x", "C:x", "\\\\h\\s\\x", "//h/s/x", "\\\\?\\C:\\Users\\Ana\\x", `${ANA}\\SSH~1\\x`, `${ANA}\\Documents\\a.`, `${ANA}\\Documents\\a `, `${ANA}\\a:b`, `${ANA}\\a*b`, `${ANA}\\a|b`, `${ANA}\\AppData\\Roaming\\x`, `${ANA}\\NUL`, `${ANA}\\Documents\\..\\x`, `${ANA}\\.ssh`, `${ANA}`, "~", "~\\Rooms", `${ANA}\\Rooms\\Planning\\x`];
		for (const text of refused) {
			record.length = 0;
			const value = await judgeSuggestion(text, winView(files, answerOf({})), "before-click");
			assert(value === null, `${text}: suggested ${JSON.stringify(value)}`);
			assert(record.length === 0, `${text}: calls ${JSON.stringify(record)}`);
		}
		const ok = await judgeSuggestion("C:/Users/Ana/Documents/Reports", winView(files, answerOf({})), "before-click");
		assert(ok?.real === `${ANA}\\Documents\\Reports` && ok.shown === `${ANA}\\Documents\\Reports`, `the ordinary folder with forward slashes: ${JSON.stringify(ok)}`);
	});

	await row("guard 3: no link is followed: a link to outside, inside the home, as the last part, a chain, and HEAD links inside the folder", async () => {
		const target = made("Real", "Target");
		fs.writeFileSync(path.join(outside, "secret.txt"), "x");
		fs.symlinkSync(outside, path.join(home, "Documents", "Away"));
		fs.symlinkSync(target, path.join(home, "Documents", "Near"));
		made("Documents", "Holder");
		fs.symlinkSync(target, path.join(home, "Documents", "Holder", "Last"));
		fs.symlinkSync(path.join(home, "Documents", "Near"), path.join(home, "Documents", "Chain"));
		const repoLike = made("Documents", "RepoLike");
		for (const name of ["HEAD", "objects", "refs"]) fs.symlinkSync(path.join(outside, name), path.join(repoLike, name));
		const targets = [outside, target];
		const firstLink: Record<string, string> = { "~/Documents/Away": "Documents/Away", "~/Documents/Away/x": "Documents/Away", "~/Documents/Near": "Documents/Near", "~/Documents/Near/x": "Documents/Near", "~/Documents/Holder/Last": "Documents/Holder/Last", "~/Documents/Chain/x": "Documents/Chain" };
		for (const text of ["~/Documents/Away", "~/Documents/Away/x", "~/Documents/Near", "~/Documents/Near/x", "~/Documents/Holder/Last", "~/Documents/Chain/x", "~/Documents/RepoLike"]) {
			const { value, calls: seen } = await recorded(() => judgeSuggestion(text, macView(), "before-click"));
			assert(value === null, `${text}: suggested ${JSON.stringify(value)}`);
			// The walk stops at the link: nothing asks where a path through it leads.
			const link = firstLink[text];
			const resolved = link ? onPlace(seen, path.join(home, link)).filter((call) => call.fn.includes("realpath")) : [];
			assert(resolved.length === 0, `${text}: a path through the link was resolved ${JSON.stringify(resolved.slice(0, 3))}`);
			for (const place of targets) assert(onPlace(seen, place).length === 0, `${text}: a call on a link's target ${JSON.stringify(onPlace(seen, place).slice(0, 3))}`);
			assert(seen.every((call) => call.fn !== "readlink" && call.fn !== "readlinkSync" && call.fn !== "promises.readlink"), `${text}: a link was read`);
		}
		// Without the flag, today's rule follows the HEAD links: the flag is what keeps their targets untouched.
		const { calls: today } = await recorded(() => folderGrantable(repoLike, "read", [roomFolder], roomFolder));
		assert(onPlace(today, outside).length > 0, "today's rule reads the links' targets: the row would not see the flag go");
		// A folder beside them, with no link, is suggested.
		const plain = await judgeSuggestion("~/Documents/Holder", macView(), "before-click");
		assert(plain?.real === path.join(home, "Documents", "Holder"), `the plain neighbour: ${JSON.stringify(plain)}`);
	}, "posix");

	await row("guard 3: on Windows rules a link on the way gives no suggestion, and nothing asks where a path through it leads", async () => {
		const record: Call[] = [];
		const entries = folders(`${ANA}\\Documents`, `${ANA}\\Documents\\Reports`);
		entries[`${ANA}\\Documents\\Jump`] = { kind: "link" };
		entries[`${ANA}\\Documents\\Jump\\x`] = { kind: "folder" };
		const files = windowsDisk(entries, record);
		for (const text of [`${ANA}\\Documents\\Jump`, `${ANA}\\Documents\\Jump\\x`]) {
			record.length = 0;
			assert((await judgeSuggestion(text, winView(files, answerOf({})), "before-click")) === null, `${text}: a link on the way is suggested`);
			const resolved = record.filter((call) => call.fn === "realpath" && call.name.toLowerCase().startsWith(`${ANA}\\Documents\\Jump`.toLowerCase()));
			assert(resolved.length === 0, `${text}: a path through the link was resolved ${JSON.stringify(resolved)}`);
		}
		assert((await judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(files, answerOf({})), "before-click"))?.once === true, "the folder beside the link");
	});

	await row("guard 3: another disk on the way, or a dev of 0, gives no suggestion; a mount's top folder gets one lstat and nothing below it", async () => {
		const record: Call[] = [];
		const entries = folders(`${ANA}\\Documents`, `${ANA}\\Documents\\Reports`);
		entries[`${ANA}\\Documents\\Mount`] = { kind: "folder", dev: 9n };
		entries[`${ANA}\\Documents\\Mount\\x`] = { kind: "folder", dev: 9n };
		const files = windowsDisk(entries, record);
		assert((await judgeSuggestion(`${ANA}\\Documents\\Mount\\x`, winView(files, answerOf({})), "before-click")) === null, "a folder on another disk is suggested");
		assert(record.filter((call) => call.name.toLowerCase().startsWith(`${ANA}\\Documents\\Mount`.toLowerCase())).length === 1, `calls on the mount: ${JSON.stringify(record)}`);
		// Windows says 0 for every folder of a volume it can't name.
		const zero = windowsDisk(Object.fromEntries(Object.keys(folders(`${ANA}\\Documents`, `${ANA}\\Documents\\Reports`)).map((name) => [name, { kind: "folder" as const, dev: 0n }])));
		assert((await judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(zero, answerOf({})), "before-click")) === null, "a dev of 0 gives a suggestion");
		const healthy = await judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(files, answerOf({})), "before-click");
		assert(healthy?.once === true, `the folder beside it: ${JSON.stringify(healthy)}`);
	});

	await row("guard 3: a home on a network disk gives no suggestions (Mac and Linux)", async () => {
		const files: SuggestionFiles = { lstat: (place, options) => fsPromises.lstat(place, options), realpath: (place) => fsPromises.realpath(place), statfs: async (place) => ({ type: place === "/" ? 26 : 77 }) };
		assert((await judgeSuggestion("~/Documents/Reports", macView({ files }), "before-click")) === null, "a network home gives a suggestion");
		assert((await judgeSuggestion("~/Documents/Reports", macView(), "before-click"))?.once === true, "the same on this disk gives none");
	}, "posix");

	await row("guard 4: off the thread, within the limit; the gate refuses only after an overrun, never at the click, and opens again once the call settles", async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const record: Call[] = [];
		const base = windowsDisk(folders(`${ANA}\\Documents`, `${ANA}\\Documents\\Reports`, `${ANA}\\Documents\\Stuck`), record);
		const stuck: SuggestionFiles = { ...base, async lstat(place, options) {
			if (place.endsWith("Stuck")) await held;
			return base.lstat(place, options);
		} };
		const started = Date.now();
		assert((await judgeSuggestion(`${ANA}\\Documents\\Stuck`, winView(stuck, answerOf({})), "before-click")) === null, "a stuck call gives a suggestion");
		const took = Date.now() - started;
		assert(took >= SUGGESTION_JUDGE_MS - 20, `the limit: ${took} ms`);
		record.length = 0;
		assert((await judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(stuck, answerOf({})), "before-click")) === null, "the gate let a judge before a card through");
		assert(record.length === 0, `the gated judge made calls: ${JSON.stringify(record)}`);
		const click = await judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(stuck, answerOf({})), "click");
		assert(click?.real === `${ANA}\\Documents\\Reports`, `the recheck at a click is gated: ${JSON.stringify(click)}`);
		const clickStarted = Date.now();
		assert((await judgeSuggestion(`${ANA}\\Documents\\Stuck`, winView(stuck, answerOf({})), "click")) === null, "a click past its own limit gives a folder");
		assert(Date.now() - clickStarted >= CLICK_CHECK_LIMIT_MS - 20, "the click's own limit");
		release();
		// The gate opens once the stuck calls settle: wait for that state, a turn of the loop at a time.
		let open = false;
		for (let turn = 0; turn < 1000 && !open; turn += 1) {
			await new Promise((resolve) => setImmediate(resolve));
			open = (await judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(base, answerOf({})), "before-click")) !== null;
		}
		assert(open, "the gate never opened after the stuck calls settled");
		const both = await Promise.all([judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(base, answerOf({})), "before-click"), judgeSuggestion(`${ANA}\\Documents\\Stuck`, winView(base, answerOf({})), "before-click")]);
		assert(both.every((each) => each !== null), `two healthy judges after the call settled: ${JSON.stringify(both)}`);
	});

	await row("guard 5: one click only strictly inside Desktop, Documents or Downloads (Mac rules)", async () => {
		made("Projects", "app");
		made("SynologyDrive", "Team");
		made("Pictures", "x");
		const judge = (text: string) => judgeSuggestion(text, macView(), "before-click");
		for (const text of ["~/Documents/Reports", "~/Downloads/March", "~/Desktop/Notes"]) assert((await judge(text))?.once === true, `${text}: no one click`);
		for (const text of ["~/Documents", "~/Projects/app", "~/SynologyDrive/Team", "~/Pictures/x"]) {
			const held = await judge(text);
			assert(held !== null && held.once === false, `${text}: ${JSON.stringify(held)}`);
		}
	}, "posix");

	await row("guard 5: one click on Windows: never in or beside OneDrive, and never without Windows' kept answer", async () => {
		const org = `${ANA}\\OneDrive - Org`;
		const entries = folders(`${ANA}\\Documents`, `${ANA}\\Documents\\Reports`, org, `${org}\\Documents`, `${org}\\Documents\\Plans`, `${org}\\Team Shortcut`, `${ANA}\\Org`, `${ANA}\\Org\\Site - Library`, `${ANA}\\Org\\Site - Library\\x`, `${ANA}\\Documents\\OneDrive`, `${ANA}\\Documents\\Mine`);
		const files = windowsDisk(entries);
		const once = async (text: string, answer: string | undefined) => (await judgeSuggestion(text, winView(files, answer), "before-click"))?.once;
		assert((await once(`${ANA}\\Documents\\Reports`, answerOf({ onedrive: [org] }))) === true, "Documents\\Reports");
		assert((await once(`${org}\\Documents\\Plans`, answerOf({ documents: `${org}\\Documents`, onedrive: [org] }))) === false, "Documents in OneDrive");
		assert((await once(`${ANA}\\Org\\Site - Library\\x`, answerOf({ onedrive: [org] }))) === false, "a synced library beside OneDrive");
		assert((await once(`${org}\\Team Shortcut`, answerOf({ onedrive: [org] }))) === false, "a shortcut inside OneDrive");
		assert((await once(`${ANA}\\Documents\\Mine`, answerOf({ onedrive: [`${ANA}\\Documents\\OneDrive`] }))) === false, "OneDrive placed inside Documents");
		assert((await once(`${ANA}\\Documents\\Reports`, undefined)) === undefined, "no kept answer gives a suggestion");
	});

	await row("guard 5: on Windows no one click for a folder that holds a OneDrive folder further down", async () => {
		const files = windowsDisk(folders(`${ANA}\\Documents`, `${ANA}\\Documents\\Mine`, `${ANA}\\Documents\\Mine\\Sub`, `${ANA}\\Documents\\Mine\\Sub\\OneDrive`, `${ANA}\\Documents\\Reports`));
		const answer = answerOf({ onedrive: [`${ANA}\\Documents\\Mine\\Sub\\OneDrive`] });
		assert((await judgeSuggestion(`${ANA}\\Documents\\Mine`, winView(files, answer), "before-click"))?.once === false, "a folder two levels above OneDrive gets one click");
		assert((await judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(files, answer), "before-click"))?.once === true, "the folder beside it");
	});

	await row("on Windows a Desktop, Documents or Downloads that is the profile, or holds it, gives no one click", async () => {
		const files = windowsDisk(folders(`${ANA}\\Documents`, `${ANA}\\Documents\\Reports`, `${ANA}\\Projects`, `${ANA}\\Projects\\app`));
		for (const documents of [ANA, "C:\\Users"]) {
			const held = await judgeSuggestion(`${ANA}\\Projects\\app`, winView(windowsDisk({ ...folders(`${ANA}\\Projects`, `${ANA}\\Projects\\app`), "C:\\Users": { kind: "folder" } }), answerOf({ documents })), "before-click");
			assert(held !== null && held.once === false, `Documents told as ${documents}: ${JSON.stringify(held)}`);
		}
		assert((await judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(files, answerOf({})), "before-click"))?.once === true, "Documents in the profile");
	});

	await row("on Windows a Desktop, Documents, Downloads or OneDrive on a share is never resolved, and gives no one click", async () => {
		const record: Call[] = [];
		const share = "\\\\files\\home\\ana";
		const entries = folders(`${ANA}\\Documents`, `${ANA}\\Documents\\Reports`);
		entries[`${share}\\Documents`] = { kind: "folder" };
		entries[`${share}\\OneDrive`] = { kind: "folder" };
		const files = windowsDisk(entries, record);
		const held = await judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(files, answerOf({ documents: `${share}\\Documents`, desktop: `${share}\\Desktop`, onedrive: [`${share}\\OneDrive`] })), "before-click");
		assert(held !== null && held.once === false, `with Documents on a share: ${JSON.stringify(held)}`);
		const onShare = record.filter((call) => spelled(call.name).startsWith(spelled(share)));
		assert(onShare.length === 0, `calls on the share: ${JSON.stringify(onShare)}`);
	});

	await row("on Windows a Desktop, Documents, Downloads or OneDrive outside the profile, on a mapped drive among them, is never resolved, and gives no one click", async () => {
		const record: Call[] = [];
		const entries = folders(`${ANA}\\Documents`, `${ANA}\\Documents\\Reports`);
		entries["H:\\Documents"] = { kind: "folder" };
		entries["H:\\OneDrive"] = { kind: "folder" };
		const files = windowsDisk(entries, record);
		const held = await judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(files, answerOf({ documents: "H:\\Documents", downloads: "D:\\Downloads", onedrive: ["H:\\OneDrive"] })), "before-click");
		assert(held !== null && held.once === false, `with Documents on a mapped drive: ${JSON.stringify(held)}`);
		const offProfile = record.filter((call) => !spelled(call.name).startsWith(spelled(ANA)));
		assert(offProfile.length === 0, `calls outside the profile: ${JSON.stringify(offProfile)}`);
		assert((await judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(files, answerOf({})), "before-click"))?.once === true, "Documents inside the profile");
	});

	await row("on Windows no one click for a folder with a part named OneDrive, whatever the list of OneDrive folders says", async () => {
		const org = `${ANA}\\OneDrive - Org`;
		const files = windowsDisk(folders(org, `${org}\\Documents`, `${org}\\Documents\\Plans`, `${ANA}\\Documents`, `${ANA}\\Documents\\OneDriveOld`, `${ANA}\\Documents\\Reports`));
		const held = await judgeSuggestion(`${org}\\Documents\\Plans`, winView(files, answerOf({ documents: `${org}\\Documents`, onedrive: [] })), "before-click");
		assert(held !== null && held.once === false, `Documents in OneDrive with an empty list: ${JSON.stringify(held)}`);
		const old = await judgeSuggestion(`${ANA}\\Documents\\OneDriveOld`, winView(files, answerOf({ onedrive: [] })), "before-click");
		assert(old !== null && old.once === false, `a part starting with OneDrive: ${JSON.stringify(old)}`);
		assert((await judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(files, answerOf({ onedrive: [] })), "before-click"))?.once === true, "the folder beside them");
	});

	await row("a folder whose real path is not the path walked to it gives no suggestion; the folder it leads to does", async () => {
		const disk = windowsDisk(folders(`${ANA}\\Documents`, `${ANA}\\Documents\\Moved`, `${ANA}\\Documents\\Elsewhere`));
		const files: SuggestionFiles = { ...disk, realpath: async (place) => (place.toLowerCase() === `${ANA}\\Documents\\Moved`.toLowerCase() ? `${ANA}\\Documents\\Elsewhere` : disk.realpath(place)) };
		const answer = answerOf({});
		const moved = await judgeSuggestion(`${ANA}\\Documents\\Moved`, winView(files, answer), "before-click");
		assert(moved === null, `a real path elsewhere: ${JSON.stringify(moved)}`);
		assert((await judgeSuggestion(`${ANA}\\Documents\\Elsewhere`, winView(files, answer), "before-click"))?.once === true, "the folder it leads to");
	});

	await row("on Windows no one click inside a OneDrive folder that isn't named OneDrive and holds the redirected Documents; Downloads beside it gets one", async () => {
		const cloud = `${ANA}\\Cloud Sync`;
		const files = windowsDisk(folders(cloud, `${cloud}\\Documents`, `${cloud}\\Documents\\Plans`, `${ANA}\\Downloads`, `${ANA}\\Downloads\\Mine`));
		const answer = answerOf({ documents: `${cloud}\\Documents`, onedrive: [cloud] });
		const plans = await judgeSuggestion(`${cloud}\\Documents\\Plans`, winView(files, answer), "before-click");
		assert(plans !== null && plans.once === false, `Documents inside the OneDrive folder: ${JSON.stringify(plans)}`);
		assert((await judgeSuggestion(`${ANA}\\Downloads\\Mine`, winView(files, answer), "before-click"))?.once === true, "Downloads beside it");
	});

	await row("on a Mac a Desktop, Documents or Downloads that is a link counts for no one click", async () => {
		const alt = made("AltHome");
		made("AltHome", "Documents", "Kept");
		made("AltHome", "Broad", "x");
		fs.symlinkSync(path.join(alt, "Broad"), path.join(alt, "Desktop"));
		const view = macView({ home: alt });
		const held = await judgeSuggestion(path.join(alt, "Broad", "x"), view, "before-click");
		assert(held !== null && held.once === false, `inside a linked Desktop's target: ${JSON.stringify(held)}`);
		assert((await judgeSuggestion(path.join(alt, "Documents", "Kept"), view, "before-click"))?.once === true, "inside a plain Documents");
	}, "posix");

	await row("a home reached through a link: the folder shown before the click is the one the click judges", async () => {
		const linkedHome = path.join(outside, "home-link");
		fs.symlinkSync(home, linkedHome);
		const view = macView({ home: linkedHome });
		const shown = await judgeSuggestion("~/Documents/Reports", view, "before-click");
		assert(shown !== null && shown.real === path.join(home, "Documents", "Reports"), `before the click: ${JSON.stringify(shown)}`);
		const atClick = await judgeSuggestion(shown.real, view, "click");
		assert(atClick !== null && atClick.real === shown.real && atClick.ino === shown.ino, `at the click: ${JSON.stringify(atClick)}`);
	}, "posix");

	await row("guard 1: a guess's own spelling never reaches the panel: the disk's name and path do", async () => {
		const held = await judgeSuggestion("~/documents/reports/", macView(), "before-click");
		const probe = fs.existsSync(path.join(home, "DOCUMENTS"));
		if (!probe) {
			assert(held === null, "a case-sensitive disk suggests another spelling");
			return;
		}
		assert(held !== null && held.name === "Reports" && held.real === path.join(home, "Documents", "Reports") && held.shown === "~/Documents/Reports", `the disk's spelling: ${JSON.stringify(held)}`);
		assert(!JSON.stringify(held).includes("documents/reports"), "the guess's spelling is held");
	}, "posix");

	await row("guard 15: before the click only lstat and realpath touch the path, no saved entry is touched, and no program starts", async () => {
		const cloud = path.join(home, "Library", "CloudStorage", "OneDrive-Org", "Team");
		const linked = path.join(home, "Linked");
		fs.symlinkSync(outside, linked);
		const share = "/Volumes/TeamShare/Projects";
		const view = macView({ writable: [cloud, linked, share] });
		const { value, calls: seen } = await recorded(() => judgeSuggestion("~/Documents/Reports", view, "before-click"));
		assert(value?.once === true, `the folder is suggested: ${JSON.stringify(value)}`);
		const place = path.join(home, "Documents", "Reports");
		const onIt = onPlace(seen, place);
		assert(onIt.length > 0 && onIt.every((call) => META.has(call.fn)), `calls on the path: ${JSON.stringify(onIt.filter((call) => !META.has(call.fn)))}`);
		for (const entry of [cloud, linked, share, outside]) assert(onPlace(seen, entry).length === 0, `a call on the saved entry ${entry}: ${JSON.stringify(onPlace(seen, entry))}`);
		assert(programs(seen).length === 0, `programs started: ${JSON.stringify(programs(seen))}`);
		// A folder in Library starts no xattr to learn whether it is a cloud drive: it waits for the window. Without the flag, the same check starts it.
		const plans = made("Library", "CloudStorage", "OneDrive-Org", "Plans");
		const library = await recorded(() => folderGrantable(plans, "read", [roomFolder], roomFolder, { links: "refuse", beforeClick: true }));
		assert(library.value === false && programs(library.calls).length === 0, `Library before the click: ${JSON.stringify(library.value)} ${JSON.stringify(programs(library.calls))}`);
		const atClick = await recorded(() => folderGrantable(plans, "read", [roomFolder], roomFolder, { links: "refuse" }));
		assert(programs(atClick.calls).length > 0 || process.platform !== "darwin", "at the click the cloud drive's mark is read: the row would not see the flag go");
	}, "posix");

	await row("guard 15: on Windows rules with no kept answer, no PowerShell starts and nothing is suggested", async () => {
		const record: Call[] = [];
		const files = windowsDisk(folders(`${ANA}\\Documents`, `${ANA}\\Documents\\Reports`), record);
		const { value, calls: seen } = await recorded(() => judgeSuggestion(`${ANA}\\Documents\\Reports`, winView(files, undefined), "before-click"));
		assert(value === null && record.length === 0 && programs(seen).length === 0, `no kept answer: ${JSON.stringify({ value, record, programs: programs(seen) })}`);
	});

	await row("guard 15: with the suggestion shown only at the press, nothing touches the disk before it", async () => {
		const { value, calls: seen } = await recorded(() => suggestionBeforeCard("~/Documents/Reports", macView(), false));
		assert(value === null && seen.length === 0, `before the card: ${JSON.stringify({ value, seen: seen.slice(0, 3) })}`);
		const shown: HeldFolder | null = await suggestionBeforeCard("~/Documents/Reports", macView());
		assert(shown?.once === true, "the default shows it");
	}, "posix");

	console.log(`${passed} passed, ${failures.length} failed`);
	fs.rmSync(outside, { recursive: true, force: true });
	if (failures.length > 0) process.exit(1);
}

await main();
